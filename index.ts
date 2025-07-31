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
  .option("--dry-run", "Show what would happen without executing transactions")
  .parse(process.argv);

const options = program.opts();

async function main() {
  // Parse options
  const godSeed = options.seed;
  const numNominators = parseInt(options.nominators);
  const validatorsPerNominator = parseInt(options.validatorsPerNominator);
  const isDryRun = options.dryRun || false;

  console.log("🚀 Starting PAPI Polkadot Populate");
  console.log(`📊 Configuration:`);
  // console.log(`   - God account seed: ${godSeed.substring(0, 10)}...`);
  console.log(`   - Number of nominators: ${numNominators}`);
  console.log(`   - Validators per nominator: ${validatorsPerNominator}`);
  console.log(`   - Mode: ${isDryRun ? "DRY RUN" : "EXECUTE (Real transactions!)"}`);

  if (!isDryRun) {
    console.log("⚠️  WARNING: This will execute REAL transactions on Paseo testnet!");
    console.log("   Use --dry-run flag to test without executing transactions");
  }

  // Create the god account signer
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
    const amountPerAccount = minNominatorBond + existentialDeposit + txFeeBuffer; // MinBond + ED + fees
    const avgStakePerAccount = minNominatorBond; // We'll stake exactly the minimum required
    const totalFundingAmount = amountPerAccount * BigInt(numNominators);
    const totalStakingAmount = avgStakePerAccount * BigInt(numNominators);
    const totalAmount = totalFundingAmount + totalStakingAmount;

    console.log(`\n💸 Funding requirements:`);
    console.log(`   - Initial funding per account: ${Number(amountPerAccount) / Number(PAS)} PAS`);
    console.log(`   - Average stake per account: ${Number(avgStakePerAccount) / Number(PAS)} PAS`);
    console.log(`   - Total funding needed: ${Number(totalFundingAmount) / Number(PAS)} PAS`);
    console.log(`   - Total staking needed: ${Number(totalStakingAmount) / Number(PAS)} PAS`);
    console.log(`   - Total amount needed: ${Number(totalAmount) / Number(PAS)} PAS`);
    console.log(`   - God account balance: ${Number(godBalance) / Number(PAS)} PAS`);

    if (godBalance < totalAmount) {
      console.error(
        `\n❌ Insufficient balance! Need ${totalAmount / PAS} PAS but only have ${godBalance / PAS} PAS`
      );
      process.exit(1);
    }

    console.log(`✅ Balance check passed - sufficient funds available`);

    // Helper function to get account at index using hard derivation
    const getAccountAtIndex = (index: number) => {
      // Use hard derivation path: ///index
      const childKeyPair = derive(`///${index}`);
      return {
        keyPair: childKeyPair,
        address: ss58Encode(childKeyPair.publicKey, 0),
        signer: getPolkadotSigner(childKeyPair.publicKey, "Sr25519", childKeyPair.sign),
      };
    };

    // Function to create accounts with batch transfers
    const createAccounts = async (
      from: number,
      to: number,
      amountPerAccount: bigint,
      batchSize = 500
    ) => {
      console.log(`\n📝 Creating accounts from ${from} to ${to - 1} (${to - from} accounts)...`);
      console.log(
        `   📊 Using batch size of ${batchSize} - estimated ${Math.ceil((to - from) / batchSize)} batches`
      );

      let counter = from;
      let createdCount = 0;
      let skippedCount = 0;

      while (counter < to) {
        const batch = [];

        // Build batch of transfers
        while (batch.length < batchSize && counter < to) {
          const account = getAccountAtIndex(counter);

          // Check if account already exists
          const accountInfo = await api.query.System.Account.getValue(account.address);
          const shouldCreate = accountInfo.providers === 0;

          if (shouldCreate) {
            console.log(`   [${counter}] Creating ${account.address}`);
            // Use transfer_allow_death for creating new accounts
            const transfer = api.tx.Balances.transfer_allow_death({
              dest: MultiAddress.Id(account.address),
              value: amountPerAccount,
            });
            batch.push(transfer.decodedCall);
            createdCount++;
          } else {
            console.log(`   [${counter}] Skipping ${account.address} (already exists)`);
            skippedCount++;
          }

          counter++;
        }

        // Execute batch if we have transfers
        if (batch.length > 0) {
          if (isDryRun) {
            console.log(`\n🔍 DRY RUN: Would execute batch of ${batch.length} transfers`);
          } else {
            console.log(
              `\n⚡ Executing batch of ${batch.length} transfers (${createdCount + skippedCount}/${to - from} accounts processed)...`
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
                next: (event) => {
                  console.log(`   📡 Event: ${event.type}`);
                  if (event.type === "txBestBlocksState") {
                    console.log(`   ✅ Batch included in block`);
                    console.log(`   📋 Transaction hash: ${event.txHash}`);
                    console.log(`   🔗 https://paseo.subscan.io/extrinsic/${event.txHash}`);
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
                error: (error) => {
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

      console.log(`\n📊 Summary:`);
      console.log(`   - Accounts created: ${createdCount}`);
      console.log(`   - Accounts skipped: ${skippedCount}`);

      return { createdCount, skippedCount };
    };

    // Function to stake and nominate
    const stakeAndNominate = async (from: number, to: number, batchSize = 25) => {
      console.log(`\n🥩 Starting staking and nomination for accounts ${from} to ${to - 1}...`);

      // First, get the list of all validators
      const validatorEntries = await api.query.Staking.Validators.getEntries();
      const allValidators: SS58String[] = validatorEntries.map(
        ({ keyArgs: [validator] }) => validator
      );

      if (allValidators.length === 0) {
        console.error("❌ No validators found on chain!");
        return;
      }

      console.log(`📊 Found ${allValidators.length} validators on chain`);

      let counter = from;
      let stakedCount = 0;
      let skippedCount = 0;

      while (counter < to) {
        const batch = [];

        while (batch.length < batchSize && counter < to) {
          const account = getAccountAtIndex(counter);

          // Check if account is already bonded
          const ledger = await api.query.Staking.Ledger.getValue(account.address);
          const isBonded = ledger !== undefined;

          // Check if already a nominator
          const nominators = await api.query.Staking.Nominators.getValue(account.address);
          const isNominator = nominators !== undefined;

          if (!isBonded && !isNominator) {
            // Check account balance before staking
            const accountInfo = await api.query.System.Account.getValue(account.address);
            const availableBalance = accountInfo.data.free;

            // Use minimum nominator bond as stake amount
            const stakeAmount = minNominatorBond;

            // Ensure account has sufficient balance (stake + ED + fees buffer)
            const requiredBalance = stakeAmount + existentialDeposit + txFeeBuffer;
            if (availableBalance < requiredBalance) {
              console.log(
                `   [${counter}] Skipping ${account.address} - insufficient balance (has ${Number(availableBalance) / Number(PAS)} PAS, needs ${Number(requiredBalance) / Number(PAS)} PAS)`
              );
              skippedCount++;
              counter++;
              continue;
            }

            console.log(
              `   [${counter}] Staking ${Number(stakeAmount) / Number(PAS)} PAS and nominating from ${account.address}`
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
                `   [${counter}] No validators selected for ${account.address}, skipping`
              );
              continue;
            }

            // Create bond and nominate transactions
            const bondTx = api.tx.Staking.bond({
              value: stakeAmount,
              payee: { type: "Staked", value: undefined },
            });

            // Convert SS58String[] to MultiAddress[] explicitly for nominate
            const validatorTargets = selectedValidators.map((validator) =>
              MultiAddress.Id(validator)
            );
            const nominateTx = api.tx.Staking.nominate({ targets: validatorTargets });

            // Batch bond and nominate together
            const batchTx = api.tx.Utility.batch_all({
              calls: [bondTx.decodedCall, nominateTx.decodedCall],
            });
            batch.push({ tx: batchTx, signer: account.signer });

            stakedCount++;
          } else {
            console.log(
              `   [${counter}] Skipping ${account.address} (already bonded: ${isBonded}, nominator: ${isNominator})`
            );
            skippedCount++;
          }

          counter++;
        }

        // Execute batch if we have transactions
        if (batch.length > 0) {
          if (isDryRun) {
            console.log(
              `\n🔍 DRY RUN: Would execute batch of ${batch.length} stake+nominate operations`
            );
          } else {
            console.log(
              `\n⚡ Executing batch of ${batch.length} stake+nominate operations (${stakedCount + skippedCount}/${to - from} accounts processed)...`
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
                    next: (event) => {
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
                    error: (error) => {
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
    };

    // Execute account creation
    if (isDryRun) {
      console.log(`\n🚧 DRY RUN MODE - No real transactions will be executed`);
      console.log(`   To execute real transactions, run without --dry-run flag`);

      // Simulate what would happen
      await createAccounts(1, numNominators + 1, amountPerAccount, 10);

      // Simulate staking
      await stakeAndNominate(1, numNominators + 1, 5);
    } else {
      console.log(`\n⚠️  READY TO EXECUTE REAL TRANSACTIONS`);
      console.log(`   This will transfer real funds on Paseo testnet!`);

      await createAccounts(1, numNominators + 1, amountPerAccount, 500);

      await stakeAndNominate(1, numNominators + 1, 25);
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
