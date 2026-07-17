import { Command } from 'commander'
import chalk from 'chalk'
import { createProof, ProofType, SingleProof, concatGindices } from '@chainsafe/persistent-merkle-tree'
import { ForkName } from '@lodestar/params'
import { BeaconState, ssz, sszTypesFor } from '@lodestar/types'
import { constructBlockHeaderWithStateRoot, getStateWithFork } from '../common/beaconchain'
import { getHistoricalProofContext, isHistoricalNetwork } from '../common/history'

interface HistoricalParticipationProofOpts {
  network: string
}

export async function generateHistoricalParticipationProof(
  proofSlotStr: string,
  participationSlotStr: string,
  validatorIndexStr: string,
  opts: HistoricalParticipationProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const participationSlot = parseNonNegativeInteger('participation slot', participationSlotStr, program)
  const validatorIndex = parseNonNegativeInteger('validator index', validatorIndexStr, program)

  if (!isHistoricalNetwork(opts.network)) {
    program.error(`Unknown network "${opts.network}"`)
  }

  const network = opts.network
  const { slotIndex: stateRootsIndex, historicalEntry, historicalSlot } = getHistoricalProofContext(
    participationSlot,
    network
  )

  if (historicalEntry < 0) {
    program.error(`Participation slot ${participationSlot} predates historical summaries on ${network}`)
  }
  if (proofSlot < historicalSlot) {
    program.error(
      `Proof slot ${proofSlot} is earlier than historical summary boundary ${historicalSlot} for participation slot ${participationSlot}`
    )
  }

  // Prove the historical summary from the proof-slot block root, then retain only its state summary root
  // and compact proof data before loading another full state.
  const proofSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, proofSlot)
    const state = forkedState as BeaconState<ForkName.fulu>

    if (historicalEntry >= state.historicalSummaries.length) {
      program.error(
        `Historical summary entry ${historicalEntry} is not available at proof slot ${proofSlot}; state contains ${state.historicalSummaries.length} entries`
      )
    }

    console.log(`Generating historical participation proof rooted at slot ${state.slot} on ${network}`)
    const stateType = sszTypesFor(fork).BeaconState as typeof ssz.fulu.BeaconState
    const stateView = stateType.toView(state)

    console.log(chalk.blue('Computing proof-slot state root...'))
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Proof-slot state root: ${Buffer.from(stateRoot).toString('hex')}`)

    const blockHeader = constructBlockHeaderWithStateRoot(state.latestBlockHeader, stateRoot)
    const blockHeaderView = ssz.electra.BeaconBlockHeader.toView(blockHeader)

    console.log(chalk.blue('Computing proof-slot block root...'))
    const blockRoot = blockHeaderView.hashTreeRoot()
    console.log(`Proof-slot block root: ${Buffer.from(blockRoot).toString('hex')}`)

    const headerPath = ssz.electra.BeaconBlockHeader.getPathInfo(['state_root'])
    const headerProof = createProof(blockHeaderView.node, {
      type: ProofType.single,
      gindex: headerPath.gindex
    }) as SingleProof

    const historicalSummariesPath = stateType.getPathInfo(['historicalSummaries', historicalEntry])
    const historicalSummariesProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: historicalSummariesPath.gindex
    }) as SingleProof

    const historicalSummary = state.historicalSummaries[historicalEntry]
    const historicalSummaryView = ssz.capella.HistoricalSummary.toView(historicalSummary)
    const stateSummaryPath = ssz.capella.HistoricalSummary.getPathInfo(['stateSummaryRoot'])
    const stateSummaryProof = createProof(historicalSummaryView.node, {
      type: ProofType.single,
      gindex: stateSummaryPath.gindex
    }) as SingleProof

    return {
      headerGindex: headerPath.gindex,
      headerWitnesses: headerProof.witnesses,
      historicalSummariesGindex: historicalSummariesPath.gindex,
      historicalSummariesWitnesses: historicalSummariesProof.witnesses,
      stateSummaryGindex: stateSummaryPath.gindex,
      stateSummaryWitnesses: stateSummaryProof.witnesses,
      stateSummaryRoot: historicalSummary.stateSummaryRoot
    }
  })()

  // Prove the participation state root from the completed state_roots vector summarized above.
  const historicalSlotData = await (async () => {
    const { state: forkedState } = await getStateWithFork(allOpts.rpc, historicalSlot)
    const state = forkedState as BeaconState<ForkName.fulu>
    const stateRootsView = ssz.phase0.HistoricalStateRoots.toView(state.stateRoots)
    const stateRootsRoot = stateRootsView.hashTreeRoot()
    console.log(`Computed historical state roots root: ${Buffer.from(stateRootsRoot).toString('hex')}`)

    const stateRootsPath = ssz.phase0.HistoricalStateRoots.getPathInfo([stateRootsIndex])
    const stateRootsProof = createProof(stateRootsView.node, {
      type: ProofType.single,
      gindex: stateRootsPath.gindex
    }) as SingleProof

    return {
      stateRootsRoot,
      stateRootsGindex: stateRootsPath.gindex,
      stateRootsWitnesses: stateRootsProof.witnesses,
      participationStateRoot: state.stateRoots[stateRootsIndex]
    }
  })()

  const computedStateSummaryRoot = Buffer.from(historicalSlotData.stateRootsRoot).toString('hex')
  const provenStateSummaryRoot = Buffer.from(proofSlotData.stateSummaryRoot).toString('hex')
  if (computedStateSummaryRoot !== provenStateSummaryRoot) {
    console.error('Computed historical state roots root does not match state_summary_root from proof slot! Proof will be invalid.')
    console.error(`${computedStateSummaryRoot} != ${provenStateSummaryRoot}`)
  }

  // Prove the validator's packed participation byte from the participation-slot state.
  const participationSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, participationSlot)
    const state = forkedState as BeaconState<ForkName.fulu>

    if (validatorIndex >= state.previousEpochParticipation.length) {
      program.error(
        `Validator index ${validatorIndex} is outside previous_epoch_participation length ${state.previousEpochParticipation.length}`
      )
    }

    console.log(chalk.blue('Computing participation-slot state root...'))
    const stateType = sszTypesFor(fork).BeaconState as typeof ssz.fulu.BeaconState
    const stateView = stateType.toView(state)
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Participation-slot state root: ${Buffer.from(stateRoot).toString('hex')}`)

    const participationPath = stateType.getPathInfo(['previousEpochParticipation', validatorIndex])
    const participationProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: participationPath.gindex
    }) as SingleProof

    return {
      stateRoot,
      participationGindex: participationPath.gindex,
      participationWitnesses: participationProof.witnesses,
      participationChunk: participationProof.leaf,
      previousEpochParticipation: state.previousEpochParticipation[validatorIndex]
    }
  })()

  const computedParticipationStateRoot = Buffer.from(participationSlotData.stateRoot).toString('hex')
  const provenParticipationStateRoot = Buffer.from(historicalSlotData.participationStateRoot).toString('hex')
  if (computedParticipationStateRoot !== provenParticipationStateRoot) {
    console.error('Computed participation-slot state root does not match historical state_roots entry! Proof will be invalid.')
    console.error(`${computedParticipationStateRoot} != ${provenParticipationStateRoot}`)
  }

  const combinedGindex = concatGindices([
    proofSlotData.headerGindex,
    proofSlotData.historicalSummariesGindex,
    proofSlotData.stateSummaryGindex,
    historicalSlotData.stateRootsGindex,
    participationSlotData.participationGindex
  ])
  const witnesses = [
    ...participationSlotData.participationWitnesses,
    ...historicalSlotData.stateRootsWitnesses,
    ...proofSlotData.stateSummaryWitnesses,
    ...proofSlotData.historicalSummariesWitnesses,
    ...proofSlotData.headerWitnesses
  ]
  const participationChunk = Buffer.from(participationSlotData.participationChunk).toString('hex')
  const participationChunkIndex = Math.floor(validatorIndex / 32)
  const participationByteOffset = validatorIndex % 32

  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Proof Slot: ${proofSlot}`)
  console.log(`Participation Slot: ${participationSlot}`)
  console.log(`Historical State Roots Slot: ${historicalSlot}`)
  console.log(`Historical Summary Entry: ${historicalEntry}`)
  console.log(`StateRoots Index: ${stateRootsIndex}`)
  console.log(`Validator Index: ${validatorIndex}`)
  console.log(`Previous Epoch Participation: ${participationSlotData.previousEpochParticipation}`)
  console.log(`Participation Chunk Index: ${participationChunkIndex}`)
  console.log(`Participation Byte Offset: ${participationByteOffset}`)
  console.log(`Participation Chunk: 0x${participationChunk}`)
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
    participationSlot,
    historicalSlot,
    historicalEntry,
    stateRootsIndex,
    validatorIndex,
    previousEpochParticipation: participationSlotData.previousEpochParticipation,
    participationChunk: `0x${participationChunk}`,
    participationChunkIndex,
    participationByteOffset,
    gindex: combinedGindex.toString(10),
    witnesses: witnesses.map(witness => `0x${Buffer.from(witness).toString('hex')}`)
  }

  console.log(JSON.stringify(output, null, 2))
}

function parseNonNegativeInteger(name: string, value: string, program: Command): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    program.error(`Invalid ${name}: ${value}`)
  }
  return parsed
}
