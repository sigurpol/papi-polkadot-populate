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
    const topupAmount = options.topup ? parseFloat(options.topup) : null;
    const fromIndex = options.from ? parseInt(options.from) : null;
    const toIndex = options.to ? parseInt(options.to) : null;
    const poolCount = options.pools ? parseInt(options.pools) : 0;
    const memberCount = options.poolMembers ? parseInt(options.poolMembers) : 0;
    const hybridCount = options.hybridStakers ? parseInt(options.hybridStakers) : 0;
    const _poolStake = options.poolStake ? parseFloat(options.poolStake) : null;
    const _memberStake = options.memberStake ? parseFloat(options.memberStake) : null;
    const _commission = options.poolCommission ? parseInt(options.poolCommission) : 10;

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
        // Check if we need to create accounts first
        console.log(`🚀 Starting population with ${numNominators} nominators...`);

        // Get staking parameters
        const minNominatorBond = await api.query.Staking.MinNominatorBond.getValue();

        // Calculate staking parameters
        const stakeRange = minNominatorBond / 2n; // Vary stake amounts by up to 50%
        const fixedBufferPerAccount = minNominatorBond / 10n; // 10% buffer for fees

        const stakeAmounts = new Map<number, bigint>();
        const createdAccountIndices: number[] = [];

        // Create accounts
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
          isDryRun
        );

        // Stake and nominate
        if (createdAccountIndices.length > 0) {
          await stakeAndNominate(
            api,
            derive,
            createdAccountIndices,
            stakeAmounts,
            validatorsPerNominator,
            PAS,
            isDryRun
          );
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
