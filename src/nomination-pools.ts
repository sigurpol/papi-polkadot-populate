// Nomination pools functionality
import { setupApiAndConnection, cleanup } from "./common.js";
import {
  parsePoolMembers,
  getPoolAccountAtIndex,
  getPoolMemberAccountAtIndex,
  getHybridAccountAtIndex,
} from "./utils.js";
// Types are used in function parameters and return types

// Export the pool management functions
export async function destroyPools(poolIds: number[], isDryRun: boolean, godSeed: string) {
  console.log("🚀 Starting PAPI Polkadot Populate - DESTROY POOLS MODE");
  console.log(`📊 Configuration:`);
  console.log(`   - Pools to destroy: ${poolIds.join(", ")}`);
  console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);

  const { api, derive, smoldot, client } = await setupApiAndConnection(godSeed);

  try {
    const results = {
      checked: 0,
      destroyed: 0,
      failed: 0,
      notFound: 0,
      notOwned: 0,
    };

    for (const poolId of poolIds) {
      results.checked++;
      console.log(`\n🔍 Checking pool ${poolId}...`);

      // Check if pool exists
      const poolInfo = await api.query.NominationPools.BondedPools.getValue(poolId);
      if (!poolInfo) {
        console.log(`   ❌ Pool ${poolId} does not exist`);
        results.notFound++;
        continue;
      }

      // Find which derived account owns this pool
      let poolAccount = null;
      let foundIndex = -1;
      for (let index = 1; index <= 100; index++) {
        const testAccount = getPoolAccountAtIndex(index, derive);
        if (poolInfo.roles.root === testAccount.address) {
          poolAccount = testAccount;
          foundIndex = index;
          break;
        }
      }

      if (!poolAccount) {
        console.log(`   ❌ Pool ${poolId} is not owned by any of our derived accounts`);
        console.log(`      Pool root: ${poolInfo.roles.root}`);
        results.notOwned++;
        continue;
      }

      console.log(
        `   📋 Pool ${poolId} creator account: ${poolAccount.address} (//pool/${foundIndex})`
      );

      // We found the owner
      console.log(`   ✅ Pool ${poolId} is owned by our account //pool/${foundIndex}`);
      console.log(`   📊 Pool state: ${poolInfo.state.type}`);
      console.log(`   💰 Pool points: ${poolInfo.points}`);

      if (isDryRun) {
        console.log(`   🔍 DRY RUN: Would destroy pool ${poolId}`);
        results.destroyed++;
        continue;
      }

      // Check if pool has members
      const memberEntries = await api.query.NominationPools.PoolMembers.getEntries();
      const poolMembers = memberEntries.filter((entry) => entry.value.pool_id === poolId);
      const memberCount = poolMembers.length;

      if (memberCount > 0) {
        // Check if the only member is the pool creator
        const poolCreator = poolInfo.roles.root;
        const onlyMemberIsCreator = memberCount === 1 && poolMembers[0]?.keyArgs[0] === poolCreator;

        if (onlyMemberIsCreator) {
          console.log(
            `   ℹ️  Pool ${poolId} has only the creator as member - proceeding to set Destroying state`
          );
        } else {
          console.log(
            `   ⚠️  Pool ${poolId} has ${memberCount} members - cannot destroy pools with members`
          );
          console.log(`   💡 Members must unbond and leave the pool before it can be destroyed`);
          results.failed++;
          continue;
        }
      }

      // For pools without members, we need to set state to Destroying first
      console.log(`   🗑️  Setting pool ${poolId} state to Destroying...`);

      try {
        // First set the pool state to Destroying
        const setStateTx = api.tx.NominationPools.set_state({
          pool_id: poolId,
          state: { type: "Destroying", value: undefined },
        });

        await new Promise((resolve, reject) => {
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
              reject(new Error(`Set state for pool ${poolId} timeout`));
            }
          }, 30000);

          subscription = setStateTx.signSubmitAndWatch(poolAccount.signer).subscribe({
            next: (event: any) => {
              console.log(`     📊 Set state event:`, event.type);
              if (event.type === "txBestBlocksState") {
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);
                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }

                  // Check for dispatch errors
                  if ("dispatchError" in event && event.dispatchError) {
                    console.log(
                      `     ❌ Pool ${poolId} state change failed with dispatch error:`,
                      event.dispatchError
                    );
                    results.failed++;
                  } else {
                    console.log(`     ✅ Pool ${poolId} state set to Destroying`);
                    results.destroyed++;
                  }
                  resolve(null);
                }
              } else if ((event as any).type === "txInvalid") {
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);
                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }
                  console.error(`     ❌ Pool ${poolId} state change transaction invalid`);
                  results.failed++;
                  resolve(null);
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
                console.error(`     ❌ Pool ${poolId} state change failed:`, error);
                results.failed++;
                resolve(null);
              }
            },
          });
        });

        console.log(`   ℹ️  Pool ${poolId} is now in Destroying state`);
        console.log(
          `   💡 Once all unbonding periods expire, the pool will be automatically removed`
        );
      } catch (error) {
        console.error(`   ❌ Failed to set pool ${poolId} to Destroying state:`, error);
        results.failed++;
      }
    }

    // Summary
    console.log(`\n📊 Pool Destruction Summary:`);
    console.log(`   - Pools checked: ${results.checked}`);
    console.log(`   - Pools destroyed: ${results.destroyed}`);
    console.log(`   - Pools failed: ${results.failed}`);
    console.log(`   - Pools not found: ${results.notFound}`);
    console.log(`   - Pools not owned: ${results.notOwned}`);
  } finally {
    cleanup(smoldot, client);
  }
}

export async function listPools(godSeed: string) {
  console.log("🚀 Starting PAPI Polkadot Populate - LIST POOLS MODE");
  const { api, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);

  try {
    console.log(`\n🔍 Scanning for pools created by this tool...`);

    // Get all existing pools
    const allPoolEntries = await api.query.NominationPools.BondedPools.getEntries();
    console.log(`   Found ${allPoolEntries.length} total pools on the network`);

    const ownedPools: Array<{
      poolId: number;
      info: any;
      creatorAddress: string;
      creatorIndex: number;
    }> = [];

    // Check each pool to see if we own it
    for (const entry of allPoolEntries) {
      const poolId = entry.keyArgs[0];
      const poolInfo = entry.value;

      // Check if any of our derived accounts is the root of this pool
      for (let index = 1; index <= 100; index++) {
        const poolAccount = getPoolAccountAtIndex(index, derive);
        if (poolInfo.roles.root === poolAccount.address) {
          ownedPools.push({
            poolId,
            info: poolInfo,
            creatorAddress: poolAccount.address,
            creatorIndex: index,
          });
          break; // Found owner, no need to check more indices
        }
      }
    }

    console.log(`\n📊 Pools created by this tool: ${ownedPools.length}`);

    if (ownedPools.length === 0) {
      console.log(`   No pools found created by accounts derived from your seed`);
      return;
    }

    // Sort by pool ID
    ownedPools.sort((a, b) => a.poolId - b.poolId);

    console.log(`\n📋 Pool Details:`);
    console.log(
      `${"Pool ID".padEnd(8)} ${"State".padEnd(12)} ${"Points".padEnd(15)} ${"Members".padEnd(8)} ${"Creator".padEnd(10)} ${"Address"}`
    );
    console.log(
      `${"─".repeat(8)} ${"─".repeat(12)} ${"─".repeat(15)} ${"─".repeat(8)} ${"─".repeat(10)} ${"─".repeat(50)}`
    );

    // Get all member entries once
    const allMemberEntries = await api.query.NominationPools.PoolMembers.getEntries();

    for (const { poolId, info, creatorAddress, creatorIndex } of ownedPools) {
      // Get members for this pool
      const poolMembers = allMemberEntries.filter((entry) => entry.value.pool_id === poolId);
      const memberCount = poolMembers.length;
      const stateStr = info.state.type;
      const pointsStr = `${Number(info.points) / Number(PAS)} PAS`;
      const creatorStr = `//pool/${creatorIndex}`;

      console.log(
        `${poolId.toString().padEnd(8)} ${stateStr.padEnd(12)} ${pointsStr.padEnd(15)} ${memberCount.toString().padEnd(8)} ${creatorStr.padEnd(10)} ${creatorAddress}`
      );

      // Show members if any
      if (memberCount > 0) {
        console.log(`         Members:`);
        for (const memberEntry of poolMembers) {
          const memberAddress = memberEntry.keyArgs[0];
          const memberInfo = memberEntry.value;
          const memberPoints = Number(memberInfo.points) / Number(PAS);
          const unbondingEras = memberInfo.unbonding_eras;

          // Check if this is a member we control
          let controlledBy = "";

          // Check member paths
          for (let i = 1; i <= 100; i++) {
            const testAccount = getPoolMemberAccountAtIndex(i, derive);
            if (testAccount.address === memberAddress) {
              controlledBy = ` [Controlled: //member/${i}]`;
              break;
            }
          }

          // Check hybrid paths if not found
          if (!controlledBy) {
            for (let i = 1; i <= 100; i++) {
              const testAccount = getHybridAccountAtIndex(i, derive);
              if (testAccount.address === memberAddress) {
                controlledBy = ` [Controlled: //hybrid/${i}]`;
                break;
              }
            }
          }

          const unbondingInfo = Object.keys(unbondingEras).length > 0 ? " (unbonding)" : "";
          console.log(
            `           - ${memberAddress}: ${memberPoints} PAS${unbondingInfo}${controlledBy}`
          );
        }
      }
    }

    // Summary statistics
    const totalPoints = ownedPools.reduce((sum, { info }) => sum + Number(info.points), 0);
    const states = ownedPools.reduce(
      (acc, { info }) => {
        acc[info.state.type] = (acc[info.state.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    console.log(`\n📈 Summary:`);
    console.log(`   - Total pools owned: ${ownedPools.length}`);
    console.log(`   - Total staked: ${totalPoints / Number(PAS)} PAS`);
    console.log(
      `   - Pool states: ${Object.entries(states)
        .map(([state, count]) => `${state}: ${count}`)
        .join(", ")}`
    );

    // Get overall pool statistics
    const totalNetworkPools = allPoolEntries.length;
    const percentage =
      totalNetworkPools > 0 ? ((ownedPools.length / totalNetworkPools) * 100).toFixed(1) : "0";
    console.log(
      `   - Network share: ${ownedPools.length}/${totalNetworkPools} pools (${percentage}%)`
    );
  } finally {
    cleanup(smoldot, client);
  }
}

export async function removeFromPool(poolMembersInput: string, isDryRun: boolean, godSeed: string) {
  console.log("🚀 Starting PAPI Polkadot Populate - REMOVE FROM POOL MODE");

  // Parse input
  let poolId: number;
  let targetMembers: string[] | "all";
  try {
    const parsed = parsePoolMembers(poolMembersInput);
    poolId = parsed.poolId;
    targetMembers = parsed.members;
  } catch (error) {
    console.error(`❌ Error parsing input:`, error);
    console.error(`   Valid formats: '10:addr1,addr2' or '10:all'`);
    return;
  }

  console.log(`📊 Configuration:`);
  console.log(`   - Pool ID: ${poolId}`);
  console.log(
    `   - Members to remove: ${targetMembers === "all" ? "All controllable members" : targetMembers.length + " specified"}`
  );
  console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);

  const { api, derive, PAS, smoldot, client } = await setupApiAndConnection(godSeed);

  try {
    // Check if pool exists
    const poolInfo = await api.query.NominationPools.BondedPools.getValue(poolId);
    if (!poolInfo) {
      console.log(`\n❌ Pool ${poolId} does not exist`);
      return;
    }

    console.log(`\n📊 Pool ${poolId} information:`);
    console.log(`   - State: ${poolInfo.state.type}`);
    console.log(`   - Points: ${Number(poolInfo.points) / Number(PAS)} PAS`);

    // Get all members of this pool
    const allMemberEntries = await api.query.NominationPools.PoolMembers.getEntries();
    const poolMembers = allMemberEntries.filter((entry) => entry.value.pool_id === poolId);
    console.log(`   - Total members: ${poolMembers.length}`);

    // Determine which members to process
    let membersToProcess: Array<{
      address: string;
      info: any;
      keyPair?: any;
      derivationPath?: string;
    }> = [];

    if (targetMembers === "all") {
      // Process all members we can control
      for (const memberEntry of poolMembers) {
        const memberAddress = memberEntry.keyArgs[0];
        const memberInfo = memberEntry.value;

        // Find if we control this account
        let memberKeyPair = null;
        let derivationPath = "";

        // Check member paths
        for (let i = 1; i <= 100; i++) {
          const testAccount = getPoolMemberAccountAtIndex(i, derive);
          if (testAccount.address === memberAddress) {
            memberKeyPair = testAccount;
            derivationPath = `//member/${i}`;
            break;
          }
        }

        // Check hybrid paths if not found
        if (!memberKeyPair) {
          for (let i = 1; i <= 100; i++) {
            const testAccount = getHybridAccountAtIndex(i, derive);
            if (testAccount.address === memberAddress) {
              memberKeyPair = testAccount;
              derivationPath = `//hybrid/${i}`;
              break;
            }
          }
        }

        // Check pool creator paths if not found
        if (!memberKeyPair) {
          for (let i = 1; i <= 100; i++) {
            const testAccount = getPoolAccountAtIndex(i, derive);
            if (testAccount.address === memberAddress) {
              memberKeyPair = testAccount;
              derivationPath = `//pool/${i}`;
              break;
            }
          }
        }

        if (memberKeyPair) {
          membersToProcess.push({
            address: memberAddress,
            info: memberInfo,
            keyPair: memberKeyPair,
            derivationPath,
          });
        }
      }

      console.log(
        `\n🔍 Found ${membersToProcess.length} controllable members out of ${poolMembers.length} total`
      );
    } else {
      // Process specific members
      for (const targetAddress of targetMembers as string[]) {
        const memberEntry = poolMembers.find((entry) => entry.keyArgs[0] === targetAddress);
        if (!memberEntry) {
          console.log(`\n⚠️  ${targetAddress} is not a member of pool ${poolId}`);
          continue;
        }

        const memberInfo = memberEntry.value;

        // Find if we control this account
        let memberKeyPair = null;
        let derivationPath = "";

        // Check all derivation paths
        for (let i = 1; i <= 100; i++) {
          const testAccount = getPoolMemberAccountAtIndex(i, derive);
          if (testAccount.address === targetAddress) {
            memberKeyPair = testAccount;
            derivationPath = `//member/${i}`;
            break;
          }
        }

        if (!memberKeyPair) {
          for (let i = 1; i <= 100; i++) {
            const testAccount = getHybridAccountAtIndex(i, derive);
            if (testAccount.address === targetAddress) {
              memberKeyPair = testAccount;
              derivationPath = `//hybrid/${i}`;
              break;
            }
          }
        }

        // Check pool creator paths if not found
        if (!memberKeyPair) {
          for (let i = 1; i <= 100; i++) {
            const testAccount = getPoolAccountAtIndex(i, derive);
            if (testAccount.address === targetAddress) {
              memberKeyPair = testAccount;
              derivationPath = `//pool/${i}`;
              break;
            }
          }
        }

        if (!memberKeyPair) {
          console.log(`\n⚠️  Cannot control ${targetAddress} - not created by this tool`);
          continue;
        }

        membersToProcess.push({
          address: targetAddress,
          info: memberInfo,
          keyPair: memberKeyPair,
          derivationPath,
        });
      }
    }

    if (membersToProcess.length === 0) {
      console.log(`\n❌ No controllable members found to process`);
      return;
    }

    console.log(`\n📋 Members to process:`);
    for (const member of membersToProcess) {
      const memberPoints = Number(member.info.points) / Number(PAS);
      const unbondingEras = member.info.unbonding_eras;
      const isUnbonding = Object.keys(unbondingEras).length > 0;
      console.log(`   - ${member.address} ${member.derivationPath}:`);
      console.log(
        `     Staked: ${memberPoints} PAS, Status: ${isUnbonding ? "Unbonding" : "Bonded"}`
      );
    }

    // Check if we're trying to remove the pool creator while pool is active
    const isLastMember = poolMembers.length === 1;
    const poolCreator = poolInfo.roles.root;
    const isRemovingCreator = membersToProcess.some((m) => m.address === poolCreator);

    if (isLastMember && isRemovingCreator && poolInfo.state.type === "Open") {
      console.log(`\n⚠️  Cannot remove pool creator when they are the last member`);
      console.log(`   Pool ${poolId} must be set to "Destroying" state first`);
      console.log(`   Use: --destroy-pools "${poolId}" to destroy the pool`);
      return;
    }

    if (isDryRun) {
      console.log(`\n🔍 DRY RUN: Would perform the following actions:`);
      for (const member of membersToProcess) {
        const isUnbonding = Object.keys(member.info.unbonding_eras).length > 0;
        const memberPoints = Number(member.info.points) / Number(PAS);

        console.log(`\n   For ${member.address}:`);
        if (!isUnbonding) {
          console.log(`     1. Unbond ${memberPoints} PAS from pool ${poolId}`);
          console.log(`     2. Wait for unbonding period (28 days on Paseo)`);
          console.log(`     3. Withdraw unbonded funds`);
        } else {
          console.log(`     1. Member is already unbonding`);
          console.log(`     2. Check if unbonding period has completed`);
          console.log(`     3. Withdraw unbonded funds if ready`);
        }
      }
      return;
    }

    // Process each member
    const results = {
      unbonded: 0,
      withdrawn: 0,
      failed: 0,
    };

    // Need to import MultiAddress
    const { MultiAddress } = await import("@polkadot-api/descriptors");

    for (const member of membersToProcess) {
      const isUnbonding = Object.keys(member.info.unbonding_eras).length > 0;
      const memberPoints = Number(member.info.points) / Number(PAS);

      console.log(`\n🔄 Processing ${member.address}...`);

      if (!isUnbonding && memberPoints > 0) {
        // Unbond from pool
        console.log(`   🔗 Unbonding ${memberPoints} PAS...`);

        const unbondTx = api.tx.NominationPools.unbond({
          member_account: MultiAddress.Id(member.address),
          unbonding_points: member.info.points,
        });

        try {
          await new Promise((resolve, reject) => {
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
                reject(new Error(`Unbond timeout`));
              }
            }, 30000);

            subscription = unbondTx.signSubmitAndWatch(member.keyPair.signer).subscribe({
              next: (event: any) => {
                if (event.type === "txBestBlocksState") {
                  if (!completed) {
                    completed = true;
                    clearTimeout(timeout);
                    if (subscription) {
                      try {
                        subscription.unsubscribe();
                      } catch {}
                    }

                    if ("dispatchError" in event && event.dispatchError) {
                      console.log(`   ❌ Unbond failed with dispatch error:`, event.dispatchError);
                      results.failed++;
                    } else {
                      console.log(`   ✅ Successfully unbonded ${memberPoints} PAS`);
                      results.unbonded++;
                    }
                    resolve(null);
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
                  console.error(`   ❌ Unbond failed:`, error);
                  results.failed++;
                  resolve(null);
                }
              },
            });
          });
        } catch (error) {
          console.error(`   ❌ Unbond error:`, error);
          results.failed++;
        }
      } else if (isUnbonding) {
        // Try to withdraw
        console.log(`   💰 Attempting to withdraw unbonded funds...`);

        const withdrawTx = api.tx.NominationPools.withdraw_unbonded({
          member_account: MultiAddress.Id(member.address),
          num_slashing_spans: 0,
        });

        try {
          await new Promise((resolve, reject) => {
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
                reject(new Error(`Withdraw timeout`));
              }
            }, 30000);

            subscription = withdrawTx.signSubmitAndWatch(member.keyPair.signer).subscribe({
              next: (event: any) => {
                if (event.type === "txBestBlocksState") {
                  if (!completed) {
                    completed = true;
                    clearTimeout(timeout);
                    if (subscription) {
                      try {
                        subscription.unsubscribe();
                      } catch {}
                    }

                    if ("dispatchError" in event && event.dispatchError) {
                      console.log(`   ❌ Withdraw failed - unbonding period may not be complete`);
                      results.failed++;
                    } else {
                      console.log(`   ✅ Successfully withdrew funds - member has left the pool!`);
                      results.withdrawn++;
                    }
                    resolve(null);
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
                  console.error(`   ❌ Withdraw failed:`, error);
                  results.failed++;
                  resolve(null);
                }
              },
            });
          });
        } catch (error) {
          console.error(`   ❌ Withdraw error:`, error);
          results.failed++;
        }
      }
    }

    // Summary
    console.log(`\n📊 Removal Summary:`);
    console.log(`   - Members unbonded: ${results.unbonded}`);
    console.log(`   - Members withdrawn: ${results.withdrawn}`);
    console.log(`   - Operations failed: ${results.failed}`);

    if (results.unbonded > 0) {
      console.log(`\n⏳ Unbonding initiated for ${results.unbonded} members.`);
      console.log(`   They must wait for the unbonding period to complete (28 days on Paseo).`);
      console.log(`   Run this command again after the period to withdraw funds.`);
    }
  } finally {
    cleanup(smoldot, client);
  }
}
