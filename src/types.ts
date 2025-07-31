// Type definitions for PAPI interfaces
export interface TransactionEvent {
  // PAPI transaction event interface - keeping as any for now due to complex PAPI types
  [key: string]: any;
}

export interface KeyPair {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
}

export interface Signer {
  // Polkadot API signer interface
  [key: string]: any;
}

export interface TypedApi {
  // PAPI typed API interface - keeping as any for now due to complex PAPI types
  [key: string]: any;
}

export type DeriveFunction = (path: string) => KeyPair;

export interface AccountInfo {
  keyPair: KeyPair;
  address: string;
  signer: any;
  index: number;
}
