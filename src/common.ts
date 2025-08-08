import { createClient } from "polkadot-api";
import { getSmProvider } from "polkadot-api/sm-provider";
import { start } from "smoldot";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { validateAndProcessSeed } from "./utils.js";
import { getNetworkConfig, getTokenUnit } from "./network-config.js";
// Types are used in return type annotations below

// Common setup function for API connection
export async function setupApiAndConnection(
  godSeed: string,
  network: string,
  isDryRun: boolean = false
) {
  const networkConfig = getNetworkConfig(network);
  if (!isDryRun) {
    console.log(`⚠️  WARNING: This will execute REAL transactions on ${network} network!`);
    console.log("   Use --dry-run flag to test without executing transactions");
  }

  // Validate and process god account seed
  const { derive, godKeyPair, godSigner } = validateAndProcessSeed(godSeed);

  // Dynamically import chain spec and descriptor based on network
  const chainSpecModule = await import(`polkadot-api/chains/${networkConfig.chainSpecName}`);
  const chainSpec = chainSpecModule.chainSpec;

  const descriptorsModule = await import("@polkadot-api/descriptors");
  const descriptor = (descriptorsModule as any)[networkConfig.descriptorName];

  // Create the client with smoldot
  console.log(`🔗 Initializing smoldot for ${network}...`);
  const smoldot = start();

  let chain;
  if (network === "westend-asset-hub") {
    // For Westend Asset Hub parachain, we need to connect to Westend relay chain first
    console.log(`📡 Adding Westend relay chain to smoldot...`);
    const westendModule = await import("polkadot-api/chains/westend2");
    const westendChain = await smoldot.addChain({ chainSpec: westendModule.chainSpec });

    console.log(`📡 Adding Westend Asset Hub parachain to smoldot...`);
    chain = await smoldot.addChain({
      chainSpec,
      potentialRelayChains: [westendChain],
    });
  } else {
    // For relay chains like Paseo
    console.log(`📡 Adding chain to smoldot (this may take a moment for Asset Hub chains)...`);
    chain = await smoldot.addChain({ chainSpec });
  }

  const client = createClient(getSmProvider(chain));

  // Get the safely typed API
  const api = client.getTypedApi(descriptor);

  console.log(`✅ Connected to ${network} network`);

  // Get the god account address in SS58 format with network-specific prefix
  const godAddress = ss58Encode(godKeyPair.publicKey, networkConfig.ss58Prefix);
  console.log(`🔑 God account address: ${godAddress}`);

  // Get token unit for this network
  const tokenUnit = getTokenUnit(network);

  // Check god account balance with timeout
  console.log(
    `🔍 Querying account balance for ${network} (this may take longer for Asset Hub to sync)...`
  );

  let accountInfo;
  try {
    accountInfo = await Promise.race([
      (api.query.System as any).Account.getValue(godAddress),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Account query timeout after 60 seconds")), 60000);
      }),
    ]);

    const godBalance = accountInfo.data.free;
    console.log(
      `💰 God account balance: ${godBalance} (${Number(godBalance) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) free, ${
        accountInfo.data.reserved
      } (${Number(accountInfo.data.reserved) / Number(tokenUnit)} ${networkConfig.tokenSymbol}) reserved`
    );
  } catch (error) {
    console.error(`❌ Failed to query account balance: ${error}`);
    console.log(`💡 This often indicates the chain is slow to sync or has connectivity issues`);
    console.log(`💡 For faster connectivity, consider using a public RPC endpoint`);
    throw error;
  }

  return {
    api,
    derive,
    godKeyPair,
    godSigner,
    godAddress,
    godBalance: accountInfo.data.free,
    tokenUnit,
    smoldot,
    client,
  };
}

// Common function to cleanup connections
export function cleanup(smoldot: any, client: any) {
  console.log("\n🔌 Disconnecting from network...");
  client.destroy();
  smoldot.terminate();
}
