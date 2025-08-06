import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { getPolkadotSigner } from "polkadot-api/signer";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { fromHex } from "@polkadot-api/utils";
import type { KeyPair, DeriveFunction, Signer, TypedApi } from "./types.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

// Helper function to get account at index using hard derivation
export const getAccountAtIndex = (index: number, derive: DeriveFunction) => {
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
export const getPoolAccountAtIndex = (index: number, derive: DeriveFunction) => {
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
export const getPoolMemberAccountAtIndex = (index: number, derive: DeriveFunction) => {
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
export const getHybridAccountAtIndex = (index: number, derive: DeriveFunction) => {
  // Use hybrid derivation path: //hybrid/index
  const childKeyPair = derive(`//hybrid/${index}`);
  return {
    keyPair: childKeyPair,
    address: ss58Encode(childKeyPair.publicKey, 0),
    signer: getPolkadotSigner(childKeyPair.publicKey, "Sr25519", childKeyPair.sign),
    index,
  };
};

// Function to validate and process god account seed
export function validateAndProcessSeed(godSeed: string): {
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
export async function getPoolChainParameters(
  api: TypedApi,
  tokenUnit: bigint,
  tokenSymbol: string
) {
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

  console.log(`📊 Pool Chain Parameters:`);
  console.log(`   MinCreateBond: ${Number(minCreateBond) / Number(tokenUnit)} ${tokenSymbol}`);
  console.log(`   MinJoinBond: ${Number(minJoinBond) / Number(tokenUnit)} ${tokenSymbol}`);
  if (maxPools !== undefined) console.log(`   MaxPools: ${maxPools}`);
  if (maxPoolMembers !== undefined) console.log(`   MaxPoolMembers: ${maxPoolMembers}`);
  console.log(`   Current Pools: ${counterForBondedPools}`);
  console.log(`   Current Members: ${counterForPoolMembers}`);

  return {
    minCreateBond,
    minJoinBond,
    maxPools,
    maxPoolMembers,
    counterForPoolMembers,
    counterForBondedPools,
  };
}

// Parse pool range string (e.g., "1-5" or "3,7,9")
export function parsePoolRange(rangeStr: string): number[] {
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

  // Remove duplicates and sort
  return [...new Set(pools)].sort((a, b) => a - b);
}

// Parse pool:members string (e.g., "10:addr1,addr2" or "10:all")
export function parsePoolMembers(input: string): { poolId: number; members: string[] | "all" } {
  const parts = input.split(":");
  if (parts.length !== 2) {
    throw new Error(
      'Invalid format. Expected "poolId:members" (e.g., "10:addr1,addr2" or "10:all")'
    );
  }

  const poolId = parseInt(parts[0]!.trim());
  if (isNaN(poolId)) {
    throw new Error(`Invalid pool ID: ${parts[0]}`);
  }

  const membersStr = parts[1]!.trim();
  if (membersStr === "all") {
    return { poolId, members: "all" };
  }

  const members = membersStr.split(",").map((addr) => addr.trim());
  if (members.length === 0 || members.some((addr) => addr === "")) {
    throw new Error("Invalid members list. Provide comma-separated addresses or 'all'");
  }

  return { poolId, members };
}
