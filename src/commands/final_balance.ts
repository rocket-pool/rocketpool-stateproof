import { Command } from 'commander'
import chalk from 'chalk'
import { concatGindices, createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import {
  ForkName,
  isForkWithdrawals,
  SLOTS_PER_EPOCH,
  SLOTS_PER_HISTORICAL_ROOT,
} from '@lodestar/params'
import { BeaconState, ssz, sszTypesFor } from '@lodestar/types'
import { constructBlockHeaderWithStateRoot, getStateWithFork } from '../common/beaconchain'
import { getHistoricalProofContextFromStart } from '../common/history'

interface FinalBalanceProofOpts {
  historicalStart: string
}

interface PastStateRoute {
  targetSlot: number
  mode: 'direct' | 'historical'
  stateRootsIndex: number
  gindices: bigint[]
  witnesses: Uint8Array[]
  historicalSlot?: number
  historicalEntry?: number
  stateSummaryRoot?: Uint8Array
  historicalFork?: ForkName
}

interface CombinedProof {
  gindex: bigint
  witnesses: Uint8Array[]
}

export async function generateFinalBalanceProof (
  proofSlotStr: string,
  withdrawalSlotStr: string,
  validatorIndexStr: string,
  opts: FinalBalanceProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const withdrawalSlot = parseNonNegativeInteger('withdrawal slot', withdrawalSlotStr, program)
  const validatorIndex = parseNonNegativeInteger('validator index', validatorIndexStr, program)
  const historicalStart = parseNonNegativeInteger('historical start', opts.historicalStart, program)

  if (validatorIndex > 2 ** 40 - 1) {
    program.error(`Validator index ${validatorIndex} exceeds the uint40 proof limit`)
  }
  if (withdrawalSlot === 0) {
    program.error('Withdrawal slot must be greater than zero')
  }
  if (withdrawalSlot >= proofSlot) {
    program.error(`Withdrawal slot ${withdrawalSlot} must be earlier than proof slot ${proofSlot}`)
  }

  const withdrawalSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, withdrawalSlot)
    if (fork !== ForkName.gloas) {
      program.error(`Final balance proof version 2 requires a Gloas withdrawal slot; slot ${withdrawalSlot} uses fork ${fork}`)
    }

    const state = forkedState as BeaconState<ForkName.gloas>
    if (state.slot !== withdrawalSlot) {
      program.error(`Requested withdrawal slot ${withdrawalSlot}, received state at slot ${state.slot}`)
    }
    if (validatorIndex >= state.balances.length) {
      program.error(`Validator index ${validatorIndex} is outside balances length ${state.balances.length}`)
    }
    if (state.balances[validatorIndex] !== 0) {
      program.error(
        `Validator ${validatorIndex} balance is ${state.balances[validatorIndex]} gwei at withdrawal slot ${withdrawalSlot}; expected zero`
      )
    }

    const matchingWithdrawalNumbers: number[] = []
    for (let i = 0; i < state.payloadExpectedWithdrawals.length; i++) {
      if (BigInt(state.payloadExpectedWithdrawals[i].validatorIndex) === BigInt(validatorIndex)) {
        matchingWithdrawalNumbers.push(i)
      }
    }
    if (matchingWithdrawalNumbers.length === 0) {
      program.error(
        `No payload_expected_withdrawals entry for validator ${validatorIndex} at slot ${withdrawalSlot}`
      )
    }
    if (matchingWithdrawalNumbers.length > 1) {
      program.error(
        `Multiple payload_expected_withdrawals entries for validator ${validatorIndex} at slot ${withdrawalSlot}`
      )
    }

    const withdrawalNum = matchingWithdrawalNumbers[0]
    if (withdrawalNum > 0xffff) {
      program.error(`Withdrawal number ${withdrawalNum} exceeds the uint16 proof limit`)
    }

    console.log(`Withdrawal slot ${state.slot} uses fork ${fork}`)
    const stateTypes = sszTypesFor(fork)
    const stateView = stateTypes.BeaconState.toView(state as never)
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Withdrawal state root: ${toHex(stateRoot)}`)

    const withdrawalPath = stateTypes.BeaconState.getPathInfo([
      'payloadExpectedWithdrawals',
      withdrawalNum,
    ])
    const withdrawalProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: withdrawalPath.gindex,
    }) as SingleProof

    const balancePath = stateTypes.BeaconState.getPathInfo(['balances', validatorIndex])
    const balanceProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: balancePath.gindex,
    }) as SingleProof

    return {
      fork,
      stateRoot,
      withdrawalNum,
      withdrawal: state.payloadExpectedWithdrawals[withdrawalNum],
      withdrawalGindex: withdrawalPath.gindex,
      withdrawalWitnesses: withdrawalProof.witnesses,
      balanceGindex: balancePath.gindex,
      balanceWitnesses: balanceProof.witnesses,
      balanceChunk: balanceProof.leaf,
    }
  })()

  const previousSlot = withdrawalSlot - 1
  const previousSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, previousSlot)
    if (!isForkWithdrawals(fork)) {
      program.error(`BeaconState.next_withdrawal_index is not supported for fork ${fork}`)
    }

    const state = forkedState as BeaconState<ForkName.capella>
    if (state.slot !== previousSlot) {
      program.error(`Requested preceding slot ${previousSlot}, received state at slot ${state.slot}`)
    }

    console.log(`Preceding slot ${state.slot} uses fork ${fork}`)
    const stateTypes = sszTypesFor(fork)
    const stateView = stateTypes.BeaconState.toView(state as never)
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Preceding state root: ${toHex(stateRoot)}`)

    const nextWithdrawalIndexPath = stateTypes.BeaconState.getPathInfo([
      'nextWithdrawalIndex',
    ])
    const nextWithdrawalIndexProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: nextWithdrawalIndexPath.gindex,
    }) as SingleProof

    return {
      fork,
      stateRoot,
      nextWithdrawalIndex: state.nextWithdrawalIndex,
      nextWithdrawalIndexGindex: nextWithdrawalIndexPath.gindex,
      nextWithdrawalIndexWitnesses: nextWithdrawalIndexProof.witnesses,
    }
  })()

  const proofSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, proofSlot)
    if (fork !== ForkName.gloas) {
      program.error(`Proof slot ${proofSlot} must use the Gloas fork; received ${fork}`)
    }

    const state = forkedState as BeaconState<ForkName.gloas>
    if (state.slot !== proofSlot) {
      program.error(`Requested proof slot ${proofSlot}, received state at slot ${state.slot}`)
    }
    if (validatorIndex >= state.validators.length) {
      program.error(`Validator index ${validatorIndex} is outside validators length ${state.validators.length}`)
    }

    console.log(`Generating final balance proof rooted at slot ${state.slot} (${fork})`)
    const stateTypes = sszTypesFor(fork)
    const stateView = stateTypes.BeaconState.toView(state as never)

    console.log(chalk.blue('Computing proof-slot state root...'))
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Proof-slot state root: ${toHex(stateRoot)}`)

    const blockHeader = constructBlockHeaderWithStateRoot(state.latestBlockHeader, stateRoot)
    const blockHeaderView = stateTypes.BeaconBlockHeader.toView(blockHeader)
    const blockRoot = blockHeaderView.hashTreeRoot()
    console.log(`Proof-slot block root: ${toHex(blockRoot)}`)

    const headerPath = stateTypes.BeaconBlockHeader.getPathInfo(['stateRoot'])
    const headerProof = createProof(blockHeaderView.node, {
      type: ProofType.single,
      gindex: headerPath.gindex,
    }) as SingleProof

    const slotPath = stateTypes.BeaconState.getPathInfo(['slot'])
    const slotProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: slotPath.gindex,
    }) as SingleProof

    const validatorPath = stateTypes.BeaconState.getPathInfo(['validators', validatorIndex])
    const validatorProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: validatorPath.gindex,
    }) as SingleProof

    const validator = state.validators[validatorIndex]

    const buildPastStateRoute = (targetSlot: number, targetStateRoot: Uint8Array): PastStateRoute => {
      const stateRootsIndex = targetSlot % SLOTS_PER_HISTORICAL_ROOT
      if (targetSlot + SLOTS_PER_HISTORICAL_ROOT >= proofSlot) {
        const stateRootsPath = stateTypes.BeaconState.getPathInfo([
          'stateRoots',
          stateRootsIndex,
        ])
        const stateRootsProof = createProof(stateView.node, {
          type: ProofType.single,
          gindex: stateRootsPath.gindex,
        }) as SingleProof

        requireMatchingRoot(
          `State root for target slot ${targetSlot}`,
          targetStateRoot,
          state.stateRoots[stateRootsIndex],
          program
        )

        return {
          targetSlot,
          mode: 'direct',
          stateRootsIndex,
          gindices: [stateRootsPath.gindex],
          witnesses: [...stateRootsProof.witnesses],
        }
      }

      const { historicalEntry, historicalSlot } = getHistoricalProofContextFromStart(
        targetSlot,
        historicalStart
      )
      if (historicalEntry < 0) {
        program.error(
          `Target slot ${targetSlot} predates historical summary start period ${historicalStart}`
        )
      }
      if (historicalEntry >= state.historicalSummaries.length) {
        program.error(
          `Historical summary entry ${historicalEntry} for target slot ${targetSlot} is not available at proof slot ${proofSlot}`
        )
      }

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
      const stateSummaryPath = ssz.capella.HistoricalSummary.getPathInfo(['stateSummaryRoot'])
      const stateSummaryProof = createProof(historicalSummaryView.node, {
        type: ProofType.single,
        gindex: stateSummaryPath.gindex,
      }) as SingleProof

      return {
        targetSlot,
        mode: 'historical',
        stateRootsIndex,
        historicalSlot,
        historicalEntry,
        stateSummaryRoot: historicalSummary.stateSummaryRoot,
        gindices: [historicalSummariesPath.gindex, stateSummaryPath.gindex],
        witnesses: [
          ...stateSummaryProof.witnesses,
          ...historicalSummariesProof.witnesses,
        ],
      }
    }

    return {
      fork,
      blockRoot,
      headerGindex: headerPath.gindex,
      headerWitnesses: headerProof.witnesses,
      slot: state.slot,
      slotGindex: slotPath.gindex,
      slotWitnesses: slotProof.witnesses,
      validator,
      validatorGindex: validatorPath.gindex,
      validatorWitnesses: validatorProof.witnesses,
      withdrawalRoute: buildPastStateRoute(withdrawalSlot, withdrawalSlotData.stateRoot),
      previousRoute: buildPastStateRoute(previousSlot, previousSlotData.stateRoot),
    }
  })()

  const routes = [proofSlotData.withdrawalRoute, proofSlotData.previousRoute]
  const historicalSlots = [
    ...new Set(
      routes
        .filter(route => route.mode === 'historical')
        .map(route => route.historicalSlot as number)
    ),
  ]
  const targetStateRoots = new Map<number, Uint8Array>([
    [withdrawalSlot, withdrawalSlotData.stateRoot],
    [previousSlot, previousSlotData.stateRoot],
  ])

  for (const historicalSlot of historicalSlots) {
    const { fork, state } = await getStateWithFork(allOpts.rpc, historicalSlot)
    const stateRootsView = ssz.phase0.HistoricalStateRoots.toView(state.stateRoots)
    const stateRootsRoot = stateRootsView.hashTreeRoot()

    for (const route of routes.filter(item => item.historicalSlot === historicalSlot)) {
      requireMatchingRoot(
        `Historical state_summary_root for target slot ${route.targetSlot}`,
        stateRootsRoot,
        route.stateSummaryRoot as Uint8Array,
        program
      )

      const stateRootsPath = ssz.phase0.HistoricalStateRoots.getPathInfo([
        route.stateRootsIndex,
      ])
      const stateRootsProof = createProof(stateRootsView.node, {
        type: ProofType.single,
        gindex: stateRootsPath.gindex,
      }) as SingleProof

      requireMatchingRoot(
        `State root for target slot ${route.targetSlot}`,
        targetStateRoots.get(route.targetSlot) as Uint8Array,
        state.stateRoots[route.stateRootsIndex],
        program
      )

      route.gindices.push(stateRootsPath.gindex)
      route.witnesses.unshift(...stateRootsProof.witnesses)
      route.historicalFork = fork
    }
  }

  const withdrawalCombinedProof = combineProof(
    proofSlotData.headerGindex,
    proofSlotData.headerWitnesses,
    proofSlotData.withdrawalRoute,
    withdrawalSlotData.withdrawalGindex,
    withdrawalSlotData.withdrawalWitnesses
  )
  const balanceCombinedProof = combineProof(
    proofSlotData.headerGindex,
    proofSlotData.headerWitnesses,
    proofSlotData.withdrawalRoute,
    withdrawalSlotData.balanceGindex,
    withdrawalSlotData.balanceWitnesses
  )
  const nextWithdrawalIndexCombinedProof = combineProof(
    proofSlotData.headerGindex,
    proofSlotData.headerWitnesses,
    proofSlotData.previousRoute,
    previousSlotData.nextWithdrawalIndexGindex,
    previousSlotData.nextWithdrawalIndexWitnesses
  )
  const slotCombinedProof = combineDirectProof(
    proofSlotData.headerGindex,
    proofSlotData.headerWitnesses,
    proofSlotData.slotGindex,
    proofSlotData.slotWitnesses
  )
  const validatorCombinedProof = combineDirectProof(
    proofSlotData.headerGindex,
    proofSlotData.headerWitnesses,
    proofSlotData.validatorGindex,
    proofSlotData.validatorWitnesses
  )

  const withdrawal = withdrawalSlotData.withdrawal
  const validator = proofSlotData.validator
  if (BigInt(withdrawal.validatorIndex) !== BigInt(validatorIndex)) {
    program.error(`Withdrawal validator index ${withdrawal.validatorIndex} does not match ${validatorIndex}`)
  }
  if (
    BigInt(withdrawal.index) !==
    BigInt(previousSlotData.nextWithdrawalIndex) + BigInt(withdrawalSlotData.withdrawalNum)
  ) {
    program.error(
      `Expected withdrawal index ${withdrawal.index} is stale relative to preceding next_withdrawal_index ${previousSlotData.nextWithdrawalIndex} and withdrawal number ${withdrawalSlotData.withdrawalNum}`
    )
  }

  const withdrawalEpoch = BigInt(Math.floor(withdrawalSlot / SLOTS_PER_EPOCH))
  if (withdrawalEpoch < BigInt(validator.withdrawableEpoch)) {
    program.error(
      `Withdrawal epoch ${withdrawalEpoch} is earlier than validator withdrawable epoch ${validator.withdrawableEpoch}`
    )
  }

  console.log()
  console.log(chalk.green('Final balance proof generation complete'))
  printProofSummary('Slot', slotCombinedProof)
  printProofSummary('Validator', validatorCombinedProof)
  printProofSummary(
    `Expected withdrawal (${proofSlotData.withdrawalRoute.mode})`,
    withdrawalCombinedProof
  )
  printProofSummary(
    `Validator balance (${proofSlotData.withdrawalRoute.mode})`,
    balanceCombinedProof
  )
  printProofSummary(
    `Previous next withdrawal index (${proofSlotData.previousRoute.mode})`,
    nextWithdrawalIndexCombinedProof
  )
  console.log()

  const output = {
    withdrawalProof: {
      withdrawalSlot,
      withdrawalNum: withdrawalSlotData.withdrawalNum,
      withdrawal: {
        index: Number(withdrawal.index),
        validatorIndex: Number(withdrawal.validatorIndex),
        withdrawalCredentials: `0x${Buffer.from(withdrawal.address).toString('hex')}`,
        amountInGwei: Number(withdrawal.amount),
      },
      witnesses: toHexWitnesses(withdrawalCombinedProof.witnesses),
    },
    validatorProof: {
      validatorIndex,
      validator: {
        pubkey: `0x${Buffer.from(validator.pubkey).toString('hex')}`,
        withdrawalCredentials: `0x${Buffer.from(validator.withdrawalCredentials).toString('hex')}`,
        effectiveBalance: Number(validator.effectiveBalance),
        slashed: validator.slashed,
        activationEligibilityEpoch: Number(validator.activationEligibilityEpoch),
        activationEpoch: Number(validator.activationEpoch),
        exitEpoch: Number(validator.exitEpoch),
        withdrawableEpoch: Number(validator.withdrawableEpoch),
      },
      witnesses: toHexWitnesses(validatorCombinedProof.witnesses),
    },
    slotProof: {
      slot: proofSlotData.slot,
      witnesses: toHexWitnesses(slotCombinedProof.witnesses),
    },
    previousNextWithdrawalIndexProof: {
      nextWithdrawalIndex: Number(previousSlotData.nextWithdrawalIndex),
      witnesses: toHexWitnesses(nextWithdrawalIndexCombinedProof.witnesses),
    },
    validatorBalanceProof: {
      balanceChunk: `0x${Buffer.from(withdrawalSlotData.balanceChunk).toString('hex')}`,
      witnesses: toHexWitnesses(balanceCombinedProof.witnesses),
    },
  }

  console.log(JSON.stringify(output, null, 2))
}

function combineProof (
  headerGindex: bigint,
  headerWitnesses: Uint8Array[],
  route: PastStateRoute,
  leafGindex: bigint,
  leafWitnesses: Uint8Array[]
): CombinedProof {
  return {
    gindex: concatGindices([headerGindex, ...route.gindices, leafGindex]),
    witnesses: [...leafWitnesses, ...route.witnesses, ...headerWitnesses],
  }
}

function combineDirectProof (
  headerGindex: bigint,
  headerWitnesses: Uint8Array[],
  leafGindex: bigint,
  leafWitnesses: Uint8Array[]
): CombinedProof {
  return {
    gindex: concatGindices([headerGindex, leafGindex]),
    witnesses: [...leafWitnesses, ...headerWitnesses],
  }
}

function requireMatchingRoot (
  label: string,
  computed: Uint8Array,
  proven: Uint8Array,
  program: Command
) {
  const computedHex = toHex(computed)
  const provenHex = toHex(proven)
  if (computedHex !== provenHex) {
    program.error(`${label} mismatch: ${computedHex} != ${provenHex}`)
  }
}

function printProofSummary (label: string, proof: CombinedProof) {
  console.log(`${label} Gindex: 0b${proof.gindex.toString(2)}`)
  console.log(`${label} Witnesses: ${proof.witnesses.length}`)
}

function toHex (value: Uint8Array): string {
  return `0x${Buffer.from(value).toString('hex')}`
}

function toHexWitnesses (witnesses: Uint8Array[]): string[] {
  return witnesses.map(toHex)
}

function parseNonNegativeInteger (name: string, value: string, program: Command): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    program.error(`Invalid ${name}: ${value}`)
  }
  return parsed
}
