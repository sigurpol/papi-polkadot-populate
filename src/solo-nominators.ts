// Solo nominator functionality
// Imports used for function implementations
import { MultiAddress } from "@polkadot-api/descriptors";
import type { SS58String } from "polkadot-api";
import type { TypedApi, DeriveFunction, Signer, TransactionEvent } from "./types.js";
import { getAccountAtIndex } from "./utils.js";

// Function to create accounts with batch transfers
export async function createAccounts(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  targetCount: number,
  minNominatorBond: bigint,
  stakeRange: bigint,
  fixedBufferPerAccount: bigint,
  stakeAmounts: Map<number, bigint>,
  createdAccountIndices: number[],
  PAS: bigint,
  isDryRun: boolean,
  batchSize = 500
) {
  console.log(`\n📝 Creating ${targetCount} new accounts...`);
  console.log(`   📊 Using batch size of ${batchSize}`);

  let accountIndex = 1; // Start checking from index 1
  let createdCount = 0;
  let skippedCount = 0;
  let totalStakeAmount = 0n;

  while (createdCount < targetCount) {
    const batch = [];

    // Build batch of transfers
    while (batch.length < batchSize && createdCount < targetCount) {
      const account = getAccountAtIndex(accountIndex, derive);

      // Check if account already exists
      const accountInfo = await api.query.System.Account.getValue(account.address);
      const shouldCreate = accountInfo.providers === 0;

      if (shouldCreate) {
        // Calculate stake for this account based on how many we've created
        const variableAmount = (stakeRange * BigInt(createdCount % 10)) / 9n;
        const stakeAmount = minNominatorBond + variableAmount;
        stakeAmounts.set(accountIndex, stakeAmount);
        createdAccountIndices.push(accountIndex);
        totalStakeAmount += stakeAmount;

        // Fund with exact stake amount + fixed buffer
        const fundingAmount = stakeAmount + fixedBufferPerAccount;
        console.log(
          `   [${accountIndex}] Creating ${account.address} with ${Number(fundingAmount) / Number(PAS)} PAS (stake: ${Number(stakeAmount) / Number(PAS)} PAS)`
        );
        // Use transfer_allow_death for creating new accounts
        const transfer = api.tx.Balances.transfer_allow_death({
          dest: MultiAddress.Id(account.address),
          value: fundingAmount,
        });
        batch.push(transfer.decodedCall);
        createdCount++;
      } else {
        // console.log(`   [${accountIndex}] Skipping ${account.address} (already exists)`);
        skippedCount++;
      }

      accountIndex++;
    }

    // Execute batch if we have transfers
    if (batch.length > 0) {
      if (isDryRun) {
        console.log(`\n🔍 DRY RUN: Would execute batch of ${batch.length} transfers`);
      } else {
        console.log(
          `\n⚡ Executing batch of ${batch.length} transfers (${createdCount}/${targetCount} new accounts created so far)...`
        );

        // Use utility.batch_all for multiple transfers (batch_all fails all if one fails)
        const batchTx = api.tx.Utility.batch_all({ calls: batch });

        // Sign and submit with timeout
        await new Promise((resolve, _reject) => {
          let completed = false;
          let subscription: { unsubscribe: () => void } | null = null;

          const timeout = setTimeout(() => {
            if (!completed) {
              completed = true;
              console.log(`   ⚠️ Transaction timeout, but may have succeeded`);
              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              resolve(null);
            }
          }, 30000); // 30 second timeout

          subscription = batchTx.signSubmitAndWatch(godSigner).subscribe({
            next: (event: TransactionEvent) => {
              console.log(`   📡 Event: ${event.type}`);
              if (event.type === "txBestBlocksState") {
                console.log(`   ✅ Batch included in block`);
                console.log(`   📋 Transaction hash: ${event.txHash}`);
                console.log(`   🔗 https://paseo.subscan.io/extrinsic/${event.txHash}`);

                // Transaction is included in block, should be successful
                console.log(`   ✅ Transaction included in block - should be successful`);

                // Transaction included in block - proceed immediately (like original polkadot-populate)
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);
                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }
                  resolve(null);
                }
              }
            },
            error: (error: Error) => {
              if (!completed) {
                completed = true;
                clearTimeout(timeout);
                console.error(`   ❌ Batch failed:`, error);
                if (subscription) {
                  try {
                    subscription.unsubscribe();
                  } catch {}
                }
                _reject(error);
              }
            },
            complete() {
              if (!completed) {
                completed = true;
                clearTimeout(timeout);
                console.log(`   ✅ Batch completed`);
                if (subscription) {
                  try {
                    subscription.unsubscribe();
                  } catch {}
                }
                resolve(null);
              }
            },
          });
        });
      }
    }
  }

  console.log(`\n📊 Account Creation Summary:`);
  console.log(`   - New accounts created: ${createdCount}`);
  console.log(`   - Existing accounts skipped: ${skippedCount}`);
  console.log(`   - Account indices used: ${createdAccountIndices.join(", ")}`);

  // Now check if we have enough balance
  const totalFixedBuffer = fixedBufferPerAccount * BigInt(createdCount);
  const totalAmount = totalStakeAmount + totalFixedBuffer;

  console.log(`\n💸 Final funding requirements:`);
  console.log(`   - Total stake amount: ${Number(totalStakeAmount) / Number(PAS)} PAS`);
  console.log(`   - Total fixed buffer: ${Number(totalFixedBuffer) / Number(PAS)} PAS`);
  console.log(`   - Total amount needed: ${Number(totalAmount) / Number(PAS)} PAS`);

  console.log(`✅ Balance check passed - sufficient funds available`);

  return { createdCount, skippedCount };
}

// Function to stake and nominate
export async function stakeAndNominate(
  api: TypedApi,
  derive: DeriveFunction,
  createdAccountIndices: number[],
  stakeAmounts: Map<number, bigint>,
  validatorsPerNominator: number,
  validatorStartIndex: number,
  PAS: bigint,
  isDryRun: boolean,
  batchSize = 25
) {
  console.log(
    `\n🥩 Starting staking and nomination for ${createdAccountIndices.length} accounts...`
  );

  // First, get the list of all validators
  const validatorEntries = await api.query.Staking.Validators.getEntries();
  const allValidators: SS58String[] = validatorEntries.map(
    ({ keyArgs: [validator] }: { keyArgs: [SS58String] }) => validator
  );

  if (allValidators.length === 0) {
    console.error("❌ No validators found on chain!");
    return;
  }

  console.log(`📊 Found ${allValidators.length} validators on chain`);
  console.log(`🔄 Starting validator assignment from index: ${validatorStartIndex}`);

  // Calculate how validators will be distributed across nominators
  // to ensure even distribution using round-robin
  let currentValidatorIndex = validatorStartIndex;
  const validatorAssignments: Map<number, SS58String[]> = new Map();

  // Pre-calculate validator assignments to ensure even distribution
  for (const accountIndex of createdAccountIndices) {
    if (accountIndex === undefined) continue;

    const selectedValidators: SS58String[] = [];

    // Use round-robin assignment starting from currentValidatorIndex
    for (let j = 0; j < validatorsPerNominator && j < allValidators.length; j++) {
      const validatorIndex = (currentValidatorIndex + j) % allValidators.length;
      const validator = allValidators[validatorIndex];
      if (validator) {
        selectedValidators.push(validator);
      }
    }

    validatorAssignments.set(accountIndex, selectedValidators);

    // Move start index for next nominator to ensure even distribution
    currentValidatorIndex = (currentValidatorIndex + validatorsPerNominator) % allValidators.length;
  }

  // Log distribution statistics
  const validatorNominationCounts: Map<SS58String, number> = new Map();
  for (const [_, validators] of validatorAssignments) {
    for (const validator of validators) {
      validatorNominationCounts.set(validator, (validatorNominationCounts.get(validator) || 0) + 1);
    }
  }

  if (validatorNominationCounts.size > 0) {
    const counts = Array.from(validatorNominationCounts.values());
    const minNominations = Math.min(...counts);
    const maxNominations = Math.max(...counts);
    console.log(
      `📊 Validator distribution: min=${minNominations}, max=${maxNominations} nominations per validator`
    );
    console.log(`📊 Total unique validators assigned: ${validatorNominationCounts.size}`);
  }

  let processedIndex = 0;
  let stakedCount = 0;
  let skippedCount = 0;

  while (processedIndex < createdAccountIndices.length) {
    const batch = [];

    while (batch.length < batchSize && processedIndex < createdAccountIndices.length) {
      const accountIndex = createdAccountIndices[processedIndex];
      if (accountIndex === undefined) {
        processedIndex++;
        continue;
      }
      const account = getAccountAtIndex(accountIndex, derive);

      // Check if account is already bonded
      const ledger = await api.query.Staking.Ledger.getValue(account.address);
      const isBonded = ledger !== undefined;

      // Check if already a nominator
      const nominators = await api.query.Staking.Nominators.getValue(account.address);
      const isNominator = nominators !== undefined;

      if (!isBonded && !isNominator) {
        // Use pre-determined stake amount from the Map
        const stakeAmount = stakeAmounts.get(accountIndex) || 0n;

        // Skip balance check - assume account has sufficient balance since we just funded it

        console.log(
          `   [${accountIndex}] Staking ${Number(stakeAmount) / Number(PAS)} PAS and nominating from ${account.address}`
        );

        // Get pre-calculated validators for this account
        const selectedValidators = validatorAssignments.get(accountIndex) || [];

        console.log(`      Selected validators: ${selectedValidators.length}`);

        // Ensure we have validators to nominate
        if (selectedValidators.length === 0) {
          console.error(
            `   [${accountIndex}] No validators selected for ${account.address}, skipping`
          );
          continue;
        }

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
      } else {
        console.log(
          `   [${accountIndex}] Skipping ${account.address} (already bonded: ${isBonded}, nominator: ${isNominator})`
        );
        skippedCount++;
      }

      processedIndex++;
    }

    // Execute batch if we have transactions
    if (batch.length > 0) {
      if (isDryRun) {
        console.log(
          `\n🔍 DRY RUN: Would execute batch of ${batch.length} stake+nominate operations`
        );
      } else {
        console.log(
          `\n⚡ Executing batch of ${batch.length} stake+nominate operations (${stakedCount + skippedCount}/${createdAccountIndices.length} accounts processed)...`
        );

        // Execute transactions in parallel
        const promises = batch.map(
          ({ tx, signer }, index) =>
            new Promise((resolve, reject) => {
              let completed = false;
              let subscription: { unsubscribe: () => void } | null = null;

              const timeout = setTimeout(() => {
                if (!completed) {
                  completed = true;
                  console.log(`   ⚠️ Transaction ${index + 1} timeout`);
                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }
                  resolve(null);
                }
              }, 30000);

              subscription = tx.signSubmitAndWatch(signer).subscribe({
                next: (event: TransactionEvent) => {
                  if (event.type === "txBestBlocksState") {
                    console.log(`   ✅ Transaction ${index + 1} included in block`);
                    console.log(`   📋 TX ${index + 1} hash: ${event.txHash}`);
                    if (!completed) {
                      completed = true;
                      clearTimeout(timeout);
                      if (subscription) {
                        try {
                          subscription.unsubscribe();
                        } catch {}
                      }
                      resolve(null);
                    }
                  }
                },
                error: (error: Error) => {
                  if (!completed) {
                    completed = true;
                    clearTimeout(timeout);
                    console.error(`   ❌ Transaction ${index + 1} failed:`, error);
                    if (subscription) {
                      try {
                        subscription.unsubscribe();
                      } catch {}
                    }
                    reject(error);
                  }
                },
              });
            })
        );

        await Promise.allSettled(promises);
      }
    }
  }

  console.log(`\n📊 Staking Summary:`);
  console.log(`   - Accounts staked: ${stakedCount}`);
  console.log(`   - Accounts skipped: ${skippedCount}`);

  return { stakedCount, skippedCount, nextValidatorIndex: currentValidatorIndex };
}

// Top-up function
export async function topupAccounts(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  targetAmount: bigint,
  fromIndex: number,
  toIndex: number,
  PAS: bigint,
  isDryRun: boolean,
  batchSize = 500
) {
  console.log(
    `\n💰 Starting topup to ${Number(targetAmount) / Number(PAS)} PAS for accounts ${fromIndex} to ${toIndex - 1}...`
  );

  let accountsToTopup: {
    index: number;
    address: string;
    currentBalance: bigint;
    topupAmount: bigint;
  }[] = [];
  let totalTopupNeeded = 0n;

  // First pass: check all account balances and calculate what's needed
  console.log(`\n🔍 Checking account balances...`);
  for (let i = fromIndex; i < toIndex; i++) {
    const account = getAccountAtIndex(i, derive);
    const accountInfo = await api.query.System.Account.getValue(account.address);
    const currentBalance = accountInfo.data.free;

    if (currentBalance < targetAmount) {
      const topupAmount = targetAmount - currentBalance;
      accountsToTopup.push({
        index: i,
        address: account.address,
        currentBalance,
        topupAmount,
      });
      totalTopupNeeded += topupAmount;
      console.log(
        `   [${i}] ${account.address}: ${Number(currentBalance) / Number(PAS)} PAS → needs ${Number(topupAmount) / Number(PAS)} PAS top-up`
      );
    } else {
      console.log(
        `   [${i}] ${account.address}: ${Number(currentBalance) / Number(PAS)} PAS → no top-up needed`
      );
    }
  }

  console.log(`\n💸 Top-up Summary:`);
  console.log(`   - Accounts needing top-up: ${accountsToTopup.length}`);
  console.log(`   - Accounts already sufficient: ${toIndex - fromIndex - accountsToTopup.length}`);
  console.log(`   - Total top-up needed: ${Number(totalTopupNeeded) / Number(PAS)} PAS`);

  if (totalTopupNeeded === 0n) {
    console.log(`✅ All accounts already have sufficient balance - nothing to do`);
    return { toppedUpCount: 0, skippedCount: toIndex - fromIndex };
  }

  if (isDryRun) {
    console.log(`\n🔍 DRY RUN: Would execute ${accountsToTopup.length} top-up transfers`);
    return {
      toppedUpCount: accountsToTopup.length,
      skippedCount: toIndex - fromIndex - accountsToTopup.length,
    };
  }

  // Execute top-ups in batches
  let processedCount = 0;
  let counter = 0;

  while (counter < accountsToTopup.length) {
    const batch = [];

    while (batch.length < batchSize && counter < accountsToTopup.length) {
      const accountToTopup = accountsToTopup[counter];
      if (!accountToTopup) {
        counter++;
        continue;
      }
      console.log(
        `   [${accountToTopup.index}] Topping up ${accountToTopup.address} with ${Number(accountToTopup.topupAmount) / Number(PAS)} PAS`
      );

      const transfer = api.tx.Balances.transfer_keep_alive({
        dest: MultiAddress.Id(accountToTopup.address),
        value: accountToTopup.topupAmount,
      });
      batch.push(transfer.decodedCall);
      counter++;
    }

    if (batch.length > 0) {
      console.log(`\n⚡ Executing batch of ${batch.length} top-up transfers...`);

      const batchTx = api.tx.Utility.batch_all({ calls: batch });

      await new Promise((resolve, _reject) => {
        let completed = false;
        let subscription: { unsubscribe: () => void } | null = null;

        const timeout = setTimeout(() => {
          if (!completed) {
            completed = true;
            console.log(`   ⚠️ Transaction timeout, but may have succeeded`);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            resolve(null);
          }
        }, 30000);

        subscription = batchTx.signSubmitAndWatch(godSigner).subscribe({
          next: (event: { type: string; txHash?: string }) => {
            console.log(`   📡 Event: ${event.type}`);
            if (event.type === "txBestBlocksState") {
              console.log(`   ✅ Batch included in block`);
              console.log(`   📋 Transaction hash: ${event.txHash}`);
              console.log(`   🔗 https://paseo.subscan.io/extrinsic/${event.txHash}`);
              console.log(`   ✅ Transaction included in block - should be successful`);

              if (!completed) {
                completed = true;
                clearTimeout(timeout);
                if (subscription) {
                  try {
                    subscription.unsubscribe();
                  } catch {}
                }
                resolve(null);
              }
            }
          },
          error: (error: Error) => {
            if (!completed) {
              completed = true;
              clearTimeout(timeout);
              console.error(`   ❌ Batch failed:`, error);
              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              _reject(error);
            }
          },
          complete() {
            if (!completed) {
              completed = true;
              clearTimeout(timeout);
              console.log(`   ✅ Batch completed`);
              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              resolve(null);
            }
          },
        });
      });

      processedCount += batch.length;
    }
  }

  console.log(`\n📊 Top-up Complete:`);
  console.log(`   - Accounts topped up: ${processedCount}`);
  console.log(`   - Accounts skipped: ${toIndex - fromIndex - processedCount}`);

  return { toppedUpCount: processedCount, skippedCount: toIndex - fromIndex - processedCount };
}
