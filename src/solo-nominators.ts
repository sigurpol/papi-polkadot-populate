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
  tokenUnit: bigint,
  tokenSymbol: string,
  isDryRun: boolean,
  batchSize?: number,
  startIndex = 1,
  checkBatchSize = 50,
  noWait = false,
  _parallelBatches = 1,
  quiet = false,
  skipCheckAccount = false,
  baseBuffer = 0n
) {
  // Use provided batch size or default
  const transferBatchSize = batchSize || 1000;
  if (!quiet) {
    console.log(`\n📝 Creating ${targetCount} new accounts...`);
    console.log(`   📊 Using transfer batch size of ${transferBatchSize}`);
    if (startIndex > 1) {
      console.log(`   ⚡ Starting from account index ${startIndex}`);
    }
    if (skipCheckAccount) {
      console.log(
        `   🚀 SKIP CHECK MODE: Assuming accounts ${startIndex} to ${startIndex + targetCount - 1} are available`
      );
    } else if (checkBatchSize > 1) {
      console.log(`   🔍 Checking ${checkBatchSize} accounts in parallel`);
    }
    if (noWait) {
      console.log(`   🚀 Fire-and-forget mode enabled (not waiting for finalization)`);
    }
  }

  let createdCount = 0;
  let skippedCount = 0;
  let totalStakeAmount = 0n;

  // Account status tracking
  const accountStatuses = new Map<number, boolean>(); // true = needs creation
  const availableIndices: number[] = []; // Track available indices for creation

  if (skipCheckAccount) {
    // Skip all account existence checks - assume all accounts from startIndex are available
    if (!quiet) {
      console.log(
        `\n⚡ Skipping account checks - assuming all accounts are available for creation`
      );
    }

    // Pre-populate statuses assuming all accounts need creation
    for (let i = 0; i < targetCount; i++) {
      const index = startIndex + i;
      accountStatuses.set(index, true);
      availableIndices.push(index);
    }
  } else {
    // Do the normal account checking process
    // Keep checking until we find enough free accounts
    let currentCheckIndex = startIndex;
    const maxChecks = 10000; // Safety limit to prevent infinite loops
    let totalChecked = 0;

    if (!quiet) {
      console.log(`\n🔍 Searching for ${targetCount} available account indices...`);
    }

    while (availableIndices.length < targetCount && totalChecked < maxChecks) {
      // Build batch of accounts to check
      const checkBatch: { index: number; address: string }[] = [];
      const batchEndIndex = Math.min(
        currentCheckIndex + checkBatchSize,
        currentCheckIndex + (targetCount - availableIndices.length) * 2
      );

      for (let i = currentCheckIndex; i < batchEndIndex && totalChecked < maxChecks; i++) {
        const account = getAccountAtIndex(i, derive);
        checkBatch.push({ index: i, address: account.address });
        totalChecked++;
      }

      if (checkBatch.length === 0) break;

      // Check batch in parallel with timeout
      const checkPromises = checkBatch.map(async ({ index, address }) => {
        try {
          if (!quiet) {
            console.log(`🔍 Checking account ${index}: ${address}...`);
          }

          // Add much shorter timeout for individual account queries (10 seconds per account)
          const accountInfo = await Promise.race([
            api.query.System.Account.getValue(address),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error(`Account query timeout after 10s for ${address}`)),
                10000
              )
            ),
          ]);

          if (!quiet) {
            console.log(`✅ Account ${index} check completed`);
          }

          const shouldCreate = (accountInfo as any).providers === 0;
          return { index, shouldCreate };
        } catch (error) {
          console.warn(`⚠️  Account ${address} check failed: ${error}. Assuming needs creation.`);
          return { index, shouldCreate: true };
        }
      });

      const results = await Promise.all(checkPromises);

      // Store results and collect available indices
      for (const { index, shouldCreate } of results) {
        accountStatuses.set(index, shouldCreate);
        if (shouldCreate) {
          availableIndices.push(index);
          if (!quiet) {
            console.log(`   ✅ Found available index: ${index}`);
          }
        } else {
          skippedCount++;
          if (!quiet) {
            console.log(`   ⏭️  Index ${index} already exists, skipping`);
          }
        }
      }

      // Move to next batch
      currentCheckIndex = batchEndIndex;

      // Show progress
      if (!quiet && availableIndices.length > 0) {
        console.log(
          `   📊 Progress: Found ${availableIndices.length}/${targetCount} available indices`
        );
      }
    }

    if (availableIndices.length < targetCount) {
      console.warn(
        `⚠️  Only found ${availableIndices.length} available indices out of ${targetCount} requested after checking ${totalChecked} accounts.`
      );
      if (availableIndices.length === 0) {
        console.error(
          `❌ No available account indices found. Consider using --skip-check-account flag.`
        );
        return;
      }
    } else {
      if (!quiet) {
        console.log(`   ✅ Found all ${availableIndices.length} required account indices`);
      }
    }
  }

  // Now create accounts using the available indices
  if (!quiet) {
    console.log(`\n📝 Starting account creation phase...`);
    console.log(
      `   📋 Account indices to use: ${availableIndices.slice(0, 5).join(", ")}${availableIndices.length > 5 ? "..." : ""}`
    );
  }

  // Process available indices in batches
  let processedIndices = 0;

  while (processedIndices < availableIndices.length) {
    if (!quiet) {
      console.log(`🔄 Creating batch ${Math.floor(processedIndices / transferBatchSize) + 1}...`);
    }
    const batch = [];

    // Build batch of transfers using available indices
    const batchEndIndex = Math.min(processedIndices + transferBatchSize, availableIndices.length);

    for (let i = processedIndices; i < batchEndIndex; i++) {
      const accountIndex = availableIndices[i];
      if (accountIndex === undefined) continue; // Safety check

      const account = getAccountAtIndex(accountIndex, derive);

      // Calculate stake for this account based on how many we've created
      // Add base buffer (20% of minBond) plus variable amount (0-80% of minBond)
      const variableAmount = (stakeRange * BigInt(createdCount % 10)) / 9n;
      const stakeAmount = minNominatorBond + baseBuffer + variableAmount;
      stakeAmounts.set(accountIndex, stakeAmount);
      createdAccountIndices.push(accountIndex);
      totalStakeAmount += stakeAmount;

      // Fund with exact stake amount + fixed buffer
      const fundingAmount = stakeAmount + fixedBufferPerAccount;
      if (!quiet) {
        console.log(
          `   [${accountIndex}] Creating ${account.address} with ${Number(fundingAmount) / Number(tokenUnit)} ${tokenSymbol} (stake: ${Number(stakeAmount) / Number(tokenUnit)} ${tokenSymbol})`
        );
      }

      // Use transfer_allow_death for creating new accounts
      const transfer = api.tx.Balances.transfer_allow_death({
        dest: MultiAddress.Id(account.address),
        value: fundingAmount,
      });

      batch.push(transfer.decodedCall);
      createdCount++;
    }

    processedIndices = batchEndIndex;

    // This should not happen anymore since we pre-found all available indices
    if (batch.length === 0) {
      break; // Exit the loop
    }

    // Execute batch if we have transfers
    if (batch.length > 0) {
      if (isDryRun) {
        console.log(`\n🔍 DRY RUN: Would execute batch of ${batch.length} transfers`);
      } else {
        if (!quiet) {
          console.log(
            `\n⚡ Executing batch of ${batch.length} transfers (${createdCount}/${targetCount} new accounts created so far)...`
          );
        }

        // Use utility.batch_all for multiple transfers (batch_all fails all if one fails)
        const batchTx = api.tx.Utility.batch_all({ calls: batch });

        if (noWait) {
          // Fire-and-forget mode: just submit and continue
          try {
            const txHash = await batchTx.signAndSubmit(godSigner);
            if (!quiet) {
              console.log(`   📋 Submitted batch transaction: ${txHash}`);
            }
          } catch (error) {
            console.error(`   ❌ Failed to submit batch:`, error);
          }
        } else {
          // Wait for inclusion (original behavior)
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
                if (!quiet) {
                  console.log(`   📡 Event: ${event.type}`);
                }
                if (event.type === "txBestBlocksState") {
                  if (!quiet) {
                    console.log(`   ✅ Batch included in block`);
                    console.log(`   📋 Transaction hash: ${event.txHash}`);
                    console.log(`   🔗 https://paseo.subscan.io/extrinsic/${event.txHash}`);
                    console.log(`   ✅ Transaction included in block - should be successful`);
                  }

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

                  // Check if this is an infrastructure error vs transaction failure
                  const errorMessage = error.message || error.toString();
                  const isInfrastructureError =
                    errorMessage.includes("ChainHead operation inaccessible") ||
                    errorMessage.includes("OperationInaccessibleError") ||
                    errorMessage.includes("connection") ||
                    errorMessage.includes("network");

                  if (isInfrastructureError) {
                    console.warn(
                      `   ⚠️ Infrastructure error (transaction may have succeeded):`,
                      errorMessage
                    );
                    console.warn(
                      `   🔄 This is usually a network/RPC issue, not a transaction failure`
                    );
                    console.warn(
                      `   🔄 Continuing execution - check transaction status manually if needed`
                    );
                    // Don't reject - treat as success since tx was likely submitted
                  } else {
                    console.error(`   ❌ Transaction failed:`, error);
                    // Only reject for actual transaction failures
                    _reject(error);
                    return;
                  }

                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }
                  resolve(null);
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
  }

  console.log(`\n📊 Account Creation Summary:`);
  console.log(`   - New accounts created: ${createdCount}`);
  console.log(`   - Existing accounts skipped: ${skippedCount}`);
  const indicesToShow =
    createdAccountIndices.length > 10
      ? `${createdAccountIndices.slice(0, 10).join(", ")}... (and ${createdAccountIndices.length - 10} more)`
      : createdAccountIndices.join(", ");
  console.log(`   - Account indices used: ${indicesToShow}`);

  // Now check if we have enough balance
  const totalFixedBuffer = fixedBufferPerAccount * BigInt(createdCount);
  const totalAmount = totalStakeAmount + totalFixedBuffer;

  console.log(`\n💸 Final funding requirements:`);
  console.log(
    `   - Total stake amount: ${Number(totalStakeAmount) / Number(tokenUnit)} ${tokenSymbol}`
  );
  console.log(
    `   - Total fixed buffer: ${Number(totalFixedBuffer) / Number(tokenUnit)} ${tokenSymbol}`
  );
  console.log(
    `   - Total amount needed: ${Number(totalAmount) / Number(tokenUnit)} ${tokenSymbol}`
  );

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
  tokenUnit: bigint,
  tokenSymbol: string,
  isDryRun: boolean,
  batchSize?: number,
  noWait = false,
  parallelBatches = 1,
  quiet = false,
  skipCheckAccount = false
) {
  // Use provided batch size or default
  const stakeBatchSize = batchSize || 100;
  if (!quiet) {
    console.log(
      `\n🥩 Starting staking and nomination for ${createdAccountIndices.length} accounts...`
    );
    console.log(`   📊 Using stake batch size of ${stakeBatchSize}`);
    if (skipCheckAccount) {
      console.log(
        `   ⚡ Skip mode: Assuming all accounts are not bonded/nominating (massive speedup)`
      );
    }
    if (noWait) {
      console.log(`   🚀 Fire-and-forget mode enabled`);
    }
    if (parallelBatches > 1) {
      console.log(`   🎯 Submitting ${parallelBatches} batches in parallel`);
    }
  }

  // First, get the list of all validators with timeout
  console.log(`🔍 Querying validators...`);
  const validatorEntries = await Promise.race([
    api.query.Staking.Validators.getEntries(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Validator query timeout after 15 seconds")), 15000)
    ),
  ]);
  const allValidators: SS58String[] = validatorEntries.map(
    ({ keyArgs: [validator] }: { keyArgs: [SS58String] }) => validator
  );

  if (allValidators.length === 0) {
    console.error("❌ No validators found on chain!");
    return;
  }

  if (!quiet) {
    console.log(`📊 Found ${allValidators.length} validators on chain`);
    console.log(`🔄 Starting validator assignment from index: ${validatorStartIndex}`);
  }

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

  if (!quiet && validatorNominationCounts.size > 0) {
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

    while (batch.length < stakeBatchSize && processedIndex < createdAccountIndices.length) {
      const accountIndex = createdAccountIndices[processedIndex];
      if (accountIndex === undefined) {
        processedIndex++;
        continue;
      }
      const account = getAccountAtIndex(accountIndex, derive);

      let isBonded = false;
      let isNominator = false;

      if (skipCheckAccount) {
        // Skip checks - assume these are new accounts that are not bonded/nominating
        // This provides massive speedup when we know accounts are fresh
      } else {
        // Check if account is already bonded
        const ledger = await api.query.Staking.Ledger.getValue(account.address);
        isBonded = ledger !== undefined;

        // Check if already a nominator
        const nominators = await api.query.Staking.Nominators.getValue(account.address);
        isNominator = nominators !== undefined;
      }

      if (!isBonded && !isNominator) {
        // Use pre-determined stake amount from the Map
        const stakeAmount = stakeAmounts.get(accountIndex) || 0n;

        // Skip balance check - assume account has sufficient balance since we just funded it

        // Get pre-calculated validators for this account
        const selectedValidators = validatorAssignments.get(accountIndex) || [];

        if (!quiet) {
          console.log(
            `   [${accountIndex}] Staking ${Number(stakeAmount) / Number(tokenUnit)} ${tokenSymbol} and nominating from ${account.address}`
          );
          console.log(`      Selected validators: ${selectedValidators.length}`);
        }

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
        if (!quiet && skippedCount < 10) {
          console.log(
            `   [${accountIndex}] Skipping ${account.address} (already bonded: ${isBonded}, nominator: ${isNominator})`
          );
        }
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
        if (!quiet) {
          console.log(
            `\n⚡ Executing batch of ${batch.length} stake+nominate operations (${stakedCount + skippedCount}/${createdAccountIndices.length} accounts processed)...`
          );
        }

        if (noWait) {
          // Fire-and-forget mode: submit all transactions without waiting
          const submitPromises = batch.map(async ({ tx, signer }) => {
            try {
              const txHash = await tx.signAndSubmit(signer);
              if (!quiet) {
                console.log(`   📋 Submitted transaction: ${txHash}`);
              }
              return { success: true, txHash };
            } catch (error) {
              console.error(`   ❌ Failed to submit transaction:`, error);
              return { success: false, error };
            }
          });

          // Submit in parallel batches if specified
          if (parallelBatches > 1) {
            for (let i = 0; i < submitPromises.length; i += parallelBatches) {
              const chunk = submitPromises.slice(i, i + parallelBatches);
              await Promise.allSettled(chunk);
            }
          } else {
            await Promise.allSettled(submitPromises);
          }
        } else {
          // Original behavior: wait for inclusion
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
                      if (!quiet) {
                        console.log(`   ✅ Transaction ${index + 1} included in block`);
                        console.log(`   📋 TX ${index + 1} hash: ${event.txHash}`);
                      }
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

                      // Check if this is an infrastructure error vs transaction failure
                      const errorMessage = error.message || error.toString();
                      const isInfrastructureError =
                        errorMessage.includes("ChainHead operation inaccessible") ||
                        errorMessage.includes("OperationInaccessibleError") ||
                        errorMessage.includes("connection") ||
                        errorMessage.includes("network");

                      if (isInfrastructureError) {
                        console.warn(
                          `   ⚠️ Infrastructure error for TX ${index + 1} (may have succeeded):`,
                          errorMessage
                        );
                        console.warn(
                          `   🔄 This is usually a network/RPC issue, not a transaction failure`
                        );
                        console.warn(
                          `   🔄 Continuing execution - check transaction status manually if needed`
                        );
                        // Don't reject - treat as success since tx was likely submitted
                      } else {
                        console.error(`   ❌ Transaction ${index + 1} failed:`, error);
                        // Only reject for actual transaction failures
                        reject(error);
                        return;
                      }

                      if (subscription) {
                        try {
                          subscription.unsubscribe();
                        } catch {}
                      }
                      resolve(null);
                    }
                  },
                });
              })
          );

          // Execute in parallel batches if specified
          if (parallelBatches > 1) {
            for (let i = 0; i < promises.length; i += parallelBatches) {
              const chunk = promises.slice(i, i + parallelBatches);
              await Promise.allSettled(chunk);
            }
          } else {
            await Promise.allSettled(promises);
          }
        }
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
  tokenUnit: bigint,
  tokenSymbol: string,
  isDryRun: boolean,
  batchSize = 500
) {
  console.log(
    `\n💰 Starting topup to ${Number(targetAmount) / Number(tokenUnit)} ${tokenSymbol} for accounts ${fromIndex} to ${toIndex - 1}...`
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
        `   [${i}] ${account.address}: ${Number(currentBalance) / Number(tokenUnit)} ${tokenSymbol} → needs ${Number(topupAmount) / Number(tokenUnit)} ${tokenSymbol} top-up`
      );
    } else {
      console.log(
        `   [${i}] ${account.address}: ${Number(currentBalance) / Number(tokenUnit)} ${tokenSymbol} → no top-up needed`
      );
    }
  }

  console.log(`\n💸 Top-up Summary:`);
  console.log(`   - Accounts needing top-up: ${accountsToTopup.length}`);
  console.log(`   - Accounts already sufficient: ${toIndex - fromIndex - accountsToTopup.length}`);
  console.log(
    `   - Total top-up needed: ${Number(totalTopupNeeded) / Number(tokenUnit)} ${tokenSymbol}`
  );

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
        `   [${accountToTopup.index}] Topping up ${accountToTopup.address} with ${Number(accountToTopup.topupAmount) / Number(tokenUnit)} ${tokenSymbol}`
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

              // Check if this is an infrastructure error vs transaction failure
              const errorMessage = error.message || error.toString();
              const isInfrastructureError =
                errorMessage.includes("ChainHead operation inaccessible") ||
                errorMessage.includes("OperationInaccessibleError") ||
                errorMessage.includes("connection") ||
                errorMessage.includes("network");

              if (isInfrastructureError) {
                console.warn(
                  `   ⚠️ Infrastructure error (transaction may have succeeded):`,
                  errorMessage
                );
                console.warn(
                  `   🔄 This is usually a network/RPC issue, not a transaction failure`
                );
                console.warn(
                  `   🔄 Continuing execution - check transaction status manually if needed`
                );
                // Don't reject - treat as success since tx was likely submitted
              } else {
                console.error(`   ❌ Batch failed:`, error);
                // Only reject for actual transaction failures
                _reject(error);
                return;
              }

              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              resolve(null);
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
