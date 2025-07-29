import { getClient } from '@lodestar/api'
import { config } from '@lodestar/config/default'
import { ForkName } from '@lodestar/params'
import { BeaconBlockHeader, BeaconState, SignedBeaconBlock, ssz } from '@lodestar/types'
import * as fs from 'fs/promises'
import chalk from 'chalk'

export async function getState (endpoint: string, stateId: number | 'head'): Promise<BeaconState<ForkName.fulu>> {
  // Check cache first
  if (typeof stateId === 'number') {
    try {
      const cachePath = `${__dirname}/../../cache/state/${stateId}.ssz`
      if ((await fs.stat(cachePath)).isFile()) {
        const data = await fs.readFile(cachePath)
        return ssz.fulu.BeaconState.deserialize(data)
      }
    }
    catch(e) {}
  }

  console.log(chalk.blue("Fetching full beacon state, this may take a while..."))
  const api = getClient({ baseUrl: endpoint }, { config })
  const res = await api.debug.getStateV2({ stateId: stateId })

  const value = res.value() as BeaconState<ForkName.fulu>

  // Write as SSZ format to cache as the SSZ format is more compact than JSON
  const treeState = ssz.fulu.BeaconState.toView(value)
  const data = treeState.serialize()
  const cachePath = `${__dirname}/../../cache/state/${value.slot}.ssz`
  await fs.writeFile(cachePath, data)

  return value
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

export function constructBlockHeaderWithStateRoot (latestBlockHeader: BeaconBlockHeader<ForkName.fulu>, stateRoot: Uint8Array): BeaconBlockHeader<ForkName.fulu> {
  return {
    slot: latestBlockHeader.slot,
    proposerIndex: latestBlockHeader.proposerIndex,
    parentRoot: latestBlockHeader.parentRoot,
    bodyRoot: latestBlockHeader.bodyRoot,
    stateRoot: stateRoot,
  }
}
