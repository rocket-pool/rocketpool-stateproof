import { Command } from 'commander'
import { generateValidatorProof } from './commands/validator'
import * as dotenv from 'dotenv'
import { generateWithdrawableEpochProof } from './commands/withdrawable_epoch'
import { generateWithdrawalProof } from './commands/withdrawal'
import { generateValidatorPubkeyProof } from './commands/validator_pubkey'

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

program.command('validator_pubkey').
  description('generate a state proof for a validator pubkey/withdrawal_credentials').
  argument('<validator_index>', 'Validator index to generate proof for').
  option('--slot <number>', 'Slot number to generate proof for ', 'head').
  action(generateValidatorPubkeyProof)

program.command('validator').
  description('generate a state proof for a validator').
  argument('<validator_index>', 'Validator index to generate proof for').
  option('--slot <number>', 'Slot number to generate proof for ', 'head').
  action(generateValidatorProof)

program.command('withdrawable_epoch').
  description('generate a state proof for the withdrawable_epoch of a validator').
  argument('<validator_index>', 'Validator index to generate proof for').
  option('--slot <number>', 'Slot number to generate proof for ', 'head').
  action(generateWithdrawableEpochProof)

program.command('withdrawal').
  description('generate a state proof for a withdrawal').
  argument('<proof_slot>', 'Slot to produce the proof for').
  argument('<withdrawal_slot>', 'Slot that contains the withdrawal (must be within 8192 slots of the proof slot)').
  argument('<withdrawal_number>', 'Index into the withdrawal list for the withdrawal').
  action(generateWithdrawalProof)

program.parse()