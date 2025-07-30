# papi-polkadot-populate

This tool aims to easily create several hard-derived child accounts from a funded account, fund them, and have all of them nominate.

The stakes of these accounts are somewhat variable, so that when we take the election snapshot, some accounts are included while others are not.

The project is inspired by https://github.com/shawntabrizi/polkadot-populate.

## Installation

To install dependencies:

```bash
bun install
```

## Usage

The tool accepts the following command-line parameters:

### Required Parameters

- `--seed <string>` - The seed phrase or hex seed of the god account (the account that will fund all child accounts). Accepts:
  - A valid 12-24 word mnemonic phrase
  - A 32-byte hex string starting with `0x` (e.g., `0xf4b7d3a7f56d6e74c2b2230703be1a01ffe9c066143ff7f93d41e3d62b82327a`)
  - The word `dev` for testing with the development seed

### Optional Parameters

- `--nominators <number>` - Number of nominator accounts to create (default: 100)
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
```

NOTE: this project was created using `bun init` in bun v1.2.16. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
