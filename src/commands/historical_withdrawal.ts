import { Command } from 'commander'
import chalk from 'chalk'
import { constructBlockHeaderWithStateRoot, getBlock, getState } from '../common/beaconchain'
import { ssz } from '@lodestar/types'
import { createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { concatGindices } from '@chainsafe/persistent-merkle-tree'

interface ValidatorProofOpts {
  slot: string
  network: string
}

const SLOTS_PER_HISTORICAL_ROOT = 8192;
const MAINNET_HISTORY_START = 758; // CAPELLA_FORK_EPOCH * 32 / SLOTS_PER_HISTORICAL_ROOT
const HOODI_HISTORY_START = 0;

export async function generateHistoricalWithdrawalProof(proofSlotStr: string, withdrawalSlotStr: string, withdrawalNumberStr: string, opts: ValidatorProofOpts, program: Command) {
  const allOpts = program.optsWithGlobals();
  const proofSlot = parseInt(proofSlotStr)
  const withdrawalSlot = parseInt(withdrawalSlotStr)
  const withdrawalNumber = parseInt(withdrawalNumberStr)
  const network = opts.network

  if (network !== 'mainnet' && network !== 'hoodi') {
    console.error(`Unknown network "${network}"`)
    process.exit(1)
  }

  const slotIndex = withdrawalSlot % SLOTS_PER_HISTORICAL_ROOT;
  const historyStart = network === 'mainnet' ? MAINNET_HISTORY_START : HOODI_HISTORY_START;
  const historicalEntry = Math.floor(withdrawalSlot / SLOTS_PER_HISTORICAL_ROOT) - historyStart

  // Fetch the block at the withdrawal slot
  const withdrawalBlock = await getBlock(allOpts.rpc, withdrawalSlot)

  // Calculate and fetch the state of a slot that contains a complete historical_summaries accumulator
  const historicalSlot = Math.floor(Math.ceil(withdrawalSlot / SLOTS_PER_HISTORICAL_ROOT) * SLOTS_PER_HISTORICAL_ROOT);
  const historicalState = await getState(allOpts.rpc, historicalSlot)

  // Fetch the beacon state at the proof slot
  const state = await getState(allOpts.rpc, proofSlot)
  console.log(`Generating proof for slot ${state.slot} on ${network}`)

  // Construct the SSZ tree
  const stateView = ssz.fulu.BeaconState.toView(state);

  // Compute the state root for this slot
  console.log(chalk.blue("Computing state root..."))
  const stateRoot = stateView.hashTreeRoot();
  console.log(`State root: ${Buffer.from(stateRoot).toString('hex')}`)

  // Construct the block header as it would be in the "parent_root" of the next block from the latest block header and the computed state root
  const blockHeader = constructBlockHeaderWithStateRoot(state.latestBlockHeader, stateRoot);
  const blockHeaderView = ssz.fulu.BeaconBlockHeader.toView(blockHeader);

  // Compute the block root
  console.log(chalk.blue("Computing block root..."))
  const blockRoot = blockHeaderView.hashTreeRoot();
  console.log(`Block root: ${Buffer.from(blockRoot).toString('hex')}`)

  // Create arrays to append partial proofs to
  const gindices = [];
  let witnesses = [];

  // Generate partial proof from BlockHeader -> state_root
  {
    const { gindex } = ssz.fulu.BeaconBlockHeader.getPathInfo(['state_root']);
    gindices.push(gindex);
    const proof = createProof(blockHeaderView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Generate partial proof from BeaconState -> historical_summaries[historicalEntry]
  {
    const { gindex } = ssz.fulu.BeaconState.getPathInfo(['historical_summaries', historicalEntry]);
    gindices.push(gindex);
    const proof = createProof(stateView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Generate partial proof from HistoricalSummary -> block_summary_root
  {
    const historicalSummaryView = ssz.fulu.HistoricalSummary.toView(state.historicalSummaries[historicalEntry]);

    const { gindex } = ssz.fulu.HistoricalSummary.getPathInfo(['block_summary_root']);
    gindices.push(gindex);
    const proof = createProof(historicalSummaryView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Generate partial proof for block_roots -> block_roots[n]
  {
    const blockRootsView = ssz.fulu.HistoricalBlockRoots.toView(historicalState.blockRoots);

    // Calculate the block root
    const blockRootsRoot = Buffer.from(blockRootsView.hashTreeRoot()).toString('hex');
    console.log(`Computed block roots root: ${blockRootsRoot}`);

    const { gindex } = ssz.fulu.HistoricalBlockRoots.getPathInfo([slotIndex]);
    gindices.push(gindex);
    const proof = createProof(blockRootsView.node, {
      type: ProofType.single,
      gindex: gindex,
    }) as SingleProof;

    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')));
  }

  const blockRootsIndex = withdrawalSlot % SLOTS_PER_HISTORICAL_ROOT
  const blockRootFromProofSlot = historicalState.blockRoots[blockRootsIndex]

  // Generate partial proof from BeaconBlock -> body -> execution_payload -> withdrawals[withdrawalNumber]
  {
    const blockHeaderView = ssz.fulu.BeaconBlock.toView(withdrawalBlock.message)

    // Compute the block root to compare with block root from proof slot
    const computedBlockRoot = Buffer.from(blockHeaderView.hashTreeRoot()).toString('hex');
    console.log(`Computed block root for slot ${withdrawalBlock.message.slot}: ${computedBlockRoot}`);
    if (computedBlockRoot !== Buffer.from(blockRootFromProofSlot).toString('hex')) {
      console.error(`Computed block root does not match block root from proof slot! Proof will be invalid.`)
      console.error(`${computedBlockRoot} != ${Buffer.from(blockRootFromProofSlot).toString('hex')}`)
    }

    const { gindex } = ssz.fulu.BeaconBlock.getPathInfo(['body', 'execution_payload', 'withdrawals', withdrawalNumber]);
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
  console.log(`Historical Blook Roots Slot: ${historicalSlot}`);
  console.log(`Withdrawal Number: ${withdrawalNumber}`)
  console.log(`Proof Slot: ${proofSlot}`)
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
  console.log();

  // Output JSON encoded result
  const output = {
    slot: proofSlot,
    withdrawalSlot: withdrawalSlot,
    withdrawalNum: withdrawalNumber,
    withdrawal: {
      index: withdrawal.index,
      validatorIndex: withdrawal.validatorIndex,
      withdrawalCredentials: `0x${Buffer.from(withdrawal.address).toString('hex')}`,
      amountInGwei: Number(withdrawal.amount),
    },
    witnesses: witnesses,
  }

  console.log(JSON.stringify(output, null, 2))
}