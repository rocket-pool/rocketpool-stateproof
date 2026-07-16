import { Command } from 'commander'
import chalk from 'chalk'
import { constructBlockHeaderWithStateRoot, getStateWithFork } from '../common/beaconchain'
import { ForkName, SLOTS_PER_HISTORICAL_ROOT } from '@lodestar/params'
import { BeaconState, ssz, sszTypesFor } from '@lodestar/types'
import { createProof, ProofType, SingleProof, concatGindices } from '@chainsafe/persistent-merkle-tree'

interface ParticipationProofOpts {}

export async function generateParticipationProof(
  proofSlotStr: string,
  participationSlotStr: string,
  validatorIndexStr: string,
  _opts: ParticipationProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const participationSlot = parseNonNegativeInteger('participation slot', participationSlotStr, program)
  const validatorIndex = parseNonNegativeInteger('validator index', validatorIndexStr, program)

  if (participationSlot >= proofSlot) {
    program.error(`Participation slot ${participationSlot} must be earlier than proof slot ${proofSlot}`)
  }

  const slotDistance = proofSlot - participationSlot
  if (slotDistance > SLOTS_PER_HISTORICAL_ROOT) {
    program.error(
      `Participation slot ${participationSlot} is ${slotDistance} slots before proof slot ${proofSlot}; maximum is ${SLOTS_PER_HISTORICAL_ROOT}`
    )
  }

  const stateRootsIndex = participationSlot % SLOTS_PER_HISTORICAL_ROOT

  // Generate the proof from the proof-slot block header to the historical state root first. Keep only
  // the compact proof data so the full proof-slot state can be released before loading the participation state.
  const proofSlotData = await (async () => {
    const { fork, state: forkedState } = await getStateWithFork(allOpts.rpc, proofSlot)
    const state = forkedState as BeaconState<ForkName.fulu>
    console.log(`Generating proof rooted at slot ${state.slot}`)

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

    const stateRootsPath = stateType.getPathInfo(['stateRoots', stateRootsIndex])
    const stateRootsProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: stateRootsPath.gindex
    }) as SingleProof

    return {
      headerGindex: headerPath.gindex,
      headerWitnesses: headerProof.witnesses,
      stateRootsGindex: stateRootsPath.gindex,
      stateRootsWitnesses: stateRootsProof.witnesses,
      participationStateRoot: state.stateRoots[stateRootsIndex]
    }
  })()

  // Generate the proof from the participation-slot state root to the packed participation leaf.
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

    const participationPath = stateType.getPathInfo([
      'previousEpochParticipation',
      validatorIndex
    ])
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
  const provenParticipationStateRoot = Buffer.from(proofSlotData.participationStateRoot).toString('hex')
  if (computedParticipationStateRoot !== provenParticipationStateRoot) {
    console.error('Computed participation-slot state root does not match state root from proof slot! Proof will be invalid.')
    console.error(`${computedParticipationStateRoot} != ${provenParticipationStateRoot}`)
  }

  const combinedGindex = concatGindices([
    proofSlotData.headerGindex,
    proofSlotData.stateRootsGindex,
    participationSlotData.participationGindex
  ])
  const witnesses = [
    ...participationSlotData.participationWitnesses,
    ...proofSlotData.stateRootsWitnesses,
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
