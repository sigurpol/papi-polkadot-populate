// Account management functionality
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { setupApiAndConnection, cleanup } from "./common.js";
// No direct use of DeriveFunction in this file - it's used in imported functions

// List all derived accounts created by this tool
export async function listAccounts(godSeed: string) {
  console.log("📋 Listing all derived accounts created by this tool...\n");

  const { api, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);

  try {
    console.log("🔍 Scanning for derived accounts...\n");

    // Check regular nominators (///1, ///2, etc.)
    console.log("👥 Regular nominators (///N):");
    let found = false;
    for (let index = 1; index <= 200; index++) {
      const account = derive(`///${index}`);
      const address = ss58Encode(account.publicKey, 0);

      // Check if account exists on chain
      const accountInfo = await api.query.System.Account.getValue(address);
      if (accountInfo.nonce > 0 || accountInfo.data.free > 0n || accountInfo.data.reserved > 0n) {
        found = true;
        const freeBalance = Number(accountInfo.data.free) / Number(PAS);
        const reservedBalance = Number(accountInfo.data.reserved) / Number(PAS);

        // Check staking status
        const ledger = await api.query.Staking.Ledger.getValue(address);
        const nominations = await api.query.Staking.Nominators.getValue(address);

        let stakingInfo = "";
        if (ledger) {
          const bonded = Number(ledger.active) / Number(PAS);
          stakingInfo = ` | Bonded: ${bonded} PAS`;
          if (nominations) {
            stakingInfo += ` | Nominating ${nominations.targets.length} validators`;
          }
        }

        console.log(
          `   [${index}] ${address}: ${freeBalance} PAS free, ${reservedBalance} PAS reserved${stakingInfo}`
        );
      }
    }
    if (!found) {
      console.log("   No regular nominator accounts found");
    }

    // Check pool creators (//pool/1, //pool/2, etc.)
    console.log("\n🏊 Pool creators (//pool/N):");
    found = false;
    for (let index = 1; index <= 100; index++) {
      const account = derive(`//pool/${index}`);
      const address = ss58Encode(account.publicKey, 0);

      const accountInfo = await api.query.System.Account.getValue(address);
      if (accountInfo.nonce > 0 || accountInfo.data.free > 0n || accountInfo.data.reserved > 0n) {
        found = true;
        const freeBalance = Number(accountInfo.data.free) / Number(PAS);
        const reservedBalance = Number(accountInfo.data.reserved) / Number(PAS);

        // Check if this account is a pool root
        const allPoolEntries = await api.query.NominationPools.BondedPools.getEntries();
        let poolInfo = "";
        for (const entry of allPoolEntries) {
          const poolId = entry.keyArgs[0];
          const pool = entry.value;
          if (pool && pool.roles.root === address) {
            const poolPoints = Number(pool.points) / Number(PAS);
            poolInfo = ` | Root of Pool ${poolId} (${poolPoints} PAS, ${pool.state.type})`;
            break;
          }
        }

        console.log(
          `   [${index}] ${address}: ${freeBalance} PAS free, ${reservedBalance} PAS reserved${poolInfo}`
        );
      }
    }
    if (!found) {
      console.log("   No pool creator accounts found");
    }

    // Check pool members (//member/1, //member/2, etc.)
    console.log("\n👥 Pool members (//member/N):");
    found = false;
    for (let index = 1; index <= 200; index++) {
      const account = derive(`//member/${index}`);
      const address = ss58Encode(account.publicKey, 0);

      const accountInfo = await api.query.System.Account.getValue(address);
      if (accountInfo.nonce > 0 || accountInfo.data.free > 0n || accountInfo.data.reserved > 0n) {
        found = true;
        const freeBalance = Number(accountInfo.data.free) / Number(PAS);
        const reservedBalance = Number(accountInfo.data.reserved) / Number(PAS);

        // Check pool membership
        const poolMember = await api.query.NominationPools.PoolMembers.getValue(address);
        let memberInfo = "";
        if (poolMember) {
          const memberPoints = Number(poolMember.points) / Number(PAS);
          memberInfo = ` | Member of Pool ${poolMember.pool_id} (${memberPoints} PAS)`;
        }

        console.log(
          `   [${index}] ${address}: ${freeBalance} PAS free, ${reservedBalance} PAS reserved${memberInfo}`
        );
      }
    }
    if (!found) {
      console.log("   No pool member accounts found");
    }

    // Check hybrid stakers (//hybrid/1, //hybrid/2, etc.)
    console.log("\n🔄 Hybrid stakers (//hybrid/N):");
    found = false;
    for (let index = 1; index <= 100; index++) {
      const account = derive(`//hybrid/${index}`);
      const address = ss58Encode(account.publicKey, 0);

      const accountInfo = await api.query.System.Account.getValue(address);
      if (accountInfo.nonce > 0 || accountInfo.data.free > 0n || accountInfo.data.reserved > 0n) {
        found = true;
        const freeBalance = Number(accountInfo.data.free) / Number(PAS);
        const reservedBalance = Number(accountInfo.data.reserved) / Number(PAS);

        // Check both pool membership and solo staking
        const poolMember = await api.query.NominationPools.PoolMembers.getValue(address);
        const ledger = await api.query.Staking.Ledger.getValue(address);
        const nominations = await api.query.Staking.Nominators.getValue(address);

        let hybridInfo = "";
        if (poolMember) {
          const memberPoints = Number(poolMember.points) / Number(PAS);
          hybridInfo += ` | Pool member: ${memberPoints} PAS`;
        }
        if (ledger) {
          const bonded = Number(ledger.active) / Number(PAS);
          hybridInfo += ` | Solo bonded: ${bonded} PAS`;
          if (nominations) {
            hybridInfo += ` (nominating ${nominations.targets.length})`;
          }
        }

        console.log(
          `   [${index}] ${address}: ${freeBalance} PAS free, ${reservedBalance} PAS reserved${hybridInfo}`
        );
      }
    }
    if (!found) {
      console.log("   No hybrid staker accounts found");
    }

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
