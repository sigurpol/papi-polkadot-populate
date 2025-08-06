// Network configuration definitions
export interface NetworkConfig {
  chainId: string;
  ss58Prefix: number;
  decimals: number;
  tokenSymbol: string;
  explorerUrl: string;
  unbondingDays: number;
  descriptorName: string;
  chainSpecName: string;
}

export const NETWORK_CONFIGS: Record<string, NetworkConfig> = {
  paseo: {
    chainId: "paseo",
    ss58Prefix: 0,
    decimals: 10,
    tokenSymbol: "PAS",
    explorerUrl: "https://paseo.subscan.io",
    unbondingDays: 28,
    descriptorName: "paseo",
    chainSpecName: "paseo",
  },
  "westend-asset-hub": {
    chainId: "westmint",
    ss58Prefix: 42,
    decimals: 12,
    tokenSymbol: "WND",
    explorerUrl: "https://assethub-westend.subscan.io",
    unbondingDays: 7,
    descriptorName: "westmint",
    chainSpecName: "westend2_asset_hub",
  },
};

export const SUPPORTED_NETWORKS = Object.keys(NETWORK_CONFIGS);

export function getNetworkConfig(network: string): NetworkConfig {
  const config = NETWORK_CONFIGS[network];
  if (!config) {
    throw new Error(
      `Unsupported network: ${network}. Supported networks: ${SUPPORTED_NETWORKS.join(", ")}`
    );
  }
  return config;
}

export function getTokenUnit(network: string): bigint {
  const config = getNetworkConfig(network);
  return BigInt(10) ** BigInt(config.decimals);
}
