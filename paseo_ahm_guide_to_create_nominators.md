# Intro

This is a small guide to help to setup 30k nominators for Paseo after RU and before AHM.

Note that 30k accounts have been already created and funded (see [list of fake accounts](paseo_fake_nominators.txt)) via the script so what remains to be done is for each account to let it bond and nominate, ensuring an even distribution of validators.

The 30k accounts are all hard-code derived from `///43` to `///30042` from the account `14iw76ZmY7BzFfBYrTrCnMyAzU5X4LY5jCFN6XuSnTYnzaTe` for which you need to know the seed.
Why 43? I have used the first 42 for testing the tool and you know that 42 is the answer to everything, right?

# Install the tool

```bash
git clone git@github.com:sigurpol/papi-polkadot-populate.git
cd papi-polkadot-populate
bun install
```

Test the everything works fine via

```bash
bun run index.ts --help
Usage: papi-polkadot-populate [options]

Create funded accounts for staking testing on Substrate chains using PAPI

Options:
  -V, --version                        output the version number
  --seed <string>                      Seed phrase, hex seed (0x...), or 'dev' for development seed
  --network <network>                  Target network (paseo, westend-asset-hub)
  --nominators <number>                Number of nominator accounts to create (default: "100")
  --validators-per-nominator <number>  Number of validators each nominator will select (default: "16")
  --validator-start-index <number>     Starting index for round-robin validator selection (for continuing across batches) (default: "0")
  --topup <number>                     Top up accounts to specified token amount
  --from <number>                      Starting account index for topup (inclusive)
  --to <number>                        Ending account index for topup (exclusive)
  --pools <number>                     Number of nomination pools to create (default: "0")
  --pool-members <number>              Number of pool members to create (default: "0")
  --hybrid-stakers <number>            Number of accounts that are both pool members and solo stakers (default: "0")
  --pool-stake <number>                Initial stake amount for each pool in tokens (uses chain MinCreateBond if not specified)
  --member-stake <number>              Stake amount for each pool member in tokens (uses chain MinJoinBond if not specified)
  --pool-commission <number>           Commission percentage for pools (0-100) (default: "10")
  --destroy-pools <range>              Destroy pools created by this tool (e.g., '1-5' or '3,7,9')
  --remove-from-pool <poolId:members>  Remove members from a pool (e.g., '10:addr1,addr2' or '10:all')
  --list-pools                         List all pools created by this tool
  --list-accounts                      List all derived accounts created by this tool
  --fast                               Skip staking info for faster account listing (use with --list-accounts)
  --unbond-accounts <range>            Unbond, stop nominating, and return funds to god account (e.g., '1-5' or '3,7,9')
  --dry-run                            Show what would happen without executing transactions
  --start-index <number>               Start checking from account ///N instead of ///1 (default: "1")
  --skip-check-account                 Skip account existence checks, assume all accounts from start-index are available
  --transfer-batch <number>            Balance transfer batch size (default: 1000, max: 1500)
  --stake-batch <number>               Staking operations batch size (default: 100, max: 250)
  --check-batch <number>               Parallel account existence checks (default: 500)
  --no-wait                            Don't wait for transaction finalization (fire-and-forget mode)
  --parallel-batches <number>          Number of batches to submit concurrently (default: 1, max: 10) (default: "1")
  --quiet                              Suppress per-account logs, show only summaries
  --create-only                        Only create and fund accounts, skip bonding/nominating
  --stake-only                         Only bond/nominate existing accounts, skip account creation
  -h, --help                           display help for command
```

Have a look at [README.md](README.md) to see different parameters and options.

# Create a SEED environment variable

You should have received the seed of the test account `14iw76ZmY7BzFfBYrTrCnMyAzU5X4LY5jCFN6XuSnTYnzaTe` used to create the 30k fake accounts. Create an environment variable e.g. `SEED` where you store the seed.

# Test via --dry-run

Each command supports the `--dry-run` option, which shows what the tool would do w/o actually submitting anything. It's very fast and give you a basic confidence on what the tool will perform for real.

# [Optional - You can skip it] Test Creation and Staking of accounts on WAH

30k accounts are already pre-created via the tool on `Paseo`.
**NOT NEEDED in order to have these 30k accounts on Paseo as nominators** but if you want to experiment with the tool before trying directly on Paseo after RU and before AHM, I suggest you to try on `Westend Asset Hub`.
Don't use the same seed of `14iw76ZmY7BzFfBYrTrCnMyAzU5X4LY5jCFN6XuSnTYnzaTe` since I've already played on WAH with it, just use maybe your own test account on WAH if properly funded (requirements are low in any case for Westend, faucet will suffice for few nominators to be created)

```bash
# Create ten nominators. Set TEST_SEED in advance.
bun run index.ts --seed $TEST_SEED --network westend-asset-hub --nominators 10 --create-only --skip-check --no-wait  # --dry-run
# Let them stake
bun run index.ts --seed $TEST_SEED --network westend-asset-hub --nominators 10 --no-wait  --skip-check-account --stake-only  # --dry-run
```

If you feel adventurous, you can experiment with all the options described in the README.me e.g. with nomination pools, dual staking plus, topping up, removing from pool, unbonding. You can try also to get info via `--list--accounts`, `--list-pools` etc. You can only create and stake in a single shot (just don't use `--create-only` or `--stake-only` option, see README.md)

# Staking 30k accounts on Paseo

## Smoldot for the win, I hope...

Enough with the experiments, back to the core point of this document: let these 30k nominate!
Now, the creation of 30k via the script was a breeze and blazingly fast because it was easy to group and parallelize transactions coming all from the same base account. For staking, we have 30k accounts and each of them needs to submit a request to bond and nominate so optimization is harder.

I have experimented with a single remote RPC and I couldn't really batch stuff without hitting severe rate limiting. Same with a list of round-robin RPC nodes, still not enough to stake 30k accounts in a reasonable time.

`smoldot` for my (limited) tests vs staking on WAH and for my (extensive) test on Paseo for account creation seems to be by far the best solution for our use-case. Probably another alternative would be to rely on a local node but the tool today only supports `smoldot` and not RPC connection. It's trivial to add if you want to experiment with that.

## Let's start

As mentioned early, we want to let each of the accounts in [this list](paseo_fake_nominators.txt) to bond and nominate for accounts from `///43` to `///30042` derived from the usual test account `14iw76ZmY7BzFfBYrTrCnMyAzU5X4LY5jCFN6XuSnTYnzaTe`.

What I would suggest is a gradual approach: let a small bunch of accounts to bond and nominate, check that everything is fine. Increase the size of the batch gradually, potentially extending how many batches in parallel we deal with. Repeat.

For the creation of accounts, I started with creating 10 then 1000 then 5000 then 10k up to 30k and worked seamlessly. Here risks that something goes wrong are much higher and the whole process will also take more time (the creation of 30k itself took 2min or so, just because I was cautious and I did few intermediate steps).

Proposed approach:

```bash
# $SEED must contain the seed of 14iw76ZmY7BzFfBYrTrCnMyAzU5X4LY5jCFN6XuSnTYnzaTe
bun run index.ts --seed $SEED --network paseo --nominators 10 --no-wait --start-index 43 --skip-check-account --stake-only
# check everything is good. Check also on https://paseo.subscan.io/account. If yes try with 100 nominators. If you want to enforce even distribution take note of the index printed as last line by the script e.g. 10 in the example below:
# 📌 Next validator index for future batches: 10
# and use the index in the following command as start validator index for round-robin validator selection via `--validator-start-index` e.g.
bun run index.ts --seed $SEED --network paseo --nominators 100 --no-wait --start-index 53 --skip-check-account --stake-only --validator-start-index 110
# check everything is good. If yes, try with 500 nominators. Again, look at next validator index as printed out in the last line of the script and use it as `--validator-start-index`. Note that you can know the index in advance if you run the command with --dry-run as option before the `real` one. I would suggest at this point to try also `--parallel-batches` (default 1, max 10)
bun run index.ts --seed $SEED --network paseo --nominators 100 --no-wait --start-index 153 --skip-check-account --stake-only  --validator-start-index 60
# scale up more if you , updating start-index. Try to bond and nominate up to 30042
```
Some comments on the parameters on the commands above (look at [solo_nominators](src/solo-nominators.ts) for more details):

- `--no-wait`: fire and forget mode -> no waiting for transaction inclusion. Use it for max throughput, we are probably fine w/o confirmation. Without `--no-wait` (default), we wait for inclusion so we call `signSubmitAndWatch` (potentially in parallel depending on `--parallel-batches`).
- `--stake-batch`: controls how many accounts are processed per batch (default: 100, you can specify more, currently up to 250)
- `--parallel-batches`: controls concurrent transaction submissions (default: 1, max : 10). We could potentially try with more than the default. If we combined  `--no-wait` with `--parallel-batches` > 1, transactions are chunked and submitted in parallel using `Promise.allSettled()`
- `--skip-check-account`: skip check entirely on staking / bonding. I would suggest to have it since we have created these accounts with enough funds to bond and nominate so no point in wasting time to check if the criteria are satisfied or not

Note that I am proposing to just creating `solo nominators` and not a mix of solo nominators, nom pools and dual staking . Reason is: we can't really create new pools on Paseo (max 16 and we have already 16 there and I suggest not to mess up with existing ones).

The tool is pretty verbose in output (you could use `--quiet` option to make but I suggest not to), so you should see step by step what is trying to do and also if something goes wrong (e.g. timeout on request, insufficient funds for a user while staking etc, PAPI errors, etc).

Example of output of a dry-run as reference:

```bash
bun run index.ts --seed $SEED --network paseo --nominators 10 --no-wait --start-index 43 --skip-check-account --stake-only --dry-run

⚠️  WARNING: This will execute REAL transactions on paseo network!
   Use --dry-run flag to test without executing transactions
🔗 Initializing smoldot for paseo...
📡 Adding chain to smoldot (this may take a moment for Asset Hub chains)...
[smoldot] Smoldot v2.0.36
[smoldot] Chain initialization complete for paseo. Name: "Paseo Testnet". Genesis hash: 0x77af…764f. Chain specification starting at: 0x7d5b…0204 (#7426803)
✅ Connected to paseo network
🔑 God account address: 14iw76ZmY7BzFfBYrTrCnMyAzU5X4LY5jCFN6XuSnTYnzaTe
🔍 Querying account balance for paseo (this may take longer for Asset Hub to sync)...
[runtime-paseo] Finalized block runtime ready. Spec version: 1005001. Size of `:code`: 1.9 MiB.
[smoldot] The task named `runtime-paseo` has occupied the CPU for an unreasonable amount of time (189ms).
💰 God account balance: 71550111982861916 (7155011.198286192 PAS) free, 0 (0 PAS) reserved
🥩 STAKE ONLY: Staking 10 existing accounts...
⚡ Processing accounts 43 to 52

🥩 Starting staking and nomination for 10 accounts...
   📊 Using stake batch size of 100
   ⚡ Skip mode: Assuming all accounts are not bonded/nominating (massive speedup)
📊 Found 150 validators on chain
🔄 Starting validator assignment from index: 0
📊 Validator distribution: min=1, max=2 nominations per validator
📊 Total unique validators assigned: 150
   [43] Staking 300 PAS and nominating from 13gEtcU1jb2y2kEmjjV5NWvMR4rvLuDThsPuspPYPppuiV3y
      Selected validators: 16
   [44] Staking 322.2222222222 PAS and nominating from 155crgHcTiEMXUaWWe5iesrmkdJVXoXMcJeTUnKXNgutKFDk
      Selected validators: 16
   [45] Staking 344.4444444444 PAS and nominating from 12HepMxTV7Sd9hckHqYLoxP15cN3wV9J454QGiNFzykGfoEZ
      Selected validators: 16
   [46] Staking 366.6666666666 PAS and nominating from 121ifTrAnnweVUNBkD5X2h4WXX5GxzveQhjHuEmTZAgoQSbn
      Selected validators: 16
   [47] Staking 388.8888888888 PAS and nominating from 13iPAAo413jHEj1f7z4VtucLnf3Xyf4DteC8coQg2tDgC1YU
      Selected validators: 16
   [48] Staking 411.1111111111 PAS and nominating from 16f2QG2zVqxCxvQs8FaEXNzUTJ6TuZoXvdt19wUhBz7UZtbC
      Selected validators: 16
   [49] Staking 433.3333333333 PAS and nominating from 12y1dULfpUc5V6Czij4XZq4zed8QDjQBBko526gyq39S8zDU
      Selected validators: 16
   [50] Staking 455.5555555555 PAS and nominating from 13zRJrJFAniEPVnfgymupwFgoX9rZFFDZdPVwE9SBzKMSnX3
      Selected validators: 16
   [51] Staking 477.7777777777 PAS and nominating from 1656T49vrJNo2m4KWyL74BfvU7a7ZFPT2y3UFe6BLZSRxPra
      Selected validators: 16
   [52] Staking 500 PAS and nominating from 13e3nb7vxaHoGuQpRQJLaG82keEJEsc1QtDiuYT7WoNJdhSa
      Selected validators: 16

🔍 DRY RUN: Would execute batch of 10 stake+nominate operations

📊 Staking Summary:
   - Accounts staked: 10
   - Accounts skipped: 0

📌 Next validator index for future batches: 10

🔌 Disconnecting from network...
[smoldot] Shutting down chain paseo
```

## What if something goes wrong?

As mentioned, the tool is pretty verbose so you should see clearly an error and where things went 🍌.

When it comes to staking, these files you should look at:

1.  [index.ts](index.ts) - the entry point of everything. In particular go to line 477 where stake-only handling starts and where we call `stakeAndNominate` function
2.  [src/solo-nominators.ts](src/solo-nominators.ts) where `stakeAndNominate` function is implemented, in particular the core log is here:

```typescript
// Create bond and nominate transactions
const bondTx = api.tx.Staking.bond({
  value: stakeAmount,
  payee: { type: "Staked", value: undefined },
});

// Convert SS58String[] to MultiAddress[] explicitly for nominate
const validatorTargets = selectedValidators.map((validator) => MultiAddress.Id(validator));
const nominateTx = api.tx.Staking.nominate({ targets: validatorTargets });

// Batch bond and nominate together
const batchTx = api.tx.Utility.batch_all({
  calls: [bondTx.decodedCall, nominateTx.decodedCall],
});
batch.push({ tx: batchTx, signer: account.signer });

stakedCount++;
```

In case of timeout, you might want to play with `--no-wait` option (faster) or without (default, slower but safer) and increase the timeout. Or if you experience issue with --nominators X with X > 100 or 1000, just try to be more conservative and try with small batches.

Good luck!
