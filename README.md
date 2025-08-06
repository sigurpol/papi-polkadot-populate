# papi-polkadot-populate

This tool aims to

- Easily create several hard-derived child accounts from a funded account, fund them, and have all of them nominate.
- Support comprehensive nomination pool operations, including pool creation, member management, and hybrid staking scenarios.
- Top-ups existing hard-derived accounts

The stakes of these accounts use pre-determined variable amounts. Each nominator is assigned a stake amount ranging from the minimum nominator staking bond (currently 250 PAS on Paseo, as read from the chain) up to 500 PAS. This variability ensures that when we take the election snapshot, some accounts are included while others are not.

The project is inspired by [polkadot-populate](https://github.com/shawntabrizi/polkadot-populate).

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
- `--validator-start-index <number>` - Starting index for round-robin validator selection (default: 0). Use this when creating nominators in batches to continue the even distribution.
- `--dry-run` - Show what would happen without executing transactions (optional)

### Performance Optimization Parameters

- `--start-index <number>` - Start checking from account ///N instead of ///1 (default: 1).
- `--skip-check-account` - Skip account existence checks, assume all accounts from start-index are available. **MAXIMUM SPEED**
- `--transfer-batch <number>` - Balance transfer batch size (default: 1000, max: 1500)
- `--stake-batch <number>` - Staking operations batch size (default: 100, max: 250)
- `--check-batch <number>` - Parallel account existence checks (default: 500)
- `--no-wait` - Don't wait for transaction finalization (fire-and-forget mode)
- `--parallel-batches <number>` - Number of batches to submit concurrently (default: 1, max: 10)
- `--quiet` - Suppress per-account logs, show only summaries

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

### Validator Distribution

The tool uses a round-robin algorithm to ensure even distribution of nominators across validators:

- Validators are assigned sequentially to each nominator
- When creating large numbers of nominators, this ensures each validator receives a nearly equal number of nominations
- Use `--validator-start-index` when creating nominators in batches to continue the distribution from where the previous batch ended

Example for batch processing:

```bash
# First batch of 1000 nominators
bun run index.ts --seed "your seed" --nominators 1000
# Output shows: "Next validator index for future batches: 16"

# Second batch continues from index 16
bun run index.ts --seed "your seed" --nominators 1000 --validator-start-index 16
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
- `--list-pools` - List all pools created by this tool (shows members)
- `--remove-from-pool <poolId:members>` - Remove members from a pool (e.g., '10:addr1,addr2' or '10:all')
- `--destroy-pools <range>` - Destroy pools created by this tool (e.g., '1-5' or '3,7,9')
- `--dry-run` - Show detailed analysis without executing transactions

### Pool Account Organization

The tool uses different derivation paths for different account types:

- Pool creators: `//pool/1`, `//pool/2`, etc.
- Pool members: `//member/1`, `//member/2`, etc.
- Hybrid stakers: `//hybrid/1`, `//hybrid/2`, etc.
- Regular nominators: `///1`, `///2`, etc.

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

### Pool Management Examples

**List all pools you've created (with members):**

```bash
bun run index.ts --seed "your seed phrase" --list-pools
```

**Remove members from a pool:**

```bash
# Remove specific members from pool 10
bun run index.ts --seed "your seed phrase" --remove-from-pool "10:addr1,addr2"

# Remove all controllable members from pool 10
bun run index.ts --seed "your seed phrase" --remove-from-pool "10:all"

# Dry run to see what would happen
bun run index.ts --seed "your seed phrase" --remove-from-pool "10:all" --dry-run
```

**Destroy specific pools:**

```bash
# Destroy pools 1, 2, and 3
bun run index.ts --seed "your seed phrase" --destroy-pools "1-3"

# Destroy specific pool IDs
bun run index.ts --seed "your seed phrase" --destroy-pools "5,8,12"

# Mixed range and specific IDs
bun run index.ts --seed "your seed phrase" --destroy-pools "1-3,7,10-12"

# Dry run to see what would be destroyed
bun run index.ts --seed "your seed phrase" --destroy-pools "1-5" --dry-run
```

**Important Notes:**

- Pools can only be destroyed after all members have left
- Members must unbond first, wait for the unbonding period (28 days on Paseo), then withdraw
- The `--remove-from-pool` command handles both unbonding and withdrawing
- You can only control members created by this tool with the same seed

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

## Account Management

The tool provides comprehensive account management capabilities to list and clean up derived accounts created by the tool.

### Account Management Parameters

- `--list-accounts` - List all derived accounts created by this tool (shows balances and staking status)
- `--unbond-accounts <range>` - Unbond, stop nominating, and prepare accounts for fund return (e.g., '1-5' or '3,7,9')
- `--dry-run` - Show detailed analysis without executing transactions

### Account Management Examples

**List all derived accounts:**

```bash
bun run index.ts --seed "your seed phrase" --list-accounts
```

This shows all accounts across different derivation paths:

- Regular nominators (///1, ///2, etc.)
- Pool creators (//pool/1, //pool/2, etc.)
- Pool members (//member/1, //member/2, etc.)
- Hybrid stakers (//hybrid/1, //hybrid/2, etc.)

**Unbond specific accounts and return funds:**

```bash
# Unbond accounts 1, 2, and 3 (checks all derivation paths automatically)
bun run index.ts --seed "your seed phrase" --unbond-accounts "1-3"

# Unbond specific account indices
bun run index.ts --seed "your seed phrase" --unbond-accounts "5,8,12"

# Mixed range and specific indices
bun run index.ts --seed "your seed phrase" --unbond-accounts "1-3,7,10-12"

# Dry run to see what would be unbonded
bun run index.ts --seed "your seed phrase" --unbond-accounts "1-10" --dry-run
```

### Account Management Behavior

**Account Discovery:**

- The tool automatically detects which derivation path each account index uses
- Checks all account types: regular nominators, pool creators, pool members, and hybrid stakers
- Only processes accounts that have staking activities (bonded or pool membership)

**Unbonding Process:**

1. **Chill**: Stops nominating if the account is currently nominating validators
2. **Unbond Solo Stakes**: Initiates unbonding from direct staking (if applicable)
3. **Leave Pools**: Initiates unbonding from nomination pools (if applicable)
4. **Wait Period**: Accounts must wait 28 days (on Paseo) for unbonding to complete
5. **Withdrawal**: After the unbonding period, funds can be withdrawn and transferred

**Important Notes:**

- The unbonding process requires a 28-day waiting period on Paseo testnet
- Accounts can have both solo stakes and pool memberships (hybrid stakers)
- The tool handles all staking types automatically
- After unbonding completes, you'll need to manually withdraw and transfer funds back to the god account

### Account Management Use Cases

**Clean up test environment:**

```bash
# List all accounts first to see what exists
bun run index.ts --seed "your seed phrase" --list-accounts

# Unbond all accounts from index 1 to 50
bun run index.ts --seed "your seed phrase" --unbond-accounts "1-50"

# Check the unbonding status
bun run index.ts --seed "your seed phrase" --list-accounts
```

**Selective cleanup:**

```bash
# Only unbond specific problematic accounts
bun run index.ts --seed "your seed phrase" --unbond-accounts "10,15,20-25" --dry-run

# Execute after reviewing the dry run
bun run index.ts --seed "your seed phrase" --unbond-accounts "10,15,20-25"
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
...
const PAS = 10_000_000_000n; // 1 PAS = 10^10 planck
```

## Performance Optimization

The tool includes several performance optimizations that can make large-scale operations **100-1000x faster**.

### Key Performance Features

1. **Start Index** - Skip checking accounts that were already processed
2. **Skip Account Checks** - Assume all accounts from start-index are available (maximum speed)
3. **Parallel Account Checking** - Check hundreds of accounts simultaneously
4. **Fire-and-Forget Mode** - Don't wait for transaction finalization
5. **Larger Batch Sizes** - Process more operations per transaction
6. **Parallel Batch Submission** - Submit multiple batches concurrently
7. **Quiet Mode** - Reduce console I/O overhead

### Performance Examples

**Fast creation of 1000 nominators starting from index 30001:**

```bash
bun run index.ts --seed $SEED \
  --nominators 1000 \
  --start-index 30001 \
  --transfer-batch 1000 \
  --stake-batch 100 \
  --check-batch 500 \
  --no-wait \
  --quiet
```

This combines multiple optimizations:

- Skips checking accounts ///1 to ///30000
- Checks 500 accounts in parallel
- Uses larger batch sizes (1000 transfers, 100 stakes)
- Doesn't wait for finalization
- Suppresses verbose logging

**MAXIMUM SPEED: Skip all account checks (when you know accounts don't exist):**

```bash
bun run index.ts --seed $SEED \
  --nominators 1000 \
  --start-index 30001 \
  --skip-check-account \
  --transfer-batch 1500 \
  --stake-batch 250 \
  --no-wait \
  --quiet
```

This is the fastest possible configuration:

- Assumes accounts ///30001 to ///31000 are available (no checks)
- Uses maximum batch sizes
- Fire-and-forget mode
- No verbose output

**Creating 30,000 nominators efficiently:**

Instead of one massive operation, break it into smaller batches:

```bash
# First batch (accounts ///1 to ///5000)
bun run index.ts --seed $SEED --nominators 5000 --no-wait --quiet

# Second batch (starts from ///5001, skips existing)
bun run index.ts --seed $SEED --nominators 5000 --start-index 5001 --no-wait --quiet

# Third batch (starts from ///10001, skips existing)
bun run index.ts --seed $SEED --nominators 5000 --start-index 10001 --no-wait --quiet

# Continue with more batches...
```

**Maximum speed configuration:**

```bash
bun run index.ts --seed $SEED \
  --nominators 1000 \
  --start-index 20001 \
  --transfer-batch 1500 \
  --stake-batch 250 \
  --check-batch 1000 \
  --parallel-batches 10 \
  --no-wait \
  --quiet
```

### When to Use Each Optimization

- **--start-index**: Always use when continuing from a previous run
- **--skip-check-account**: Use when you're confident accounts don't exist (maximum speed)
- **--no-wait**: Use for bulk operations where you don't need immediate confirmation
- **--quiet**: Use for large operations to reduce console overhead
- **--transfer-batch**: Increase for simple account creation (max ~1500)
- **--stake-batch**: Keep moderate for complex staking operations (max ~250)
- **--parallel-batches**: Use carefully, too many may overwhelm the node

### Important Notes

- **--skip-check-account is dangerous**: Only use if you're certain the account range is empty
- If accounts already exist, transfers will fail and you'll waste transaction fees
- Fire-and-forget mode (`--no-wait`) means transactions are submitted but not confirmed
- You can verify transaction success later using block explorers
- Start with conservative settings and increase gradually
- Monitor your node's performance when using aggressive parallelization
