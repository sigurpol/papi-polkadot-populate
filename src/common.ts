import { createClient } from "polkadot-api";
import { getSmProvider } from "polkadot-api/sm-provider";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { start } from "smoldot";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { validateAndProcessSeed } from "./utils.js";
import { getNetworkConfig, getTokenUnit } from "./network-config.js";
// Types are used in return type annotations below

// RPC endpoints for fallback connectivity
const RPC_ENDPOINTS: Record<string, string> = {
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

  let client: any;
  let smoldot: any = null;

  // For Westend Asset Hub, try RPC first due to smoldot connectivity issues
  if (network === "westend-asset-hub" && RPC_ENDPOINTS[network]) {
    console.log(`🔗 Connecting to ${network} via public RPC endpoint...`);
    try {
      const wsProvider = getWsProvider(RPC_ENDPOINTS[network]);
      client = createClient(wsProvider);
      console.log(`✅ Connected to ${network} via RPC`);
    } catch (rpcError) {
      console.log(`❌ RPC connection failed, falling back to smoldot: ${rpcError}`);
      // Fallback to smoldot
      const chainSpecModule = await import(`polkadot-api/chains/${networkConfig.chainSpecName}`);
      const chainSpec = chainSpecModule.chainSpec;
      smoldot = start();
      client = createClient(getSmProvider(smoldot.addChain({ chainSpec })));
    }
  } else {
    // Use smoldot for other networks
    const chainSpecModule = await import(`polkadot-api/chains/${networkConfig.chainSpecName}`);
    const chainSpec = chainSpecModule.chainSpec;
    smoldot = start();
    client = createClient(getSmProvider(smoldot.addChain({ chainSpec })));
  }

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
  console.log(`💡 This may take longer for Asset Hub chains to sync initially...`);
  try {
    const accountInfo = await Promise.race([
      (api.query.System as any).Account.getValue(godAddress),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Account query timeout after 60s")), 60000)
      )
    ]) as any;
    
    const godBalance = accountInfo.data.free;
    console.log(
      `💰 God account balance: ${godBalance} (${Number(godBalance) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) free, ${
        accountInfo.data.reserved
      } (${Number(accountInfo.data.reserved) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) reserved`
    );

    return { api, derive, godKeyPair, godSigner, godAddress, godBalance, tokenUnit, smoldot, client };
  } catch (error) {
    console.error(`❌ Failed to query account balance: ${error}`);
    console.log(`💡 This might indicate the chain is slow to sync or has connectivity issues`);
    throw error;
  }
}

// Common function to cleanup connections
export function cleanup(smoldot: any, client: any) {
  console.log("\n🔌 Disconnecting from network...");
  client.destroy();
  if (smoldot) {
    smoldot.terminate();
  }
}
