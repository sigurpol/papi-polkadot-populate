# papi-polkadot-populate

This tool aims to

- Easily create several hard-derived child accounts from a funded account, fund them, and have all of them nominate.
- Support comprehensive nomination pool operations, including pool creation, member management, and hybrid staking scenarios.
- Top-ups existing hard-derived accounts

The stakes of these accounts use pre-determined variable amounts. Each nominator is assigned a stake amount ranging from the minimum nominator staking bond (currently 250 PAS on Paseo, as read from the chain) up to 500 PAS. This variability ensures that when we take the election snapshot, some accounts are included while others are not.

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

## Nomination Pools

The tool supports comprehensive nomination pool operations, including pool creation, member management, and hybrid staking scenarios. All pool operations fetch live chain parameters to ensure compliance with current network requirements.

### Pool Parameters

- `--pools <number>` - Number of nomination pools to create (default: 0)
- `--pool-members <number>` - Number of pool members to create (default: 0)
- `--hybrid-stakers <number>` - Number of accounts that are both pool members and solo stakers (default: 0)
- `--pool-stake <number>` - Initial stake amount for each pool in PAS (optional, uses chain MinCreateBond if not specified)
- `--member-stake <number>` - Stake amount for each pool member in PAS (optional, uses chain MinJoinBond if not specified)
- `--pool-commission <number>` - Commission percentage for pools (0-100, default: 10)
- `--dry-run` - Show detailed analysis without executing transactions

### Pool Account Organization

The tool uses different derivation paths for different account types:

- Pool creators: `//pool/1`, `//pool/2`, etc.
- Pool members: `//member/1`, `//member/2`, etc.
- Hybrid stakers: `//hybrid/1`, `//hybrid/2`, etc.
- Regular nominators: `///1`, `///2`, etc.

### Chain Parameter Integration

The tool automatically fetches and displays current chain parameters:

- **MinCreateBond**: Minimum stake required to create a pool (currently 0 PAS on Paseo)
- **MinJoinBond**: Minimum stake required to join a pool (currently 1 PAS on Paseo)
- **MaxPools**: Maximum number of pools allowed on chain
- **MaxPoolMembers**: Maximum number of pool members allowed
- Current pool and member counts

### Pool Creation Examples

**Create 3 pools using chain minimums:**

```bash
bun run index.ts --seed "your seed phrase" --pools 3
```

**Create pools with custom stake amounts:**

```bash
bun run index.ts --seed "your seed phrase" --pools 5 --pool-stake 1000 --pool-commission 5
```

**Create pools with members (members join newly created pools):**

```bash
bun run index.ts --seed "your seed phrase" --pools 3 --pool-members 20
```

**Create pools with custom member stakes:**

```bash
bun run index.ts --seed "your seed phrase" --pools 2 --pool-members 15 --member-stake 50
```

### Hybrid Staking Examples

Hybrid stakers are accounts that participate in both pool staking and solo staking simultaneously:

**Create hybrid stakers (requires pools in same command):**

```bash
bun run index.ts --seed "your seed phrase" --pools 2 --hybrid-stakers 10
```

**Complete scenario with all staking types:**

```bash
bun run index.ts --seed "your seed phrase" --nominators 10 --pools 3 --pool-members 20 --hybrid-stakers 5
```

**Large-scale pool setup:**

```bash
bun run index.ts --seed "your seed phrase" --pools 10 --pool-members 100 --hybrid-stakers 20 --pool-stake 500 --member-stake 25
```

### Dry-Run Mode for Pools

Pool operations support comprehensive dry-run analysis:

**Analyze pool creation requirements:**

```bash
bun run index.ts --seed "your seed phrase" --pools 5 --pool-members 30 --dry-run
```

**Check hybrid staker funding needs:**

```bash
bun run index.ts --seed "your seed phrase" --pools 3 --hybrid-stakers 10 --dry-run
```

### Pool Behavior Details

**Pool Creation:**

- Each pool is created with the specified stake amount
- Pool creator account serves as root, nominator, and bouncer
- Commission is set during pool creation
- Pool IDs are assigned sequentially by the chain

**Member Distribution:**

- Members are distributed evenly across newly created pools within the same command
- Members can only be created when pools are also being created (--pools required with --pool-members)
- Each member account is funded with stake amount + buffer
- Members automatically join their assigned pool after funding

**Hybrid Staking:**

- Hybrid accounts are funded with both pool stake and solo stake amounts
- Hybrid stakers can only be created when pools are also being created (--pools required with --hybrid-stakers)
- First joins a newly created pool, then bonds and nominates as solo staker
- Uses batch transactions for atomic execution
- Nominates random validators for solo staking portion

**Error Handling:**

- Validates god account has sufficient balance before operations
- Checks against chain limits (MaxPools, MaxPoolMembers)
- Skips existing accounts automatically
- Graceful handling of failed transactions

### Important Usage Notes

**Valid Usage Patterns:**

```bash
# ✅ Create pools only
bun run index.ts --seed "your seed phrase" --pools 3

# ✅ Create pools with members
bun run index.ts --seed "your seed phrase" --pools 3 --pool-members 20

# ✅ Create pools with hybrids
bun run index.ts --seed "your seed phrase" --pools 2 --hybrid-stakers 10

# ✅ Complete scenario
bun run index.ts --seed "your seed phrase" --pools 3 --pool-members 20 --hybrid-stakers 5
```

**Invalid Usage Patterns:**

```bash
# ❌ Cannot create members without pools
bun run index.ts --seed "your seed phrase" --pool-members 20

# ❌ Cannot create hybrids without pools
bun run index.ts --seed "your seed phrase" --hybrid-stakers 10

# ❌ Cannot create both members and hybrids without pools
bun run index.ts --seed "your seed phrase" --pool-members 10 --hybrid-stakers 5
```

The tool enforces that pool members and hybrid stakers can only join newly created pools within the same command execution. This ensures predictable behavior and prevents members from joining random existing pools on the network.

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
