// Account management functionality
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { setupApiAndConnection, cleanup } from "./common.js";
// No direct use of DeriveFunction in this file - it's used in imported functions

// Helper function to check accounts in parallel batches
async function checkAccountBatch(
  api: any,
  derive: any,
  startIndex: number,
  endIndex: number,
  pathPrefix: string,
  PAS: bigint
) {
  const batchSize = 500; // Increased to 500 for better parallelization (read-only operations)
  const accounts = [];

  // Process all batches in parallel since API calls are read-only
  const batchPromises = [];

  for (let i = startIndex; i <= endIndex; i += batchSize) {
    const batchEnd = Math.min(i + batchSize - 1, endIndex);

    // Create a promise for each batch
    const batchPromise = (async () => {
      const queries = [];
      const indices = [];

      // Prepare batch queries
      for (let index = i; index <= batchEnd; index++) {
        const account = derive(pathPrefix + index);
        const address = ss58Encode(account.publicKey, 0);
        queries.push(api.query.System.Account.getValue(address));
        indices.push({ index, address, account });
      }

      // Execute queries in parallel
      const results = await Promise.all(queries);

      // Prepare staking queries for found accounts
      const stakingQueries = [];
      const foundAccounts = [];

      for (let j = 0; j < results.length; j++) {
        const accountInfo = results[j];
        const indexInfo = indices[j];
        if (indexInfo) {
          const { index, address } = indexInfo;

          if (
            accountInfo.nonce > 0 ||
            accountInfo.data.free > 0n ||
            accountInfo.data.reserved > 0n
          ) {
            foundAccounts.push({ index, address, accountInfo });
            // Add staking queries
            stakingQueries.push(
              api.query.Staking.Ledger.getValue(address),
              api.query.Staking.Nominators.getValue(address),
              api.query.NominationPools.PoolMembers.getValue(address)
            );
          }
        }
      }

      // Execute all staking queries in parallel
      const stakingResults = stakingQueries.length > 0 ? await Promise.all(stakingQueries) : [];

      // Process results
      const batchAccounts = [];
      for (let k = 0; k < foundAccounts.length; k++) {
        const foundAccount = foundAccounts[k];
        if (foundAccount) {
          const { index, address, accountInfo } = foundAccount;
          const freeBalance = Number(accountInfo.data.free) / Number(PAS);
          const reservedBalance = Number(accountInfo.data.reserved) / Number(PAS);

          // Extract staking results (3 per account)
          const baseIdx = k * 3;
          const ledger = stakingResults[baseIdx];
          const nominators = stakingResults[baseIdx + 1];
          const poolMembers = stakingResults[baseIdx + 2];

          batchAccounts.push({
            index,
            address,
            freeBalance,
            reservedBalance,
            isStaking: ledger !== undefined,
            isNominating: nominators !== undefined,
            poolMembership: poolMembers,
          });
        }
      }

      return batchAccounts;
    })();

    batchPromises.push(batchPromise);
  }

  // Wait for all batches to complete
  const batchResults = await Promise.all(batchPromises);

  // Flatten results
  for (const batch of batchResults) {
    accounts.push(...batch);
  }

  // Sort by index for consistent output
  accounts.sort((a, b) => a.index - b.index);

  return accounts;
}

// List all derived accounts created by this tool
export async function listAccounts(godSeed: string) {
  console.log("📋 Listing all derived accounts created by this tool...\n");

  const { api, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);

  try {
    console.log("🔍 Scanning for derived accounts (maximum parallel mode)...\n");

    // Function to find the range of existing accounts (optimized for sequential accounts)
    const findAccountRange = async (pathPrefix: string, label: string) => {
      console.log(`\n👥 ${label}:`);
      console.log("   Detecting account range (assuming sequential accounts)...");

      // Since we assume sequential accounts without gaps, use binary search to find the end
      let low = 1;
      let high = 100000; // Maximum expected accounts
      let lastFound = 0;

      // Binary search to find the last existing account
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);

        // Check a small batch around the midpoint to determine if accounts exist here
        const checkPoints = [mid, mid - 1, mid + 1].filter((n) => n >= 1);
        const queries = checkPoints.map((index) => {
          const account = derive(pathPrefix + index);
          const address = ss58Encode(account.publicKey, 0);
          return api.query.System.Account.getValue(address).then((info) => ({ index, info }));
        });

        const results = await Promise.all(queries);
        const hasAccount = results.some(
          (r) => r.info.nonce > 0 || r.info.data.free > 0n || r.info.data.reserved > 0n
        );

        if (hasAccount) {
          lastFound = Math.max(
            ...results
              .filter((r) => r.info.nonce > 0 || r.info.data.free > 0n || r.info.data.reserved > 0n)
              .map((r) => r.index)
          );
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (lastFound === 0) {
        console.log("   No accounts found.");
        return;
      }

      // Add some buffer to ensure we don't miss any accounts
      const maxIndex = Math.min(lastFound + 100, 100000);
      console.log(`   Found accounts up to index ~${lastFound}, checking 1 to ${maxIndex}...`);

      // Now check the determined range in parallel with maximum speed
      const accounts = await checkAccountBatch(api, derive, 1, maxIndex, pathPrefix, PAS);

      if (accounts.length === 0) {
        console.log("   No accounts found.");
        return;
      }

      // Display found accounts
      for (const acc of accounts) {
        const stakingStatus = acc.isStaking
          ? acc.isNominating
            ? "🥩 Staking & Nominating"
            : "🥩 Staking (not nominating)"
          : "❌ Not staking";

        const poolStatus = acc.poolMembership ? "🏊 Pool member" : "";

        console.log(
          `   [${acc.index}] ${acc.address}: ${acc.freeBalance.toFixed(4)} PAS free, ${acc.reservedBalance.toFixed(
            4
          )} PAS reserved | ${stakingStatus} ${poolStatus}`
        );
      }

      console.log(`   Total: ${accounts.length} accounts found`);
    };

    // Check regular nominators (///1, ///2, etc.)
    await findAccountRange("///", "Regular nominators (///N)");

    // Check pool creators (//pool/1, //pool/2, etc.)
    await findAccountRange("//pool/", "Pool creators (//pool/N)");

    // Check pool members (//member/1, //member/2, etc.)
    await findAccountRange("//member/", "Pool members (//member/N)");

    // Check hybrid stakers (//hybrid/1, //hybrid/2, etc.)
    await findAccountRange("//hybrid/", "Hybrid stakers (//hybrid/N)");

    console.log("\n✅ Account listing complete");
  } finally {
    cleanup(smoldot, client);
  }
}

// Unbond accounts and return funds to god account
export async function unbondAccounts(accountIndices: number[], isDryRun: boolean, godSeed: string) {
  console.log(
    `🔓 ${isDryRun ? "DRY RUN: " : ""}Unbonding ${accountIndices.length} account(s) and returning funds to god account...\n`
  );

  const { api, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);

  try {
    if (isDryRun) {
      console.log("📊 Analysis of accounts to unbond:\n");
    }

    let totalToReturn = 0n;
    const accountsToUnbond: Array<{
      index: number;
      address: string;
      accountType: string;
      derivationPath: string;
      freeBalance: bigint;
      bondedAmount: bigint;
      poolMemberPoints: bigint;
      isNominating: boolean;
      poolId?: number;
    }> = [];

    // Check each account index and determine what type of account it is
    for (const index of accountIndices) {
      // Try different derivation paths
      const derivationPaths = [
        { path: `///${index}`, type: "Regular nominator" },
        { path: `//pool/${index}`, type: "Pool creator" },
        { path: `//member/${index}`, type: "Pool member" },
        { path: `//hybrid/${index}`, type: "Hybrid staker" },
      ];

      for (const { path, type } of derivationPaths) {
        const account = derive(path);
        const address = ss58Encode(account.publicKey, 0);

        const accountInfo = await api.query.System.Account.getValue(address);
        if (accountInfo.nonce > 0 || accountInfo.data.free > 0n || accountInfo.data.reserved > 0n) {
          // Account exists, check staking status
          const ledger = await api.query.Staking.Ledger.getValue(address);
          const nominations = await api.query.Staking.Nominators.getValue(address);
          const poolMember = await api.query.NominationPools.PoolMembers.getValue(address);

          const freeBalance = accountInfo.data.free;
          const bondedAmount = ledger ? ledger.active : 0n;
          const poolMemberPoints = poolMember ? poolMember.points : 0n;
          const isNominating = nominations !== undefined;
          const poolId = poolMember ? poolMember.pool_id : undefined;

          if (bondedAmount > 0n || poolMemberPoints > 0n) {
            accountsToUnbond.push({
              index,
              address,
              accountType: type,
              derivationPath: path,
              freeBalance,
              bondedAmount,
              poolMemberPoints,
              isNominating,
              poolId,
            });

            totalToReturn += freeBalance;

            if (isDryRun) {
              console.log(`   [${index}] ${type} (${path})`);
              console.log(`        Address: ${address}`);
              console.log(`        Free: ${Number(freeBalance) / Number(PAS)} PAS`);
              if (bondedAmount > 0n) {
                console.log(
                  `        Bonded: ${Number(bondedAmount) / Number(PAS)} PAS${isNominating ? " (nominating)" : ""}`
                );
              }
              if (poolMemberPoints > 0n) {
                console.log(
                  `        Pool member: ${Number(poolMemberPoints) / Number(PAS)} PAS (Pool ${poolId})`
                );
              }
              console.log("");
            }
            break; // Found the account, no need to check other paths
          }
        }
      }
    }

    if (accountsToUnbond.length === 0) {
      console.log("❌ No stakeable accounts found for the specified indices");
      return;
    }

    if (isDryRun) {
      console.log(`📊 Summary:`);
      console.log(`   Accounts to unbond: ${accountsToUnbond.length}`);
      console.log(`   Total funds to return: ${Number(totalToReturn) / Number(PAS)} PAS`);
      console.log(`   God account would receive: ${Number(totalToReturn) / Number(PAS)} PAS`);
      console.log("\n   Operations that would be performed:");

      for (const account of accountsToUnbond) {
        console.log(`   [${account.index}] ${account.accountType}:`);
        if (account.isNominating) {
          console.log(`      1. Chill (stop nominating)`);
        }
        if (account.bondedAmount > 0n) {
          console.log(`      2. Unbond ${Number(account.bondedAmount) / Number(PAS)} PAS`);
          console.log(`      3. Wait 28 days for unbonding period`);
          console.log(`      4. Withdraw unbonded funds`);
        }
        if (account.poolMemberPoints > 0n) {
          console.log(
            `      2. Unbond from pool ${account.poolId} (${Number(account.poolMemberPoints) / Number(PAS)} PAS)`
          );
          console.log(`      3. Wait 28 days for unbonding period`);
          console.log(`      4. Withdraw from pool`);
        }
        console.log(`      5. Transfer remaining balance to god account`);
      }
      return;
    }

    // Execute unbonding operations
    console.log("🔄 Executing unbonding operations...\n");

    let processedCount = 0;
    const results = {
      chilled: 0,
      unbonded: 0,
      poolLeft: 0,
      errors: 0,
    };

    for (const account of accountsToUnbond) {
      console.log(
        `[${++processedCount}/${accountsToUnbond.length}] Processing ${account.accountType} at ${account.derivationPath}...`
      );

      try {
        const accountKeyPair = derive(account.derivationPath);
        const accountSigner = getPolkadotSigner(
          accountKeyPair.publicKey,
          "Sr25519",
          accountKeyPair.sign
        );

        const transactions = [];

        // 1. Chill if nominating
        if (account.isNominating) {
          console.log(`   Chilling (stopping nominations)...`);
          transactions.push(api.tx.Staking.chill());
          results.chilled++;
        }

        // 2. Unbond from solo staking
        if (account.bondedAmount > 0n) {
          console.log(
            `   Unbonding ${Number(account.bondedAmount) / Number(PAS)} PAS from solo staking...`
          );
          transactions.push(api.tx.Staking.unbond({ value: account.bondedAmount }));
          results.unbonded++;
        }

        // 3. Leave pool (unbond from pool)
        if (account.poolMemberPoints > 0n) {
          console.log(
            `   Unbonding ${Number(account.poolMemberPoints) / Number(PAS)} PAS from pool ${account.poolId}...`
          );
          transactions.push(
            api.tx.NominationPools.unbond({
              member_account: { type: "Id", value: account.address },
              unbonding_points: account.poolMemberPoints,
            })
          );
          results.poolLeft++;
        }

        if (transactions.length > 0) {
          // Submit batch transaction if multiple operations needed
          let tx;
          if (transactions.length === 1) {
            tx = transactions[0];
          } else {
            tx = api.tx.Utility.batch_all({
              calls: transactions.map((t) => t.decodedCall),
            });
          }

          // Use the proper signer pattern
          await new Promise<void>((resolve, reject) => {
            let completed = false;
            let subscription: any = null;

            const timeout = setTimeout(() => {
              if (!completed) {
                completed = true;
                if (subscription) {
                  try {
                    subscription.unsubscribe();
                  } catch {}
                }
                results.errors++;
                reject(new Error("Transaction timeout"));
              }
            }, 30000);

            subscription = tx!.signSubmitAndWatch(accountSigner).subscribe({
              next: (event: any) => {
                if (event.type === "txBestBlocksState") {
                  console.log(`   ✅ Transaction included in block`);
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
              error: (error: any) => {
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);
                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }
                  console.log(`   ❌ Transaction error: ${error}`);
                  results.errors++;
                  reject(error);
                }
              },
            });
          });
        }
      } catch (error) {
        console.log(`   ❌ Error processing account: ${error}`);
        results.errors++;
      }
    }

    console.log(`\n📊 Summary of operations:`);
    console.log(`   Accounts chilled: ${results.chilled}`);
    console.log(`   Solo stakes unbonded: ${results.unbonded}`);
    console.log(`   Pool memberships left: ${results.poolLeft}`);
    console.log(`   Errors: ${results.errors}`);

    if (results.unbonded > 0 || results.poolLeft > 0) {
      console.log(
        `\n⏳ Unbonding initiated. Accounts must wait for the unbonding period (28 days on Paseo).`
      );
      console.log(`   After the unbonding period, you can:`);
      console.log(`   1. Use Staking.withdraw_unbonded() to withdraw solo staking funds`);
      console.log(`   2. Use NominationPools.withdraw_unbonded() to withdraw pool funds`);
      console.log(`   3. Transfer remaining balances back to god account`);
      console.log(
        `\n   Consider running this tool again after 28 days to complete the withdrawal process.`
      );
    }
  } finally {
    cleanup(smoldot, client);
  }
}
