import { Command } from 'commander'
import chalk from 'chalk'
import { constructBlockHeaderWithStateRoot, getBlock, getState } from '../common/beaconchain'
import { ssz } from '@lodestar/types'
import { createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { concatGindices } from '@chainsafe/persistent-merkle-tree'

interface ValidatorProofOpts {
  slot: string
}

export async function generateWithdrawalProof(proofSlotStr: string, withdrawalSlotStr: string, withdrawalNumberStr: string, opts: ValidatorProofOpts, program: Command) {
  const allOpts = program.optsWithGlobals();
  const proofSlot = parseInt(proofSlotStr)
  const withdrawalSlot = parseInt(withdrawalSlotStr)
  const withdrawalNumber = parseInt(withdrawalNumberStr)

  // Fetch the block at the withdrawal slot
  const withdrawalBlock = await getBlock(allOpts.rpc, withdrawalSlot)

  // Fetch the beacon state at the proof slot
  const state = await getState(allOpts.rpc, proofSlot)
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

  const blockRootsIndex = withdrawalSlot % 8192
  const blockRootFromProofSlot = state.blockRoots[blockRootsIndex]

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

  // Generate partial proof from BeaconState -> blook_roots[blockRootsIndex]
  {
    const { gindex } = ssz.electra.BeaconState.getPathInfo(['block_roots', blockRootsIndex]);
    gindices.push(gindex);
    const proof = createProof(stateView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Generate partial proof from BeaconBlock -> body -> execution_payload -> withdrawals[withdrawalNumber]
  {
    const blockHeaderView = ssz.electra.BeaconBlock.toView(withdrawalBlock.message)

    // Compute the block root to compare with block root from proof slot
    const computedBlockRoot = Buffer.from(blockHeaderView.hashTreeRoot()).toString('hex');
    console.log(`Computed block root for slot ${withdrawalBlock.message.slot}: ${computedBlockRoot}`);
    if (computedBlockRoot !== Buffer.from(blockRootFromProofSlot).toString('hex')) {
      console.error(`Computed block root does not match block root from proof slot! Proof will be invalid.`)
      console.error(`${computedBlockRoot} != ${Buffer.from(blockRootFromProofSlot).toString('hex')}`)
    }

    const { gindex } = ssz.electra.BeaconBlock.getPathInfo(['body', 'execution_payload', 'withdrawals', withdrawalNumber]);
    gindices.push(gindex);
    const proof = createProof(blockHeaderView.node, {
      type: ProofType.single,
      gindex: gindex,
    }) as SingleProof;
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Grab the leaf node values
  const withdrawal = withdrawalBlock.message.body.executionPayload.withdrawals[withdrawalNumber];

  // Reverse the witnesses array to match the order of the gindices array and flatten
  witnesses = witnesses.reverse().flat();
  const combinedGindex = concatGindices(gindices);

  // Output the results
  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Withdrawal Slot: ${withdrawalSlot}`)
  console.log(`Withdrawal Number: ${withdrawalNumber}`)
  console.log(`Proof Slot: ${proofSlot}`)
  console.log(`BlockRoots Index: ${blockRootsIndex}`)
  console.log()
  console.log(`Gindex: 0b${combinedGindex.toString(2)}`)
  console.log(`Gindex: ${combinedGindex.toString(10)}`)
  console.log()
  console.log(`Witnesses (${witnesses.length}):`)
  console.log(`[`)
  console.log(witnesses.map(witness => `"0x${witness}"`).join(',\n'))
  console.log(`]`)
  console.log()
  console.log(`Leaf Nodes:`)
  console.log(`Index: ${withdrawal.index}`)
  console.log(`Validator Index: ${withdrawal.validatorIndex}`)
  console.log(`Address: 0x${Buffer.from(withdrawal.address).toString('hex')}`)
  console.log(`Amount (gwei): ${withdrawal.amount.toString(10)}`)
}