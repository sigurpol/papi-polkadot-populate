import { createClient } from "polkadot-api";
import { getSmProvider } from "polkadot-api/sm-provider";
import { start } from "smoldot";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { validateAndProcessSeed } from "./utils.js";
import { getNetworkConfig, getTokenUnit } from "./network-config.js";
// Types are used in return type annotations below

// Common setup function for API connection
export async function setupApiAndConnection(godSeed: string, network: string) {
  const networkConfig = getNetworkConfig(network);
  console.log(`⚠️  WARNING: This will execute REAL transactions on ${network} network!`);
  console.log("   Use --dry-run flag to test without executing transactions");

  // Validate and process god account seed
  const { derive, godKeyPair, godSigner } = validateAndProcessSeed(godSeed);

  // Dynamically import chain spec and descriptor based on network
  const chainSpecModule = await import(`polkadot-api/chains/${networkConfig.chainSpecName}`);
  const chainSpec = chainSpecModule.chainSpec;

  const descriptorsModule = await import("@polkadot-api/descriptors");
  const descriptor = (descriptorsModule as any)[networkConfig.descriptorName];

  // Create the client with smoldot
  const smoldot = start();
  const client = createClient(getSmProvider(smoldot.addChain({ chainSpec })));

  // Get the safely typed API
  const api = client.getTypedApi(descriptor);

  console.log(`✅ Connected to ${network} network`);

  // Get the god account address in SS58 format with network-specific prefix
  const godAddress = ss58Encode(godKeyPair.publicKey, networkConfig.ss58Prefix);
  console.log(`🔑 God account address: ${godAddress}`);

  // Get token unit for this network
  const tokenUnit = getTokenUnit(network);

  // Check god account balance
  const accountInfo = await (api.query.System as any).Account.getValue(godAddress);
  const godBalance = accountInfo.data.free;
  console.log(
    `💰 God account balance: ${godBalance} (${Number(godBalance) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) free, ${
      accountInfo.data.reserved
    } (${Number(accountInfo.data.reserved) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) reserved`
  );

  return { api, derive, godKeyPair, godSigner, godAddress, godBalance, tokenUnit, smoldot, client };
}

// Common function to cleanup connections
export function cleanup(smoldot: any, client: any) {
  console.log("\n🔌 Disconnecting from network...");
  client.destroy();
  smoldot.terminate();
}
