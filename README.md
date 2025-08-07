# PAPI Polkadot Populate

A comprehensive tool for creating and managing staking accounts on Substrate chains using [Polkadot API (PAPI)](https://papi.how). This tool can create thousands of nominators, manage nomination pools, and perform account lifecycle operations efficiently.

## Features

- **Multi-Network Support**: Works with Paseo and Westend Asset Hub (extensible to other networks)
- **Solo Staking**: Create funded accounts that bond and nominate validators
- **Nomination Pools**: Create pools, manage members, and hybrid staking scenarios
- **Account Management**: List, unbond, and clean up derived accounts
- **Performance Optimized**: Batch operations, parallel processing, and split-phase execution
- **Comprehensive Validation**: Chain limits checking and smart error handling

## Installation

```bash
bun install
```

## Quick Start

```bash
# Create 5 nominators on Paseo (dry run)
bun run index.ts --seed dev --network paseo --nominators 5 --dry-run

# Create nominators on Westend Asset Hub
bun run index.ts --seed "your seed phrase" --network westend-asset-hub --nominators 10
```

## Core Parameters

### Required Parameters

- **`--seed <string>`** - Funding account seed phrase, hex seed (0x...), or 'dev' for testing
- **`--network <network>`** - Target network: `paseo` or `westend-asset-hub`

### Common Options

- **`--nominators <number>`** - Number of solo nominators to create (default: 100)
- **`--dry-run`** - Preview operations without executing transactions
- **`--validators-per-nominator <number>`** - Validators each nominator selects (default: 16)

## Network Support

The tool supports multiple Substrate chains with automatic configuration:

| Network               | Token | Decimals | SS58 Prefix | Usage                         |
| --------------------- | ----- | -------- | ----------- | ----------------------------- |
| **Paseo**             | PAS   | 10       | 0           | `--network paseo`             |
| **Westend Asset Hub** | WND   | 12       | 42          | `--network westend-asset-hub` |

Each network has specific:

- Token symbols and decimal precision
- Explorer URLs for transaction links
- Unbonding periods and staking parameters
- SS58 address formatting

**Examples:**

```bash
# Paseo testnet
bun run index.ts --seed dev --network paseo --nominators 5

# Westend Asset Hub
bun run index.ts --seed dev --network westend-asset-hub --nominators 5
```

## Solo Staking

Create funded accounts that bond tokens and nominate validators.

### Basic Usage

```bash
# Create 10 nominators on Paseo
bun run index.ts --seed "your seed phrase" --network paseo --nominators 10

# Custom validator selection
bun run index.ts --seed dev --network paseo --nominators 50 --validators-per-nominator 8

# Dry run to preview
bun run index.ts --seed dev --network paseo --nominators 5 --dry-run
```

### Account Logic

- Uses hard-derived accounts: `///1`, `///2`, `///3`, etc.
- Skips existing accounts automatically
- Each account gets: stake amount + existential deposit + transaction fees
- Stakes vary from MinBond + 20% to MinBond + 100% for election diversity

### Split Operations

For large-scale operations, split into two phases for better performance:

```bash
# Phase 1: Create accounts only (fast)
bun run index.ts --seed $SEED --network paseo --nominators 1000 --create-only \
  --skip-check-account --transfer-batch 1000 --no-wait --quiet

# Phase 2: Stake existing accounts
bun run index.ts --seed $SEED --network paseo --stake-only --nominators 1000 \
  --skip-check-account --stake-batch 100 --no-wait --quiet
```

## Nomination Pools

Create and manage nomination pools with comprehensive validation against chain limits.

### Pool Creation

```bash
# Create 3 pools using chain minimums
bun run index.ts --seed dev --network paseo --pools 3

# Custom pool parameters
bun run index.ts --seed dev --network paseo --pools 5 \
  --pool-stake 1000 --pool-commission 5

# Create pools with members
bun run index.ts --seed dev --network paseo --pools 3 --pool-members 20 \
  --member-stake 50
```

### Pool Parameters

- **`--pools <number>`** - Number of pools to create
- **`--pool-members <number>`** - Members to create (requires --pools)
- **`--hybrid-stakers <number>`** - Accounts doing both pool and solo staking
- **`--pool-stake <number>`** - Initial pool stake amount
- **`--member-stake <number>`** - Member stake amount
- **`--pool-commission <number>`** - Commission percentage (default: 10)

### Account Types & Paths

- Pool creators: `//pool/1`, `//pool/2`, etc.
- Pool members: `//member/1`, `//member/2`, etc.
- Hybrid stakers: `//hybrid/1`, `//hybrid/2`, etc.
- Regular nominators: `///1`, `///2`, etc.

### Chain Limits Validation

The tool validates against live chain parameters:

- **MaxPools**: Maximum pools allowed (16 on Paseo)
- **MaxPoolMembersPerPool**: Members per pool (32 on Paseo)
- **MaxPoolMembers**: Total members across all pools (512 on Paseo)

Example validation error:

```bash
❌ Error: Requested 20 pools but only 3 slots available
   Current pools: 13/16
   Reduce --pools to 3 or less
```

### Pool Management

```bash
# List all your pools
bun run index.ts --seed dev --network paseo --list-pools

# Remove members from pool
bun run index.ts --seed dev --network paseo --remove-from-pool "10:all" --dry-run

# Destroy pools
bun run index.ts --seed dev --network paseo --destroy-pools "1-5" --dry-run
```

## Account Management

List and manage all derived accounts created by the tool.

### List Accounts

```bash
# Full account listing with staking info
bun run index.ts --seed dev --network paseo --list-accounts

# Fast mode: balances only (for large numbers)
bun run index.ts --seed dev --network paseo --list-accounts --fast
```

### Unbond Accounts

```bash
# Unbond specific accounts
bun run index.ts --seed dev --network paseo --unbond-accounts "1-10" --dry-run

# Mixed ranges
bun run index.ts --seed dev --network paseo --unbond-accounts "1-5,8,10-15"
```

**Unbonding Process:**

1. Chill (stop nominating)
2. Unbond from solo staking and/or pools
3. Wait unbonding period (network-specific, e.g., 28 days on Paseo)
4. Withdraw funds manually

## Top-up Mode

Ensure accounts have minimum balances:

```bash
# Top up accounts to 250 tokens
bun run index.ts --seed dev --network paseo --topup 250 --from 3 --to 32

# Single account top-up
bun run index.ts --seed dev --network paseo --topup 500 --from 10 --to 11 --dry-run
```

## Performance Optimization

### Key Performance Features

1. **Batch Operations**: Process multiple accounts per transaction
2. **Parallel Processing**: Check hundreds of accounts simultaneously
3. **Skip Checks**: Assume accounts don't exist for maximum speed
4. **Fire-and-Forget**: Submit without waiting for confirmation
5. **Split Operations**: Separate creation from staking

### Performance Parameters

- **`--start-index <number>`** - Skip checking early accounts
- **`--skip-check-account`** - Maximum speed (dangerous: only use if sure accounts don't exist)
- **`--transfer-batch <number>`** - Transfer batch size (default: 1000, max: 1500)
- **`--stake-batch <number>`** - Staking batch size (default: 100, max: 250)
- **`--check-batch <number>`** - Parallel account checks (default: 500)
- **`--no-wait`** - Fire-and-forget mode
- **`--parallel-batches <number>`** - Concurrent batches (default: 1, max: 10)
- **`--quiet`** - Suppress verbose output

### High-Performance Examples

```bash
# Maximum speed configuration
bun run index.ts --seed $SEED --network paseo --nominators 1000 \
  --start-index 30001 --skip-check-account \
  --transfer-batch 1500 --stake-batch 250 --no-wait --quiet

# Conservative parallel processing
bun run index.ts --seed $SEED --network paseo --nominators 500 \
  --transfer-batch 1000 --stake-batch 100 --parallel-batches 3 --quiet
```

### Large-Scale Operations (30,000+ Nominators)

**Two-Phase Approach (Recommended):**

```bash
# Phase 1: Create accounts (optimized for transfers)
for i in {0..29}; do
  start=$((i * 1000 + 1))
  bun run index.ts --seed $SEED --network paseo --nominators 1000 --start-index $start \
    --create-only --skip-check-account --transfer-batch 1000 --no-wait --quiet
done

# Phase 2: Stake accounts (optimized for staking)
for i in {0..29}; do
  start=$((i * 1000 + 1))
  bun run index.ts --seed $SEED --network paseo --stake-only --start-index $start \
    --nominators 1000 --skip-check-account --stake-batch 100 --no-wait --quiet
done
```

## Advanced Examples

### Complete Pool Ecosystem

```bash
# Create comprehensive pool setup
bun run index.ts --seed dev --network paseo \
  --pools 10 --pool-members 100 --hybrid-stakers 20 \
  --pool-stake 500 --member-stake 25 --pool-commission 5
```

### Mixed Staking Scenarios

```bash
# Solo nominators + pools + hybrids
bun run index.ts --seed dev --network paseo \
  --nominators 50 --pools 3 --pool-members 20 --hybrid-stakers 10
```

### Validator Distribution

The tool uses round-robin validator selection for even distribution:

```bash
# First batch
bun run index.ts --seed dev --network paseo --nominators 1000
# Output: "Next validator index: 16"

# Second batch continues distribution
bun run index.ts --seed dev --network paseo --nominators 1000 --validator-start-index 16
```

## Network-Specific Considerations

### Paseo Testnet

- Token: PAS (10 decimals)
- Unbonding period: 28 days
- Pool limits: 16 pools, 32 members/pool, 512 total members
- Explorer: <https://paseo.subscan.io>

### Westend Asset Hub

- Token: WND (12 decimals)
- Unbonding period: 7 days
- Pool limits: Network-dependent
- Explorer: <https://westmint.subscan.io>

## Error Handling

The tool provides comprehensive error handling:

- **Chain Limit Validation**: Prevents exceeding network constraints
- **Balance Verification**: Ensures sufficient god account funds
- **Account Existence**: Skips existing accounts automatically
- **Transaction Failures**: Graceful handling with clear error messages
- **Network-Specific**: Tailored messages for each supported network

## Troubleshooting

### Common Issues

**"Unsupported network" Error:**

```bash
❌ Unsupported network: invalid. Supported networks: paseo, westend-asset-hub
```

Use `--network paseo` or `--network westend-asset-hub`

**Chain Limit Errors:**

```bash
❌ Requested 20 pools but only 3 slots available
```

Reduce the requested amount or clean up existing pools/members

**Insufficient Funds:**
Ensure your god account has adequate balance for the requested operations

### Performance Tips

1. **Start Small**: Test with small numbers before large operations
2. **Use Dry Run**: Always preview operations first
3. **Monitor Resources**: Watch node performance with aggressive parallelization
4. **Split Large Jobs**: Use two-phase approach for 10,000+ accounts
5. **Conservative Batches**: Start with default batch sizes

## Contributing

This project uses:

- [PAPI](https://papi.how) for type-safe Substrate chain interactions
- [Bun](https://bun.sh) for fast JavaScript runtime
- [Smoldot](https://github.com/smol-dot/smoldot) for light client connectivity

### Adding New Networks

1. Add network to PAPI: `npx papi add <chain> -n <network-name>`
2. Update `src/network-config.ts` with network parameters
3. Test with dry-run operations

## License

[License information]

## Inspiration

Inspired by [polkadot-populate](https://github.com/shawntabrizi/polkadot-populate) but built with modern PAPI for better type safety and performance.
