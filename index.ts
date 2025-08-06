#!/usr/bin/env node

// PAPI Polkadot Populate - Modular version
import { Command } from "commander";

// Import modules
import { setupApiAndConnection, cleanup } from "./src/common.js";
import { parsePoolRange } from "./src/utils.js";
import { createAccounts, stakeAndNominate, topupAccounts } from "./src/solo-nominators.js";
import { destroyPools, listPools, removeFromPool } from "./src/nomination-pools.js";
import { listAccounts, unbondAccounts } from "./src/account-management.js";

// Set up CLI argument parsing
const program = new Command();

program
  .name("papi-polkadot-populate")
  .description("Create funded accounts for staking testing on Substrate chains using PAPI")
  .version("2.0.0")
  .requiredOption("--seed <string>", "Seed phrase, hex seed (0x...), or 'dev' for development seed")
  .option("--nominators <number>", "Number of nominator accounts to create", "100")
  .option(
    "--validators-per-nominator <number>",
    "Number of validators each nominator will select",
    "16"
  )
  .option(
    "--validator-start-index <number>",
    "Starting index for round-robin validator selection (for continuing across batches)",
    "0"
  )
  .option("--topup <number>", "Top up accounts to specified PAS amount")
  .option("--from <number>", "Starting account index for topup (inclusive)")
  .option("--to <number>", "Ending account index for topup (exclusive)")
  .option("--pools <number>", "Number of nomination pools to create", "0")
  .option("--pool-members <number>", "Number of pool members to create", "0")
  .option(
    "--hybrid-stakers <number>",
    "Number of accounts that are both pool members and solo stakers",
    "0"
  )
  .option(
    "--pool-stake <number>",
    "Initial stake amount for each pool in PAS (uses chain MinCreateBond if not specified)"
  )
  .option(
    "--member-stake <number>",
    "Stake amount for each pool member in PAS (uses chain MinJoinBond if not specified)"
  )
  .option("--pool-commission <number>", "Commission percentage for pools (0-100)", "10")
  .option("--destroy-pools <range>", "Destroy pools created by this tool (e.g., '1-5' or '3,7,9')")
  .option(
    "--remove-from-pool <poolId:members>",
    "Remove members from a pool (e.g., '10:addr1,addr2' or '10:all')"
  )
  .option("--list-pools", "List all pools created by this tool")
  .option("--list-accounts", "List all derived accounts created by this tool")
  .option(
    "--unbond-accounts <range>",
    "Unbond, stop nominating, and return funds to god account (e.g., '1-5' or '3,7,9')"
  )
  .option("--dry-run", "Show what would happen without executing transactions")
  // Performance optimization options
  .option("--start-index <number>", "Start checking from account ///N instead of ///1", "1")
  .option(
    "--skip-check-account",
    "Skip account existence checks, assume all accounts from start-index are available"
  )
  .option("--transfer-batch <number>", "Balance transfer batch size (default: 1000, max: 1500)")
  .option("--stake-batch <number>", "Staking operations batch size (default: 100, max: 250)")
  .option("--check-batch <number>", "Parallel account existence checks (default: 500)")
  .option("--no-wait", "Don't wait for transaction finalization (fire-and-forget mode)")
  .option(
    "--parallel-batches <number>",
    "Number of batches to submit concurrently (default: 1, max: 10)",
    "1"
  )
  .option("--quiet", "Suppress per-account logs, show only summaries")
  // Split operation modes
  .option("--create-only", "Only create and fund accounts, skip bonding/nominating")
  .option("--stake-only", "Only bond/nominate existing accounts, skip account creation")
  .parse(process.argv);

const options = program.opts();

async function main() {
  // Parse options
  const godSeed = options.seed;
  const isDryRun = options.dryRun || false;

  // Determine operation mode
  const isListAccountsMode = options.listAccounts === true;
  const isUnbondMode = options.unbondAccounts !== undefined;
  const isListMode = options.listPools === true;
  const isRemoveMode = options.removeFromPool !== undefined;
  const isDestroyMode = options.destroyPools !== undefined;

  if (isListAccountsMode) {
    // List derived accounts created by this tool
    await listAccounts(godSeed);
  } else if (isUnbondMode) {
    // Parse and validate account range
    try {
      const accountIds = parsePoolRange(options.unbondAccounts);
      console.log(`Parsed account indices to unbond: ${accountIds.join(", ")}`);

      // Execute account unbonding
      await unbondAccounts(accountIds, isDryRun, godSeed);
    } catch (error) {
      console.error("❌ Error parsing account range:", error);
      console.error("   Valid formats: '1-5' (range), '3,7,9' (list), or '1-3,7,10-12' (mixed)");
      process.exit(1);
    }
  } else if (isListMode) {
    // List pools created by this tool
    await listPools(godSeed);
  } else if (isRemoveMode) {
    // Remove members from pool
    await removeFromPool(options.removeFromPool, isDryRun, godSeed);
  } else if (isDestroyMode) {
    // Parse and validate pool range
    try {
      const poolIds = parsePoolRange(options.destroyPools);
      console.log(`Parsed pool IDs to destroy: ${poolIds.join(", ")}`);

      // Execute pool destruction
      await destroyPools(poolIds, isDryRun, godSeed);
    } catch (error) {
      console.error("❌ Error parsing pool range:", error);
      console.error("   Valid formats: '1-5' (range), '3,7,9' (list), or '1-3,7,10-12' (mixed)");
      process.exit(1);
    }
  } else {
    // Parse other mode options
    const numNominators = parseInt(options.nominators);
    const validatorsPerNominator = parseInt(options.validatorsPerNominator);
    const validatorStartIndex = parseInt(options.validatorStartIndex);
    const topupAmount = options.topup ? parseFloat(options.topup) : null;
    const fromIndex = options.from ? parseInt(options.from) : null;
    const toIndex = options.to ? parseInt(options.to) : null;
    const poolCount = options.pools ? parseInt(options.pools) : 0;
    const memberCount = options.poolMembers ? parseInt(options.poolMembers) : 0;
    const hybridCount = options.hybridStakers ? parseInt(options.hybridStakers) : 0;
    const _poolStake = options.poolStake ? parseFloat(options.poolStake) : null;
    const _memberStake = options.memberStake ? parseFloat(options.memberStake) : null;
    const _commission = options.poolCommission ? parseInt(options.poolCommission) : 10;

    // Parse performance options
    const startIndex = parseInt(options.startIndex);
    const skipCheckAccount = options.skipCheckAccount === true;
    const transferBatch = options.transferBatch ? parseInt(options.transferBatch) : undefined;
    const stakeBatch = options.stakeBatch ? parseInt(options.stakeBatch) : undefined;
    const checkBatch = options.checkBatch ? parseInt(options.checkBatch) : undefined;
    const noWait = options.noWait === true;
    const parallelBatches = parseInt(options.parallelBatches);
    const quiet = options.quiet === true;

    // Parse split operation options
    const createOnly = options.createOnly === true;
    const stakeOnly = options.stakeOnly === true;

    // Validate mutually exclusive options
    if (createOnly && stakeOnly) {
      console.error("❌ Error: --create-only and --stake-only cannot be used together");
      process.exit(1);
    }

    // Determine operation mode
    const isTopupMode = topupAmount !== null;
    const isPoolMode = poolCount > 0 || memberCount > 0 || hybridCount > 0;

    if (isTopupMode) {
      // Validate top-up options
      if (fromIndex === null || toIndex === null) {
        console.error("❌ Error: --topup requires both --from and --to options");
        console.error("   Example: --topup 250 --from 3 --to 32");
        process.exit(1);
      }

      // Execute topup mode
      const { api, godSigner, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);
      try {
        const targetAmountPlanck = (PAS * BigInt(Math.floor(topupAmount * 100))) / 100n;
        await topupAccounts(
          api,
          godSigner,
          derive,
          targetAmountPlanck,
          fromIndex,
          toIndex,
          PAS,
          isDryRun
        );
      } finally {
        cleanup(smoldot, client);
      }
    } else if (isPoolMode) {
      console.log("🚧 Pool mode not yet fully implemented in modular version");
      console.log("Available pool commands:");
      console.log("  --list-pools");
      console.log("  --remove-from-pool <poolId:members>");
      console.log("  --destroy-pools <range>");
      process.exit(1);
    } else {
      // Execute solo nominator mode
      const { api, godSigner, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);
      try {
        // Get staking parameters
        const minNominatorBond = await api.query.Staking.MinNominatorBond.getValue();

        // Calculate staking parameters
        const stakeRange = minNominatorBond / 2n; // Vary stake amounts by up to 50%
        const fixedBufferPerAccount = minNominatorBond / 10n; // 10% buffer for fees

        const stakeAmounts = new Map<number, bigint>();
        const createdAccountIndices: number[] = [];

        if (createOnly) {
          // CREATE ONLY MODE: Only create accounts, skip staking
          console.log(`🚀 CREATE ONLY: Creating ${numNominators} accounts...`);
          if (startIndex > 1) {
            console.log(
              `⚡ Starting from account index ${startIndex} (skipping ${startIndex - 1} accounts)`
            );
          }

          await createAccounts(
            api,
            godSigner,
            derive,
            numNominators,
            minNominatorBond,
            stakeRange,
            fixedBufferPerAccount,
            stakeAmounts,
            createdAccountIndices,
            PAS,
            isDryRun,
            transferBatch,
            startIndex,
            checkBatch,
            noWait,
            parallelBatches,
            quiet,
            skipCheckAccount
          );

          console.log(
            `✅ Account creation completed. ${createdAccountIndices.length} accounts created.`
          );
          console.log(`📌 To stake these accounts later, use:`);
          console.log(`   --stake-only --start-index ${startIndex} --nominators ${numNominators}`);
        } else if (stakeOnly) {
          // STAKE ONLY MODE: Only stake existing accounts, skip creation
          console.log(`🥩 STAKE ONLY: Staking ${numNominators} existing accounts...`);
          console.log(`⚡ Processing accounts ${startIndex} to ${startIndex + numNominators - 1}`);

          // Generate account indices and stake amounts for existing accounts
          for (let i = 0; i < numNominators; i++) {
            const accountIndex = startIndex + i;
            createdAccountIndices.push(accountIndex);

            // Calculate same stake amount as during creation
            const variableAmount = (stakeRange * BigInt(i % 10)) / 9n;
            const stakeAmount = minNominatorBond + variableAmount;
            stakeAmounts.set(accountIndex, stakeAmount);
          }

          const result = await stakeAndNominate(
            api,
            derive,
            createdAccountIndices,
            stakeAmounts,
            validatorsPerNominator,
            validatorStartIndex,
            PAS,
            isDryRun,
            stakeBatch,
            noWait,
            parallelBatches,
            quiet,
            skipCheckAccount
          );

          if (result) {
            console.log(
              `\n📌 Next validator index for future batches: ${result.nextValidatorIndex}`
            );
          }
        } else {
          // DEFAULT MODE: Both create and stake (original behavior)
          console.log(`🚀 Starting population with ${numNominators} nominators...`);
          if (startIndex > 1) {
            console.log(
              `⚡ Starting from account index ${startIndex} (skipping ${startIndex - 1} accounts)`
            );
          }

          // Create accounts with performance options
          await createAccounts(
            api,
            godSigner,
            derive,
            numNominators,
            minNominatorBond,
            stakeRange,
            fixedBufferPerAccount,
            stakeAmounts,
            createdAccountIndices,
            PAS,
            isDryRun,
            transferBatch,
            startIndex,
            checkBatch,
            noWait,
            parallelBatches,
            quiet,
            skipCheckAccount
          );

          // Stake and nominate
          if (createdAccountIndices.length > 0) {
            const result = await stakeAndNominate(
              api,
              derive,
              createdAccountIndices,
              stakeAmounts,
              validatorsPerNominator,
              validatorStartIndex,
              PAS,
              isDryRun,
              stakeBatch,
              noWait,
              parallelBatches,
              quiet,
              skipCheckAccount
            );

            if (result) {
              console.log(
                `\n📌 Next validator index for future batches: ${result.nextValidatorIndex}`
              );
            }
          }
        }
      } finally {
        cleanup(smoldot, client);
      }
    }
  }
}

// Run the main function
main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
