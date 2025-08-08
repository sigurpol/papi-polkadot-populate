// Block limit utilities for calculating optimal batch sizes
import type { TypedApi } from "./types.js";

export interface BatchSizes {
  transfers: number;
  staking: number;
  checkBatch: number;
}

const DEFAULT_BATCH_SIZES: BatchSizes = {
  transfers: 1000, // Simple balance transfers
  staking: 100, // Complex operations (bond + nominate)
  checkBatch: 50, // Parallel account existence checks (conservative for smoldot)
};

/**
 * Get optimal batch sizes based on chain runtime constants
 * Falls back to conservative defaults if constants cannot be queried
 */
export async function getOptimalBatchSizes(
  api: TypedApi,
  userOverrides?: Partial<BatchSizes>
): Promise<BatchSizes> {
  try {
    // Try to query block weight limits from chain
    // Note: The exact API may vary depending on the chain runtime
    const blockWeights = await api.constants.System.BlockWeights.getValue();

    // Extract max block weight
    // The structure is: { baseBlock, maxBlock, perClass }
    const maxBlockWeight = blockWeights.maxBlock;

    // Calculate batch sizes based on weight limits
    // These are rough estimates - actual weight per transaction varies
    // Using conservative estimates to ensure we don't exceed block limits

    // For reference (approximate weights):
    // - Simple transfer: ~150,000,000 weight units
    // - Staking operations: ~500,000,000 weight units
    // Max block weight is typically ~2,000,000,000,000 (2 * 10^12)

    // Use 75% of max block weight to leave room for other transactions
    const usableWeight = (maxBlockWeight.refTime * 75n) / 100n;

    // Estimate weight per transaction type (conservative)
    const transferWeight = 150_000_000n;
    const stakingWeight = 500_000_000n;

    // Calculate max transactions per batch
    const maxTransfers = Number(usableWeight / transferWeight);
    const maxStaking = Number(usableWeight / stakingWeight);

    // Apply reasonable limits
    const calculatedSizes: BatchSizes = {
      transfers: Math.min(1500, Math.max(500, maxTransfers)),
      staking: Math.min(250, Math.max(25, maxStaking)),
      checkBatch: 50, // Conservative for smoldot connections
    };

    console.log(`📊 Calculated batch sizes from chain constants:`);
    console.log(`   - Max block weight: ${maxBlockWeight.refTime.toString()}`);
    console.log(`   - Usable weight (75%): ${usableWeight.toString()}`);
    console.log(`   - Transfers per batch: ${calculatedSizes.transfers}`);
    console.log(`   - Staking ops per batch: ${calculatedSizes.staking}`);

    // Apply user overrides if provided
    return {
      transfers: userOverrides?.transfers ?? calculatedSizes.transfers,
      staking: userOverrides?.staking ?? calculatedSizes.staking,
      checkBatch: userOverrides?.checkBatch ?? calculatedSizes.checkBatch,
    };
  } catch (error) {
    // If we can't query chain constants, use conservative defaults
    console.log(`⚠️  Could not query chain constants, using default batch sizes`);
    console.log(`   Error: ${error}`);

    // Apply user overrides to defaults if provided
    return {
      transfers: userOverrides?.transfers ?? DEFAULT_BATCH_SIZES.transfers,
      staking: userOverrides?.staking ?? DEFAULT_BATCH_SIZES.staking,
      checkBatch: userOverrides?.checkBatch ?? DEFAULT_BATCH_SIZES.checkBatch,
    };
  }
}

/**
 * Validate user-provided batch sizes
 * Ensures they are within reasonable limits to prevent issues
 */
export function validateBatchSizes(sizes: Partial<BatchSizes>): string[] {
  const errors: string[] = [];

  if (sizes.transfers !== undefined) {
    if (sizes.transfers < 1 || sizes.transfers > 2000) {
      errors.push(`Transfer batch size must be between 1 and 2000 (got ${sizes.transfers})`);
    }
  }

  if (sizes.staking !== undefined) {
    if (sizes.staking < 1 || sizes.staking > 500) {
      errors.push(`Staking batch size must be between 1 and 500 (got ${sizes.staking})`);
    }
  }

  if (sizes.checkBatch !== undefined) {
    if (sizes.checkBatch < 1 || sizes.checkBatch > 1000) {
      errors.push(`Check batch size must be between 1 and 1000 (got ${sizes.checkBatch})`);
    }
  }

  return errors;
}

/**
 * Log batch size configuration for user visibility
 */
export function logBatchSizes(sizes: BatchSizes, isUserConfigured: boolean): void {
  const source = isUserConfigured ? "User-configured" : "Auto-calculated";
  console.log(`\n⚙️  ${source} batch sizes:`);
  console.log(`   - Balance transfers: ${sizes.transfers} per batch`);
  console.log(`   - Staking operations: ${sizes.staking} per batch`);
  console.log(`   - Account checks: ${sizes.checkBatch} in parallel`);
}
