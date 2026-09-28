import type { Address } from 'viem';

// Monad mainnet (143). Every entry was re-verified 2026-10-05 against official docs and
// read-only eth_call (memory/tech_docs_verification_2026-10-05.md). Gapless contracts are
// added at the address freeze, not before.

export const MONAD_CHAIN_ID = 143 as const;

/** Perpl Exchange proxy (v1.7.5). */
export const PERPL_EXCHANGE: Address = '0x34B6552d57a35a1D042CcAe1951BD1C370112a6F';

/** Agora AUSD, 6 decimals, ERC-2612 permit, EIP-712 domain "Agora Dollar" v1. */
export const AUSD: Address = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
export const AUSD_DECIMALS = 6 as const;

/** Chainlink Data Feeds, all 8 decimals, 3600 s heartbeat. MON/USD is in the "new" risk tier. */
export const CHAINLINK_FEEDS = {
  BTC_USD: '0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546',
  ETH_USD: '0x1B1414782B859871781bA3E4B0979b9ca57A0A04',
  MON_USD: '0xBcD78f76005B7515837af6b50c7C52BCf73822fb',
  AUSD_USD: '0xE20751C7B5867bCBef815ffc1b284c3f412a9e13'
} as const satisfies Record<string, Address>;
export const CHAINLINK_FEED_DECIMALS = 8 as const;

/** Chainlink CRE forwarders. `simulation` is MockKeystoneForwarder used by `cre workflow simulate`. */
export const CRE_FORWARDERS = {
  simulation: '0x9eF6468C5f37b976E57d52054c693269479A784d',
  production: '0x76c9cf548b4179F8901cda1f8623568b58215E62'
} as const satisfies Record<string, Address>;
