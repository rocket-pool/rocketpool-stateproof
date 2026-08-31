import { Command } from 'commander'
import * as dotenv from 'dotenv'
import { generateValidatorProof } from './commands/validator'
import { generateSlotProof } from './commands/slot'
import { generateWithdrawalProof } from './commands/withdrawal'
import { generateHistoricalWithdrawalProof } from './commands/historical_withdrawal'
import { generateParticipationProof } from './commands/participation'
import { generateHistoricalParticipationProof } from './commands/historical_participation'
import { generateBalanceProof } from './commands/balance'
import { generateHistoricalBalanceProof } from './commands/historical_balance'
import { generateNextWithdrawalIndexProof } from './commands/next_withdrawal_index'
import { generateHistoricalNextWithdrawalIndexProof } from './commands/historical_next_withdrawal_index'
import { generateFinalBalanceProof } from './commands/final_balance'

dotenv.config()

const program = new Command()

function getRocketPoolBanner(): string {
  return `\n
______           _        _    ______           _ 
| ___ \\         | |      | |   | ___ \\         | | 
| |_/ /___   ___| | _____| |_  | |_/ /__   ___ | |
|    // _ \\ / _ | |/ / _ \\ __| |  __/ _ \\ / _ \\| |
| |\\ \\ (_) | (__|   <  __/ |_  | | | (_) | (_) | |
\\_| \\_\\___/ \\___|_|\\_\\___|\\__| \\_|  \\___/ \\___/|_|
\n`;
}

program.name('rp-stateproof')
  .addHelpText('beforeAll', getRocketPoolBanner())
  .hook("preAction", () => console.log(getRocketPoolBanner()))
  .version('1.0.0')
  .description('debugging tool to generate state proofs required for Rocket Pool')
  .option('--rpc', 'beacon chain API endpoint (defaults to BEACON_CHAIN_API env variable)', process.env.BEACON_CHAIN_API)

program.command('validator').
  description('generate a state proof for a validator').
  argument('<validator_index>', 'validator index to generate proof for').
  option('--slot <number>', 'slot number to generate proof for ', 'head').
  action(generateValidatorProof)

program.command('slot').
  description('generate a state proof for the slot number').
  option('--slot <number>', 'slot number to generate proof for ', 'head').
  action(generateSlotProof)

program.command('balance').
  description('generate a state proof for the packed balance of a validator').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<balance_slot>', 'slot containing the validator balance (must be within 8192 slots of the proof slot)').
  argument('<validator_index>', 'validator index to generate proof for').
  action(generateBalanceProof)

program.command('historical_balance').
  description('generate a state proof for the packed balance of a validator using historical_summaries').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<balance_slot>', 'historical slot containing the validator balance').
  argument('<validator_index>', 'validator index to generate proof for').
  option('--historical-start <period>', 'historical period of the first summary entry', '758').
  action(generateHistoricalBalanceProof)

program.command('next_withdrawal_index').
  description('generate a state proof for BeaconState.next_withdrawal_index').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<withdrawal_index_slot>', 'slot containing next_withdrawal_index (must be within 8192 slots of the proof slot)').
  action(generateNextWithdrawalIndexProof)

program.command('historical_next_withdrawal_index').
  description('generate a state proof for BeaconState.next_withdrawal_index using historical_summaries').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<withdrawal_index_slot>', 'historical slot containing next_withdrawal_index').
  option('--historical-start <period>', 'historical period of the first summary entry', '758').
  action(generateHistoricalNextWithdrawalIndexProof)

program.command('final_balance').
  description('generate a Gloas FinalBalanceProofBundleV2').
  argument('<proof_slot>', 'slot to produce the proofs for').
  argument('<withdrawal_slot>', 'Gloas slot containing the expected withdrawal').
  argument('<validator_index>', 'validator index whose final balance is being proven').
  option('--historical-start <period>', 'historical period of the first summary entry', '758').
  action(generateFinalBalanceProof)

program.command('participation').
  description('generate a state proof for the previous_epoch_participation of a validator').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<participation_slot>', 'slot containing the previous_epoch_participation (must be within 8192 slots of the proof slot)').
  argument('<validator_index>', 'validator index to generate proof for').
  action(generateParticipationProof)

program.command('historical_participation').
  description('generate a state proof for previous_epoch_participation using historical_summaries').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<participation_slot>', 'historical slot containing the previous_epoch_participation').
  argument('<validator_index>', 'validator index to generate proof for').
  option('--network <string>', '"mainnet" or "hoodi" (defaults to "mainnet")', 'mainnet').
  action(generateHistoricalParticipationProof)

program.command('withdrawal').
  description('generate a state proof for a withdrawal').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<withdrawal_slot>', 'slot that contains the withdrawal (must be within 8191 slots of the proof slot)').
  argument('<withdrawal_number>', 'index into the withdrawal list for the withdrawal').
  action(generateWithdrawalProof)

program.command('historical_withdrawal').
  description('generate a state proof for a withdrawal using historical_summaries').
  argument('<proof_slot>', 'slot to produce the proof for').
  argument('<withdrawal_slot>', 'slot that contains the withdrawal').
  argument('<withdrawal_number>', 'index into the withdrawal list for the withdrawal').
  option('--historical-start <period>', 'historical period of the first summary entry', '758').
  action(generateHistoricalWithdrawalProof)

program.parse()
