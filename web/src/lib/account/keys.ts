import {
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
} from '@category-labs/mera'
import { HDKey } from '@scure/bip32'
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import type {
  PasskeyCredentialMetadata,
  Secp256k1SigningSession,
} from '@category-labs/mera'
import { env } from '@/env'

/**
 * Passkey and key-derivation ceremonies (ARCHITECTURE ADR-W1, 8.3). Highest
 * security sensitivity in the app: no private key, seed, mnemonic or PRF
 * output is ever logged, put in React state, or sent anywhere.
 */

export const OWNER_PATH = "m/44'/60'/0'/0/0"
export const OPERATOR_PATH = "m/44'/60'/0'/0/1"

/**
 * Passkeys are bound to `VITE_RP_ID` forever (ARCHITECTURE 8.3, Q1). A preview
 * deploy on a different host must never be able to run a ceremony.
 */
export function assertPasskeyOrigin(): void {
  if (typeof window === 'undefined') return
  if (window.location.hostname !== env.VITE_RP_ID) {
    throw new Error(
      `Passkey ceremonies are only allowed on ${env.VITE_RP_ID}, got ${window.location.hostname}`,
    )
  }
}

function zero(bytes: Uint8Array): void {
  bytes.fill(0)
}

export interface AccountSessions {
  ownerSession: Secp256k1SigningSession
  operatorSession: Secp256k1SigningSession
}

/**
 * Derives the owner (index 0) and operator (index 1) secp256k1 sessions from
 * one 32-byte WebAuthn PRF output (03_mera_agora_frontend_reference section
 * 1.8): the PRF output is 256-bit BIP-39 entropy, then a seed, then the two
 * paths. Every buffer we own is zeroed. The mnemonic is a JS string and
 * cannot be zeroed; its lifetime here is as short as derivation allows.
 */
export function deriveAccountKeys(prfOutput: Uint8Array): AccountSessions {
  if (prfOutput.length !== 32) {
    throw new RangeError('deriveAccountKeys: prfOutput must be 32 bytes')
  }

  const entropy = new Uint8Array(prfOutput)
  const mnemonic = entropyToMnemonic(entropy, wordlist)
  zero(entropy)

  const seed = mnemonicToSeedSync(mnemonic)
  const root = HDKey.fromMasterSeed(seed)
  zero(seed)

  const ownerNode = root.derive(OWNER_PATH)
  const operatorNode = root.derive(OPERATOR_PATH)
  root.wipePrivateData()

  const ownerKey = ownerNode.privateKey
  const operatorKey = operatorNode.privateKey
  if (!ownerKey || !operatorKey) {
    ownerNode.wipePrivateData()
    operatorNode.wipePrivateData()
    throw new Error(
      'deriveAccountKeys: derivation did not produce a private key',
    )
  }

  const ownerSession = createSecp256k1SigningSession({ privateKey: ownerKey })
  const operatorSession = createSecp256k1SigningSession({
    privateKey: operatorKey,
  })

  zero(ownerKey)
  zero(operatorKey)
  ownerNode.wipePrivateData()
  operatorNode.wipePrivateData()

  return { ownerSession, operatorSession }
}

export interface CreatedPasskey {
  credential: PasskeyCredentialMetadata
  sessions: AccountSessions
}

/** "Create account" (ARCHITECTURE 5.1): one passkey ceremony, one PRF output. */
export async function createAccountPasskey(): Promise<CreatedPasskey> {
  assertPasskeyOrigin()
  const result = await createPasskeyWithPrfOutput({
    rp: { id: env.VITE_RP_ID, name: 'Gapless' },
    user: { name: 'Gapless account', displayName: 'Gapless account' },
  })
  const sessions = deriveAccountKeys(result.prfOutput)
  zero(result.prfOutput)
  return {
    credential: {
      credentialId: result.credentialId,
      transports: result.transports,
    },
    sessions,
  }
}

/** "Sign in" (ARCHITECTURE 5.1): re-derive the same owner and operator from the same passkey. */
export async function unlockAccountKeys(
  credential?: PasskeyCredentialMetadata,
): Promise<AccountSessions> {
  assertPasskeyOrigin()
  const result = await getPasskeyPrfOutput({ rpId: env.VITE_RP_ID, credential })
  const sessions = deriveAccountKeys(result.prfOutput)
  zero(result.prfOutput)
  return sessions
}
