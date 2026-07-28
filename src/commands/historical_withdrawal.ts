import { Command } from 'commander'
import chalk from 'chalk'
import { concatGindices, createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { ForkName } from '@lodestar/params'
import { BeaconState, SignedBeaconBlock, ssz, sszTypesFor } from '@lodestar/types'
import {
  constructBlockHeaderWithStateRoot,
  getBlockWithFork,
  getStateWithFork,
} from '../common/beaconchain'
import { getHistoricalProofContextFromStart } from '../common/history'

interface HistoricalWithdrawalProofOpts {
  historicalStart: string
}

interface WithdrawalValue {
  index: number | bigint
  validatorIndex: number | bigint
  address: Uint8Array
  amount: number | bigint
}

export async function generateHistoricalWithdrawalProof (
  proofSlotStr: string,
  withdrawalSlotStr: string,
  withdrawalNumberStr: string,
  opts: HistoricalWithdrawalProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const withdrawalSlot = parseNonNegativeInteger('withdrawal slot', withdrawalSlotStr, program)
  const withdrawalNumber = parseNonNegativeInteger('withdrawal number', withdrawalNumberStr, program)
  const historicalStart = parseNonNegativeInteger('historical start', opts.historicalStart, program)

  if (withdrawalSlot >= proofSlot) {
    program.error(`Withdrawal slot ${withdrawalSlot} must be earlier than proof slot ${proofSlot}`)
  }

  const { slotIndex: rootsIndex, historicalEntry, historicalSlot } =
    getHistoricalProofContextFromStart(withdrawalSlot, historicalStart)

  if (historicalEntry < 0) {
    program.error(
      `Withdrawal slot ${withdrawalSlot} predates historical summary start period ${historicalStart}`
    )
  }
  if (proofSlot < historicalSlot) {
    program.error(
      `Proof slot ${proofSlot} is earlier than historical summary boundary ${historicalSlot} for withdrawal slot ${withdrawalSlot}`
    )
  }

  const { fork: withdrawalFork, block: withdrawalBlock } = await getBlockWithFork(
    allOpts.rpc,
    withdrawalSlot
  )
  if (!isWithdrawalFork(withdrawalFork)) {
    program.error(`Withdrawals are not supported for fork ${withdrawalFork}`)
  }

  const useStateRoots = withdrawalFork === ForkName.gloas

  const proofSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, proofSlot)
    const state = forkedState as BeaconState<ForkName.gloas>

    if (historicalEntry >= state.historicalSummaries.length) {
      program.error(
        `Historical summary entry ${historicalEntry} is not available at proof slot ${proofSlot}; state contains ${state.historicalSummaries.length} entries`
      )
    }

    console.log(`Generating historical withdrawal proof rooted at slot ${state.slot} (${fork})`)
    const stateTypes = sszTypesFor(fork)
    const stateView = stateTypes.BeaconState.toView(state as never)

    console.log(chalk.blue('Computing proof-slot state root...'))
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Proof-slot state root: ${Buffer.from(stateRoot).toString('hex')}`)

    const blockHeader = constructBlockHeaderWithStateRoot(state.latestBlockHeader, stateRoot)
    const blockHeaderView = stateTypes.BeaconBlockHeader.toView(blockHeader)

    console.log(chalk.blue('Computing proof-slot block root...'))
    const blockRoot = blockHeaderView.hashTreeRoot()
    console.log(`Proof-slot block root: ${Buffer.from(blockRoot).toString('hex')}`)

    const headerPath = stateTypes.BeaconBlockHeader.getPathInfo(['stateRoot'])
    const headerProof = createProof(blockHeaderView.node, {
      type: ProofType.single,
      gindex: headerPath.gindex,
    }) as SingleProof

    const historicalSummariesPath = stateTypes.BeaconState.getPathInfo([
      'historicalSummaries',
      historicalEntry,
    ])
    const historicalSummariesProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: historicalSummariesPath.gindex,
    }) as SingleProof

    const historicalSummary = state.historicalSummaries[historicalEntry]
    const historicalSummaryView = ssz.capella.HistoricalSummary.toView(historicalSummary)
    const summaryField = useStateRoots ? 'stateSummaryRoot' : 'blockSummaryRoot'
    const summaryPath = ssz.capella.HistoricalSummary.getPathInfo([summaryField])
    const summaryProof = createProof(historicalSummaryView.node, {
      type: ProofType.single,
      gindex: summaryPath.gindex,
    }) as SingleProof

    return {
      fork,
      headerGindex: headerPath.gindex,
      headerWitnesses: headerProof.witnesses,
      historicalSummariesGindex: historicalSummariesPath.gindex,
      historicalSummariesWitnesses: historicalSummariesProof.witnesses,
      summaryGindex: summaryPath.gindex,
      summaryWitnesses: summaryProof.witnesses,
      summaryRoot: historicalSummary[summaryField],
    }
  })()

  const historicalSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, historicalSlot)
    const state = forkedState as BeaconState<ForkName.gloas>

    if (useStateRoots) {
      const rootsView = ssz.phase0.HistoricalStateRoots.toView(state.stateRoots)
      const rootsRoot = rootsView.hashTreeRoot()
      console.log(`Computed historical state roots root: ${Buffer.from(rootsRoot).toString('hex')}`)

      const rootsPath = ssz.phase0.HistoricalStateRoots.getPathInfo([rootsIndex])
      const rootsProof = createProof(rootsView.node, {
        type: ProofType.single,
        gindex: rootsPath.gindex,
      }) as SingleProof

      return {
        fork,
        rootsKind: 'state' as const,
        rootsRoot,
        rootsGindex: rootsPath.gindex,
        rootsWitnesses: rootsProof.witnesses,
        withdrawalRoot: state.stateRoots[rootsIndex],
      }
    }

    const rootsView = ssz.phase0.HistoricalBlockRoots.toView(state.blockRoots)
    const rootsRoot = rootsView.hashTreeRoot()
    console.log(`Computed historical block roots root: ${Buffer.from(rootsRoot).toString('hex')}`)

    const rootsPath = ssz.phase0.HistoricalBlockRoots.getPathInfo([rootsIndex])
    const rootsProof = createProof(rootsView.node, {
      type: ProofType.single,
      gindex: rootsPath.gindex,
    }) as SingleProof

    return {
      fork,
      rootsKind: 'block' as const,
      rootsRoot,
      rootsGindex: rootsPath.gindex,
      rootsWitnesses: rootsProof.witnesses,
      withdrawalRoot: state.blockRoots[rootsIndex],
    }
  })()

  const computedSummaryRoot = Buffer.from(historicalSlotData.rootsRoot).toString('hex')
  const provenSummaryRoot = Buffer.from(proofSlotData.summaryRoot).toString('hex')
  if (computedSummaryRoot !== provenSummaryRoot) {
    console.error(
      `Computed historical ${historicalSlotData.rootsKind} roots root does not match ${historicalSlotData.rootsKind}_summary_root from proof slot! Proof will be invalid.`
    )
    console.error(`${computedSummaryRoot} != ${provenSummaryRoot}`)
  }

  const withdrawalSlotData = useStateRoots
    ? await generateGloasWithdrawalSlotProof(
      allOpts.rpc,
      withdrawalSlot,
      withdrawalNumber,
      withdrawalFork,
      historicalSlotData.withdrawalRoot,
      program
    )
    : generatePreGloasWithdrawalSlotProof(
      withdrawalBlock,
      withdrawalFork,
      withdrawalNumber,
      historicalSlotData.withdrawalRoot,
      program
    )

  const combinedGindex = concatGindices([
    proofSlotData.headerGindex,
    proofSlotData.historicalSummariesGindex,
    proofSlotData.summaryGindex,
    historicalSlotData.rootsGindex,
    withdrawalSlotData.withdrawalGindex,
  ])
  const witnesses = [
    ...withdrawalSlotData.withdrawalWitnesses,
    ...historicalSlotData.rootsWitnesses,
    ...proofSlotData.summaryWitnesses,
    ...proofSlotData.historicalSummariesWitnesses,
    ...proofSlotData.headerWitnesses,
  ]
  const withdrawal = withdrawalSlotData.withdrawal
  const rootsLabel = historicalSlotData.rootsKind === 'state' ? 'StateRoots' : 'BlockRoots'

  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Withdrawal Slot: ${withdrawalSlot}`)
  console.log(`Withdrawal Fork: ${withdrawalFork}`)
  console.log(`Historical Roots Slot: ${historicalSlot}`)
  console.log(`Historical Roots Fork: ${historicalSlotData.fork}`)
  console.log(`Historical Start Period: ${historicalStart}`)
  console.log(`Historical Summary Entry: ${historicalEntry}`)
  console.log(`${rootsLabel} Index: ${rootsIndex}`)
  console.log(`Withdrawal Number: ${withdrawalNumber}`)
  console.log(`Proof Slot: ${proofSlot}`)
  console.log(`Proof Fork: ${proofSlotData.fork}`)
  console.log()
  console.log(`Gindex: 0b${combinedGindex.toString(2)}`)
  console.log(`Gindex: ${combinedGindex.toString(10)}`)
  console.log()
  console.log(`Witnesses (${witnesses.length}):`)
  console.log('[')
  console.log(witnesses.map(witness => `"0x${Buffer.from(witness).toString('hex')}"`).join(',\n'))
  console.log(']')
  console.log()
  console.log('Leaf Nodes:')
  console.log(`Index: ${withdrawal.index}`)
  console.log(`Validator Index: ${withdrawal.validatorIndex}`)
  console.log(`Address: 0x${Buffer.from(withdrawal.address).toString('hex')}`)
  console.log(`Amount (gwei): ${withdrawal.amount.toString(10)}`)
  console.log()

  const output = {
    slot: proofSlot,
    withdrawalSlot,
    withdrawalNum: withdrawalNumber,
    withdrawal: {
      index: withdrawal.index,
      validatorIndex: withdrawal.validatorIndex,
      withdrawalCredentials: `0x${Buffer.from(withdrawal.address).toString('hex')}`,
      amountInGwei: Number(withdrawal.amount),
    },
    witnesses: witnesses.map(witness => `0x${Buffer.from(witness).toString('hex')}`),
  }

  console.log(JSON.stringify(output, null, 2))
}

async function generateGloasWithdrawalSlotProof (
  endpoint: string,
  withdrawalSlot: number,
  withdrawalNumber: number,
  expectedFork: ForkName.gloas,
  provenStateRoot: Uint8Array,
  program: Command
) {
  const { fork, state: forkedState } = await getStateWithFork(endpoint, withdrawalSlot)
  if (fork !== expectedFork) {
    program.error(`Withdrawal block fork ${expectedFork} does not match withdrawal state fork ${fork}`)
  }

  const state = forkedState as BeaconState<ForkName.gloas>
  if (withdrawalNumber >= state.payloadExpectedWithdrawals.length) {
    program.error(
      `Withdrawal number ${withdrawalNumber} is outside payload_expected_withdrawals length ${state.payloadExpectedWithdrawals.length}`
    )
  }

  const stateTypes = sszTypesFor(fork)
  const stateView = stateTypes.BeaconState.toView(state as never)
  const computedStateRoot = Buffer.from(stateView.hashTreeRoot()).toString('hex')
  const expectedStateRoot = Buffer.from(provenStateRoot).toString('hex')
  console.log(`Computed withdrawal state root for slot ${state.slot}: ${computedStateRoot}`)

  if (computedStateRoot !== expectedStateRoot) {
    console.error('Computed withdrawal state root does not match historical state_roots entry! Proof will be invalid.')
    console.error(`${computedStateRoot} != ${expectedStateRoot}`)
  }

  const withdrawalPath = stateTypes.BeaconState.getPathInfo([
    'payloadExpectedWithdrawals',
    withdrawalNumber,
  ])
  const withdrawalProof = createProof(stateView.node, {
    type: ProofType.single,
    gindex: withdrawalPath.gindex,
  }) as SingleProof

  return {
    withdrawalGindex: withdrawalPath.gindex,
    withdrawalWitnesses: withdrawalProof.witnesses,
    withdrawal: state.payloadExpectedWithdrawals[withdrawalNumber] as WithdrawalValue,
  }
}

function generatePreGloasWithdrawalSlotProof (
  withdrawalBlock: SignedBeaconBlock,
  fork: Exclude<WithdrawalFork, ForkName.gloas>,
  withdrawalNumber: number,
  provenBlockRoot: Uint8Array,
  program: Command
) {
  const block = withdrawalBlock as SignedBeaconBlock<ForkName.fulu>
  const withdrawals = block.message.body.executionPayload.withdrawals
  if (withdrawalNumber >= withdrawals.length) {
    program.error(`Withdrawal number ${withdrawalNumber} is outside withdrawals length ${withdrawals.length}`)
  }

  const blockTypes = sszTypesFor(fork)
  const blockView = blockTypes.BeaconBlock.toView(withdrawalBlock.message as never)
  const computedBlockRoot = Buffer.from(blockView.hashTreeRoot()).toString('hex')
  const expectedBlockRoot = Buffer.from(provenBlockRoot).toString('hex')
  console.log(`Computed withdrawal block root for slot ${withdrawalBlock.message.slot}: ${computedBlockRoot}`)

  if (computedBlockRoot !== expectedBlockRoot) {
    console.error('Computed withdrawal block root does not match historical block_roots entry! Proof will be invalid.')
    console.error(`${computedBlockRoot} != ${expectedBlockRoot}`)
  }

  const withdrawalPath = blockTypes.BeaconBlock.getPathInfo([
    'body',
    'executionPayload',
    'withdrawals',
    withdrawalNumber,
  ])
  const withdrawalProof = createProof(blockView.node, {
    type: ProofType.single,
    gindex: withdrawalPath.gindex,
  }) as SingleProof

  return {
    withdrawalGindex: withdrawalPath.gindex,
    withdrawalWitnesses: withdrawalProof.witnesses,
    withdrawal: withdrawals[withdrawalNumber] as WithdrawalValue,
  }
}

type WithdrawalFork =
  | ForkName.capella
  | ForkName.deneb
  | ForkName.electra
  | ForkName.fulu
  | ForkName.gloas

function isWithdrawalFork (fork: ForkName): fork is WithdrawalFork {
  return fork === ForkName.capella ||
    fork === ForkName.deneb ||
    fork === ForkName.electra ||
    fork === ForkName.fulu ||
    fork === ForkName.gloas
}

function parseNonNegativeInteger (name: string, value: string, program: Command): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    program.error(`Invalid ${name}: ${value}`)
  }
  return parsed
}
