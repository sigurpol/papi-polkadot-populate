import { createClient } from "polkadot-api";
import { getSmProvider } from "polkadot-api/sm-provider";
import { chainSpec } from "polkadot-api/chains/paseo";
import { start } from "smoldot";
import { paseo } from "@polkadot-api/descriptors";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { validateAndProcessSeed } from "./utils.js";
// Types are used in return type annotations below

// Common setup function for API connection
export async function setupApiAndConnection(godSeed: string) {
  console.log("⚠️  WARNING: This will execute REAL transactions on Paseo testnet!");
  console.log("   Use --dry-run flag to test without executing transactions");

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
    `💰 God account balance: ${godBalance} (${Number(godBalance) / Number(PAS)} PAS) free, ${
      accountInfo.data.reserved
    } (${Number(accountInfo.data.reserved) / Number(PAS)} PAS) reserved`
  );

  return { api, derive, godKeyPair, godSigner, godAddress, godBalance, PAS, smoldot, client };
}

// Common function to cleanup connections
export function cleanup(smoldot: any, client: any) {
  console.log("\n🔌 Disconnecting from network...");
  client.destroy();
  smoldot.terminate();
}
