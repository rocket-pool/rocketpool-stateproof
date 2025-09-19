import { Command } from 'commander'
import chalk from 'chalk'
import { constructBlockHeaderWithStateRoot, getBlock, getState } from '../common/beaconchain'
import { ssz } from '@lodestar/types'
import { createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { concatGindices } from '@chainsafe/persistent-merkle-tree'

interface ValidatorProofOpts {
  slot: string
}

export async function generateSlotProof(opts: ValidatorProofOpts, program: Command) {
  const allOpts = program.optsWithGlobals();

  // Parse slot param
  let slot: number | string = opts.slot
  if (slot !== 'head') {
    slot = parseInt(slot)
  }

  // Fetch the state
  const state = await getState(allOpts.rpc, slot)
  console.log(`Generating proof for slot ${state.slot}`)

  // Construct the SSZ tree
  const stateView = ssz.electra.BeaconState.toView(state);

  // Compute the state root for this slot
  console.log(chalk.blue("Computing state root..."))
  const stateRoot = stateView.hashTreeRoot();
  console.log(`State root: ${Buffer.from(stateRoot).toString('hex')}`)

  // Construct the block header as it would be in the "parent_root" of the next block from the latest block header and the computed state root
  const blockHeader = constructBlockHeaderWithStateRoot(state.latestBlockHeader, stateRoot);
  const blockHeaderView = ssz.electra.BeaconBlockHeader.toView(blockHeader);

  // Compute the block root
  console.log(chalk.blue("Computing block root..."))
  const blockRoot = blockHeaderView.hashTreeRoot();
  console.log(`Block root: ${Buffer.from(blockRoot).toString('hex')}`)

  // Create arrays to append partial proofs to
  const gindices = [];
  let witnesses = [];

  // Generate partial proof from BlockHeader -> state_root
  {
    const { gindex } = ssz.electra.BeaconBlockHeader.getPathInfo(['state_root']);
    gindices.push(gindex);
    const proof = createProof(blockHeaderView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Generate partial proof from BeaconState -> slot
  {
    let { gindex } = ssz.electra.BeaconState.getPathInfo(['slot']);
    gindices.push(gindex);
    const proof = createProof(stateView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Reverse the witnesses array to match the order of the gindices array and flatten
  witnesses = witnesses.reverse().flat();
  const combinedGindex = concatGindices(gindices);

  // Output the results
  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Slot number: ${slot}`)
  console.log()
  console.log(`Gindex: 0b${combinedGindex.toString(2)}`)
  console.log(`Gindex: ${combinedGindex.toString(10)}`)
  console.log()
  console.log(`Witnesses (${witnesses.length}):`)
  console.log(`[`)
  console.log(witnesses.map(witness => `"0x${witness}"`).join(',\n'))
  console.log(`]`)
  console.log()
  console.log()

  // Output JSON encoded result
  const output = {
    slot: slot,
    witnesses: witnesses.map(witness => `0x${witness}`)
  }

  console.log(JSON.stringify(output, null, 2))
}