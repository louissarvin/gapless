import { hashTypedData, isAddressEqual, keccak256, recoverTypedDataAddress, toBytes, type Address, type Hex } from 'viem';
import { readContract } from 'viem/actions';
import { IGaplessFactoryAbi } from '../../abi/index.ts';
import { MONAD_CHAIN_ID } from '../../lib/addresses.ts';
import type { ChainClient } from '../../lib/sendQueue.ts';

/** INTERFACES.md §5.2 and Constants.CREATE_ACCOUNT_TYPEHASH (C5 CR22 added maxNotionalPerDay). */
export const CREATE_ACCOUNT_TYPE =
  'CreateAccount(address owner,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 deadline)';
export const CREATE_ACCOUNT_TYPEHASH = keccak256(toBytes(CREATE_ACCOUNT_TYPE));
export const FACTORY_DOMAIN_NAME = 'GaplessFactory';
export const FACTORY_DOMAIN_VERSION = '1';

export const CREATE_ACCOUNT_TYPES = {
  CreateAccount: [
    { name: 'owner', type: 'address' },
    { name: 'key', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'maxNotional', type: 'uint128' },
    { name: 'maxNotionalPerDay', type: 'uint128' },
    { name: 'deadline', type: 'uint256' }
  ]
} as const;

/** GaplessTypes.OperatorGrant (C5 CR21). Field names match the ABI tuple, so viem encodes it by name. */
export interface OperatorGrant {
  key: Address;
  expiry: bigint;
  maxNotionalPerTradeCNS: bigint;
  /** N-03 leaky bucket over 1 day; 0 blocks operator trades and buys. */
  maxNotionalPerDayCNS: bigint;
}

export function createAccountDomain(factory: Address) {
  return { name: FACTORY_DOMAIN_NAME, version: FACTORY_DOMAIN_VERSION, chainId: MONAD_CHAIN_ID, verifyingContract: factory } as const;
}

/** secp256k1 n / 2: OZ ECDSA rejects s above it (malleable twin) and v other than 27 or 28. */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/** Fails fast on signatures the factory's OZ ECDSA would reject onchain. Expects 65-byte hex. */
export function isCanonicalSig(sig: Hex): boolean {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) return false;
  const s = BigInt(`0x${sig.slice(66, 130)}`);
  const v = Number.parseInt(sig.slice(130, 132), 16);
  return s <= SECP256K1_HALF_N && (v === 27 || v === 28);
}

interface CreateAccountInput {
  factory: Address;
  owner: Address;
  grant: OperatorGrant;
  deadline: bigint;
}

function createAccountTypedData(input: CreateAccountInput) {
  return {
    domain: createAccountDomain(input.factory),
    types: CREATE_ACCOUNT_TYPES,
    primaryType: 'CreateAccount',
    message: {
      owner: input.owner,
      key: input.grant.key,
      expiry: input.grant.expiry,
      maxNotional: input.grant.maxNotionalPerTradeCNS,
      maxNotionalPerDay: input.grant.maxNotionalPerDayCNS,
      deadline: input.deadline
    }
  } as const;
}

/** The digest GaplessFactory.createAccountFor checks (`_hashTypedDataV4`). */
export function createAccountDigest(input: CreateAccountInput): Hex {
  return hashTypedData(createAccountTypedData(input));
}

/**
 * Offchain check of the owner's CreateAccount signature (EOA only; Mera owners are EOAs).
 * A signature for another chain id, factory or grant recovers a different address and fails.
 */
export async function verifyCreateAccountSig(input: CreateAccountInput & { sig: Hex }): Promise<boolean> {
  if (!isCanonicalSig(input.sig)) return false;
  try {
    const signer = await recoverTypedDataAddress({ ...createAccountTypedData(input), signature: input.sig });
    return isAddressEqual(signer, input.owner);
  } catch {
    return false;
  }
}

/** Boot check: the deployed factory signs the same typed data this file encodes. Returns mismatches. */
export async function checkFactoryDomain(client: ChainClient, factory: Address): Promise<string[]> {
  const [domain, typehash] = await Promise.all([
    readContract(client, { address: factory, abi: IGaplessFactoryAbi, functionName: 'eip712Domain' }),
    readContract(client, { address: factory, abi: IGaplessFactoryAbi, functionName: 'CREATE_ACCOUNT_TYPEHASH' })
  ]);
  const [fields, name, version, chainId, verifyingContract, salt, extensions] = domain;
  const problems: string[] = [];
  // ERC-5267: 0x0f = name, version, chainId, verifyingContract; no salt or extensions in the signed domain.
  if (fields !== '0x0f' || BigInt(salt) !== 0n || extensions.length > 0) problems.push('fields');
  if (name !== FACTORY_DOMAIN_NAME) problems.push('name');
  if (version !== FACTORY_DOMAIN_VERSION) problems.push('version');
  if (chainId !== BigInt(MONAD_CHAIN_ID)) problems.push('chainId');
  if (!isAddressEqual(verifyingContract, factory)) problems.push('verifyingContract');
  if (typehash !== CREATE_ACCOUNT_TYPEHASH) problems.push('CREATE_ACCOUNT_TYPEHASH');
  return problems;
}
