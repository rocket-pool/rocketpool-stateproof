import { Command } from 'commander'
import chalk from 'chalk'
import { concatGindices, createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { ForkName, isForkWithdrawals, SLOTS_PER_HISTORICAL_ROOT } from '@lodestar/params'
import { BeaconState, sszTypesFor } from '@lodestar/types'
import { constructBlockHeaderWithStateRoot, getStateWithFork } from '../common/beaconchain'

interface NextWithdrawalIndexProofOpts {}

export async function generateNextWithdrawalIndexProof (
  proofSlotStr: string,
  withdrawalIndexSlotStr: string,
  _opts: NextWithdrawalIndexProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const withdrawalIndexSlot = parseNonNegativeInteger(
    'withdrawal index slot',
    withdrawalIndexSlotStr,
    program
  )

  if (withdrawalIndexSlot >= proofSlot) {
    program.error(
      `Withdrawal index slot ${withdrawalIndexSlot} must be earlier than proof slot ${proofSlot}`
    )
  }

  const slotDistance = proofSlot - withdrawalIndexSlot
  if (slotDistance > SLOTS_PER_HISTORICAL_ROOT) {
    program.error(
      `Withdrawal index slot ${withdrawalIndexSlot} is ${slotDistance} slots before proof slot ${proofSlot}; maximum is ${SLOTS_PER_HISTORICAL_ROOT}`
    )
  }

  const [
    { fork: proofFork, state: proofState },
    { fork: withdrawalIndexFork, state: forkedWithdrawalIndexState },
  ] = await Promise.all([
    getStateWithFork(allOpts.rpc, proofSlot),
    getStateWithFork(allOpts.rpc, withdrawalIndexSlot),
  ])

  if (!isForkWithdrawals(withdrawalIndexFork)) {
    program.error(
      `BeaconState.next_withdrawal_index is not supported for fork ${withdrawalIndexFork}`
    )
  }

  const withdrawalIndexState = forkedWithdrawalIndexState as BeaconState<ForkName.capella>
  const stateRootsIndex = withdrawalIndexSlot % SLOTS_PER_HISTORICAL_ROOT

  console.log(`Generating next withdrawal index proof rooted at slot ${proofState.slot} (${proofFork})`)
  console.log(
    `Withdrawal index slot ${withdrawalIndexState.slot} uses fork ${withdrawalIndexFork}`
  )

  const proofTypes = sszTypesFor(proofFork)
  const proofStateView = proofTypes.BeaconState.toView(proofState as never)

  console.log(chalk.blue('Computing proof-slot state root...'))
  const proofStateRoot = proofStateView.hashTreeRoot()
  console.log(`Proof-slot state root: ${Buffer.from(proofStateRoot).toString('hex')}`)

  const blockHeader = constructBlockHeaderWithStateRoot(
    proofState.latestBlockHeader,
    proofStateRoot
  )
  const blockHeaderView = proofTypes.BeaconBlockHeader.toView(blockHeader)

  console.log(chalk.blue('Computing proof-slot block root...'))
  const blockRoot = blockHeaderView.hashTreeRoot()
  console.log(`Proof-slot block root: ${Buffer.from(blockRoot).toString('hex')}`)

  const headerPath = proofTypes.BeaconBlockHeader.getPathInfo(['stateRoot'])
  const headerProof = createProof(blockHeaderView.node, {
    type: ProofType.single,
    gindex: headerPath.gindex,
  }) as SingleProof

  const stateRootsPath = proofTypes.BeaconState.getPathInfo([
    'stateRoots',
    stateRootsIndex,
  ])
  const stateRootsProof = createProof(proofStateView.node, {
    type: ProofType.single,
    gindex: stateRootsPath.gindex,
  }) as SingleProof

  const withdrawalIndexTypes = sszTypesFor(withdrawalIndexFork)
  const withdrawalIndexStateView = withdrawalIndexTypes.BeaconState.toView(
    withdrawalIndexState as never
  )

  console.log(chalk.blue('Computing withdrawal-index state root...'))
  const withdrawalIndexStateRoot = withdrawalIndexStateView.hashTreeRoot()
  console.log(
    `Withdrawal-index state root: ${Buffer.from(withdrawalIndexStateRoot).toString('hex')}`
  )

  const computedWithdrawalIndexStateRoot = Buffer.from(withdrawalIndexStateRoot).toString('hex')
  const provenWithdrawalIndexStateRoot = Buffer.from(
    proofState.stateRoots[stateRootsIndex]
  ).toString('hex')
  if (computedWithdrawalIndexStateRoot !== provenWithdrawalIndexStateRoot) {
    console.error(
      'Computed withdrawal-index state root does not match state root from proof slot! Proof will be invalid.'
    )
    console.error(`${computedWithdrawalIndexStateRoot} != ${provenWithdrawalIndexStateRoot}`)
  }

  const nextWithdrawalIndexPath = withdrawalIndexTypes.BeaconState.getPathInfo([
    'nextWithdrawalIndex',
  ])
  const nextWithdrawalIndexProof = createProof(withdrawalIndexStateView.node, {
    type: ProofType.single,
    gindex: nextWithdrawalIndexPath.gindex,
  }) as SingleProof

  const combinedGindex = concatGindices([
    headerPath.gindex,
    stateRootsPath.gindex,
    nextWithdrawalIndexPath.gindex,
  ])
  const witnesses = [
    ...nextWithdrawalIndexProof.witnesses,
    ...stateRootsProof.witnesses,
    ...headerProof.witnesses,
  ]
  const nextWithdrawalIndex = withdrawalIndexState.nextWithdrawalIndex

  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Proof Slot: ${proofSlot}`)
  console.log(`Proof Fork: ${proofFork}`)
  console.log(`Withdrawal Index Slot: ${withdrawalIndexSlot}`)
  console.log(`Withdrawal Index Fork: ${withdrawalIndexFork}`)
  console.log(`StateRoots Index: ${stateRootsIndex}`)
  console.log(`Next Withdrawal Index: ${nextWithdrawalIndex.toString(10)}`)
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
    proofFork,
    withdrawalIndexSlot,
    withdrawalIndexFork,
    stateRootsIndex,
    nextWithdrawalIndex: Number(nextWithdrawalIndex),
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
