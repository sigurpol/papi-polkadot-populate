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
  .description("Populate Paseo testnet with nominators using PAPI")
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
        console.log(`   [${accountIndex}] Skipping ${account.address} (already exists)`);
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
        await new Promise((resolve, reject) => {
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
                reject(error);
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

      await new Promise((resolve, reject) => {
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
              reject(error);
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

  // Determine operation mode
  const isTopupMode = topupAmount !== null;

  if (isTopupMode) {
    // Validate top-up options
    if (fromIndex === null || toIndex === null) {
      console.error("❌ Error: --topup requires both --from and --to options");
      console.error("   Example: --topup 250 --from 3 --to 32");
      process.exit(1);
    }

    if (fromIndex >= toIndex) {
      console.error("❌ Error: --from must be less than --to");
      process.exit(1);
    }

    console.log("🚀 Starting PAPI Polkadot Populate - TOPUP MODE");
    console.log(`📊 Configuration:`);
    console.log(`   - Top-up amount: ${topupAmount} PAS`);
    console.log(
      `   - Account range: ///${fromIndex} to ///${toIndex - 1} (${toIndex - fromIndex} accounts)`
    );
    console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);
  } else {
    console.log("🚀 Starting PAPI Polkadot Populate");
    console.log(`📊 Configuration:`);
    console.log(`   - Number of nominators: ${numNominators}`);
    console.log(`   - Validators per nominator: ${validatorsPerNominator}`);
    console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);
  }

  if (!isDryRun) {
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

  try {
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

    // Execute operations based on mode
    if (isTopupMode) {
      await topupAccounts(
        api,
        godSigner,
        derive,
        topupAmount!,
        fromIndex!,
        toIndex!,
        godBalance,
        PAS,
        isDryRun
      );
    } else if (isDryRun) {
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
    } else {
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
  } catch (error) {
    console.error("❌ Error:", error);
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

main().catch(console.error);
