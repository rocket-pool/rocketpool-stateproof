import { Command } from 'commander'
import chalk from 'chalk'
import {
  constructBlockHeaderWithStateRoot,
  getBlockWithFork,
  getStateWithFork,
} from '../common/beaconchain'
import { ForkName, SLOTS_PER_HISTORICAL_ROOT } from '@lodestar/params'
import { BeaconState, SignedBeaconBlock, sszTypesFor } from '@lodestar/types'
import { concatGindices, createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'

interface WithdrawalProofOpts {}

export async function generateWithdrawalProof (
  proofSlotStr: string,
  withdrawalSlotStr: string,
  withdrawalNumberStr: string,
  _opts: WithdrawalProofOpts,
  program: Command
) {
  const allOpts = program.optsWithGlobals()
  const proofSlot = parseNonNegativeInteger('proof slot', proofSlotStr, program)
  const withdrawalSlot = parseNonNegativeInteger('withdrawal slot', withdrawalSlotStr, program)
  const withdrawalNumber = parseNonNegativeInteger('withdrawal number', withdrawalNumberStr, program)

  if (withdrawalSlot >= proofSlot) {
    program.error(`Withdrawal slot ${withdrawalSlot} must be earlier than proof slot ${proofSlot}`)
  }

  const slotDistance = proofSlot - withdrawalSlot
  if (slotDistance >= SLOTS_PER_HISTORICAL_ROOT) {
    program.error(
      `Withdrawal slot ${withdrawalSlot} is ${slotDistance} slots before proof slot ${proofSlot}; maximum is ${SLOTS_PER_HISTORICAL_ROOT - 1}`
    )
  }

  const [
    { fork: proofFork, state: proofState },
    { fork: withdrawalFork, block: withdrawalBlock },
  ] = await Promise.all([
    getStateWithFork(allOpts.rpc, proofSlot),
    getBlockWithFork(allOpts.rpc, withdrawalSlot),
  ])

  if (!isWithdrawalFork(withdrawalFork)) {
    program.error(`Withdrawals are not supported for fork ${withdrawalFork}`)
  }

  console.log(`Generating proof for slot ${proofState.slot} (${proofFork})`)
  console.log(`Withdrawal slot ${withdrawalSlot} uses fork ${withdrawalFork}`)

  const proofTypes = sszTypesFor(proofFork)
  const proofStateView = proofTypes.BeaconState.toView(proofState as never)

  console.log(chalk.blue('Computing state root...'))
  const proofStateRoot = proofStateView.hashTreeRoot()
  console.log(`State root: ${Buffer.from(proofStateRoot).toString('hex')}`)

  const blockHeader = constructBlockHeaderWithStateRoot(proofState.latestBlockHeader, proofStateRoot)
  const blockHeaderView = proofTypes.BeaconBlockHeader.toView(blockHeader)

  console.log(chalk.blue('Computing block root...'))
  const blockRoot = blockHeaderView.hashTreeRoot()
  console.log(`Block root: ${Buffer.from(blockRoot).toString('hex')}`)

  const gindices: bigint[] = []
  const witnessGroups: string[][] = []

  const headerPath = proofTypes.BeaconBlockHeader.getPathInfo(['stateRoot'])
  const headerProof = createProof(blockHeaderView.node, {
    type: ProofType.single,
    gindex: headerPath.gindex,
  }) as SingleProof
  gindices.push(headerPath.gindex)
  witnessGroups.push(headerProof.witnesses.map(witness => Buffer.from(witness).toString('hex')))

  const rootsIndex = withdrawalSlot % SLOTS_PER_HISTORICAL_ROOT
  let rootsLabel: 'BlockRoots' | 'StateRoots'
  let withdrawal: {
    index: number | bigint
    validatorIndex: number | bigint
    address: Uint8Array
    amount: number | bigint
  }

  if (withdrawalFork === ForkName.gloas) {
    rootsLabel = 'StateRoots'
    const { fork: withdrawalStateFork, state: withdrawalState } = await getStateWithFork(
      allOpts.rpc,
      withdrawalSlot
    )

    if (withdrawalStateFork !== withdrawalFork) {
      program.error(
        `Withdrawal block fork ${withdrawalFork} does not match withdrawal state fork ${withdrawalStateFork}`
      )
    }

    const gloasWithdrawalState = withdrawalState as BeaconState<ForkName.gloas>
    if (withdrawalNumber >= gloasWithdrawalState.payloadExpectedWithdrawals.length) {
      program.error(
        `Withdrawal number ${withdrawalNumber} is outside payload_expected_withdrawals length ${gloasWithdrawalState.payloadExpectedWithdrawals.length}`
      )
    }

    const rootsPath = proofTypes.BeaconState.getPathInfo(['stateRoots', rootsIndex])
    const rootsProof = createProof(proofStateView.node, {
      type: ProofType.single,
      gindex: rootsPath.gindex,
    }) as SingleProof
    gindices.push(rootsPath.gindex)
    witnessGroups.push(rootsProof.witnesses.map(witness => Buffer.from(witness).toString('hex')))

    const withdrawalTypes = sszTypesFor(withdrawalStateFork)
    const withdrawalStateView = withdrawalTypes.BeaconState.toView(gloasWithdrawalState as never)
    const computedWithdrawalStateRoot = Buffer.from(withdrawalStateView.hashTreeRoot()).toString('hex')
    const provenWithdrawalStateRoot = Buffer.from(proofState.stateRoots[rootsIndex]).toString('hex')
    console.log(`Computed state root for slot ${withdrawalState.slot}: ${computedWithdrawalStateRoot}`)

    if (computedWithdrawalStateRoot !== provenWithdrawalStateRoot) {
      console.error('Computed withdrawal state root does not match state root from proof slot! Proof will be invalid.')
      console.error(`${computedWithdrawalStateRoot} != ${provenWithdrawalStateRoot}`)
    }

    const withdrawalPath = withdrawalTypes.BeaconState.getPathInfo([
      'payloadExpectedWithdrawals',
      withdrawalNumber,
    ])
    const withdrawalProof = createProof(withdrawalStateView.node, {
      type: ProofType.single,
      gindex: withdrawalPath.gindex,
    }) as SingleProof
    gindices.push(withdrawalPath.gindex)
    witnessGroups.push(withdrawalProof.witnesses.map(witness => Buffer.from(witness).toString('hex')))

    withdrawal = gloasWithdrawalState.payloadExpectedWithdrawals[withdrawalNumber]
  }
  else {
    rootsLabel = 'BlockRoots'
    const preGloasWithdrawalBlock = withdrawalBlock as SignedBeaconBlock<ForkName.fulu>
    const withdrawals = preGloasWithdrawalBlock.message.body.executionPayload.withdrawals
    if (withdrawalNumber >= withdrawals.length) {
      program.error(
        `Withdrawal number ${withdrawalNumber} is outside withdrawals length ${withdrawals.length}`
      )
    }

    const rootsPath = proofTypes.BeaconState.getPathInfo(['blockRoots', rootsIndex])
    const rootsProof = createProof(proofStateView.node, {
      type: ProofType.single,
      gindex: rootsPath.gindex,
    }) as SingleProof
    gindices.push(rootsPath.gindex)
    witnessGroups.push(rootsProof.witnesses.map(witness => Buffer.from(witness).toString('hex')))

    const withdrawalTypes = sszTypesFor(withdrawalFork)
    const withdrawalBlockView = withdrawalTypes.BeaconBlock.toView(withdrawalBlock.message as never)
    const computedWithdrawalBlockRoot = Buffer.from(withdrawalBlockView.hashTreeRoot()).toString('hex')
    const provenWithdrawalBlockRoot = Buffer.from(proofState.blockRoots[rootsIndex]).toString('hex')
    console.log(`Computed block root for slot ${withdrawalBlock.message.slot}: ${computedWithdrawalBlockRoot}`)

    if (computedWithdrawalBlockRoot !== provenWithdrawalBlockRoot) {
      console.error('Computed withdrawal block root does not match block root from proof slot! Proof will be invalid.')
      console.error(`${computedWithdrawalBlockRoot} != ${provenWithdrawalBlockRoot}`)
    }

    const withdrawalPath = withdrawalTypes.BeaconBlock.getPathInfo([
      'body',
      'executionPayload',
      'withdrawals',
      withdrawalNumber,
    ])
    const withdrawalProof = createProof(withdrawalBlockView.node, {
      type: ProofType.single,
      gindex: withdrawalPath.gindex,
    }) as SingleProof
    gindices.push(withdrawalPath.gindex)
    witnessGroups.push(withdrawalProof.witnesses.map(witness => Buffer.from(witness).toString('hex')))

    withdrawal = withdrawals[withdrawalNumber]
  }

  const witnesses = witnessGroups.reverse().flat()
  const combinedGindex = concatGindices(gindices)

  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Withdrawal Slot: ${withdrawalSlot}`)
  console.log(`Withdrawal Fork: ${withdrawalFork}`)
  console.log(`Withdrawal Number: ${withdrawalNumber}`)
  console.log(`Proof Slot: ${proofSlot}`)
  console.log(`Proof Fork: ${proofFork}`)
  console.log(`${rootsLabel} Index: ${rootsIndex}`)
  console.log()
  console.log(`Gindex: 0b${combinedGindex.toString(2)}`)
  console.log(`Gindex: ${combinedGindex.toString(10)}`)
  console.log()
  console.log(`Witnesses (${witnesses.length}):`)
  console.log('[')
  console.log(witnesses.map(witness => `"0x${witness}"`).join(',\n'))
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
    witnesses: witnesses.map(witness => `0x${witness}`),
  }

  console.log(JSON.stringify(output, null, 2))
}

function isWithdrawalFork (fork: ForkName): fork is ForkName.capella | ForkName.deneb | ForkName.electra | ForkName.fulu | ForkName.gloas {
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
