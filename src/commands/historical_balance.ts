import { Command } from 'commander'
import chalk from 'chalk'
import { concatGindices, createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { ForkName } from '@lodestar/params'
import { BeaconState, ssz, sszTypesFor } from '@lodestar/types'
import { constructBlockHeaderWithStateRoot, getStateWithFork } from '../common/beaconchain'
import { getHistoricalProofContextFromStart } from '../common/history'

interface HistoricalBalanceProofOpts {
  historicalStart: string
}

export async function generateHistoricalBalanceProof (
  proofSlotStr: string,
  balanceSlotStr: string,
  validatorIndexStr: string,
  opts: HistoricalBalanceProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const balanceSlot = parseNonNegativeInteger('balance slot', balanceSlotStr, program)
  const validatorIndex = parseNonNegativeInteger('validator index', validatorIndexStr, program)
  const historicalStart = parseNonNegativeInteger('historical start', opts.historicalStart, program)

  if (balanceSlot >= proofSlot) {
    program.error(`Balance slot ${balanceSlot} must be earlier than proof slot ${proofSlot}`)
  }

  const { slotIndex: stateRootsIndex, historicalEntry, historicalSlot } =
    getHistoricalProofContextFromStart(balanceSlot, historicalStart)

  if (historicalEntry < 0) {
    program.error(
      `Balance slot ${balanceSlot} predates historical summary start period ${historicalStart}`
    )
  }
  if (proofSlot < historicalSlot) {
    program.error(
      `Proof slot ${proofSlot} is earlier than historical summary boundary ${historicalSlot} for balance slot ${balanceSlot}`
    )
  }

  const proofSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, proofSlot)
    const state = forkedState as BeaconState<ForkName.gloas>

    if (historicalEntry >= state.historicalSummaries.length) {
      program.error(
        `Historical summary entry ${historicalEntry} is not available at proof slot ${proofSlot}; state contains ${state.historicalSummaries.length} entries`
      )
    }

    console.log(`Generating historical balance proof rooted at slot ${state.slot} (${fork})`)
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
    const stateSummaryPath = ssz.capella.HistoricalSummary.getPathInfo(['stateSummaryRoot'])
    const stateSummaryProof = createProof(historicalSummaryView.node, {
      type: ProofType.single,
      gindex: stateSummaryPath.gindex,
    }) as SingleProof

    return {
      fork,
      headerGindex: headerPath.gindex,
      headerWitnesses: headerProof.witnesses,
      historicalSummariesGindex: historicalSummariesPath.gindex,
      historicalSummariesWitnesses: historicalSummariesProof.witnesses,
      stateSummaryGindex: stateSummaryPath.gindex,
      stateSummaryWitnesses: stateSummaryProof.witnesses,
      stateSummaryRoot: historicalSummary.stateSummaryRoot,
    }
  })()

  const historicalSlotData = await (async () => {
    const { fork, state } = await getStateWithFork(allOpts.rpc, historicalSlot)
    const stateRootsView = ssz.phase0.HistoricalStateRoots.toView(state.stateRoots)
    const stateRootsRoot = stateRootsView.hashTreeRoot()
    console.log(`Computed historical state roots root: ${Buffer.from(stateRootsRoot).toString('hex')}`)

    const stateRootsPath = ssz.phase0.HistoricalStateRoots.getPathInfo([stateRootsIndex])
    const stateRootsProof = createProof(stateRootsView.node, {
      type: ProofType.single,
      gindex: stateRootsPath.gindex,
    }) as SingleProof

    return {
      fork,
      stateRootsRoot,
      stateRootsGindex: stateRootsPath.gindex,
      stateRootsWitnesses: stateRootsProof.witnesses,
      balanceStateRoot: state.stateRoots[stateRootsIndex],
    }
  })()

  const computedStateSummaryRoot = Buffer.from(historicalSlotData.stateRootsRoot).toString('hex')
  const provenStateSummaryRoot = Buffer.from(proofSlotData.stateSummaryRoot).toString('hex')
  if (computedStateSummaryRoot !== provenStateSummaryRoot) {
    console.error('Computed historical state roots root does not match state_summary_root from proof slot! Proof will be invalid.')
    console.error(`${computedStateSummaryRoot} != ${provenStateSummaryRoot}`)
  }

  const balanceSlotData = await (async () => {
    const { fork, state } = await getStateWithFork(allOpts.rpc, balanceSlot)

    if (validatorIndex >= state.balances.length) {
      program.error(
        `Validator index ${validatorIndex} is outside balances length ${state.balances.length}`
      )
    }

    console.log(`Balance slot ${state.slot} uses fork ${fork}`)
    const stateTypes = sszTypesFor(fork)
    const stateView = stateTypes.BeaconState.toView(state as never)
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Computed balance-slot state root: ${Buffer.from(stateRoot).toString('hex')}`)

    const balancePath = stateTypes.BeaconState.getPathInfo(['balances', validatorIndex])
    const balanceProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: balancePath.gindex,
    }) as SingleProof

    return {
      fork,
      stateRoot,
      balanceGindex: balancePath.gindex,
      balanceWitnesses: balanceProof.witnesses,
      balanceChunk: balanceProof.leaf,
      balance: state.balances[validatorIndex],
    }
  })()

  const computedBalanceStateRoot = Buffer.from(balanceSlotData.stateRoot).toString('hex')
  const provenBalanceStateRoot = Buffer.from(historicalSlotData.balanceStateRoot).toString('hex')
  if (computedBalanceStateRoot !== provenBalanceStateRoot) {
    console.error('Computed balance-slot state root does not match historical state_roots entry! Proof will be invalid.')
    console.error(`${computedBalanceStateRoot} != ${provenBalanceStateRoot}`)
  }

  const combinedGindex = concatGindices([
    proofSlotData.headerGindex,
    proofSlotData.historicalSummariesGindex,
    proofSlotData.stateSummaryGindex,
    historicalSlotData.stateRootsGindex,
    balanceSlotData.balanceGindex,
  ])
  const witnesses = [
    ...balanceSlotData.balanceWitnesses,
    ...historicalSlotData.stateRootsWitnesses,
    ...proofSlotData.stateSummaryWitnesses,
    ...proofSlotData.historicalSummariesWitnesses,
    ...proofSlotData.headerWitnesses,
  ]
  const balanceChunk = `0x${Buffer.from(balanceSlotData.balanceChunk).toString('hex')}`
  const balanceChunkIndex = Math.floor(validatorIndex / 4)
  const balanceByteOffset = (validatorIndex % 4) * 8

  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Proof Slot: ${proofSlot}`)
  console.log(`Proof Fork: ${proofSlotData.fork}`)
  console.log(`Balance Slot: ${balanceSlot}`)
  console.log(`Balance Fork: ${balanceSlotData.fork}`)
  console.log(`Historical Roots Slot: ${historicalSlot}`)
  console.log(`Historical Roots Fork: ${historicalSlotData.fork}`)
  console.log(`Historical Start Period: ${historicalStart}`)
  console.log(`Historical Summary Entry: ${historicalEntry}`)
  console.log(`StateRoots Index: ${stateRootsIndex}`)
  console.log(`Validator Index: ${validatorIndex}`)
  console.log(`Balance (gwei): ${balanceSlotData.balance.toString(10)}`)
  console.log(`Balance Chunk Index: ${balanceChunkIndex}`)
  console.log(`Balance Byte Offset: ${balanceByteOffset}`)
  console.log(`Balance Chunk: ${balanceChunk}`)
  console.log()
  console.log(`Gindex: 0b${combinedGindex.toString(2)}`)
  console.log(`Gindex: ${combinedGindex.toString(10)}`)
  console.log()
  console.log(`Witnesses (${witnesses.length}):`)
  console.log('[')
  console.log(witnesses.map(witness => `"0x${Buffer.from(witness).toString('hex')}"`).join(',\n'))
  console.log(']')
  console.log()

  const output = {
    slot: proofSlot,
    balanceSlot,
    historicalSlot,
    historicalEntry,
    historicalStart,
    stateRootsIndex,
    validatorIndex,
    balance: Number(balanceSlotData.balance),
    balanceChunk,
    balanceChunkIndex,
    balanceByteOffset,
    gindex: combinedGindex.toString(10),
    witnesses: witnesses.map(witness => `0x${Buffer.from(witness).toString('hex')}`),
  }

  console.log(JSON.stringify(output, null, 2))
}

function parseNonNegativeInteger (name: string, value: string, program: Command): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    program.error(`Invalid ${name}: ${value}`)
  }
  return parsed
}
