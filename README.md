# Rocket Pool State Proof Generator

This is a naive implementation of a proof generator for use with the Rocket Pool protocol. 

It is intended for use in debugging and testing against other more production-ready implementations.

## Usage

Install dependencies:

```bash
    bun install
```

Then run the help command for a list of available commands:

```bash
    bun src/index.js --help
```

Outputs:

```
______           _        _    ______           _ 
| ___ \         | |      | |   | ___ \         | | 
| |_/ /___   ___| | _____| |_  | |_/ /__   ___ | |
|    // _ \ / _ | |/ / _ \ __| |  __/ _ \ / _ \| |
| |\ \ (_) | (__|   <  __/ |_  | | | (_) | (_) | |
\_| \_\___/ \___|_|\_\___|\__| \_|  \___/ \___/|_|


Usage: rp-stateproof [options] [command]

debugging tool to generate state proofs required for Rocket Pool

Options:
  -V, --version                                                             output the version number
  --rpc                                                                     beacon chain API endpoint (defaults to BEACON_CHAIN_API env variable)
  -h, --help                                                                display help for command

Commands:
  validator_pubkey [options] <validator_index>                              generate a state proof for a validator pubkey/withdrawal_credentials
  validator [options] <validator_index>                                     generate a state proof for a validator
  withdrawable_epoch [options] <validator_index>                            generate a state proof for the withdrawable_epoch of a validator
  withdrawal <proof_slot> <withdrawal_slot> <withdrawal_number>             generate a state proof for a withdrawal
  historical_withdrawal <proof_slot> <withdrawal_slot> <withdrawal_number>  generate a state proof for a withdrawal (using historical block root)
  help [command]   
```