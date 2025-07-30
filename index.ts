import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy, DEV_PHRASE } from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import { createClient } from "polkadot-api";
import { paseo } from "@polkadot-api/descriptors";
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
  .parse(process.argv);

const options = program.opts();

async function main() {
  // Parse options
  const godSeed = options.seed;
  const numNominators = parseInt(options.nominators);
  const validatorsPerNominator = parseInt(options.validatorsPerNominator);

  console.log("🚀 Starting PAPI Polkadot Populate");
  console.log(`📊 Configuration:`);
  console.log(`   - God account seed: ${godSeed.substring(0, 10)}...`);
  console.log(`   - Number of nominators: ${numNominators}`);
  console.log(`   - Validators per nominator: ${validatorsPerNominator}`);

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
  const _godSigner = getPolkadotSigner(godKeyPair.publicKey, "Sr25519", godKeyPair.sign);

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
    console.log(
      `💰 God account balance: ${accountInfo.data.free} (free), ${accountInfo.data.reserved} (reserved)`
    );

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

    // Test account derivation
    console.log("\n📦 Testing account derivation:");
    for (let i = 1; i <= Math.min(3, numNominators); i++) {
      const account = getAccountAtIndex(i);
      console.log(`   Account #${i}: ${account.address}`);
    }
  } catch (error) {
    console.error("❌ Error:", error);
  } finally {
    client.destroy();
    smoldot.terminate();
  }
}

main().catch(console.error);
