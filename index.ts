#!/usr/bin/env node

// PAPI Polkadot Populate - Modular version
import { Command } from "commander";

// Import modules
import { setupApiAndConnection, cleanup } from "./src/common.js";
import { parsePoolRange } from "./src/utils.js";
import { createAccounts, stakeAndNominate, topupAccounts } from "./src/solo-nominators.js";
import { destroyPools, listPools, removeFromPool } from "./src/nomination-pools.js";
import { listAccounts, unbondAccounts } from "./src/account-management.js";
import { createPools, createPoolMembers, createHybridStakers } from "./src/pool-creation.js";
import { SUPPORTED_NETWORKS } from "./src/network-config.js";

// Set up CLI argument parsing
const program = new Command();

program
  .name("papi-polkadot-populate")
  .description("Create funded accounts for staking testing on Substrate chains using PAPI")
  .version("2.0.0")
  .requiredOption("--seed <string>", "Seed phrase, hex seed (0x...), or 'dev' for development seed")
  .requiredOption("--network <network>", `Target network (${SUPPORTED_NETWORKS.join(", ")})`)
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
  .option("--topup <number>", "Top up accounts to specified token amount")
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
    "Initial stake amount for each pool in tokens (uses chain MinCreateBond if not specified)"
  )
  .option(
    "--member-stake <number>",
    "Stake amount for each pool member in tokens (uses chain MinJoinBond if not specified)"
  )
  .option("--pool-commission <number>", "Commission percentage for pools (0-100)", "10")
  .option("--destroy-pools <range>", "Destroy pools created by this tool (e.g., '1-5' or '3,7,9')")
  .option(
    "--remove-from-pool <poolId:members>",
    "Remove members from a pool (e.g., '10:addr1,addr2' or '10:all')"
  )
  .option("--list-pools", "List all pools created by this tool")
  .option("--list-accounts", "List all derived accounts created by this tool")
  .option("--fast", "Skip staking info for faster account listing (use with --list-accounts)")
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
  const network = options.network;
  const isDryRun = options.dryRun || false;

  // Determine operation mode
  const isListAccountsMode = options.listAccounts === true;
  const isUnbondMode = options.unbondAccounts !== undefined;
  const isListMode = options.listPools === true;
  const isRemoveMode = options.removeFromPool !== undefined;
  const isDestroyMode = options.destroyPools !== undefined;

  if (isListAccountsMode) {
    // List derived accounts created by this tool
    const fastMode = options.fast === true;
    await listAccounts(godSeed, fastMode, network);
  } else if (isUnbondMode) {
    // Parse and validate account range
    try {
      const accountIds = parsePoolRange(options.unbondAccounts);
      console.log(`Parsed account indices to unbond: ${accountIds.join(", ")}`);

      // Execute account unbonding
      await unbondAccounts(accountIds, isDryRun, godSeed, network);
    } catch (error) {
      console.error("❌ Error parsing account range:", error);
      console.error("   Valid formats: '1-5' (range), '3,7,9' (list), or '1-3,7,10-12' (mixed)");
      process.exit(1);
    }
  } else if (isListMode) {
    // List pools created by this tool
    await listPools(godSeed, network);
  } else if (isRemoveMode) {
    // Remove members from pool
    await removeFromPool(options.removeFromPool, isDryRun, godSeed, network);
  } else if (isDestroyMode) {
    // Parse and validate pool range
    try {
      const poolIds = parsePoolRange(options.destroyPools);
      console.log(`Parsed pool IDs to destroy: ${poolIds.join(", ")}`);

      // Execute pool destruction
      await destroyPools(poolIds, isDryRun, godSeed, network);
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
      const { api, godSigner, derive, tokenUnit, smoldot, client } = await setupApiAndConnection(
        godSeed,
        network
      );
      try {
        const targetAmountPlanck = (tokenUnit * BigInt(Math.floor(topupAmount * 100))) / 100n;
        await topupAccounts(
          api,
          godSigner,
          derive,
          targetAmountPlanck,
          fromIndex,
          toIndex,
          tokenUnit,
          isDryRun
        );
      } finally {
        cleanup(smoldot, client);
      }
    } else if (isPoolMode) {
      console.log(
        `🏊 Starting pool operations with ${poolCount} pools, ${memberCount} members, ${hybridCount} hybrids...`
      );

      const { api, godSigner, derive, tokenUnit, smoldot, client } = await setupApiAndConnection(
        godSeed,
        network
      );
      try {
        let createdPoolIds: number[] = [];
        let nextValidatorIndex = validatorStartIndex;

        // Validate pool mode requirements
        if (memberCount > 0 && poolCount === 0) {
          console.error("❌ Error: --pool-members requires --pools to be specified");
          console.error("   Pool members can only join newly created pools");
          process.exit(1);
        }

        if (hybridCount > 0 && poolCount === 0) {
          console.error("❌ Error: --hybrid-stakers  requires --pools to be specified");
          console.error("   Hybrid stakers need pools to join");
          process.exit(1);
        }

        // Validate chain limits before starting operations
        if (poolCount > 0 || memberCount > 0 || hybridCount > 0) {
          console.log("🔍 Checking chain limits and existing pools...");
          const [maxPools, maxPoolMembersPerPool, maxPoolMembers, existingPools, existingMembers] =
            await Promise.all([
              (api.query.NominationPools as any).MaxPools.getValue(),
              (api.query.NominationPools as any).MaxPoolMembersPerPool.getValue(),
              (api.query.NominationPools as any).MaxPoolMembers.getValue(),
              (api.query.NominationPools as any).BondedPools.getEntries(),
              (api.query.NominationPools as any).PoolMembers.getEntries(),
            ]);

          const currentPoolCount = existingPools.filter((entry: any) => entry.value).length;
          const currentMemberCount = existingMembers.length;
          const availablePools = Number(maxPools) - currentPoolCount;
          const availableMemberSlots = Number(maxPoolMembers) - currentMemberCount;

          console.log(`   📊 Current network state:`);
          console.log(`      - Existing pools: ${currentPoolCount}/${maxPools}`);
          console.log(`      - Existing pool members: ${currentMemberCount}/${maxPoolMembers}`);
          console.log(`      - Available pool slots: ${availablePools}`);
          console.log(`      - Available member slots: ${availableMemberSlots}`);

          // Check pool count limit against available slots
          if (poolCount > availablePools) {
            console.error(
              `❌ Error: Requested ${poolCount} pools but only ${availablePools} slots available`
            );
            console.error(`   Current pools: ${currentPoolCount}/${maxPools}`);
            if (availablePools > 0) {
              console.error(`   Reduce --pools to ${availablePools} or less`);
            } else {
              console.error(`   Cannot create any pools - chain is at maximum capacity`);
              console.error(`   Consider destroying existing pools first with --destroy-pools`);
            }
            process.exit(1);
          }

          // Check members per pool limit
          if (poolCount > 0 && memberCount > 0) {
            const membersPerPool = Math.ceil(memberCount / poolCount);
            if (membersPerPool > Number(maxPoolMembersPerPool)) {
              console.error(
                `❌ Error: ${membersPerPool} members per pool exceeds chain limit of ${maxPoolMembersPerPool}`
              );
              console.error(
                `   With ${poolCount} pools and ${memberCount} members, each pool would have ~${membersPerPool} members`
              );
              console.error(`   Either increase --pools or reduce --pool-members`);
              process.exit(1);
            }
          }

          // Check total pool members limit against available slots (including hybrid stakers who are also pool members)
          const totalPoolMembers = memberCount + hybridCount;
          if (totalPoolMembers > availableMemberSlots) {
            console.error(
              `❌ Error: Requested ${totalPoolMembers} pool members but only ${availableMemberSlots} slots available`
            );
            console.error(`   Current members: ${currentMemberCount}/${maxPoolMembers}`);
            console.error(`   --pool-members: ${memberCount}, --hybrid-stakers: ${hybridCount}`);
            if (availableMemberSlots > 0) {
              console.error(`   Reduce the total to ${availableMemberSlots} or less`);
            } else {
              console.error(`   Cannot create any pool members - chain is at maximum capacity`);
              console.error(`   Consider removing existing members first with --remove-from-pool`);
            }
            process.exit(1);
          }

          console.log(`✅ Chain limits validation passed:`);
          console.log(
            `   - Will create ${poolCount} pools (${availablePools - poolCount} slots remaining)`
          );
          if (totalPoolMembers > 0) {
            console.log(
              `   - Will create ${totalPoolMembers} pool members (${availableMemberSlots - totalPoolMembers} slots remaining)`
            );
            if (poolCount > 0 && memberCount > 0) {
              const membersPerPool = Math.ceil(memberCount / poolCount);
              console.log(`   - Members per pool: ~${membersPerPool}/${maxPoolMembersPerPool}`);
            }
          }
        }

        // Step 1: Create nomination pools
        if (poolCount > 0) {
          const poolStakeAmount = _poolStake
            ? (tokenUnit * BigInt(Math.floor(_poolStake * 100))) / 100n
            : null;

          const poolResult = await createPools(
            api,
            godSigner,
            derive,
            poolCount,
            poolStakeAmount,
            _commission,
            tokenUnit,
            isDryRun,
            noWait,
            quiet
          );

          createdPoolIds = poolResult.createdPools;

          if (createdPoolIds.length === 0 && !isDryRun) {
            console.error("❌ No pools were created successfully");
            process.exit(1);
          }

          // Get actual pool IDs from chain for non-dry-run
          if (!isDryRun && createdPoolIds.length > 0) {
            // In a real implementation, we'd query the chain to get the actual pool IDs
            // For now, we'll assume pools are created with sequential IDs
            const allPools = await (api.query.NominationPools as any).BondedPools.getEntries();
            const recentPools = allPools
              .filter((entry: any) => entry.value) // Filter out null entries
              .map((entry: any) => entry.keyArgs[0]) // Get pool IDs
              .sort((a: any, b: any) => b - a) // Sort descending (most recent first)
              .slice(0, poolCount); // Take the most recent pools

            if (recentPools.length > 0) {
              createdPoolIds = recentPools.reverse(); // Reverse to get ascending order
              console.log(`📊 Using pool IDs: ${createdPoolIds.join(", ")}`);
            }
          } else if (isDryRun) {
            // For dry run, simulate pool IDs
            createdPoolIds = Array.from({ length: poolCount }, (_, i) => i + 1);
          }
        }

        // Step 2: Create pool members
        if (memberCount > 0 && createdPoolIds.length > 0) {
          const memberStakeAmount = _memberStake
            ? (tokenUnit * BigInt(Math.floor(_memberStake * 100))) / 100n
            : null;

          await createPoolMembers(
            api,
            godSigner,
            derive,
            memberCount,
            memberStakeAmount,
            createdPoolIds,
            tokenUnit,
            isDryRun,
            noWait,
            quiet
          );
        }

        // Step 3: Create hybrid stakers
        if (hybridCount > 0 && createdPoolIds.length > 0) {
          const memberStakeAmount = _memberStake
            ? (tokenUnit * BigInt(Math.floor(_memberStake * 100))) / 100n
            : null;
          const soloStakeAmount = null; // Use chain minimum + buffer

          const hybridResult = await createHybridStakers(
            api,
            godSigner,
            derive,
            hybridCount,
            memberStakeAmount,
            soloStakeAmount,
            createdPoolIds,
            validatorsPerNominator,
            nextValidatorIndex,
            tokenUnit,
            isDryRun,
            noWait,
            quiet
          );

          nextValidatorIndex = hybridResult.nextValidatorIndex || nextValidatorIndex;
        }

        console.log(`\n✅ Pool operations completed successfully!`);
        if (nextValidatorIndex !== validatorStartIndex) {
          console.log(`📌 Next validator index for future operations: ${nextValidatorIndex}`);
        }
      } finally {
        cleanup(smoldot, client);
      }
    } else {
      // Execute solo nominator mode
      const { api, godSigner, derive, tokenUnit, smoldot, client } = await setupApiAndConnection(
        godSeed,
        network
      );
      try {
        // Get staking parameters
        const minNominatorBond = await (api.query.Staking as any).MinNominatorBond.getValue();

        // Calculate staking parameters
        const baseBuffer = minNominatorBond / 5n; // 20% base buffer (50 PAS if minBond is 250)
        const stakeRange = (minNominatorBond * 4n) / 5n; // 80% of minBond as range (200 PAS if minBond is 250)
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
            tokenUnit,
            isDryRun,
            transferBatch,
            startIndex,
            checkBatch,
            noWait,
            parallelBatches,
            quiet,
            skipCheckAccount,
            baseBuffer
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
            const stakeAmount = minNominatorBond + baseBuffer + variableAmount;
            stakeAmounts.set(accountIndex, stakeAmount);
          }

          const result = await stakeAndNominate(
            api,
            derive,
            createdAccountIndices,
            stakeAmounts,
            validatorsPerNominator,
            validatorStartIndex,
            tokenUnit,
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
            tokenUnit,
            isDryRun,
            transferBatch,
            startIndex,
            checkBatch,
            noWait,
            parallelBatches,
            quiet,
            skipCheckAccount,
            baseBuffer
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
              tokenUnit,
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
