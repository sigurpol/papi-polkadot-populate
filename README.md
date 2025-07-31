# papi-polkadot-populate

This tool aims to easily create several hard-derived child accounts from a funded account, fund them, and have all of them nominate.

The stakes of these accounts use pre-determined variable amounts. Each nominator is assigned a stake amount ranging from the minimum nominator staking bond (currently 250 PAS on Paseo, as read from the chain) up to 500 PAS. This variability ensures that when we take the election snapshot, some accounts are included while others are not.

Optionally the tool also allows to top-ups existing hard-derived accounts.

The project is inspired by https://github.com/shawntabrizi/polkadot-populate.

## Installation

To install dependencies:

```bash
bun install
```

## Populate nominators (create accounts + bond + stake)

The tool accepts the following command-line parameters:

### Required Parameters

- `--seed <string>` - The seed phrase or hex seed of the god account (the account that will fund all child accounts). Accepts:
  - A valid 12-24 word mnemonic phrase
  - A 32-byte hex string starting with `0x` (e.g., `0xf4b7d3a7f56d6e74c2b2230703be1a01ffe9c066143ff7f93d41e3d62b82327a`)
  - The word `dev` for testing with the development seed

### Optional Parameters

- `--nominators <number>` - Number of NEW nominator accounts to create (default: 100). The tool will skip any existing accounts and create exactly this many new ones.
- `--validators-per-nominator <number>` - Number of validators each nominator will select (default: 16)
- `--dry-run` - Show what would happen without executing transactions (optional)

### Examples

Using a mnemonic phrase:

```bash
bun run index.ts --seed "your twelve word mnemonic phrase goes here and should be valid"
```

Using a hex seed:

```bash
bun run index.ts --seed "0xf4b7d3a7f56d6e74c2b2230703be1a01ffe9c066143ff7f93d41e3d62b82327a"
```

Using dev seed for testing:

```bash
bun run index.ts --seed dev --nominators 5 --validators-per-nominator 10
```

Creating 50 nominators with 8 validators each:

```bash
bun run index.ts --seed "your seed phrase" --nominators 50 --validators-per-nominator 8
```

Dry run mode (test without executing transactions):

```bash
bun run index.ts --seed dev --nominators 5 --dry-run
```

Execute real transactions (default behavior):

```bash
bun run index.ts --seed "your funded seed" --nominators 5
```

## Top-up Mode

The tool also supports a top-up mode to ensure accounts have a minimum balance.

### Top-up Parameters

- `--seed <string>` - The seed phrase or hex seed of the god account
- `--topup <number>` - Target balance in PAS (required for topup mode)
- `--from <number>` - Starting account index (inclusive, required for topup mode)
- `--to <number>` - Ending account index (exclusive, required for topup mode)
- `--dry-run` - Show what would happen without executing transactions (optional)

### Top-up Examples

Top up accounts ///3 to ///31 to have at least 250 PAS each:

```bash
bun run index.ts --seed "your seed phrase" --topup 250 --from 3 --to 32
```

Dry run to see what top-ups would be needed:

```bash
bun run index.ts --seed "your seed phrase" --topup 250 --from 3 --to 32 --dry-run
```

Top up a single account (///10) to 500 PAS:

```bash
bun run index.ts --seed "your seed phrase" --topup 500 --from 10 --to 11
```

### Top-up Behavior

- **Smart topup**: Only tops up accounts that have less than the target amount
- **Precise amounts**: If account has 100 PAS and target is 250 PAS, only 150 PAS is transferred
- **Skip sufficient accounts**: Accounts already at or above target balance are left unchanged
- **Balance verification**: Checks god account has sufficient funds before proceeding
- **Batch processing**: Processes multiple topups in efficient batches

## Account Creation Logic

The tool uses hard-derived accounts with paths like `///1`, `///2`, `///3`, etc. When you specify `--nominators N`, the tool will:

1. Start checking from account `///1`
2. Skip any accounts that already exist on-chain
3. Continue checking sequential indices until it finds exactly N accounts that don't exist
4. Create and fund those N new accounts

For example, if you specify `--nominators 10` and accounts `///1`, `///2`, and `///5` already exist, the tool will create accounts at indices `3`, `4`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, and `13` to ensure exactly 10 new accounts are created.

Each new account is funded with:

- Its predetermined stake amount (250-500 PAS)
- 1 PAS for existential deposit
- 1 PAS buffer for transaction fees

## Choose your network

The project targets initially `paseo` testnet.
PAPI dependencies for Paseo have been added via

```bash
bun papi add -n paseo paseo
```

If you want to target another network (e.g. `Westend`) simply do something like

```bash
bun papi add -n westend wnd
```

and replace the following lines in `index.ts`:

```ts
import { paseo } from "@polkadot-api/descriptors";
import { chainSpec } from "polkadot-api/chains/paseo";
...
// get the safely typed API
const api = client.getTypedApi(paseo);
...
const PAS = 10_000_000_000n; // 1 PAS = 10^10 planck
```
