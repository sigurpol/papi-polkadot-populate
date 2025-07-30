import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy, DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createClient } from "polkadot-api";
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
  console.log(`   - God account seed: ${godSeed.substring(0, 10)}...`);
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

    // Check god account balance
    const accountInfo = await api.query.System.Account.getValue(godAddress);
    const godBalance = accountInfo.data.free;
    console.log(
      `💰 God account balance: ${godBalance} (free), ${accountInfo.data.reserved} (reserved)`
    );

    // Calculate funding requirements and check balance immediately
    const PAS = 1_000_000_000_000n; // 1 PAS = 10^12 planck
    const amountPerAccount = PAS * 1n; // 1 PAS per account
    const totalAmount = amountPerAccount * BigInt(numNominators);

    console.log(`\n💸 Funding requirements:`);
    console.log(`   - Each account will receive: ${amountPerAccount / PAS} PAS`);
    console.log(`   - Total amount needed: ${totalAmount / PAS} PAS`);
    console.log(`   - God account balance: ${godBalance / PAS} PAS`);

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
      batchSize = 100
    ) => {
      console.log(`\n📝 Creating accounts from ${from} to ${to - 1} (${to - from} accounts)...`);

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
            batch.push(transfer);
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
            console.log(`\n⚡ Executing batch of ${batch.length} transfers...`);

            // Use utility.batch for multiple transfers
            const batchTx = batch.length === 1 ? batch[0] : api.tx.Utility.batch({ calls: batch });

            // Sign and submit
            await new Promise((resolve, reject) => {
              batchTx.signSubmitAndWatch(godSigner).subscribe({
                next: (event) => {
                  if (event.type === "txBestBlocksState") {
                    console.log(`   ✅ Batch included in block`);
                    console.log(`   🔗 https://paseo.subscan.io/extrinsic/${event.txHash}`);
                  }
                },
                error: (error) => {
                  console.error(`   ❌ Batch failed:`, error);
                  reject(error);
                },
                complete() {
                  console.log(`   ✅ Batch completed`);
                  resolve(null);
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

    // Execute account creation
    if (isDryRun) {
      console.log(`\n🚧 DRY RUN MODE - No real transactions will be executed`);
      console.log(`   To execute real transactions, run without --dry-run flag`);

      // Simulate what would happen
      await createAccounts(1, numNominators + 1, amountPerAccount, 10);
    } else {
      console.log(`\n⚠️  READY TO EXECUTE REAL TRANSACTIONS`);
      console.log(`   This will transfer real funds on Paseo testnet!`);
      console.log(`   Press Ctrl+C within 5 seconds to cancel...`);

      // Give user time to cancel
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Execute real transactions
      await createAccounts(1, numNominators + 1, amountPerAccount, 10);
    }
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    client.destroy();
    smoldot.terminate();
  }
}

main().catch(console.error);
