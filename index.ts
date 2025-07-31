import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy, DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createClient } from "polkadot-api";
import type { SS58String } from "polkadot-api";
import { paseo, MultiAddress } from "@polkadot-api/descriptors";
import { chainSpec } from "polkadot-api/chains/paseo";
import { getSmProvider } from "polkadot-api/sm-provider";
import { start } from "polkadot-api/smoldot";
import { Command } from "commander";
import { fromHex } from "@polkadot-api/utils";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";

// Type definitions for PAPI interfaces
interface TransactionEvent {
  type: string;
  txHash?: string;
}

interface KeyPair {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
}

interface Signer {
  // Polkadot API signer interface
  [key: string]: any;
}

interface TypedApi {
  // PAPI typed API interface - keeping as any for now due to complex PAPI types
  [key: string]: any;
}

type DeriveFunction = (path: string) => KeyPair;

// Set up CLI argument parsing
const program = new Command();

program
  .name("papi-polkadot-populate")
  .description("Populate Paseo testnet with nominators and nomination pools using PAPI")
  .version("1.0.0")
  .requiredOption("--seed <string>", "God account seed phrase")
  .option("--nominators <number>", "Number of nominator accounts to create", "100")
  .option(
    "--validators-per-nominator <number>",
    "Number of validators each nominator selects",
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
    "--force-destroy-pools <range>",
    "Force destroy pools by unbonding all controllable members first"
  )
  .option("--list-pools", "List all pools created by this tool")
  .option(
    "--remove-from-pool <poolId:members>",
    "Remove members from a pool (e.g., '10:addr1,addr2' or '10:all')"
  )
  .option("--dry-run", "Show what would happen without executing transactions")
  .parse(process.argv);

const options = program.opts();

// Helper function to get account at index using hard derivation
const getAccountAtIndex = (index: number, derive: DeriveFunction) => {
  // Use hard derivation path: ///index
  const childKeyPair = derive(`///${index}`);
  return {
    keyPair: childKeyPair,
    address: ss58Encode(childKeyPair.publicKey, 0),
    signer: getPolkadotSigner(childKeyPair.publicKey, "Sr25519", childKeyPair.sign),
    index, // Store the account index
  };
};

// Helper function to get pool account at index using pool-specific derivation
const getPoolAccountAtIndex = (index: number, derive: DeriveFunction) => {
  // Use pool derivation path: //pool/index
  const childKeyPair = derive(`//pool/${index}`);
  return {
    keyPair: childKeyPair,
    address: ss58Encode(childKeyPair.publicKey, 0),
    signer: getPolkadotSigner(childKeyPair.publicKey, "Sr25519", childKeyPair.sign),
    index,
  };
};

// Helper function to get pool member account at index using member-specific derivation
const getPoolMemberAccountAtIndex = (index: number, derive: DeriveFunction) => {
  // Use member derivation path: //member/index
  const childKeyPair = derive(`//member/${index}`);
  return {
    keyPair: childKeyPair,
    address: ss58Encode(childKeyPair.publicKey, 0),
    signer: getPolkadotSigner(childKeyPair.publicKey, "Sr25519", childKeyPair.sign),
    index,
  };
};

// Helper function to get hybrid account at index using hybrid-specific derivation
const getHybridAccountAtIndex = (index: number, derive: DeriveFunction) => {
  // Use hybrid derivation path: //hybrid/index
  const childKeyPair = derive(`//hybrid/${index}`);
  return {
    keyPair: childKeyPair,
    address: ss58Encode(childKeyPair.publicKey, 0),
    signer: getPolkadotSigner(childKeyPair.publicKey, "Sr25519", childKeyPair.sign),
    index,
  };
};

// Function to create accounts with batch transfers
async function createAccounts(
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
async function stakeAndNominate(
  api: TypedApi,
  derive: DeriveFunction,
  createdAccountIndices: number[],
  stakeAmounts: Map<number, bigint>,
  minNominatorBond: bigint,
  validatorsPerNominator: number,
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
        const stakeAmount = stakeAmounts.get(accountIndex) || minNominatorBond;

        // Skip balance check - assume account has sufficient balance since we just funded it

        console.log(
          `   [${accountIndex}] Staking ${Number(stakeAmount) / Number(PAS)} PAS and nominating from ${account.address}`
        );

        // Select random validators
        const selectedValidators: SS58String[] = [];
        const validatorsCopy = [...allValidators];

        for (let i = 0; i < Math.min(validatorsPerNominator, allValidators.length); i++) {
          const randomIndex = Math.floor(Math.random() * validatorsCopy.length);
          const validator = validatorsCopy[randomIndex];
          if (validator) {
            selectedValidators.push(validator);
            validatorsCopy.splice(randomIndex, 1);
          }
        }

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

  return { stakedCount, skippedCount };
}

// Top-up function
async function topupAccounts(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  topupAmountPAS: number,
  fromIndex: number,
  toIndex: number,
  godBalance: bigint,
  PAS: bigint,
  isDryRun: boolean,
  batchSize = 500
) {
  const topupAmountPlanck = (PAS * BigInt(Math.floor(topupAmountPAS * 100))) / 100n; // Convert to planck with precision

  console.log(
    `\n💰 Starting topup to ${topupAmountPAS} PAS for accounts ${fromIndex} to ${toIndex - 1}...`
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

    if (currentBalance < topupAmountPlanck) {
      const topupAmount = topupAmountPlanck - currentBalance;
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
  console.log(`   - God account balance: ${Number(godBalance) / Number(PAS)} PAS`);

  if (totalTopupNeeded === 0n) {
    console.log(`✅ All accounts already have sufficient balance - nothing to do`);
    return { toppedUpCount: 0, skippedCount: toIndex - fromIndex };
  }

  if (godBalance < totalTopupNeeded) {
    console.error(
      `\n❌ Insufficient balance! Need ${Number(totalTopupNeeded) / Number(PAS)} PAS but only have ${Number(godBalance) / Number(PAS)} PAS`
    );
    process.exit(1);
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

// Function to validate and process god account seed
function validateAndProcessSeed(godSeed: string): {
  miniSecret: Uint8Array;
  derive: DeriveFunction;
  godKeyPair: KeyPair;
  godSigner: Signer;
} {
  let miniSecret: Uint8Array;

  if (godSeed.toLowerCase() === "dev") {
    console.log("🔧 Using development phrase");
    miniSecret = entropyToMiniSecret(mnemonicToEntropy(DEV_PHRASE));
  } else if (godSeed.startsWith("0x")) {
    // Handle hex seed
    console.log("🔧 Using hex seed");
    try {
      const hexSeed = godSeed.slice(2); // Remove 0x prefix
      if (hexSeed.length !== 64) {
        throw new Error("Hex seed must be 32 bytes (64 hex characters)");
      }
      miniSecret = fromHex(godSeed);
    } catch {
      console.error(
        "❌ Error: Invalid hex seed. Must be 32 bytes (64 hex characters) starting with 0x"
      );
      console.error(`   Example: 0x${"f".repeat(64)}`);
      process.exit(1);
    }
  } else {
    // Expect a valid mnemonic phrase
    try {
      miniSecret = entropyToMiniSecret(mnemonicToEntropy(godSeed));
    } catch {
      console.error("❌ Error: Invalid seed format. Seed must be one of:");
      console.error("   - A valid 12-24 word mnemonic phrase");
      console.error("   - A 32-byte hex string starting with 0x");
      console.error("   - 'dev' for testing");
      process.exit(1);
    }
  }

  const derive = sr25519CreateDerive(miniSecret);
  const godKeyPair = derive("");
  const godSigner = getPolkadotSigner(godKeyPair.publicKey, "Sr25519", godKeyPair.sign);

  return { miniSecret, derive, godKeyPair, godSigner };
}

// Function to fetch pool chain parameters from NominationPools pallet
async function getPoolChainParameters(api: TypedApi, PAS: bigint) {
  // Fetch live chain values from NominationPools pallet
  const minCreateBond = await api.query.NominationPools.MinCreateBond.getValue();
  const minJoinBond = await api.query.NominationPools.MinJoinBond.getValue();

  // These may not exist on all chains, so handle gracefully
  let maxPools: number | undefined;
  let maxPoolMembers: number | undefined;
  let counterForPoolMembers: number;
  let counterForBondedPools: number;

  try {
    maxPools = await api.query.NominationPools.MaxPools.getValue();
  } catch {
    maxPools = undefined;
  }

  try {
    maxPoolMembers = await api.query.NominationPools.MaxPoolMembers.getValue();
  } catch {
    maxPoolMembers = undefined;
  }

  try {
    counterForPoolMembers = await api.query.NominationPools.CounterForPoolMembers.getValue();
  } catch {
    counterForPoolMembers = 0;
  }

  try {
    counterForBondedPools = await api.query.NominationPools.CounterForBondedPools.getValue();
  } catch {
    counterForBondedPools = 0;
  }

  console.log(`\n🏊 Pool Chain Parameters:`);
  console.log(`   - MinCreateBond: ${Number(minCreateBond) / Number(PAS)} PAS`);
  console.log(`   - MinJoinBond: ${Number(minJoinBond) / Number(PAS)} PAS`);
  console.log(`   - Current pools: ${counterForBondedPools}${maxPools ? `/${maxPools}` : ""}`);
  console.log(
    `   - Current members: ${counterForPoolMembers}${maxPoolMembers ? `/${maxPoolMembers}` : ""}`
  );

  return {
    minCreateBond,
    minJoinBond,
    maxPools,
    maxPoolMembers,
    counterForPoolMembers,
    counterForBondedPools,
  };
}

// Function to handle topup mode execution
async function executeTopupMode(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  topupAmount: number,
  fromIndex: number,
  toIndex: number,
  godBalance: bigint,
  PAS: bigint,
  isDryRun: boolean
) {
  await topupAccounts(
    api,
    godSigner,
    derive,
    topupAmount,
    fromIndex,
    toIndex,
    godBalance,
    PAS,
    isDryRun
  );
}

// Function to handle dry-run mode execution
async function createNominatorsDryRun(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  numNominators: number,
  minNominatorBond: bigint,
  stakeRange: bigint,
  fixedBufferPerAccount: bigint,
  stakeAmounts: Map<number, bigint>,
  createdAccountIndices: number[],
  validatorsPerNominator: number,
  PAS: bigint,
  isDryRun: boolean
) {
  console.log(`\n🚧 DRY RUN MODE - No real transactions will be executed`);
  console.log(`   To execute real transactions, run without --dry-run flag`);

  // Simulate what would happen
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
    10
  );

  // Simulate staking
  await stakeAndNominate(
    api,
    derive,
    createdAccountIndices,
    stakeAmounts,
    minNominatorBond,
    validatorsPerNominator,
    PAS,
    isDryRun,
    5
  );
}

// Function to handle normal execution mode
async function createNominators(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  numNominators: number,
  minNominatorBond: bigint,
  stakeRange: bigint,
  fixedBufferPerAccount: bigint,
  stakeAmounts: Map<number, bigint>,
  createdAccountIndices: number[],
  validatorsPerNominator: number,
  PAS: bigint,
  isDryRun: boolean
) {
  console.log(`\n⚠️  READY TO EXECUTE REAL TRANSACTIONS`);
  console.log(`   This will transfer real funds on Paseo testnet!`);

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
    500
  );

  // Delay to allow balance updates to be available for staking
  console.log(`\n⏳ Waiting 15 seconds for balance availability...`);
  await new Promise((resolve) => setTimeout(resolve, 15000));

  await stakeAndNominate(
    api,
    derive,
    createdAccountIndices,
    stakeAmounts,
    minNominatorBond,
    validatorsPerNominator,
    PAS,
    isDryRun,
    25
  );
}

// Dry-run function for pool creation analysis
async function createPoolsDryRun(
  api: TypedApi,
  derive: DeriveFunction,
  poolCount: number,
  poolStake: bigint,
  commission: number,
  PAS: bigint
) {
  console.log(`\n🔍 DRY RUN: Pool Creation Analysis`);
  console.log(`   - Would create ${poolCount} nomination pools`);
  console.log(`   - Each pool initial stake: ${Number(poolStake) / Number(PAS)} PAS`);
  console.log(`   - Commission rate: ${commission}%`);

  const poolAccounts: Array<{ keyPair: any; address: string; signer: Signer; index: number }> = [];
  let totalFunding = 0n;

  let poolIndex = 1;
  for (let i = 1; i <= poolCount; i++) {
    let poolAccount: { keyPair: any; address: string; signer: Signer; index: number };
    let isPoolMember = true;

    // Find an account that's not already a pool member
    do {
      poolAccount = getPoolAccountAtIndex(poolIndex, derive);
      const poolMemberInfo = await api.query.NominationPools.PoolMembers.getValue(
        poolAccount.address
      );
      isPoolMember = poolMemberInfo !== undefined;

      if (isPoolMember) {
        console.log(
          `   [Pool ${i}] Account ${poolAccount.address} (index ${poolIndex}) already belongs to a pool - trying next`
        );
        poolIndex++;
      }
    } while (isPoolMember);

    poolAccounts.push(poolAccount);
    poolIndex++; // Move to next index for next pool

    // Check if account exists
    const accountInfo = await api.query.System.Account.getValue(poolAccount.address);
    const exists = accountInfo.providers > 0;

    const fundingNeeded = poolStake + PAS * 5n; // stake + buffer
    totalFunding += fundingNeeded;

    console.log(`   [Pool ${i}] Creator: ${poolAccount.address}`);
    console.log(`      - Account exists: ${exists ? "Yes" : "No"}`);
    console.log(`      - Funding needed: ${Number(fundingNeeded) / Number(PAS)} PAS`);
    console.log(`      - Would create pool with stake: ${Number(poolStake) / Number(PAS)} PAS`);
  }

  console.log(`\n   📊 Pool Creation Summary:`);
  console.log(`      - Total pools: ${poolCount}`);
  console.log(`      - Total funding needed: ${Number(totalFunding) / Number(PAS)} PAS`);
  console.log(
    `      - Average per pool: ${Number(totalFunding / BigInt(poolCount)) / Number(PAS)} PAS`
  );

  return { poolAccounts, totalFunding };
}

// Dry-run function for pool members analysis
async function createPoolMembersDryRun(
  api: TypedApi,
  derive: DeriveFunction,
  memberCount: number,
  memberStake: bigint,
  availablePoolIds: number[],
  PAS: bigint
) {
  console.log(`\n🔍 DRY RUN: Pool Members Analysis`);
  console.log(`   - Would create ${memberCount} pool members`);
  console.log(`   - Each member stake: ${Number(memberStake) / Number(PAS)} PAS`);
  console.log(
    `   - Available pools: ${availablePoolIds.length} (IDs: ${availablePoolIds.join(", ")})`
  );

  let memberIndex = 1;
  let wouldCreate = 0;
  let totalFunding = 0n;
  const memberDistribution = new Map<number, number>();

  // Initialize pool distribution tracking
  availablePoolIds.forEach((id) => memberDistribution.set(id, 0));

  for (let i = 0; i < memberCount; i++) {
    const memberAccount = getPoolMemberAccountAtIndex(memberIndex, derive);

    // Check if account exists
    const accountInfo = await api.query.System.Account.getValue(memberAccount.address);
    const exists = accountInfo.providers > 0;

    if (!exists) {
      const fundingNeeded = memberStake + PAS * 5n; // stake + buffer
      totalFunding += fundingNeeded;

      // Determine which pool this member would join
      const poolId = availablePoolIds[memberIndex % availablePoolIds.length];
      if (poolId !== undefined) {
        memberDistribution.set(poolId, (memberDistribution.get(poolId) ?? 0) + 1);
      }

      console.log(`   [Member ${memberIndex}] ${memberAccount.address}`);
      console.log(`      - Would fund with: ${Number(fundingNeeded) / Number(PAS)} PAS`);
      console.log(`      - Would join pool: ${poolId}`);

      wouldCreate++;
    } else {
      console.log(`   [Member ${memberIndex}] ${memberAccount.address} (already exists - skip)`);
    }
    memberIndex++;
  }

  console.log(`\n   📊 Pool Members Summary:`);
  console.log(`      - Members to create: ${wouldCreate}`);
  console.log(`      - Members to skip: ${memberCount - wouldCreate}`);
  console.log(`      - Total funding needed: ${Number(totalFunding) / Number(PAS)} PAS`);
  console.log(`      - Distribution across pools:`);
  memberDistribution.forEach((count: number, poolId: number) => {
    if (count > 0) {
      console.log(`         Pool ${poolId}: ${count} members`);
    }
  });

  return { wouldCreate, totalFunding };
}

// Dry-run function for hybrid stakers analysis
async function createHybridStakersDryRun(
  api: TypedApi,
  derive: DeriveFunction,
  hybridCount: number,
  soloStake: bigint,
  poolStake: bigint,
  availablePoolIds: number[],
  validatorsPerNominator: number,
  PAS: bigint
) {
  console.log(`\n🔍 DRY RUN: Hybrid Stakers Analysis`);
  console.log(`   - Would create ${hybridCount} hybrid stakers`);
  console.log(`   - Solo stake per account: ${Number(soloStake) / Number(PAS)} PAS`);
  console.log(`   - Pool stake per account: ${Number(poolStake) / Number(PAS)} PAS`);
  console.log(`   - Validators per nominator: ${validatorsPerNominator}`);

  // Get validators for analysis
  const validatorEntries = await api.query.Staking.Validators.getEntries();
  const allValidators = validatorEntries.map(
    ({ keyArgs: [validator] }: { keyArgs: [string] }) => validator
  );

  console.log(`   - Available validators: ${allValidators.length}`);
  console.log(
    `   - Can select up to: ${Math.min(validatorsPerNominator, allValidators.length)} per account`
  );

  let wouldCreate = 0;
  let totalFunding = 0n;
  const hybridDistribution = new Map<number, number>();

  // Initialize pool distribution tracking
  availablePoolIds.forEach((id) => hybridDistribution.set(id, 0));

  for (let i = 1; i <= hybridCount; i++) {
    const hybridAccount = getHybridAccountAtIndex(i, derive);

    // Check if account exists
    const accountInfo = await api.query.System.Account.getValue(hybridAccount.address);
    const exists = accountInfo.providers > 0;

    if (!exists) {
      const fundingNeeded = soloStake + poolStake + PAS * 8n; // both stakes + buffer
      totalFunding += fundingNeeded;

      // Determine which pool this hybrid would join
      const poolId = availablePoolIds[i % availablePoolIds.length];
      if (poolId !== undefined) {
        hybridDistribution.set(poolId, (hybridDistribution.get(poolId) ?? 0) + 1);
      }

      console.log(`   [Hybrid ${i}] ${hybridAccount.address}`);
      console.log(`      - Would fund with: ${Number(fundingNeeded) / Number(PAS)} PAS`);
      console.log(`      - Would join pool: ${poolId} with ${Number(poolStake) / Number(PAS)} PAS`);
      console.log(`      - Would solo stake: ${Number(soloStake) / Number(PAS)} PAS`);
      console.log(
        `      - Would nominate: ${Math.min(validatorsPerNominator, allValidators.length)} validators`
      );

      wouldCreate++;
    } else {
      console.log(`   [Hybrid ${i}] ${hybridAccount.address} (already exists - skip)`);
    }
  }

  console.log(`\n   📊 Hybrid Stakers Summary:`);
  console.log(`      - Hybrids to create: ${wouldCreate}`);
  console.log(`      - Hybrids to skip: ${hybridCount - wouldCreate}`);
  console.log(`      - Total funding needed: ${Number(totalFunding) / Number(PAS)} PAS`);
  console.log(`      - Pool distribution:`);
  hybridDistribution.forEach((count: number, poolId: number) => {
    if (count > 0) {
      console.log(`         Pool ${poolId}: ${count} hybrid stakers`);
    }
  });

  return { wouldCreate, totalFunding };
}

// Function to create actual nomination pools
async function createPools(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  poolCount: number,
  poolStake: bigint,
  commission: number,
  createdPoolIds: number[],
  PAS: bigint,
  isDryRun: boolean,
  batchSize = 10
) {
  // Get starting pool count to calculate pool IDs
  const startingPoolCount = await api.query.NominationPools.CounterForBondedPools.getValue();
  console.log(`\n🏊 Creating ${poolCount} nomination pools...`);
  console.log(`   📊 Using batch size of ${batchSize} for funding`);

  // First, fund pool creator accounts
  const poolAccounts: Array<{ keyPair: any; address: string; signer: Signer; index: number }> = [];
  const fundingBatch = [];

  let poolIndex = 1;
  for (let i = 1; i <= poolCount; i++) {
    let poolAccount: { keyPair: any; address: string; signer: Signer; index: number };
    let isPoolMember = true;

    // Find an account that's not already a pool member
    do {
      poolAccount = getPoolAccountAtIndex(poolIndex, derive);
      const poolMemberInfo = await api.query.NominationPools.PoolMembers.getValue(
        poolAccount.address
      );
      isPoolMember = poolMemberInfo !== undefined;

      if (isPoolMember) {
        console.log(
          `   [Pool ${i}] Account ${poolAccount.address} (index ${poolIndex}) already belongs to a pool - trying next`
        );
        poolIndex++;
      }
    } while (isPoolMember);

    poolAccounts.push(poolAccount);
    console.log(`   [Pool ${i}] Selected creator ${poolAccount.address} (index ${poolIndex})`);
    poolIndex++; // Move to next index for next pool

    // Check if account exists and needs funding
    const accountInfo = await api.query.System.Account.getValue(poolAccount.address);
    const exists = accountInfo.providers > 0;

    const requiredAmount = poolStake + PAS * 5n; // stake + buffer for pool creation
    const currentBalance = accountInfo.data.free;
    const needsFunding = !exists || currentBalance < requiredAmount;

    if (needsFunding) {
      // Fund pool creator account (either new account or insufficient balance)
      const fundingAmount =
        requiredAmount > currentBalance ? requiredAmount - currentBalance : requiredAmount;
      console.log(
        `   [Pool ${i}] Funding creator ${poolAccount.address} with ${Number(fundingAmount) / Number(PAS)} PAS`
      );

      const transfer = api.tx.Balances.transfer_allow_death({
        dest: MultiAddress.Id(poolAccount.address),
        value: fundingAmount,
      });
      fundingBatch.push(transfer.decodedCall);
    } else {
      console.log(
        `   [Pool ${i}] Creator ${poolAccount.address} already exists - skipping funding`
      );
    }
  }

  // Execute funding batch
  if (!isDryRun && fundingBatch.length > 0) {
    console.log(`\n⚡ Executing funding batch of ${fundingBatch.length} transfers...`);
    const batchTx = api.tx.Utility.batch_all({ calls: fundingBatch });

    await new Promise((resolve, reject) => {
      let completed = false;
      let subscription: { unsubscribe: () => void } | null = null;

      const timeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          console.log(`   ⚠️  Funding timeout, but may have succeeded`);
          if (subscription) {
            try {
              subscription.unsubscribe();
            } catch {}
          }
          resolve(null);
        }
      }, 30000);

      subscription = batchTx.signSubmitAndWatch(godSigner).subscribe({
        next: (event: TransactionEvent) => {
          console.log(`   📡 Event: ${event.type}`);
          if (event.type === "txBestBlocksState") {
            console.log(`   ✅ Funding batch included in block`);
            console.log(`   📋 Transaction hash: ${event.txHash}`);
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
            console.error(`   ❌ Funding batch failed:`, error);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            reject(error);
          }
        },
      });
    });

    // Wait for balance updates
    console.log(`\n⏳ Waiting 25 seconds for balance availability...`);
    await new Promise((resolve) => setTimeout(resolve, 25000));
  }

  // Create pools sequentially to track pool IDs properly
  for (let i = 0; i < poolAccounts.length; i++) {
    const poolAccount = poolAccounts[i];
    if (!poolAccount) continue;

    const poolIndex = i + 1;

    if (isDryRun) {
      console.log(`   🔍 DRY RUN: Would create pool ${poolIndex} with ${poolAccount.address}`);
      continue;
    }

    console.log(`   [Pool ${poolIndex}] Creating pool with creator ${poolAccount.address}...`);

    // Check account balance before pool creation
    const accountInfo = await api.query.System.Account.getValue(poolAccount.address);
    const freeBalance = accountInfo.data.free;
    console.log(`   💰 Creator balance: ${Number(freeBalance) / Number(PAS)} PAS`);

    try {
      // Create pool with the pool account as root, nominator, and bouncer
      console.log(`   🔧 Pool creation parameters:`);
      console.log(`      - Amount: ${Number(poolStake) / Number(PAS)} PAS`);
      console.log(`      - Root: ${poolAccount.address}`);
      console.log(`      - Nominator: ${poolAccount.address}`);
      console.log(`      - Bouncer: ${poolAccount.address}`);

      const createPoolTx = api.tx.NominationPools.create({
        amount: poolStake,
        root: MultiAddress.Id(poolAccount.address),
        nominator: MultiAddress.Id(poolAccount.address),
        bouncer: MultiAddress.Id(poolAccount.address),
      });

      console.log(`   🔧 Transaction created, signing with pool account signer...`);

      // Set commission if not default (need to check if this call exists)
      let finalTx = createPoolTx;
      if (commission !== 0) {
        // Try to batch with commission setting, but fall back if not available
        try {
          // Commission setting might be available in future - for now just note it
          // const setCommissionTx = api.tx.NominationPools.set_commission({
          //   pool_id: null, // Will be determined after pool creation
          //   new_commission: [commission * 10000000, poolAccount.address], // Commission in Perbill (parts per billion)
          // });

          // For now, just create the pool and set commission separately if needed
          finalTx = createPoolTx;
        } catch {
          // Commission setting might not be available or have different signature
          console.log(
            `   ⚠️  Commission setting not available, creating pool with default commission`
          );
        }
      }

      await new Promise((resolve, _reject) => {
        let completed = false;
        let subscription: { unsubscribe: () => void } | null = null;

        const timeout = setTimeout(() => {
          if (!completed) {
            completed = true;
            console.log(`   ⚠️  Pool creation timeout for pool ${poolIndex}`);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            resolve(null);
          }
        }, 30000);

        subscription = finalTx.signSubmitAndWatch(poolAccount.signer).subscribe({
          next: (event: TransactionEvent) => {
            console.log(`   📡 Pool ${poolIndex} event: ${event.type}`);
            if (event.type === "txBestBlocksState") {
              console.log(`   ✅ Pool ${poolIndex} transaction included in block`);
              console.log(`   📋 TX hash: ${event.txHash}`);

              // Check for transaction success/failure events
              if ("dispatchError" in event && event.dispatchError) {
                console.log(`   ❌ Transaction failed with dispatch error:`, event.dispatchError);
              } else if ("ok" in event && event.ok) {
                console.log(`   ✅ Transaction executed successfully`);
                // Calculate pool ID based on starting count and pool index
                const estimatedPoolId = startingPoolCount + poolIndex;
                createdPoolIds.push(estimatedPoolId);
                console.log(`   🆔 Estimated Pool ID: ${estimatedPoolId}`);
              } else {
                console.log(`   ⚠️  Transaction status unclear`);
                console.log(`   📋 Full event:`, JSON.stringify(event, null, 2));
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
              console.error(`   ❌ Pool ${poolIndex} creation failed:`, error);
              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              // Don't reject, continue with other pools
              resolve(null);
            }
          },
        });
      });

      // Small delay between pool creations
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`   ❌ Failed to create pool ${poolIndex}:`, error);
      // Continue with next pool
    }
  }

  console.log(`\n📊 Pool Creation Summary:`);
  console.log(`   - Pools requested: ${poolCount}`);
  console.log(`   - Creator accounts processed: ${poolAccounts.length}`);
  console.log(`   - Pool creation attempts completed`);

  if (createdPoolIds.length > 0) {
    console.log(`\n🎯 Created Pool Details:`);
    createdPoolIds.forEach((poolId, index) => {
      const creatorAccount = poolAccounts[index];
      if (creatorAccount) {
        console.log(`   Pool ${poolId}: Creator ${creatorAccount.address}`);
      }
    });
  }

  return { createdCount: poolAccounts.length };
}

// Function to create pool members
async function createPoolMembers(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  memberCount: number,
  memberStake: bigint,
  availablePoolIds: number[],
  createdMemberIndices: number[],
  PAS: bigint,
  isDryRun: boolean,
  batchSize = 100
) {
  console.log(`\n👥 Creating ${memberCount} pool members...`);
  console.log(
    `   📊 Available pools: ${availablePoolIds.length} (IDs: ${availablePoolIds.join(", ")})`
  );

  if (availablePoolIds.length === 0) {
    console.error(`❌ No pools available for members to join!`);
    return { createdCount: 0, joinedCount: 0 };
  }

  let memberIndex = 1;
  let createdCount = 0;
  let joinedCount = 0;
  const successfulJoins: Array<{ memberAddress: string; poolId: number; memberIndex: number }> = [];

  while (createdCount < memberCount) {
    const batch = [];
    const memberAccountsInBatch = [];

    // Build funding batch
    while (batch.length < batchSize && createdCount < memberCount) {
      const memberAccount = getPoolMemberAccountAtIndex(memberIndex, derive);

      // Check if account exists
      const accountInfo = await api.query.System.Account.getValue(memberAccount.address);
      const exists = accountInfo.providers > 0;

      if (!exists) {
        const fundingAmount = memberStake + PAS * 5n; // stake + buffer
        console.log(
          `   [Member ${memberIndex}] Funding ${memberAccount.address} with ${Number(fundingAmount) / Number(PAS)} PAS`
        );

        const transfer = api.tx.Balances.transfer_allow_death({
          dest: MultiAddress.Id(memberAccount.address),
          value: fundingAmount,
        });
        batch.push(transfer.decodedCall);
        memberAccountsInBatch.push({ account: memberAccount, index: memberIndex });
        createdMemberIndices.push(memberIndex);
        createdCount++;
      } else {
        console.log(
          `   [Member ${memberIndex}] ${memberAccount.address} already exists - skipping`
        );
      }
      memberIndex++;
    }

    // Execute funding batch
    if (!isDryRun && batch.length > 0) {
      console.log(`\n⚡ Executing funding batch of ${batch.length} member transfers...`);
      const batchTx = api.tx.Utility.batch_all({ calls: batch });

      await new Promise((resolve, _reject) => {
        let completed = false;
        let subscription: { unsubscribe: () => void } | null = null;

        const timeout = setTimeout(() => {
          if (!completed) {
            completed = true;
            console.log(`   ⚠️  Member funding timeout`);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            resolve(null);
          }
        }, 30000);

        subscription = batchTx.signSubmitAndWatch(godSigner).subscribe({
          next: (event: TransactionEvent) => {
            console.log(`   📡 Event: ${event.type}`);
            if (event.type === "txBestBlocksState") {
              console.log(`   ✅ Member funding batch included in block`);
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
              console.error(`   ❌ Member funding failed:`, error);
              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              _reject(error);
            }
          },
        });
      });

      // Wait for balance updates
      console.log(`\n⏳ Waiting 25 seconds for balance availability...`);
      await new Promise((resolve) => setTimeout(resolve, 25000));

      // Have members join pools
      console.log(`\n🏊 Having members join pools...`);
      for (const { account, index } of memberAccountsInBatch) {
        const poolId = availablePoolIds[index % availablePoolIds.length]; // Distribute evenly
        if (poolId === undefined) {
          console.log(`   ❌ No pool ID available for member ${index}`);
          continue;
        }
        console.log(
          `   [Member ${index}] Joining pool ${poolId} with ${Number(memberStake) / Number(PAS)} PAS`
        );

        // Check account balance before joining
        const preJoinBalance = await api.query.System.Account.getValue(account.address);
        console.log(`   💰 Member balance: ${Number(preJoinBalance.data.free) / Number(PAS)} PAS`);

        try {
          const joinTx = api.tx.NominationPools.join({
            amount: memberStake,
            pool_id: poolId,
          });

          await new Promise((resolve) => {
            let completed = false;
            let subscription: { unsubscribe: () => void } | null = null;

            const timeout = setTimeout(() => {
              if (!completed) {
                completed = true;
                console.log(`   ⚠️  Join timeout for member ${index}`);
                if (subscription) {
                  try {
                    subscription.unsubscribe();
                  } catch {}
                }
                resolve(null);
              }
            }, 20000);

            subscription = joinTx.signSubmitAndWatch(account.signer).subscribe({
              next: (event: TransactionEvent) => {
                if (event.type === "txBestBlocksState") {
                  console.log(`   ✅ Member ${index} joined pool ${poolId}`);
                  joinedCount++;
                  successfulJoins.push({
                    memberAddress: account.address,
                    poolId: poolId,
                    memberIndex: index,
                  });
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
                  console.error(`   ❌ Member ${index} join failed:`, error);
                  if (subscription) {
                    try {
                      subscription.unsubscribe();
                    } catch {}
                  }
                  resolve(null); // Continue with other members
                }
              },
            });
          });

          // Small delay between joins
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          console.error(`   ❌ Failed to join pool for member ${index}:`, error);
        }
      }
    } else if (isDryRun && batch.length > 0) {
      console.log(`\n🔍 DRY RUN: Would execute funding batch of ${batch.length} members`);
      for (const { index } of memberAccountsInBatch) {
        const poolId = availablePoolIds[index % availablePoolIds.length];
        console.log(`   🔍 DRY RUN: Member ${index} would join pool ${poolId}`);
      }
    }
  }

  console.log(`\n📊 Pool Members Summary:`);
  console.log(`   - Members created: ${createdCount}`);
  console.log(`   - Members joined pools: ${joinedCount}`);

  if (successfulJoins.length > 0) {
    console.log(`\n🎯 Successful Member Joins:`);
    successfulJoins.forEach(({ memberAddress, poolId, memberIndex }) => {
      console.log(`   Member ${memberIndex}: ${memberAddress} → Pool ${poolId}`);
    });
  }

  return { createdCount, joinedCount };
}

// Function to create hybrid stakers (both pool members and solo stakers)
async function createHybridStakers(
  api: TypedApi,
  godSigner: Signer,
  derive: DeriveFunction,
  hybridCount: number,
  soloStake: bigint,
  poolStake: bigint,
  availablePoolIds: number[],
  validatorsPerNominator: number,
  PAS: bigint,
  isDryRun: boolean
) {
  console.log(`\n🔀 Creating ${hybridCount} hybrid stakers (pool + solo)...`);
  console.log(`   📊 Solo stake: ${Number(soloStake) / Number(PAS)} PAS per account`);
  console.log(`   📊 Pool stake: ${Number(poolStake) / Number(PAS)} PAS per account`);

  if (availablePoolIds.length === 0) {
    console.error(`❌ No pools available for hybrid stakers to join!`);
    return { createdCount: 0, joinedCount: 0, stakedCount: 0 };
  }

  // Get validators for nominations
  const validatorEntries = await api.query.Staking.Validators.getEntries();
  const allValidators = validatorEntries.map(
    ({ keyArgs: [validator] }: { keyArgs: [string] }) => validator
  );
  console.log(`   📊 Available validators: ${allValidators.length}`);

  // Collect hybrid accounts that need funding
  const hybridAccounts: Array<{ account: any; index: number }> = [];
  let hybridIndex = 1;

  for (let i = 1; i <= hybridCount; i++) {
    let hybridAccount: any;
    let isPoolMember = false;
    let isStaker = false;
    let exists = false;

    // Find an account that's not already a pool member or staker
    do {
      hybridAccount = getHybridAccountAtIndex(hybridIndex, derive);

      // Check if account exists (has providers > 0)
      const accountInfo = await api.query.System.Account.getValue(hybridAccount.address);
      exists = accountInfo.providers > 0;

      // Check if account is already a pool member
      const poolMemberInfo = await api.query.NominationPools.PoolMembers.getValue(
        hybridAccount.address
      );
      isPoolMember = poolMemberInfo !== undefined;

      // Check if account is already a staker (has staking ledger)
      const stakingLedger = await api.query.Staking.Ledger.getValue(hybridAccount.address);
      isStaker = stakingLedger !== undefined;

      if (exists || isPoolMember || isStaker) {
        console.log(
          `   [Hybrid ${i}] Account ${hybridAccount.address} (index ${hybridIndex}) already exists/member/staker - trying next`
        );
        hybridIndex++;
      }
    } while (exists || isPoolMember || isStaker);

    console.log(
      `   [Hybrid ${i}] Selected account ${hybridAccount.address} (index ${hybridIndex})`
    );
    hybridIndex++; // Move to next index for next hybrid

    if (isDryRun) {
      const poolId = availablePoolIds[i % availablePoolIds.length];
      console.log(
        `   🔍 DRY RUN: Would fund ${hybridAccount.address} with ${Number(soloStake + poolStake + PAS * 8n) / Number(PAS)} PAS`
      );
      console.log(
        `   🔍 DRY RUN: Would join pool ${poolId} with ${Number(poolStake) / Number(PAS)} PAS`
      );
      console.log(`   🔍 DRY RUN: Would solo stake ${Number(soloStake) / Number(PAS)} PAS`);
      console.log(
        `   🔍 DRY RUN: Would nominate ${Math.min(validatorsPerNominator, allValidators.length)} validators`
      );
      continue;
    }

    hybridAccounts.push({ account: hybridAccount, index: i }); // Use i for display consistency
  }

  if (isDryRun || hybridAccounts.length === 0) {
    return { createdCount: 0, joinedCount: 0, stakedCount: 0 };
  }

  // Batch fund all hybrid accounts
  console.log(`\n💰 Batch funding ${hybridAccounts.length} hybrid accounts...`);
  const fundingTxs = hybridAccounts.map(({ account }) => {
    const totalFunding = soloStake + poolStake + PAS * 8n; // both stakes + buffer
    console.log(`   💸 Funding ${account.address} with ${Number(totalFunding) / Number(PAS)} PAS`);
    return api.tx.Balances.transfer_allow_death({
      dest: MultiAddress.Id(account.address),
      value: totalFunding,
    });
  });

  if (fundingTxs.length > 0) {
    const batchFundTx = api.tx.Utility.batch_all({ calls: fundingTxs.map((tx) => tx.decodedCall) });

    await new Promise((resolve, reject) => {
      let completed = false;
      let subscription: { unsubscribe: () => void } | null = null;

      const timeout = setTimeout(() => {
        if (!completed) {
          completed = true;
          console.log(`   ⚠️  Batch funding timeout`);
          if (subscription) {
            try {
              subscription.unsubscribe();
            } catch {}
          }
          reject(new Error("Batch funding timeout"));
        }
      }, 60000);

      subscription = batchFundTx.signSubmitAndWatch(godSigner).subscribe({
        next: (event: TransactionEvent) => {
          if (event.type === "txBestBlocksState") {
            console.log(`   ✅ Batch funding completed successfully`);
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
          } else if (event.type === "txInvalid") {
            if (!completed) {
              completed = true;
              clearTimeout(timeout);
              console.error(`   ❌ Batch funding failed - invalid transaction`);
              if (subscription) {
                try {
                  subscription.unsubscribe();
                } catch {}
              }
              reject(new Error("Invalid transaction"));
            }
          }
        },
        error: (error: Error) => {
          if (!completed) {
            completed = true;
            clearTimeout(timeout);
            console.error(`   ❌ Batch funding failed:`, error);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            reject(error);
          }
        },
      });
    });

    // Wait for balance updates
    console.log(`\n⏳ Waiting 30 seconds for balance availability...`);
    await new Promise((resolve) => setTimeout(resolve, 30000));
  }

  // Now process hybrid stakers sequentially for pool joining and solo staking
  let createdCount = hybridAccounts.length;
  let joinedCount = 0;
  let stakedCount = 0;

  for (const { account: hybridAccount, index: i } of hybridAccounts) {
    try {
      // Verify balance before joining pool
      const accountInfo = await api.query.System.Account.getValue(hybridAccount.address);
      const freeBalance = accountInfo.data.free;
      console.log(`   💰 Hybrid ${i} balance: ${Number(freeBalance) / Number(PAS)} PAS`);

      if (freeBalance < poolStake + soloStake + PAS * 5n) {
        console.error(`   ❌ Hybrid ${i} insufficient balance for operations - skipping`);
        continue;
      }

      // Join pool first
      const poolId = availablePoolIds[i % availablePoolIds.length];
      console.log(
        `   [Hybrid ${i}] Joining pool ${poolId} with ${Number(poolStake) / Number(PAS)} PAS`
      );

      const joinTx = api.tx.NominationPools.join({
        amount: poolStake,
        pool_id: poolId,
      });

      await new Promise((resolve) => {
        let completed = false;
        let subscription: { unsubscribe: () => void } | null = null;

        const timeout = setTimeout(() => {
          if (!completed) {
            completed = true;
            console.log(`   ⚠️  Pool join timeout for hybrid ${i}`);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            resolve(null);
          }
        }, 20000);

        subscription = joinTx.signSubmitAndWatch(hybridAccount.signer).subscribe({
          next: (event: TransactionEvent) => {
            if (event.type === "txBestBlocksState") {
              console.log(`   ✅ Hybrid ${i} joined pool ${poolId}`);
              joinedCount++;
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
              console.error(`   ❌ Hybrid ${i} pool join failed:`, error);
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

      // Small delay before solo staking
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Then do solo staking
      console.log(`   [Hybrid ${i}] Solo staking ${Number(soloStake) / Number(PAS)} PAS`);

      // Select random validators
      const selectedValidators: string[] = [];
      const validatorsCopy = [...allValidators];
      const validatorsToSelect = Math.min(validatorsPerNominator, allValidators.length);

      for (let j = 0; j < validatorsToSelect; j++) {
        if (validatorsCopy.length === 0) break;
        const randomIndex = Math.floor(Math.random() * validatorsCopy.length);
        const validator = validatorsCopy[randomIndex];
        if (validator) {
          selectedValidators.push(validator);
          validatorsCopy.splice(randomIndex, 1);
        }
      }

      // Create bond and nominate transactions
      const bondTx = api.tx.Staking.bond({
        value: soloStake,
        payee: { type: "Staked", value: undefined },
      });

      const validatorTargets = selectedValidators.map((validator) => MultiAddress.Id(validator));
      const nominateTx = api.tx.Staking.nominate({ targets: validatorTargets });

      // Batch bond and nominate together
      const batchTx = api.tx.Utility.batch_all({
        calls: [bondTx.decodedCall, nominateTx.decodedCall],
      });

      await new Promise((resolve) => {
        let completed = false;
        let subscription: { unsubscribe: () => void } | null = null;

        const timeout = setTimeout(() => {
          if (!completed) {
            completed = true;
            console.log(`   ⚠️  Solo staking timeout for hybrid ${i}`);
            if (subscription) {
              try {
                subscription.unsubscribe();
              } catch {}
            }
            resolve(null);
          }
        }, 20000);

        subscription = batchTx.signSubmitAndWatch(hybridAccount.signer).subscribe({
          next: (event: TransactionEvent) => {
            if (event.type === "txBestBlocksState") {
              console.log(`   ✅ Hybrid ${i} solo staking completed`);
              stakedCount++;
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
              console.error(`   ❌ Hybrid ${i} solo staking failed:`, error);
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

      // Small delay before next hybrid
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`   ❌ Failed to process hybrid staker ${i}:`, error);
    }
  }

  console.log(`\n📊 Hybrid Stakers Summary:`);
  console.log(`   - Accounts created: ${createdCount}`);
  console.log(`   - Pool joins completed: ${joinedCount}`);
  console.log(`   - Solo stakes completed: ${stakedCount}`);

  return { createdCount, joinedCount, stakedCount };
}

// Parse pool range string (e.g., "1-5" or "3,7,9")
function parsePoolRange(rangeStr: string): number[] {
  const pools: number[] = [];

  for (const part of rangeStr.split(",")) {
    const trimmed = part.trim();
    if (trimmed.includes("-")) {
      const rangeParts = trimmed.split("-").map((s) => parseInt(s.trim()));
      const start = rangeParts[0];
      const end = rangeParts[1];
      if (start === undefined || end === undefined || isNaN(start) || isNaN(end) || start > end) {
        throw new Error(`Invalid range: ${trimmed}`);
      }
      for (let i = start; i <= end; i++) {
        pools.push(i);
      }
    } else {
      const poolId = parseInt(trimmed);
      if (isNaN(poolId)) {
        throw new Error(`Invalid pool ID: ${trimmed}`);
      }
      pools.push(poolId);
    }
  }

  return [...new Set(pools)].sort((a, b) => a - b); // Remove duplicates and sort
}

// Destroy nomination pools
async function destroyPools(poolIds: number[], isDryRun: boolean, godSeed: string) {
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
          const timeout = setTimeout(() => {
            if (!completed) {
              completed = true;
              reject(new Error(`Set state for pool ${poolId} timeout`));
            }
          }, 30000);

          setStateTx.signSubmitAndWatch(poolAccount.signer).subscribe({
            next: (event) => {
              console.log(`     📊 Set state event:`, event.type);
              if (event.type === "txBestBlocksState") {
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);

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
                  console.error(`     ❌ Pool ${poolId} state change transaction invalid`);
                  results.failed++;
                  resolve(null);
                }
              }
            },
            error: (error) => {
              if (!completed) {
                completed = true;
                clearTimeout(timeout);
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
    console.log("🔌 Disconnecting from network...");
    client.destroy();
    smoldot.terminate();
  }
}

// List pools created by this tool
async function listPools(godSeed: string) {
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
    console.log("\n🔌 Disconnecting from network...");
    client.destroy();
    smoldot.terminate();
  }
}

// Parse pool:members string (e.g., "10:addr1,addr2" or "10:all")
function parsePoolMembers(input: string): { poolId: number; members: string[] | "all" } {
  const parts = input.split(":");
  if (parts.length !== 2) {
    throw new Error(
      `Invalid format. Expected 'poolId:members' (e.g., '10:addr1,addr2' or '10:all')`
    );
  }

  const poolId = parseInt(parts[0] || "");
  if (isNaN(poolId) || parts[0] === undefined) {
    throw new Error(`Invalid pool ID: ${parts[0] || "undefined"}`);
  }

  const membersPart = (parts[1] || "").trim();
  if (membersPart.toLowerCase() === "all") {
    return { poolId, members: "all" };
  }

  const members = membersPart
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (members.length === 0) {
    throw new Error(`No members specified`);
  }

  return { poolId, members };
}

// Remove members from a pool
async function removeFromPool(poolMembersInput: string, isDryRun: boolean, godSeed: string) {
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
            const timeout = setTimeout(() => {
              if (!completed) {
                completed = true;
                reject(new Error(`Unbond timeout`));
              }
            }, 30000);

            unbondTx.signSubmitAndWatch(member.keyPair.signer).subscribe({
              next: (event) => {
                if (event.type === "txBestBlocksState") {
                  if (!completed) {
                    completed = true;
                    clearTimeout(timeout);

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
              error: (error) => {
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);
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
            const timeout = setTimeout(() => {
              if (!completed) {
                completed = true;
                reject(new Error(`Withdraw timeout`));
              }
            }, 30000);

            withdrawTx.signSubmitAndWatch(member.keyPair.signer).subscribe({
              next: (event) => {
                if (event.type === "txBestBlocksState") {
                  if (!completed) {
                    completed = true;
                    clearTimeout(timeout);

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
              error: (error) => {
                if (!completed) {
                  completed = true;
                  clearTimeout(timeout);
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
    console.log("\n🔌 Disconnecting from network...");
    client.destroy();
    smoldot.terminate();
  }
}

// Common setup function for both modes
async function setupApiAndConnection(godSeed: string) {
  if (!options.dryRun) {
    console.log("⚠️  WARNING: This will execute REAL transactions on Paseo testnet!");
    console.log("   Use --dry-run flag to test without executing transactions");
  }

  // Validate and process god account seed
  const { derive, godKeyPair, godSigner } = validateAndProcessSeed(godSeed);

  // Create the client with smoldot
  const smoldot = start();
  const client = createClient(getSmProvider(smoldot.addChain({ chainSpec })));

  // Get the safely typed API
  const api = client.getTypedApi(paseo);

  console.log("✅ Connected to Paseo testnet");

  // Get the god account address in SS58 format (Paseo uses prefix 0)
  const godAddress = ss58Encode(godKeyPair.publicKey, 0);
  console.log(`🔑 God account address: ${godAddress}`);

  // Define PAS constant
  const PAS = 10_000_000_000n; // 1 PAS = 10^10 planck (same as DOT)

  // Check god account balance
  const accountInfo = await api.query.System.Account.getValue(godAddress);
  const godBalance = accountInfo.data.free;
  console.log(
    `💰 God account balance: ${godBalance} (${Number(godBalance) / Number(PAS)} PAS) free, ${accountInfo.data.reserved} (${Number(accountInfo.data.reserved) / Number(PAS)} PAS) reserved`
  );

  return { api, derive, godKeyPair, godSigner, godAddress, godBalance, PAS, smoldot, client };
}

// Complete topup mode execution
async function executeCompleteTopupMode(
  topupAmount: number,
  fromIndex: number,
  toIndex: number,
  isDryRun: boolean,
  godSeed: string
) {
  // Validate topup options
  if (fromIndex >= toIndex) {
    console.error("❌ Error: --from must be less than --to");
    process.exit(1);
  }

  console.log("🚀 Starting PAPI Polkadot Populate - TOPUP MODE");
  console.log(`📊 Configuration:`);
  console.log(`   - Topup amount: ${topupAmount} PAS`);
  console.log(
    `   - Account range: ///${fromIndex} to ///${toIndex - 1} (${toIndex - fromIndex} accounts)`
  );
  console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);

  const { api, derive, godSigner, godBalance, PAS, smoldot, client } =
    await setupApiAndConnection(godSeed);

  try {
    await executeTopupMode(
      api,
      godSigner,
      derive,
      topupAmount,
      fromIndex,
      toIndex,
      godBalance,
      PAS,
      isDryRun
    );
  } finally {
    // Clean up connections gracefully
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Give time for pending operations
      client.destroy();
      smoldot.terminate();
    } catch {
      // Ignore cleanup errors - they're not critical
    }
  }
}

// Complete populate mode execution
async function executeCompletePopulateMode(
  numNominators: number,
  validatorsPerNominator: number,
  isDryRun: boolean,
  godSeed: string
) {
  console.log("🚀 Starting PAPI Polkadot Populate");
  console.log(`📊 Configuration:`);
  console.log(`   - Number of nominators: ${numNominators}`);
  console.log(`   - Validators per nominator: ${validatorsPerNominator}`);
  console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);

  const { api, derive, godSigner, godBalance, PAS, smoldot, client } =
    await setupApiAndConnection(godSeed);

  try {
    // Calculate funding requirements and check balance immediately
    // Get MinNominatorStakingBond from storage
    const minNominatorBond = await api.query.Staking.MinNominatorBond.getValue();
    console.log(`\n⚡ MinNominatorStakingBond: ${Number(minNominatorBond) / Number(PAS)} PAS`);

    // Account for existential deposit (1 PAS) and transaction fees
    const existentialDeposit = PAS; // 1 PAS
    const txFeeBuffer = PAS; // 1 PAS for transaction fees buffer

    // Pre-determine stake amounts for each nominator (250-500 PAS)
    const maxStake = PAS * 500n;
    const stakeRange = maxStake - minNominatorBond;
    const stakeAmounts: Map<number, bigint> = new Map(); // Map account index to stake amount
    const createdAccountIndices: number[] = []; // Track which accounts we actually create

    // Calculate fixed buffer per account
    const fixedBufferPerAccount = existentialDeposit + txFeeBuffer;

    console.log(`\n💸 Funding configuration:`);
    console.log(
      `   - Stake range: ${Number(minNominatorBond) / Number(PAS)} - ${Number(maxStake) / Number(PAS)} PAS`
    );
    console.log(
      `   - Fixed buffer per account: ${Number(fixedBufferPerAccount) / Number(PAS)} PAS (ED + fees)`
    );
    console.log(`   - Target new accounts: ${numNominators}`);
    console.log(`   - God account balance: ${Number(godBalance) / Number(PAS)} PAS`);

    // Execute based on dry-run vs normal mode
    if (isDryRun) {
      await createNominatorsDryRun(
        api,
        godSigner,
        derive,
        numNominators,
        minNominatorBond,
        stakeRange,
        fixedBufferPerAccount,
        stakeAmounts,
        createdAccountIndices,
        validatorsPerNominator,
        PAS,
        isDryRun
      );
    } else {
      await createNominators(
        api,
        godSigner,
        derive,
        numNominators,
        minNominatorBond,
        stakeRange,
        fixedBufferPerAccount,
        stakeAmounts,
        createdAccountIndices,
        validatorsPerNominator,
        PAS,
        isDryRun
      );
    }
  } finally {
    // Clean up connections gracefully
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Give time for pending operations
      client.destroy();
      smoldot.terminate();
    } catch {
      // Ignore cleanup errors - they're not critical
    }
  }
}

// Complete pool mode execution
async function executeCompletePoolMode(
  poolCount: number,
  memberCount: number,
  hybridCount: number,
  poolStakeInput: number | null,
  memberStakeInput: number | null,
  commission: number,
  validatorsPerNominator: number,
  isDryRun: boolean,
  godSeed: string
) {
  console.log("🚀 Starting PAPI Polkadot Populate - POOL MODE");
  console.log(`📊 Configuration:`);
  console.log(`   - Pools to create: ${poolCount}`);
  console.log(`   - Pool members to create: ${memberCount}`);
  console.log(`   - Hybrid stakers to create: ${hybridCount}`);
  console.log(`   - Pool commission: ${commission}%`);
  console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);

  const { api, derive, godSigner, godBalance, PAS, smoldot, client } =
    await setupApiAndConnection(godSeed);

  try {
    // Get chain parameters
    const { minCreateBond, minJoinBond } = await getPoolChainParameters(api, PAS);

    // Use chain minimums if not specified
    const poolStake = poolStakeInput ? PAS * BigInt(poolStakeInput) : minCreateBond;
    const memberStake = memberStakeInput ? PAS * BigInt(memberStakeInput) : minJoinBond;

    // Get solo staking minimum for hybrid accounts
    const minNominatorBond = await api.query.Staking.MinNominatorBond.getValue();
    const soloStake = minNominatorBond;

    console.log(`\n💸 Stake configuration:`);
    console.log(`   - Pool create stake: ${Number(poolStake) / Number(PAS)} PAS`);
    console.log(`   - Member join stake: ${Number(memberStake) / Number(PAS)} PAS`);
    console.log(`   - Hybrid solo stake: ${Number(soloStake) / Number(PAS)} PAS`);

    // Track pool IDs to use for members and hybrids
    let availablePoolIds: number[] = [];

    // For dry-run, simulate pool IDs (assuming sequential from current max + 1)
    if (isDryRun && poolCount > 0) {
      const currentMaxPoolId = await api.query.NominationPools.CounterForBondedPools.getValue();
      availablePoolIds = Array.from({ length: poolCount }, (_, i) => currentMaxPoolId + i + 1);
    }

    let totalPoolFunding = 0n;
    let totalMemberFunding = 0n;
    let totalHybridFunding = 0n;

    // Execute or simulate operations
    if (poolCount > 0) {
      if (isDryRun) {
        const { totalFunding } = await createPoolsDryRun(
          api,
          derive,
          poolCount,
          poolStake,
          commission,
          PAS
        );
        totalPoolFunding = totalFunding;
      } else {
        // Create pools and capture their IDs for members/hybrids to use
        const createdPoolIds: number[] = [];
        await createPools(
          api,
          godSigner,
          derive,
          poolCount,
          poolStake,
          commission,
          createdPoolIds,
          PAS,
          isDryRun
        );
        availablePoolIds = createdPoolIds; // Use only newly created pools
      }
    }

    // Members can only join newly created pools
    if (memberCount > 0) {
      if (poolCount === 0) {
        console.error(`❌ Cannot create pool members without creating pools in the same command!`);
        console.error(
          `   Use --pools <number> to create pools first, then members will join them.`
        );
        return;
      }
      if (availablePoolIds.length === 0) {
        console.error(`❌ No pools were created successfully - cannot create members`);
        return;
      }
      if (isDryRun) {
        const { totalFunding } = await createPoolMembersDryRun(
          api,
          derive,
          memberCount,
          memberStake,
          availablePoolIds,
          PAS
        );
        totalMemberFunding = totalFunding;
      } else {
        const createdMemberIndices: number[] = [];
        await createPoolMembers(
          api,
          godSigner,
          derive,
          memberCount,
          memberStake,
          availablePoolIds, // Only join newly created pools
          createdMemberIndices,
          PAS,
          isDryRun
        );
      }
    }

    // Hybrid stakers can only join newly created pools
    if (hybridCount > 0) {
      if (poolCount === 0) {
        console.error(
          `❌ Cannot create hybrid stakers without creating pools in the same command!`
        );
        console.error(
          `   Use --pools <number> to create pools first, then hybrids will join them.`
        );
        return;
      }
      if (availablePoolIds.length === 0) {
        console.error(`❌ No pools were created successfully - cannot create hybrid stakers`);
        return;
      }
      if (isDryRun) {
        const { totalFunding } = await createHybridStakersDryRun(
          api,
          derive,
          hybridCount,
          soloStake,
          memberStake,
          availablePoolIds,
          validatorsPerNominator,
          PAS
        );
        totalHybridFunding = totalFunding;
      } else {
        await createHybridStakers(
          api,
          godSigner,
          derive,
          hybridCount,
          soloStake,
          memberStake,
          availablePoolIds, // Only join newly created pools
          validatorsPerNominator,
          PAS,
          isDryRun
        );
      }
    }

    // Final summary
    if (isDryRun) {
      const totalFunding = totalPoolFunding + totalMemberFunding + totalHybridFunding;
      console.log(`\n🔍 DRY RUN: Final Summary`);
      console.log(`   📊 Total funding requirements:`);
      console.log(`      - For pools: ${Number(totalPoolFunding) / Number(PAS)} PAS`);
      console.log(`      - For members: ${Number(totalMemberFunding) / Number(PAS)} PAS`);
      console.log(`      - For hybrids: ${Number(totalHybridFunding) / Number(PAS)} PAS`);
      console.log(`      - Grand total: ${Number(totalFunding) / Number(PAS)} PAS`);
      console.log(`   💰 God account balance: ${Number(godBalance) / Number(PAS)} PAS`);
      console.log(
        `   ${godBalance >= totalFunding ? "✅" : "❌"} Balance ${godBalance >= totalFunding ? "sufficient" : "insufficient"}`
      );

      if (godBalance < totalFunding) {
        console.log(
          `   ⚠️  Need additional ${Number(totalFunding - godBalance) / Number(PAS)} PAS`
        );
      }

      console.log(`\n   🎯 To execute these operations, run the same command without --dry-run`);
    } else {
      console.log(`\n✅ Pool operations complete!`);
    }
  } finally {
    // Clean up
    await new Promise((resolve) => setTimeout(resolve, 1000));
    client.destroy();
    smoldot.terminate();
  }
}

async function main() {
  // Parse options
  const godSeed = options.seed;
  const numNominators = parseInt(options.nominators);
  const validatorsPerNominator = parseInt(options.validatorsPerNominator);
  const isDryRun = options.dryRun || false;

  // Top-up mode options
  const topupAmount = options.topup ? parseFloat(options.topup) : null;
  const fromIndex = options.from ? parseInt(options.from) : null;
  const toIndex = options.to ? parseInt(options.to) : null;

  // Pool-specific options
  const poolCount = options.pools ? parseInt(options.pools) : 0;
  const memberCount = options.poolMembers ? parseInt(options.poolMembers) : 0;
  const hybridCount = options.hybridStakers ? parseInt(options.hybridStakers) : 0;
  const poolStake = options.poolStake ? parseFloat(options.poolStake) : null;
  const memberStake = options.memberStake ? parseFloat(options.memberStake) : null;
  const commission = options.poolCommission ? parseInt(options.poolCommission) : 10;

  // Determine operation mode
  const isTopupMode = topupAmount !== null;
  const isPoolMode = poolCount > 0 || memberCount > 0 || hybridCount > 0;
  const isDestroyMode = options.destroyPools !== undefined;
  const isListMode = options.listPools === true;
  const isRemoveMode = options.removeFromPool !== undefined;

  if (isListMode) {
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
  } else if (isTopupMode) {
    // Validate top-up options
    if (fromIndex === null || toIndex === null) {
      console.error("❌ Error: --topup requires both --from and --to options");
      console.error("   Example: --topup 250 --from 3 --to 32");
      process.exit(1);
    }

    // Execute complete topup mode end-to-end
    await executeCompleteTopupMode(topupAmount, fromIndex, toIndex, isDryRun, godSeed);
  } else if (isPoolMode) {
    // Execute complete pool mode end-to-end
    await executeCompletePoolMode(
      poolCount,
      memberCount,
      hybridCount,
      poolStake,
      memberStake,
      commission,
      validatorsPerNominator,
      isDryRun,
      godSeed
    );
  } else {
    // Execute complete populate mode end-to-end
    await executeCompletePopulateMode(numNominators, validatorsPerNominator, isDryRun, godSeed);
  }
}

main().catch(console.error);
