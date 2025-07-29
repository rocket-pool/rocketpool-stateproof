import { Command } from 'commander'
import chalk from 'chalk'
import { constructBlockHeaderWithStateRoot, getBlock, getState } from '../common/beaconchain'
import { ssz } from '@lodestar/types'
import { createProof, ProofType, SingleProof } from '@chainsafe/persistent-merkle-tree'
import { concatGindices } from '@chainsafe/persistent-merkle-tree'

interface ValidatorProofOpts {
  slot: string
}

export async function generateValidatorProof(validatorIndexStr: string, opts: ValidatorProofOpts, program: Command) {
  const allOpts = program.optsWithGlobals();
  const validatorIndex = parseInt(validatorIndexStr)


  // Parse slot param
  let slot: number | string = opts.slot
  if (slot !== 'head') {
    slot = parseInt(slot)
  }

  // Fetch the state
  const state = await getState(allOpts.rpc, slot)
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

  // Generate partial proof from BeaconState -> validators[n] -> pubkey/withdrawal_credentials
  {
    let { gindex } = ssz.electra.BeaconState.getPathInfo(['validators', validatorIndex]);
    // We want to generate a proof to the pubkey/withdrawal_credentials branch of the merkle tree which requires concatenating 0b00 to the gindex
    gindices.push(gindex);
    const proof = createProof(stateView.node, {
      type: ProofType.single,
      gindex
    }) as SingleProof
    witnesses.push(proof.witnesses.map(witness => Buffer.from(witness).toString('hex')))
  }

  // Construct the validator root
  const validator = state.validators[validatorIndex];
  const validatorView = ssz.electra.Validator.toView(validator);
  const validatorRoot = validatorView.hashTreeRoot();

  // Reverse the witnesses array to match the order of the gindices array and flatten
  witnesses = witnesses.reverse().flat();
  const combinedGindex = concatGindices(gindices);

  // Output the results
  console.log()
  console.log(chalk.green('Proof generation complete'))
  console.log()
  console.log(`Validator Index: ${validatorIndex}`)
  console.log()
  console.log(`Gindex: 0b${combinedGindex.toString(2)}`)
  console.log(`Gindex: ${combinedGindex.toString(10)}`)
  console.log()
  console.log(`Witnesses (${witnesses.length}):`)
  console.log(`[`)
  console.log(witnesses.map(witness => `"0x${witness}"`).join(',\n'))
  console.log(`]`)
  console.log()
  console.log(`Validator Root: 0x${Buffer.from(validatorRoot).toString('hex')}`);
  console.log()
  console.log(`Validator:`)
  console.log(`Pubkey: 0x${Buffer.from(validator.pubkey).toString('hex')}`)
  console.log(`Withdrawal Credentials: 0x${Buffer.from(validator.withdrawalCredentials).toString('hex')}`)
  console.log(`Effective Balance: ${validator.effectiveBalance.toString(10)}`)
  console.log(`Slashed: ${validator.slashed}`)
  console.log(`Activation Eligibility Epoch: ${validator.activationEligibilityEpoch}`)
  console.log(`Activation Epoch: ${validator.activationEpoch}`)
  console.log(`Exit Epoch: ${validator.exitEpoch}`)
  console.log(`Withdrawable Epoch: ${validator.withdrawableEpoch}`)
  console.log()

  // Output JSON encoded result
  const output = {
    slot: slot,
    validatorIndex: validatorIndex,
    validator: {
      pubkey: `0x${Buffer.from(validator.pubkey)}`,
      withdrawalCredentials: `0x${Buffer.from(validator.withdrawalCredentials).toString('hex')}`,
      effectiveBalance: Number(validator.effectiveBalance),
      slashed: validator.slashed,
      activationEligibilityEpoch: Number(validator.activationEligibilityEpoch),
      activationEpoch: Number(validator.activationEpoch),
      exitEpoch: Number(validator.exitEpoch),
      withdrawableEpoch: Number(validator.withdrawableEpoch),
    },
    witnesses: witnesses,
  }

  console.log(JSON.stringify(output, null, 2))
}