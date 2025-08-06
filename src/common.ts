import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { validateAndProcessSeed } from "./utils.js";
import { getNetworkConfig, getTokenUnit } from "./network-config.js";
// Types are used in return type annotations below

// RPC endpoints for all supported networks
const RPC_ENDPOINTS: Record<string, string> = {
  paseo: "wss://paseo.dotters.network",
  "westend-asset-hub": "wss://westend-asset-hub-rpc.polkadot.io",
};

// Common setup function for API connection
export async function setupApiAndConnection(godSeed: string, network: string) {
  const networkConfig = getNetworkConfig(network);
  console.log(`⚠️  WARNING: This will execute REAL transactions on ${network} network!`);
  console.log("   Use --dry-run flag to test without executing transactions");

  // Validate and process god account seed
  const { derive, godKeyPair, godSigner } = validateAndProcessSeed(godSeed);

  // Load descriptor
  const descriptorsModule = await import("@polkadot-api/descriptors");
  const descriptor = (descriptorsModule as any)[networkConfig.descriptorName];

  // Connect via RPC endpoint
  const rpcEndpoint = RPC_ENDPOINTS[network];
  if (!rpcEndpoint) {
    throw new Error(`No RPC endpoint configured for network: ${network}`);
  }

  console.log(`🔗 Connecting to ${network} via RPC endpoint...`);
  const wsProvider = getWsProvider(rpcEndpoint);
  const client = createClient(wsProvider);

  // Get the safely typed API
  const api = client.getTypedApi(descriptor);

  console.log(`✅ Connected to ${network} network`);

  // Get the god account address in SS58 format with network-specific prefix
  const godAddress = ss58Encode(godKeyPair.publicKey, networkConfig.ss58Prefix);
  console.log(`🔑 God account address: ${godAddress}`);

  // Get token unit for this network
  const tokenUnit = getTokenUnit(network);

  // Check god account balance
  console.log(`🔍 Querying account balance for ${network}...`);

  try {
    const accountInfo = await (api.query.System as any).Account.getValue(godAddress);

    const godBalance = accountInfo.data.free;
    console.log(
      `💰 God account balance: ${godBalance} (${Number(godBalance) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) free, ${
        accountInfo.data.reserved
      } (${Number(accountInfo.data.reserved) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) reserved`
    );

    return { api, derive, godKeyPair, godSigner, godAddress, godBalance, tokenUnit, client };
  } catch (error) {
    console.error(`❌ Failed to query account balance: ${error}`);
    throw error;
  }
}

// Common function to cleanup connections
export function cleanup(client: any) {
  console.log("\n🔌 Disconnecting from network...");
  client.destroy();
}
