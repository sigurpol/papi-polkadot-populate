// Simple nomination pool creation functionality
import { MultiAddress } from "@polkadot-api/descriptors";
import type { SS58String } from "polkadot-api";
import type { TypedApi, DeriveFunction, Signer, TransactionEvent } from "./types.js";
import {
  getPoolAccountAtIndex,
  getPoolMemberAccountAtIndex,
  getHybridAccountAtIndex,
} from "./utils.js";

// Fetch pool parameters and limits from chain
async function fetchPoolParameters(api: TypedApi) {
  const [minCreateBond, minJoinBond, maxPools, maxPoolMembersPerPool, maxPoolMembers] =
    await Promise.all([
      api.query.NominationPools.MinCreateBond.getValue(),
      api.query.NominationPools.MinJoinBond.getValue(),
      api.query.NominationPools.MaxPools.getValue(),
      api.query.NominationPools.MaxPoolMembersPerPool.getValue(),
      api.query.NominationPools.MaxPoolMembers.getValue(),
    ]);

  return {
    minCreateBond,
    minJoinBond,
    maxPools: Number(maxPools),
    maxPoolMembersPerPool: Number(maxPoolMembersPerPool),
    maxPoolMembers: Number(maxPoolMembers),
  };
}

// Helper function to execute a transaction with proper error handling
async function executeTransaction(
  tx: any,
  signer: Signer,
  description: string,
  quiet: boolean,
  noWait = false
): Promise<void> {
  if (noWait) {
    try {
      const txHash = await tx.signAndSubmit(signer);
      if (!quiet) {
        console.log(`   📋 ${description} submitted: ${txHash}`);
      }
    } catch (error) {
      console.error(`   ❌ ${description} failed:`, error);
      throw error;
    }
    return;
  }

  return new Promise<void>((resolve, reject) => {
    let completed = false;
    let subscription: { unsubscribe: () => void } | null = null;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        console.log(`   ⚠️ ${description} timeout`);
        if (subscription) {
          try {
            subscription.unsubscribe();
          } catch {}
        }
        resolve(); // Don't reject on timeout, might have succeeded
      }
    }, 30000);

    subscription = tx.signSubmitAndWatch(signer).subscribe({
      next: (event: TransactionEvent) => {
        if (event.type === "txBestBlocksState") {
          if (!quiet) {
            console.log(`   ✅ ${description} successful`);
          }
          if (!completed) {
            completed = true;
            clearTimeout(timeout);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            resolve();
          }
        }
      },
      error: (error: Error) => {
        if (!completed) {
          completed = true;
          clearTimeout(timeout);

          const errorMessage = error.message || error.toString();
          const isInfrastructureError =
            errorMessage.includes("ChainHead operation inaccessible") ||
            errorMessage.includes("OperationInaccessibleError");

          if (isInfrastructureError) {
            console.warn(`   ⚠️ ${description} infrastructure error (may have succeeded)`);
            resolve();
          } else {
            console.error(`   ❌ ${description} failed:`, error);
            reject(error);
          }

          if (subscription) {
            try {
              subscription.unsubscribe();
            } catch {}
          }
        }
      },
    });
  });
}

// Simple function to create nomination pools
export async function createPools(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  poolCount: number,
  poolStake: bigint | null,
  commission: number,
  tokenUnit: bigint,
  tokenSymbol: string,
  isDryRun: boolean,
  noWait = false,
  quiet = false
) {
  const poolParams = await fetchPoolParameters(api);

  // Safety check against chain limits (main validation should be done in caller)
  if (poolCount > poolParams.maxPools) {
    console.error(`❌ Pool count ${poolCount} exceeds limit ${poolParams.maxPools}`);
    return { createdPools: [], totalFundingNeeded: 0n };
  }

  const actualPoolStake = poolStake || poolParams.minCreateBond;
  const fundingBuffer = actualPoolStake / 10n; // 10% buffer for fees

  if (!quiet) {
    console.log(`\n🏊 Creating ${poolCount} nomination pools...`);
    console.log(
      `   📊 Pool stake: ${Number(actualPoolStake) / Number(tokenUnit)} ${tokenSymbol} each`
    );
    console.log(`   📊 Commission: ${commission}%`);
    console.log(
      `   📊 Chain limits: ${poolParams.maxPools} max pools, ${poolParams.maxPoolMembersPerPool} max members per pool`
    );
  }

  let totalFundingNeeded = 0n;
  const createdPools: number[] = [];

  // Create pools one by one (simple approach for small numbers)
  for (let i = 1; i <= poolCount; i++) {
    const poolAccount = getPoolAccountAtIndex(i, derive);
    const fundingAmount = actualPoolStake + fundingBuffer;
    totalFundingNeeded += fundingAmount;

    if (isDryRun) {
      console.log(`   🔍 DRY RUN: Would create pool ${i} with ${poolAccount.address}`);
      createdPools.push(i);
      continue;
    }

    if (!quiet) {
      console.log(`\n⚡ Creating pool ${i}/${poolCount} (${poolAccount.address})...`);
    }

    try {
      // 1. Fund the pool creator account
      const fundTx = api.tx.Balances.transfer_allow_death({
        dest: MultiAddress.Id(poolAccount.address),
        value: fundingAmount,
      });

      await executeTransaction(fundTx, godSigner, `Fund pool ${i} creator`, quiet, noWait);

      // 2. Create the pool
      const createPoolTx = api.tx.NominationPools.create({
        amount: actualPoolStake,
        root: MultiAddress.Id(poolAccount.address),
        nominator: MultiAddress.Id(poolAccount.address),
        bouncer: MultiAddress.Id(poolAccount.address),
      });

      await executeTransaction(createPoolTx, poolAccount.signer, `Create pool ${i}`, quiet, noWait);

      createdPools.push(i);
    } catch (error) {
      console.error(`   ❌ Failed to create pool ${i}:`, error);
      // Continue with next pool
    }
  }

  console.log(`\n📊 Pool Creation Summary:`);
  console.log(`   - Pools requested: ${poolCount}`);
  console.log(`   - Pools created: ${createdPools.length}`);
  console.log(
    `   - Total funding used: ${Number(totalFundingNeeded) / Number(tokenUnit)} ${tokenSymbol}`
  );

  return { createdPools, totalFundingNeeded };
}

// Simple function to create pool members
export async function createPoolMembers(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  memberCount: number,
  memberStake: bigint | null,
  createdPoolIds: number[],
  tokenUnit: bigint,
  tokenSymbol: string,
  isDryRun: boolean,
  noWait = false,
  quiet = false
) {
  if (createdPoolIds.length === 0) {
    console.error(`❌ No pools available to join`);
    return { createdMembers: 0 };
  }

  const poolParams = await fetchPoolParameters(api);

  // Safety check against chain limits (main validation should be done in caller)
  if (memberCount > poolParams.maxPoolMembers) {
    console.error(`❌ Member count ${memberCount} exceeds limit ${poolParams.maxPoolMembers}`);
    return { createdMembers: 0 };
  }

  const actualMemberStake = memberStake || poolParams.minJoinBond;
  const fundingBuffer = actualMemberStake / 10n; // 10% buffer for fees

  if (!quiet) {
    console.log(`\n👥 Creating ${memberCount} pool members...`);
    console.log(
      `   📊 Member stake: ${Number(actualMemberStake) / Number(tokenUnit)} ${tokenSymbol} each`
    );
    console.log(`   📊 Joining ${createdPoolIds.length} pools (round-robin)`);
  }

  let createdMembers = 0;
  let totalFundingNeeded = 0n;

  // Create members one by one (simple approach)
  for (let i = 1; i <= memberCount; i++) {
    const poolId = createdPoolIds[(i - 1) % createdPoolIds.length]; // Round-robin
    const memberAccount = getPoolMemberAccountAtIndex(i, derive);
    const fundingAmount = actualMemberStake + fundingBuffer;
    totalFundingNeeded += fundingAmount;

    if (isDryRun) {
      console.log(`   🔍 DRY RUN: Would create member ${i} joining pool ${poolId}`);
      createdMembers++;
      continue;
    }

    if (!quiet) {
      console.log(
        `\n⚡ Creating member ${i}/${memberCount} (${memberAccount.address} → Pool ${poolId})...`
      );
    }

    try {
      // 1. Fund the member account
      const fundTx = api.tx.Balances.transfer_allow_death({
        dest: MultiAddress.Id(memberAccount.address),
        value: fundingAmount,
      });

      await executeTransaction(fundTx, godSigner, `Fund member ${i}`, quiet, noWait);

      // 2. Join the pool
      const joinTx = api.tx.NominationPools.join({
        amount: actualMemberStake,
        pool_id: poolId,
      });

      await executeTransaction(
        joinTx,
        memberAccount.signer,
        `Member ${i} join pool ${poolId}`,
        quiet,
        noWait
      );

      createdMembers++;
    } catch (error) {
      console.error(`   ❌ Failed to create member ${i}:`, error);
      // Continue with next member
    }
  }

  console.log(`\n📊 Pool Member Summary:`);
  console.log(`   - Members requested: ${memberCount}`);
  console.log(`   - Members created: ${createdMembers}`);
  console.log(
    `   - Total funding used: ${Number(totalFundingNeeded) / Number(tokenUnit)} ${tokenSymbol}`
  );

  return { createdMembers, totalFundingNeeded };
}

// Simple function to create hybrid stakers
export async function createHybridStakers(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  hybridCount: number,
  memberStake: bigint | null,
  soloStake: bigint | null,
  createdPoolIds: number[],
  validatorsPerHybrid: number,
  validatorStartIndex: number,
  tokenUnit: bigint,
  tokenSymbol: string,
  isDryRun: boolean,
  noWait = false,
  quiet = false
) {
  if (createdPoolIds.length === 0) {
    console.error(`❌ No pools available for hybrid stakers`);
    return { createdHybrids: 0, nextValidatorIndex: validatorStartIndex };
  }

  const poolParams = await fetchPoolParameters(api);
  const minNominatorBond = await api.query.Staking.MinNominatorBond.getValue();

  const actualMemberStake = memberStake || poolParams.minJoinBond;
  const actualSoloStake = soloStake || minNominatorBond + minNominatorBond / 5n;
  const fundingBuffer = (actualMemberStake + actualSoloStake) / 10n;

  // Get validators
  const validatorEntries = await api.query.Staking.Validators.getEntries();
  const allValidators: SS58String[] = validatorEntries.map(
    ({ keyArgs: [validator] }: { keyArgs: [SS58String] }) => validator
  );

  if (!quiet) {
    console.log(`\n🔄 Creating ${hybridCount} hybrid stakers...`);
    console.log(
      `   📊 Pool stake: ${Number(actualMemberStake) / Number(tokenUnit)} ${tokenSymbol}`
    );
    console.log(`   📊 Solo stake: ${Number(actualSoloStake) / Number(tokenUnit)} ${tokenSymbol}`);
    console.log(
      `   📊 Total per account: ${Number(actualMemberStake + actualSoloStake + fundingBuffer) / Number(tokenUnit)} ${tokenSymbol}`
    );
  }

  let createdHybrids = 0;
  let totalFundingNeeded = 0n;
  let currentValidatorIndex = validatorStartIndex;

  for (let i = 1; i <= hybridCount; i++) {
    const poolId = createdPoolIds[(i - 1) % createdPoolIds.length]; // Round-robin
    const hybridAccount = getHybridAccountAtIndex(i, derive);
    const totalFunding = actualMemberStake + actualSoloStake + fundingBuffer;
    totalFundingNeeded += totalFunding;

    // Select validators for solo staking
    const selectedValidators: SS58String[] = [];
    for (let j = 0; j < validatorsPerHybrid && j < allValidators.length; j++) {
      const validatorIndex = (currentValidatorIndex + j) % allValidators.length;
      const validator = allValidators[validatorIndex];
      if (validator) {
        selectedValidators.push(validator);
      }
    }
    currentValidatorIndex = (currentValidatorIndex + validatorsPerHybrid) % allValidators.length;

    if (isDryRun) {
      console.log(
        `   🔍 DRY RUN: Would create hybrid ${i} joining pool ${poolId} + nominating ${selectedValidators.length} validators`
      );
      createdHybrids++;
      continue;
    }

    if (!quiet) {
      console.log(
        `\n⚡ Creating hybrid ${i}/${hybridCount} (Pool ${poolId} + ${selectedValidators.length} validators)...`
      );
    }

    try {
      // 1. Fund the hybrid account
      const fundTx = api.tx.Balances.transfer_allow_death({
        dest: MultiAddress.Id(hybridAccount.address),
        value: totalFunding,
      });

      await executeTransaction(fundTx, godSigner, `Fund hybrid ${i}`, quiet, noWait);

      // 2. Join pool
      const joinPoolTx = api.tx.NominationPools.join({
        amount: actualMemberStake,
        pool_id: poolId,
      });

      // 3. Bond for solo staking
      const bondTx = api.tx.Staking.bond({
        value: actualSoloStake,
        payee: { type: "Staked", value: undefined },
      });

      // 4. Nominate validators
      const validatorTargets = selectedValidators.map((validator) => MultiAddress.Id(validator));
      const nominateTx = api.tx.Staking.nominate({ targets: validatorTargets });

      // Execute all hybrid operations
      await executeTransaction(
        joinPoolTx,
        hybridAccount.signer,
        `Hybrid ${i} join pool`,
        quiet,
        noWait
      );
      await executeTransaction(bondTx, hybridAccount.signer, `Hybrid ${i} bond`, quiet, noWait);
      await executeTransaction(
        nominateTx,
        hybridAccount.signer,
        `Hybrid ${i} nominate`,
        quiet,
        noWait
      );

      createdHybrids++;
    } catch (error) {
      console.error(`   ❌ Failed to create hybrid ${i}:`, error);
      // Continue with next hybrid
    }
  }

  console.log(`\n📊 Hybrid Staker Summary:`);
  console.log(`   - Hybrids requested: ${hybridCount}`);
  console.log(`   - Hybrids created: ${createdHybrids}`);
  console.log(
    `   - Total funding used: ${Number(totalFundingNeeded) / Number(tokenUnit)} ${tokenSymbol}`
  );
  console.log(`   - Next validator index: ${currentValidatorIndex}`);

  return { createdHybrids, totalFundingNeeded, nextValidatorIndex: currentValidatorIndex };
}
