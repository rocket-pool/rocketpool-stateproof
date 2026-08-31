import { Command } from 'commander'
import chalk from 'chalk'
import { concatGindices, createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { SLOTS_PER_HISTORICAL_ROOT } from '@lodestar/params'
import { sszTypesFor } from '@lodestar/types'
import { constructBlockHeaderWithStateRoot, getStateWithFork } from '../common/beaconchain'

interface BalanceProofOpts {}

export async function generateBalanceProof (
  proofSlotStr: string,
  balanceSlotStr: string,
  validatorIndexStr: string,
  _opts: BalanceProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const balanceSlot = parseNonNegativeInteger('balance slot', balanceSlotStr, program)
  const validatorIndex = parseNonNegativeInteger('validator index', validatorIndexStr, program)

  if (balanceSlot >= proofSlot) {
    program.error(`Balance slot ${balanceSlot} must be earlier than proof slot ${proofSlot}`)
  }

  const slotDistance = proofSlot - balanceSlot
  if (slotDistance > SLOTS_PER_HISTORICAL_ROOT) {
    program.error(
      `Balance slot ${balanceSlot} is ${slotDistance} slots before proof slot ${proofSlot}; maximum is ${SLOTS_PER_HISTORICAL_ROOT}`
    )
  }

  const stateRootsIndex = balanceSlot % SLOTS_PER_HISTORICAL_ROOT

  const proofSlotData = await (async () => {
    const { fork, state } = await getStateWithFork(allOpts.rpc, proofSlot)
    console.log(`Generating balance proof rooted at slot ${state.slot} (${fork})`)

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

    const stateRootsPath = stateTypes.BeaconState.getPathInfo(['stateRoots', stateRootsIndex])
    const stateRootsProof = createProof(stateView.node, {
      type: ProofType.single,
      gindex: stateRootsPath.gindex,
    }) as SingleProof

    return {
      fork,
      headerGindex: headerPath.gindex,
      headerWitnesses: headerProof.witnesses,
      stateRootsGindex: stateRootsPath.gindex,
      stateRootsWitnesses: stateRootsProof.witnesses,
      balanceStateRoot: state.stateRoots[stateRootsIndex],
    }
  })()

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

    console.log(chalk.blue('Computing balance-slot state root...'))
    const stateRoot = stateView.hashTreeRoot()
    console.log(`Balance-slot state root: ${Buffer.from(stateRoot).toString('hex')}`)

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
  const provenBalanceStateRoot = Buffer.from(proofSlotData.balanceStateRoot).toString('hex')
  if (computedBalanceStateRoot !== provenBalanceStateRoot) {
    console.error('Computed balance-slot state root does not match state root from proof slot! Proof will be invalid.')
    console.error(`${computedBalanceStateRoot} != ${provenBalanceStateRoot}`)
  }

  const combinedGindex = concatGindices([
    proofSlotData.headerGindex,
    proofSlotData.stateRootsGindex,
    balanceSlotData.balanceGindex,
  ])
  const witnesses = [
    ...balanceSlotData.balanceWitnesses,
    ...proofSlotData.stateRootsWitnesses,
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
