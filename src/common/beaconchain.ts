import { getClient } from '@lodestar/api'
import { config } from '@lodestar/config/default'
import { ForkName } from '@lodestar/params'
import { BeaconBlockHeader, BeaconState, SignedBeaconBlock, ssz } from '@lodestar/types'
import * as fs from 'fs/promises'
import chalk from 'chalk'

export async function getState (endpoint: string, stateId: number | 'head'): Promise<BeaconState<ForkName.electra>> {
  // Check cache first
  if (typeof stateId === 'number') {
    try {
      const cachePath = `${__dirname}/../../cache/state/${stateId}.ssz`
      if ((await fs.stat(cachePath)).isFile()) {
        const data = await fs.readFile(cachePath)
        return ssz.electra.BeaconState.deserialize(data)
      }
    }
    catch(e) {}
  }

  console.log(chalk.blue("Fetching full beacon state, this may take a while..."))
  const api = getClient({ baseUrl: endpoint }, { config })
  const res = await api.debug.getStateV2({ stateId: stateId })

  const value = res.value() as BeaconState<ForkName.electra>

  // Write as SSZ format to cache as the SSZ format is more compact than JSON
  const treeState = ssz.electra.BeaconState.toView(value)
  const data = treeState.serialize()
  const cachePath = `${__dirname}/../../cache/state/${value.slot}.ssz`
  await fs.writeFile(cachePath, data)

  return value
}

export async function getBlock (endpoint: string, blockId: string | number): Promise<SignedBeaconBlock<ForkName.electra>> {
  if (typeof blockId === 'number') {
    try {
      const cachePath = `${__dirname}/../../cache/block/${blockId}.ssz`
      if ((await fs.stat(cachePath)).isFile()) {
        const data = await fs.readFile(cachePath)
        return ssz.electra.SignedBeaconBlock.deserialize(data)
      }
    } catch(e) {}
  }

  console.log(chalk.blue("Fetching beacon block..."))
  const api = getClient({ baseUrl: endpoint }, { config })
  const res = await api.beacon.getBlockV2({ blockId: blockId })

  const value = res.value() as SignedBeaconBlock<ForkName.electra>

  // Write as SSZ format to cache as the SSZ format is more compact than JSON
  const treeState = ssz.electra.SignedBeaconBlock.toView(value)
  const data = treeState.serialize()
  const cachePath = `${__dirname}/../../cache/block/${value.message.slot}.ssz`
  await fs.writeFile(cachePath, data)

  return value
}

export function constructBlockHeaderWithStateRoot (latestBlockHeader: BeaconBlockHeader<ForkName.electra>, stateRoot: Uint8Array): BeaconBlockHeader<ForkName.electra> {
  return {
    slot: latestBlockHeader.slot,
    proposerIndex: latestBlockHeader.proposerIndex,
    parentRoot: latestBlockHeader.parentRoot,
    bodyRoot: latestBlockHeader.bodyRoot,
    stateRoot: stateRoot,
  }
}
