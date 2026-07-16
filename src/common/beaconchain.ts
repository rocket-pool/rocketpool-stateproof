import { getClient } from '@lodestar/api'
import { config } from '@lodestar/config/default'
import { ForkName, forkAll } from '@lodestar/params'
import { BeaconBlockHeader, BeaconState, SignedBeaconBlock, ssz, sszTypesFor } from '@lodestar/types'
import * as fs from 'fs/promises'
import chalk from 'chalk'

export interface ForkedBeaconState {
  fork: ForkName
  state: BeaconState
}

export async function getStateWithFork (endpoint: string, stateId: number | 'head'): Promise<ForkedBeaconState> {
  // Check cache first
  if (typeof stateId === 'number') {
    try {
      const cachePath = `${__dirname}/../../cache/state/${stateId}.ssz`
      if ((await fs.stat(cachePath)).isFile()) {
        const data = await fs.readFile(cachePath)
        return deserializeBeaconState(data)
      }
    }
    catch(e) {}
  }

  console.log(chalk.blue("Fetching full beacon state, this may take a while..."))
  const api = getClient({ baseUrl: endpoint }, { config })
  const res = await api.debug.getStateV2({ stateId: stateId })

  const state = res.value()
  const fork = res.meta().version

  // Write as SSZ format to cache as the SSZ format is more compact than JSON
  const data = res.ssz()
  const cachePath = `${__dirname}/../../cache/state/${state.slot}.ssz`
  await fs.writeFile(cachePath, data)

  return { fork, state }
}

export async function getState (endpoint: string, stateId: number | 'head'): Promise<BeaconState<ForkName.fulu>> {
  return (await getStateWithFork(endpoint, stateId)).state as BeaconState<ForkName.fulu>
}

export async function getBlock (endpoint: string, blockId: string | number): Promise<SignedBeaconBlock<ForkName.fulu>> {
  if (typeof blockId === 'number') {
    try {
      const cachePath = `${__dirname}/../../cache/block/${blockId}.ssz`
      if ((await fs.stat(cachePath)).isFile()) {
        const data = await fs.readFile(cachePath)
        return ssz.fulu.SignedBeaconBlock.deserialize(data)
      }
    } catch(e) {}
  }

  console.log(chalk.blue("Fetching beacon block..."))
  const api = getClient({ baseUrl: endpoint }, { config })
  const res = await api.beacon.getBlockV2({ blockId: blockId })

  const value = res.value() as SignedBeaconBlock<ForkName.fulu>

  // Write as SSZ format to cache as the SSZ format is more compact than JSON
  const treeState = ssz.fulu.SignedBeaconBlock.toView(value)
  const data = treeState.serialize()
  const cachePath = `${__dirname}/../../cache/block/${value.message.slot}.ssz`
  await fs.writeFile(cachePath, data)

  return value
}

export function constructBlockHeaderWithStateRoot (latestBlockHeader: BeaconBlockHeader, stateRoot: Uint8Array): BeaconBlockHeader {
  return {
    slot: latestBlockHeader.slot,
    proposerIndex: latestBlockHeader.proposerIndex,
    parentRoot: latestBlockHeader.parentRoot,
    bodyRoot: latestBlockHeader.bodyRoot,
    stateRoot: stateRoot,
  }
}

function deserializeBeaconState (data: Uint8Array): ForkedBeaconState {
  // Cache files created before fork metadata was retained only contain raw SSZ bytes. Try newest to oldest;
  // incompatible container layouts fail their fixed/variable offset validation before a value is returned.
  for (const fork of [...forkAll].reverse()) {
    try {
      const state = sszTypesFor(fork).BeaconState.deserialize(data)
      return { fork, state }
    }
    catch(e) {}
  }

  throw new Error('Cached beacon state does not match any supported fork')
}
