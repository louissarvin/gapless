import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { decodeFunctionData, domainSeparator, encodeFunctionResult, getAddress, keccak256, parseEther, parseGwei, toBytes, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { IGaplessFactoryAbi } from '../src/abi/index.ts';
import type { MonadPublicClient } from '../src/lib/chain.ts';
import { migrate, openDb, type Database } from '../src/lib/db.ts';
import { billedPriceWei, feeQuote, GAS, maxCostWei, RELAY_GAS_MEASURED } from '../src/lib/gas.ts';
import { SendQueue } from '../src/lib/sendQueue.ts';
import { SpendGovernor } from '../src/lib/spendGovernor.ts';
import { buildRelayApp } from '../src/relay/app.ts';
import { RELAY_MIGRATIONS } from '../src/relay/migrations.ts';
import {
  CREATE_ACCOUNT_TYPE,
  CREATE_ACCOUNT_TYPEHASH,
  CREATE_ACCOUNT_TYPES,
  checkFactoryDomain,
  createAccountDigest,
  createAccountDomain,
  isCanonicalSig,
  verifyCreateAccountSig
} from '../src/relay/sponsor/eip712.ts';
import { SponsorLedger } from '../src/relay/sponsor/ledger.ts';
import { SponsorService, sponsorGrantPolicy } from '../src/relay/sponsor/service.ts';
import { captureLogger, FakeChain, TEST_KEYS } from './fakeChain.ts';
import { FACTORY, FakeOnboarding } from './fakeGapless.ts';
import { APP_ORIGIN, relayEnv } from './helpers.ts';

const relayAccount = privateKeyToAccount(TEST_KEYS.relay);
const owner = privateKeyToAccount(TEST_KEYS.owner);
const other = privateKeyToAccount(TEST_KEYS.other);
const OPERATOR: Address = '0x00000000000000000000000000000000000000a1';
const CLONE: Address = getAddress('0x00000000000000000000000000000000000c1013');
const CLONE2: Address = getAddress('0x00000000000000000000000000000000000c1014');
const NOW_MS = Date.UTC(2026, 9, 5, 12);
const NOW_S = BigInt(NOW_MS / 1000);
const TOKEN = 'i'.repeat(40);

let apps: FastifyInstance[] = [];
let dirs: string[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  apps = [];
  dirs = [];
});

interface SetupOpts {
  env?: Record<string, string>;
  db?: Database;
  relayBalance?: bigint;
  fetchKeeper?: typeof fetch;
  sponsor?: boolean;
  /** Fund both predicted clones with the Perpl minimum before create (H-2 fund-first). Default true. */
  fundClones?: boolean;
}

async function setup(opts: SetupOpts = {}) {
  const chain = new FakeChain();
  chain.balance(relayAccount.address, opts.relayBalance ?? parseEther('1.3'));
  const fx = new FakeOnboarding();
  fx.install(chain);
  fx.accounts.set(owner.address.toLowerCase(), CLONE);
  fx.accounts.set(other.address.toLowerCase(), CLONE2);
  if (opts.fundClones !== false) {
    fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    fx.walletAusd.set(CLONE2.toLowerCase(), 10_000_000n);
  }
  // Emulate tx effects: create deploys the clone; sweep opens the Perpl account.
  chain.onSent = (tx) => {
    if (tx.to?.toLowerCase() === FACTORY.toLowerCase()) {
      const { args } = decodeFunctionData({ abi: IGaplessFactoryAbi, data: tx.data! });
      const clone = fx.accounts.get(String(args![0]).toLowerCase())!.toLowerCase();
      fx.deployed.add(clone);
      fx.owners.set(clone, args![0] as Address);
    }
    if (tx.to && fx.deployed.has(tx.to.toLowerCase()) && tx.data && tx.data !== '0x') {
      fx.perplAccountId.set(tx.to.toLowerCase(), 77n);
      fx.perplBalance.set(77n, fx.walletAusd.get(tx.to.toLowerCase()) ?? 0n);
    }
    if (tx.value > 0n && tx.to) chain.balance(tx.to, tx.value);
  };
  const env = relayEnv({
    SPONSOR_ENABLED: 'true',
    RELAY_KEY: TEST_KEYS.relay,
    GAPLESS_FACTORY_ADDRESS: FACTORY,
    DRIP_ALLOWLIST: OPERATOR,
    RELAY_INTERNAL_TOKEN: TOKEN,
    KEEPER_INTERNAL_URL: 'http://keeper.internal:3702',
    SPONSOR_ALLOWLIST_ONLY: 'false',
    ...opts.env
  });
  const db = opts.db ?? openDb(':memory:');
  migrate(db, RELAY_MIGRATIONS);
  const { log, events, lines } = captureLogger();
  const clock = { t: NOW_MS };
  const client = chain.client();
  const governor = new SpendGovernor(db, relayAccount.address, { capWei: env.RELAY_DAILY_SPEND_CAP_WEI, hotReserveWei: 0n, alertWei: env.RELAY_DAILY_SPEND_CAP_WEI }, log, () => clock.t);
  // Each wait advances one block and 150 ms, so reserve-window waits finish deterministically.
  const sleep = async () => {
    chain.head += 1n;
    clock.t += 150;
  };
  const queue = new SendQueue({ client, account: relayAccount, governor, log, sleep, now: () => clock.t, strictReserveSpacing: env.STRICT_RESERVE_SPACING });
  const ledger = new SponsorLedger(
    db,
    {
      createsPerIpPerDay: env.CREATES_PER_IP_PER_DAY,
      dailyCreateCap: env.DAILY_CREATE_CAP,
      totalCreateCap: env.TOTAL_CREATE_CAP,
      activationsPerIpPerDay: env.ACTIVATIONS_PER_IP_PER_DAY,
      dailyActivationCap: env.DAILY_ACTIVATION_CAP,
      demoOwner: env.SPONSOR_DEMO_OWNER?.toLowerCase()
    },
    () => clock.t
  );
  const sponsor = new SponsorService({
    client,
    queue,
    ledger,
    factory: FACTORY,
    dripWei: env.DRIP_WEI,
    dripAllowlist: new Set(env.DRIP_ALLOWLIST.map((a) => a.toLowerCase())),
    ownerAllowlistOnly: env.SPONSOR_ALLOWLIST_ONLY,
    ownerAllowlist: new Set(env.SPONSOR_OWNER_ALLOWLIST.map((a) => a.toLowerCase())),
    grantPolicy: sponsorGrantPolicy(env),
    log,
    now: () => clock.t,
    sleep
  });
  const app = await buildRelayApp({
    env,
    log,
    db,
    client: client as unknown as MonadPublicClient,
    readHead: async () => ({ number: chain.head, timestamp: NOW_S }),
    resolveAccountId: async () => null,
    sponsor: opts.sponsor === false ? null : sponsor,
    fetchKeeper: opts.fetchKeeper,
    now: () => clock.t
  });
  apps.push(app);
  return { app, chain, fx, db, events, lines, clock, ledger, governor, queue };
}

interface GrantOver {
  key?: Address;
  expiry?: bigint;
  maxNotionalPerTradeCNS?: bigint;
  maxNotionalPerDayCNS?: bigint;
}

/** Canary grant (CANARY_PARAMS.md): 25 AUSD per trade, 100 AUSD per day, 4 h. */
async function signCreate(signer: ReturnType<typeof privateKeyToAccount> = owner, over: { chainId?: number; deadline?: bigint } & GrantOver = {}) {
  const grant = {
    key: over.key ?? OPERATOR,
    expiry: over.expiry ?? NOW_S + 14_400n,
    maxNotionalPerTradeCNS: over.maxNotionalPerTradeCNS ?? 25_000_000n,
    maxNotionalPerDayCNS: over.maxNotionalPerDayCNS ?? 100_000_000n
  };
  const deadline = over.deadline ?? NOW_S + 600n;
  const domain = { ...createAccountDomain(FACTORY), ...(over.chainId ? { chainId: over.chainId } : {}) };
  const sig = await signer.signTypedData({
    domain,
    types: CREATE_ACCOUNT_TYPES,
    primaryType: 'CreateAccount',
    message: {
      owner: signer.address,
      key: grant.key,
      expiry: grant.expiry,
      maxNotional: grant.maxNotionalPerTradeCNS,
      maxNotionalPerDay: grant.maxNotionalPerDayCNS,
      deadline
    }
  });
  return {
    owner: signer.address,
    grant: {
      key: grant.key,
      expiry: grant.expiry.toString(),
      maxNotionalPerTradeCNS: grant.maxNotionalPerTradeCNS.toString(),
      maxNotionalPerDayCNS: grant.maxNotionalPerDayCNS.toString()
    },
    deadline: deadline.toString(),
    sig
  };
}

const post = (app: FastifyInstance, url: string, payload: unknown, ip = '203.0.113.7', origin = APP_ORIGIN) =>
  app.inject({ method: 'POST', url, payload: payload as object, remoteAddress: ip, headers: { origin, 'content-type': 'application/json' } });

describe('EIP-712 CreateAccount (frozen typed data)', () => {
  test('typehash is keccak of the frozen type string', () => {
    expect(CREATE_ACCOUNT_TYPE).toBe(
      'CreateAccount(address owner,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 deadline)'
    );
    expect(CREATE_ACCOUNT_TYPEHASH).toBe(keccak256(toBytes(CREATE_ACCOUNT_TYPE)));
  });

  test('boot check compares the deployed domain and typehash', async () => {
    const chain = new FakeChain();
    const fx = new FakeOnboarding();
    fx.install(chain);
    expect(await checkFactoryDomain(chain.client(), FACTORY)).toEqual([]);
    fx.domain = { ...fx.domain, name: 'Other', typehash: `0x${'00'.repeat(32)}` as Hex };
    expect(await checkFactoryDomain(chain.client(), FACTORY)).toEqual(['name', 'CREATE_ACCOUNT_TYPEHASH']);
  });

  test('valid signature: sponsored createAccountFor with the explicit gas limit', async () => {
    const { app, chain } = await setup();
    const res = await post(app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ owner: owner.address, account: CLONE, status: 'created' });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.gas).toBe(GAS.createAccountFor);
    const { functionName, args } = decodeFunctionData({ abi: IGaplessFactoryAbi, data: chain.sent[0]!.data! });
    expect(functionName).toBe('createAccountFor');
    expect(args![0]).toBe(owner.address);
  });

  test('wrong chain id, wrong owner or tampered grant: 400 BAD_SIGNATURE, nothing sent or booked', async () => {
    const { app, chain, ledger } = await setup();
    const wrongChain = await signCreate(owner, { chainId: 1 });
    expect((await post(app, '/sponsor/create', wrongChain)).json().error.code).toBe('BAD_SIGNATURE');
    const tampered = { ...(await signCreate()), grant: { key: other.address, expiry: (NOW_S + 3_600n).toString(), maxNotionalPerTradeCNS: '1', maxNotionalPerDayCNS: '1' } };
    expect((await post(app, '/sponsor/create', tampered)).json().error.code).toBe('BAD_SIGNATURE');
    // N-03: the daily budget is signed; raising it alone breaks the signature.
    const signed = await signCreate();
    const raisedDay = { ...signed, grant: { ...signed.grant, maxNotionalPerDayCNS: '99000000' } };
    expect((await post(app, '/sponsor/create', raisedDay)).json().error.code).toBe('BAD_SIGNATURE');
    const notOwner = { ...(await signCreate(other)), owner: owner.address };
    expect((await post(app, '/sponsor/create', notOwner)).json().error.code).toBe('BAD_SIGNATURE');
    expect(chain.sent).toHaveLength(0);
    expect(ledger.getCreate(owner.address)).toBeNull();
  });

  test('expired or too-far deadlines are refused', async () => {
    const { app } = await setup();
    const expired = await signCreate(owner, { deadline: NOW_S - 1n });
    const tooClose = await signCreate(owner, { deadline: NOW_S + 30n });
    const tooFar = await signCreate(owner, { deadline: NOW_S + 2n * 86_400n });
    expect((await post(app, '/sponsor/create', expired)).json().error.code).toBe('SIG_EXPIRED');
    expect((await post(app, '/sponsor/create', tooClose)).json().error.code).toBe('SIG_EXPIRED');
    expect((await post(app, '/sponsor/create', tooFar)).json().error.code).toBe('DEADLINE_TOO_FAR');
  });

  test('replay is idempotent: the stored result comes back, nothing is sent twice', async () => {
    const { app, chain } = await setup();
    const body = await signCreate();
    const first = await post(app, '/sponsor/create', body);
    const second = await post(app, '/sponsor/create', body);
    const fresh = await post(app, '/sponsor/create', await signCreate(owner, { deadline: NOW_S + 900n }));
    expect(second.statusCode).toBe(200);
    expect(second.json().data).toEqual(first.json().data);
    expect(fresh.json().data.txHash).toBe(first.json().data.txHash);
    expect(chain.sent).toHaveLength(1);
  });

  test('an account created elsewhere is 409 and frees the cap slot', async () => {
    const { app, fx, chain } = await setup({ env: { CREATES_PER_IP_PER_DAY: '1' } });
    fx.deployed.add(CLONE.toLowerCase());
    expect((await post(app, '/sponsor/create', await signCreate())).json().error.code).toBe('ACCOUNT_EXISTS');
    expect((await post(app, '/sponsor/create', await signCreate(other))).statusCode).toBe(200);
    expect(chain.sent).toHaveLength(1);
  });

  test('concurrent identical requests send once', async () => {
    const { app, chain } = await setup();
    const body = await signCreate();
    const results = await Promise.all([post(app, '/sponsor/create', body), post(app, '/sponsor/create', body), post(app, '/sponsor/create', body)]);
    // Each one either sees the claim in progress (409) or the stored result.
    for (const r of results) expect([200, 409]).toContain(r.statusCode);
    const hashes = new Set(results.filter((r) => r.statusCode === 200).map((r) => r.json().data.txHash));
    expect(hashes.size).toBe(1);
    expect(chain.sent).toHaveLength(1);
  });
});

/**
 * Pinned from the real GaplessFactory (C5) by an out-of-tree forge test that imports contract/src read-only
 * (chainId 143, factory deployed at the forge default address, vm.sign with key 0xa11ce), and recomputed
 * independently with `cast keccak` and `cast abi-encode`. Any drift in the type string, field order or domain fails here.
 */
const FORGE_PARITY = {
  factory: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as Address,
  ownerKey: '0x00000000000000000000000000000000000000000000000000000000000a11ce' as Hex,
  owner: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as Address,
  grant: { key: '0x00000000000000000000000000000000000000A1' as Address, expiry: 1_791_223_200n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n },
  deadline: 1_791_202_200n,
  typehash: '0xf3634aa5071693062095af0226bf09020881caa8b6fc7e0da4b667dbe63b492b',
  domainSeparator: '0xeba9fc6d13d2ffe348bcf5cd4b6b1bbe426d2649990ef3995fa337ae008c4fd3',
  digest: '0x469fa01bfe8f40d06670b52b3abe494c4b85da17b9cc5d0eee9341b20885a2a7',
  sig: '0x199b32e85003eae4ffce21360e0d44e143b556c39916c646dc884dbf17659bd9735cf796965257c4a3f1f318ece570f7c02b5f929cf3665b1569c1086e96e4fd1b' as Hex
} as const;

describe('CreateAccount parity with the C5 factory (forge and cast)', () => {
  test('typehash, domain separator and digest match the contract', () => {
    const f = FORGE_PARITY;
    expect(CREATE_ACCOUNT_TYPEHASH).toBe(f.typehash);
    expect(domainSeparator({ domain: createAccountDomain(f.factory) })).toBe(f.domainSeparator);
    expect(createAccountDigest({ factory: f.factory, owner: f.owner, grant: f.grant, deadline: f.deadline })).toBe(f.digest);
  });

  test('viem signs the same bytes forge signed, and the relay accepts the forge signature', async () => {
    const f = FORGE_PARITY;
    const signer = privateKeyToAccount(f.ownerKey);
    expect(signer.address).toBe(f.owner);
    const sig = await signer.signTypedData({
      domain: createAccountDomain(f.factory),
      types: CREATE_ACCOUNT_TYPES,
      primaryType: 'CreateAccount',
      message: { owner: f.owner, key: f.grant.key, expiry: f.grant.expiry, maxNotional: f.grant.maxNotionalPerTradeCNS, maxNotionalPerDay: f.grant.maxNotionalPerDayCNS, deadline: f.deadline }
    });
    expect(sig).toBe(f.sig);
    expect(await verifyCreateAccountSig({ factory: f.factory, owner: f.owner, grant: f.grant, deadline: f.deadline, sig: f.sig })).toBe(true);
    const raised = { ...f.grant, maxNotionalPerDayCNS: f.grant.maxNotionalPerDayCNS + 1n };
    expect(await verifyCreateAccountSig({ factory: f.factory, owner: f.owner, grant: raised, deadline: f.deadline, sig: f.sig })).toBe(false);
  });

  test('createAccountFor carries the signed 4-field grant', async () => {
    const { app, chain } = await setup();
    expect((await post(app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    const { args } = decodeFunctionData({ abi: IGaplessFactoryAbi, data: chain.sent[0]!.data! });
    expect(args![1]).toEqual({ key: getAddress(OPERATOR), expiry: NOW_S + 14_400n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n });
  });

  test('boot check also rejects a domain with other fields or extensions', async () => {
    const chain = new FakeChain();
    const fx = new FakeOnboarding();
    fx.install(chain);
    fx.domain = { ...fx.domain, fields: '0x1f', extensions: [1n] };
    expect(await checkFactoryDomain(chain.client(), FACTORY)).toEqual(['fields']);
  });
});

describe('sponsored grant policy (SA2 N-03)', () => {
  const policyCases: [string, GrantOver][] = [
    ['expiry past the 6 h policy', { expiry: NOW_S + 21_601n }],
    ['expiry in under 10 min', { expiry: NOW_S + 599n }],
    ['per-trade above 25 AUSD', { maxNotionalPerTradeCNS: 25_000_001n }],
    ['daily budget above 100 AUSD', { maxNotionalPerDayCNS: 100_000_001n }],
    ['zero daily budget (operator could not trade)', { maxNotionalPerDayCNS: 0n }],
    ['zero per-trade cap', { maxNotionalPerTradeCNS: 0n }]
  ];
  for (const [name, over] of policyCases) {
    test(`${name}: 400 GRANT_OUT_OF_POLICY, nothing sent or booked`, async () => {
      const { app, chain, ledger } = await setup();
      const res = await post(app, '/sponsor/create', await signCreate(owner, over));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('GRANT_OUT_OF_POLICY');
      expect(chain.sent).toHaveLength(0);
      expect(ledger.getCreate(owner.address)).toBeNull();
    });
  }

  test('limits come from env and the edges pass', async () => {
    const { app } = await setup({ env: { SPONSOR_GRANT_MAX_PER_DAY_CNS: '200000000', SPONSOR_GRANT_MAX_TTL_S: '28800' } });
    const res = await post(app, '/sponsor/create', await signCreate(owner, { expiry: NOW_S + 28_800n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 200_000_000n }));
    expect(res.statusCode).toBe(200);
  });

  test('a zero key grants nothing and is sponsored as is', async () => {
    const { app } = await setup();
    const zero = '0x0000000000000000000000000000000000000000' as Address;
    const res = await post(app, '/sponsor/create', await signCreate(owner, { key: zero, expiry: 0n, maxNotionalPerTradeCNS: 0n, maxNotionalPerDayCNS: 0n }));
    expect(res.statusCode).toBe(200);
  });

  test('schema: the daily budget is required and must fit uint128', async () => {
    const { app } = await setup();
    const body = await signCreate();
    const { maxNotionalPerDayCNS: _drop, ...threeField } = body.grant;
    expect((await post(app, '/sponsor/create', { ...body, grant: threeField })).json().error.code).toBe('VALIDATION_ERROR');
    const wide = { ...body, grant: { ...body.grant, maxNotionalPerDayCNS: (1n << 128n).toString() } };
    expect((await post(app, '/sponsor/create', wide)).json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('sponsor caps (sqlite, reserve then settle)', () => {
  test('per-IP day cap', async () => {
    const { app } = await setup({ env: { CREATES_PER_IP_PER_DAY: '1' } });
    expect((await post(app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    const capped = await post(app, '/sponsor/create', await signCreate(other));
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('SPONSOR_CAP');
    expect((await post(app, '/sponsor/create', await signCreate(other), '198.51.100.9')).statusCode).toBe(200);
  });

  test('lifetime cap survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gapless-relay-'));
    dirs.push(dir);
    const path = join(dir, 'relay.sqlite');
    const first = await setup({ db: openDb(path), env: { TOTAL_CREATE_CAP: '1' } });
    expect((await post(first.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    const restarted = await setup({ db: openDb(path), env: { TOTAL_CREATE_CAP: '1' } });
    const res = await post(restarted.app, '/sponsor/create', await signCreate(other), '198.51.100.9');
    expect(res.json().error.code).toBe('SPONSOR_CAP');
    expect(restarted.chain.sent).toHaveLength(0);
  });

  test('global daily MON cap: refused before sending, and the slot is released', async () => {
    // One wei under the create's reservation (gas x maxFee at the 100 gwei floor).
    const cap = maxCostWei(GAS.createAccountFor, feeQuote(parseGwei('100'))) - 1n;
    const { app, chain, ledger } = await setup({ env: { RELAY_DAILY_SPEND_CAP_WEI: cap.toString() } });
    const res = await post(app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('BUDGET_EXHAUSTED');
    expect(chain.sent).toHaveLength(0);
    expect(ledger.getCreate(owner.address)?.status).toBe('rejected');
  });

  test('feature flag off: 503, no chain reads', async () => {
    const { app, chain } = await setup({ env: { SPONSOR_ENABLED: 'false' } });
    const res = await post(app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SPONSOR_DISABLED');
    expect(chain.methods).toHaveLength(0);
  });

  test('foreign Origin is 403 and malformed bodies are 400', async () => {
    const { app } = await setup();
    expect((await post(app, '/sponsor/create', await signCreate(), '203.0.113.7', 'https://evil.example')).statusCode).toBe(403);
    expect((await post(app, '/activate', { account: CLONE, extra: 1 })).statusCode).toBe(400);
    expect((await post(app, '/sponsor/create', { ...(await signCreate()), sig: '0x1234' })).statusCode).toBe(400);
  });
});

describe('/activate', () => {
  async function created(opts: SetupOpts = {}) {
    const s = await setup(opts);
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 3_600n, maxNotionalPerTradeCNS: 50_000_000n, maxNotionalPerDayCNS: 100_000_000n });
    return s;
  }

  test('sweeps, then drips 0.5 MON to the onchain operator as a spaced emptying tx, then waits 3 blocks', async () => {
    const { app, chain, fx } = await created();
    fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    const res = await post(app, '/activate', { account: CLONE });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ account: CLONE, perplAccountId: '77', dripSkipped: null });
    expect(data.drip).toMatchObject({ to: getAddress(OPERATOR), wei: parseEther('0.5').toString() });
    const [create, sweep, drip] = chain.sent;
    expect(sweep!.to?.toLowerCase()).toBe(CLONE.toLowerCase());
    expect(drip!.to?.toLowerCase()).toBe(OPERATOR.toLowerCase());
    expect(drip!.value).toBe(parseEther('0.5'));
    expect(drip!.gas).toBe(GAS.transfer);
    // Relay key under 10 MON: gas-only sends need no spacing (M-2); the drip (value) is an emptying tx.
    expect(sweep!.sentAtHead).toBeGreaterThanOrEqual(create!.sentAtHead);
    expect(drip!.sentAtHead - (sweep!.sentAtHead + 1n)).toBeGreaterThanOrEqual(3n);
    expect(chain.head).toBeGreaterThanOrEqual(BigInt(data.drip.blockNumber) + 3n);

    const again = await post(app, '/activate', { account: CLONE });
    expect(again.json().data).toEqual(data);
    expect(chain.sent).toHaveLength(3);
  });

  test('drips only allowlisted operators, once per operator', async () => {
    const s = await created({ env: { DRIP_ALLOWLIST: '0x00000000000000000000000000000000000000b2' } });
    s.fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    const res = await post(s.app, '/activate', { account: CLONE });
    expect(res.json().data).toMatchObject({ drip: null, dripSkipped: 'not_allowlisted' });
    expect(s.chain.sent.some((t) => t.value > 0n)).toBe(false);

    const t = await created();
    t.fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    expect((await post(t.app, '/activate', { account: CLONE })).json().data.drip).not.toBeNull();
    // A second relay-created account pointing at the same operator gets nothing.
    expect((await post(t.app, '/sponsor/create', await signCreate(other))).statusCode).toBe(200);
    t.fx.perplAccountId.set(CLONE2.toLowerCase(), 78n);
    t.fx.perplBalance.set(78n, 10_000_000n);
    t.fx.operator.set(CLONE2.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 3_600n, maxNotionalPerTradeCNS: 1n, maxNotionalPerDayCNS: 100_000_000n });
    t.chain.balance(OPERATOR, 0n);
    expect((await post(t.app, '/activate', { account: CLONE2 })).json().data.dripSkipped).toBe('already_dripped');
  });

  test('unfunded accounts are refused without spending, and can retry once funded', async () => {
    const { app, chain, fx } = await created();
    fx.walletAusd.set(CLONE.toLowerCase(), 5_000_000n);
    const res = await post(app, '/activate', { account: CLONE });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_FUNDED');
    expect(chain.sent).toHaveLength(1);
    fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    expect((await post(app, '/activate', { account: CLONE })).statusCode).toBe(200);
  });

  test('non-accounts are 404', async () => {
    const { app } = await setup();
    const res = await post(app, '/activate', { account: '0x000000000000000000000000000000000000dEaD' });
    expect(res.statusCode).toBe(404);
  });
});

describe('/sigma-refresh forwarding', () => {
  /** CLONE as a deployed account with Perpl account 77 and an open position on perp 1. */
  function eligible(fx: FakeOnboarding, perps: number[] = [1]) {
    fx.deployed.add(CLONE.toLowerCase());
    fx.perplAccountId.set(CLONE.toLowerCase(), 77n);
    for (const p of perps) fx.positions.set(`${p}:77`, 5n);
  }

  function keeperFake(status: number) {
    const calls: { url: string; auth: string | null; body: string }[] = [];
    const f = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), body: String(init.body) });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test('forwards with the internal token, at most once per 60 s per perp', async () => {
    const k = keeperFake(202);
    const { app, clock, fx } = await setup({ fetchKeeper: k.f });
    eligible(fx, [1, 10]);
    const first = await post(app, '/sigma-refresh', { perpId: 1, account: CLONE });
    expect(first.statusCode).toBe(202);
    expect(k.calls).toEqual([{ url: 'http://keeper.internal:3702/sigma-refresh', auth: `Bearer ${TOKEN}`, body: '{"perpId":1}' }]);
    const second = await post(app, '/sigma-refresh', { perpId: 1, account: CLONE }, '198.51.100.20');
    expect(second.statusCode).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
    // M-5 PoC: another market is not blocked by a held perp-1 slot (was 429 for 60 s).
    expect((await post(app, '/sigma-refresh', { perpId: 10, account: CLONE }, '198.51.100.21')).statusCode).toBe(202);
    clock.t += 60_000;
    expect((await post(app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(202);
    expect(k.calls).toHaveLength(3);
  });

  test('a refusal does not use up the slot; no keeper configured is 503', async () => {
    const k = keeperFake(404);
    const { app, fx } = await setup({ fetchKeeper: k.f });
    eligible(fx, [99]);
    expect((await post(app, '/sigma-refresh', { perpId: 99, account: CLONE })).statusCode).toBe(404);
    expect((await post(app, '/sigma-refresh', { perpId: 99, account: CLONE })).statusCode).toBe(404);
    const none = await setup({ env: { KEEPER_INTERNAL_URL: '' } });
    expect((await post(none.app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(503);
  });

  test('M-5: demand must come from a Gapless account with an open position on that perp', async () => {
    const k = keeperFake(202);
    const { app, fx } = await setup({ fetchKeeper: k.f });
    // PoC: a bare forged request with only perpId was 202.
    expect((await post(app, '/sigma-refresh', { perpId: 1 })).statusCode).toBe(400);
    const notAccount = await post(app, '/sigma-refresh', { perpId: 1, account: owner.address });
    expect(notAccount.statusCode).toBe(403);
    expect(notAccount.json().error.code).toBe('NOT_ELIGIBLE');
    fx.deployed.add(CLONE.toLowerCase());
    expect((await post(app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(403);
    fx.perplAccountId.set(CLONE.toLowerCase(), 77n);
    expect((await post(app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(403);
    fx.positions.set('1:77', 3n);
    expect((await post(app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(202);
    expect(k.calls).toHaveLength(1);
  });

  test('M-5: accepted refreshes are capped per account per day', async () => {
    const k = keeperFake(202);
    const { app, fx, clock } = await setup({ fetchKeeper: k.f, env: { SIGMA_REFRESH_PER_ACCOUNT_PER_DAY: '2' } });
    eligible(fx);
    for (let i = 0; i < 2; i++) {
      expect((await post(app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(202);
      clock.t += 60_000;
    }
    const capped = await post(app, '/sigma-refresh', { perpId: 1, account: CLONE });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('SIGMA_REFRESH_CAP');
    expect(k.calls).toHaveLength(2);
  });
});

describe('SE3-M3: sigma refresh demand in allowlist mode', () => {
  test('PoC: self-made accounts with a position cannot spend the 12 daily posts; the sponsored account still can', async () => {
    const k = { calls: 0 };
    const fetchKeeper = (async () => {
      k.calls++;
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const s = await setup({ fetchKeeper, env: { SPONSOR_ALLOWLIST_ONLY: 'true', SPONSOR_DEMO_OWNER: owner.address } });
    // Two accounts the attacker created through the permissionless factory, each with the Perpl minimum and 1 lot.
    const attacker = [CLONE2, '0x00000000000000000000000000000000000acc02' as const];
    attacker.forEach((acct, i) => {
      s.fx.deployed.add(acct.toLowerCase());
      s.fx.owners.set(acct.toLowerCase(), other.address);
      s.fx.perplAccountId.set(acct.toLowerCase(), 90n + BigInt(i));
      s.fx.positions.set(`1:${90 + i}`, 1n);
    });
    for (const acct of attacker) {
      const res = await post(s.app, '/sigma-refresh', { perpId: 1, account: acct });
      // Was 202 (6 per account, 12 posts gone by about 5 h UTC).
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_ELIGIBLE');
    }
    expect(k.calls).toBe(0);
    // The relay-created demo account with an open position is served.
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    s.fx.perplAccountId.set(CLONE.toLowerCase(), 77n);
    s.fx.positions.set('1:77', 3n);
    expect((await post(s.app, '/sigma-refresh', { perpId: 1, account: CLONE })).statusCode).toBe(202);
    expect(k.calls).toBe(1);
  });
});

describe('H-2: who gets sponsored', () => {
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  test('PoC: six fresh attacker owners cannot exhaust creates; the demo owner still gets one (was 200 x6 then 429)', async () => {
    const s = await setup({ env: { SPONSOR_ALLOWLIST_ONLY: 'true', SPONSOR_DEMO_OWNER: owner.address } });
    for (let i = 0; i < 6; i++) {
      const attacker = privateKeyToAccount(generatePrivateKey());
      const clone = getAddress(`0x${(0xbad00 + i).toString(16).padStart(40, '0')}`);
      s.fx.accounts.set(attacker.address.toLowerCase(), clone);
      s.fx.walletAusd.set(clone.toLowerCase(), 10_000_000n);
      const res = await post(s.app, '/sponsor/create', await signCreate(attacker), i < 5 ? '203.0.113.10' : '2001:db8:1:2::99');
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_ALLOWLISTED');
    }
    expect(s.chain.sent).toHaveLength(0);
    expect((await post(s.app, '/sponsor/create', await signCreate(), '198.51.100.7')).statusCode).toBe(200);
    expect(s.governor.usage().committedWei).toBeLessThan(parseEther('0.2'));
  });

  test('allowlist mode: listed owners only', async () => {
    const s = await setup({ env: { SPONSOR_ALLOWLIST_ONLY: 'true', SPONSOR_OWNER_ALLOWLIST: other.address } });
    expect((await post(s.app, '/sponsor/create', await signCreate())).json().error.code).toBe('NOT_ALLOWLISTED');
    expect((await post(s.app, '/sponsor/create', await signCreate(other))).statusCode).toBe(200);
  });

  test('fund first: the predicted account must already hold the Perpl minimum; nothing is claimed or sent', async () => {
    const s = await setup({ fundClones: false });
    s.fx.walletAusd.set(CLONE.toLowerCase(), 9_999_999n);
    const res = await post(s.app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOT_FUNDED');
    expect(s.ledger.getCreate(owner.address)).toBeNull();
    expect(s.chain.sent).toHaveLength(0);
    s.fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
  });

  test('the demo owner has a reserved slot outside the total and daily caps', async () => {
    const third = privateKeyToAccount(generatePrivateKey());
    const CLONE3 = getAddress('0x00000000000000000000000000000000000c1015');
    const s = await setup({ env: { TOTAL_CREATE_CAP: '2', DAILY_CREATE_CAP: '1', SPONSOR_DEMO_OWNER: owner.address } });
    s.fx.accounts.set(third.address.toLowerCase(), CLONE3);
    s.fx.walletAusd.set(CLONE3.toLowerCase(), 10_000_000n);
    expect((await post(s.app, '/sponsor/create', await signCreate(other))).statusCode).toBe(200);
    expect((await post(s.app, '/sponsor/create', await signCreate(third), '198.51.100.3')).json().error.code).toBe('SPONSOR_CAP');
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
  });

  test('front-run after our simulation: the revert is recorded as FRONT_RUN', async () => {
    const s = await setup();
    // isAccount flips to true once our tx is out, as if the attacker's copy landed first.
    s.chain.handlers.unshift((c) => {
      if (c.to.toLowerCase() !== FACTORY.toLowerCase() || s.chain.sent.length === 0) return undefined;
      const { functionName } = decodeFunctionData({ abi: IGaplessFactoryAbi, data: c.data });
      return functionName === 'isAccount' ? encodeFunctionResult({ abi: IGaplessFactoryAbi, functionName: 'isAccount', result: true }) : undefined;
    });
    s.chain.sendQueue.push({ kind: 'revert' });
    const res = await post(s.app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(502);
    expect(s.ledger.getCreate(owner.address)).toMatchObject({ status: 'failed', error_code: 'FRONT_RUN' });
  });

  test('an EIP-7702 delegated owner is refused before anything is sent', async () => {
    const s = await setup();
    s.chain.codes.set(owner.address.toLowerCase(), `0xef0100${'11'.repeat(20)}`);
    const res = await post(s.app, '/sponsor/create', await signCreate());
    expect(res.json().error.code).toBe('OWNER_NOT_EOA');
    expect(s.chain.sent).toHaveLength(0);
  });

  test('I-1: the high-s twin of a valid signature and v outside 27/28 fail offchain', async () => {
    const s = await setup();
    const good = await signCreate();
    const r = good.sig.slice(0, 66);
    const sv = BigInt(`0x${good.sig.slice(66, 130)}`);
    const v = Number.parseInt(good.sig.slice(130, 132), 16);
    const hi = `${r}${(SECP_N - sv).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as Hex;
    expect(isCanonicalSig(good.sig)).toBe(true);
    expect(isCanonicalSig(hi)).toBe(false);
    expect(isCanonicalSig(`${good.sig.slice(0, 130)}01` as Hex)).toBe(false);
    expect((await post(s.app, '/sponsor/create', { ...good, sig: hi })).json().error.code).toBe('BAD_SIGNATURE');
    expect(s.chain.sent).toHaveLength(0);
  });

  test('L-3: a stored create whose account vanished (abandoned proposal) is not trusted', async () => {
    const s = await setup();
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    s.fx.deployed.delete(CLONE.toLowerCase());
    // Past the 3-block dedupe on create:owner, and finality past the stored block.
    s.chain.setHead(s.chain.head + 5n);
    s.chain.finalized = s.chain.head;
    const again = await post(s.app, '/sponsor/create', await signCreate(owner, { deadline: NOW_S + 900n }));
    expect(again.statusCode).toBe(200);
    expect(s.chain.sent).toHaveLength(2);
    expect(s.events()).toContain('sponsor.create_vanished');
    expect(s.ledger.getCreate(owner.address)).toMatchObject({ status: 'sent', tx_hash: s.chain.sent[1]!.hash });
  });

  test('SE-W4 L-1 PoC: a bad signature during read lag no longer drops the owner\'s sent row', async () => {
    const s = await setup();
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    const before = s.ledger.getCreate(owner.address)!;
    // Read lag: the account is not visible yet, and finality has passed the create's block.
    s.fx.deployed.delete(CLONE.toLowerCase());
    s.chain.setHead(s.chain.head + 5n);
    s.chain.finalized = s.chain.head;
    const forged = { ...(await signCreate(other)), owner: owner.address };
    const res = await post(s.app, '/sponsor/create', forged, '198.51.100.66');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_SIGNATURE');
    expect(s.ledger.getCreate(owner.address)).toEqual(before);
    expect(s.events()).not.toContain('sponsor.create_vanished');
    expect(s.chain.sent).toHaveLength(1);
    // Lag over: the owner keeps the stored result and can activate.
    s.fx.deployed.add(CLONE.toLowerCase());
    expect((await post(s.app, '/sponsor/create', await signCreate())).json().data).toMatchObject({ account: CLONE, status: 'created', txHash: before.tx_hash });
    expect((await post(s.app, '/activate', { account: CLONE })).statusCode).toBe(200);
  });

  test('SE-W4 L-1: a replayed valid payload cannot drop the row on read lag, finalized state decides', async () => {
    const s = await setup();
    const signed = await signCreate();
    expect((await post(s.app, '/sponsor/create', signed)).statusCode).toBe(200);
    const before = s.ledger.getCreate(owner.address)!;
    // `latest` lags and misses the account; finalized reads see real state.
    s.chain.handlers.unshift((c) => {
      if (c.block !== 'latest' || c.to.toLowerCase() !== FACTORY.toLowerCase()) return undefined;
      const { functionName } = decodeFunctionData({ abi: IGaplessFactoryAbi, data: c.data });
      return functionName === 'isAccount' ? encodeFunctionResult({ abi: IGaplessFactoryAbi, functionName: 'isAccount', result: false }) : undefined;
    });
    s.chain.setHead(s.chain.head + 5n);
    // Finality not yet at the create's block: refuse, keep the row.
    const early = await post(s.app, '/sponsor/create', signed, '198.51.100.66');
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('IN_PROGRESS');
    expect(s.ledger.getCreate(owner.address)).toEqual(before);
    // Finality covers it and the account exists there: the stored result stands.
    s.chain.finalized = s.chain.head;
    const late = await post(s.app, '/sponsor/create', signed, '198.51.100.66');
    expect(late.statusCode).toBe(200);
    expect(late.json().data).toMatchObject({ status: 'created', txHash: before.tx_hash });
    expect(s.ledger.getCreate(owner.address)).toEqual(before);
    expect(s.events()).not.toContain('sponsor.create_vanished');
    expect(s.chain.sent).toHaveLength(1);
  });

  test('SE-W4 L-1: a row stored without a block is judged vanished only after the settle window', async () => {
    const s = await setup();
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    // Adopted, resumed or promoted rows carry no block.
    s.ledger.settleCreate(owner.address, { status: 'sent', txHash: null, block: null });
    s.fx.deployed.delete(CLONE.toLowerCase());
    s.chain.setHead(s.chain.head + 5n);
    s.chain.finalized = s.chain.head;
    expect((await post(s.app, '/sponsor/create', await signCreate())).json().error.code).toBe('IN_PROGRESS');
    expect(s.ledger.getCreate(owner.address)).toMatchObject({ status: 'sent', block_number: null });
    s.clock.t += 60_000;
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    expect(s.events()).toContain('sponsor.create_vanished');
    expect(s.chain.sent).toHaveLength(2);
  });
});

describe('M-1 and I-4: /activate scope', () => {
  test('PoC: funded accounts the relay did not create are refused, nothing is swept (was 9 sweeps, 0.83 MON)', async () => {
    const s = await setup();
    for (let i = 0; i < 14; i++) {
      const acct = `0x${(0xa000 + i).toString(16).padStart(40, '0')}`;
      s.fx.deployed.add(acct);
      s.fx.walletAusd.set(acct, 10_000_000n);
      // Distinct clients, so the per-route rate limit is not what refuses them.
      const res = await post(s.app, '/activate', { account: getAddress(acct) }, `203.0.113.${50 + i}`);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('NOT_SPONSORED');
    }
    expect(s.chain.sent).toHaveLength(0);
    expect(s.governor.usage().committedWei).toBe(0n);
  });

  test('global daily activation cap', async () => {
    const s = await setup({ env: { DAILY_ACTIVATION_CAP: '1' } });
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    expect((await post(s.app, '/sponsor/create', await signCreate(other))).statusCode).toBe(200);
    expect((await post(s.app, '/activate', { account: CLONE })).statusCode).toBe(200);
    const capped = await post(s.app, '/activate', { account: CLONE2 }, '198.51.100.40');
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.code).toBe('SPONSOR_CAP');
  });

  test('I-4: a third party activating before the operator is set does not lock the drip out', async () => {
    const s = await setup();
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    const early = await post(s.app, '/activate', { account: CLONE }, '198.51.100.66');
    expect(early.json().data).toMatchObject({ drip: null, dripSkipped: 'no_operator' });
    s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 3_600n, maxNotionalPerTradeCNS: 1n, maxNotionalPerDayCNS: 100_000_000n });
    const later = await post(s.app, '/activate', { account: CLONE });
    expect(later.statusCode).toBe(200);
    expect(later.json().data.drip).toMatchObject({ to: getAddress(OPERATOR) });
    expect(s.chain.sent.filter((t) => t.value > 0n)).toHaveLength(1);
  });
});

describe('C5 N-03: drip and the operator daily budget', () => {
  test('an operator re-granted with a zero daily budget gets no drip, and the skip reopens once it has one', async () => {
    const s = await setup();
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 3_600n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 0n });
    const blocked = await post(s.app, '/activate', { account: CLONE });
    expect(blocked.json().data).toMatchObject({ drip: null, dripSkipped: 'operator_no_budget' });
    s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 3_600n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n });
    const later = await post(s.app, '/activate', { account: CLONE });
    expect(later.json().data.drip).toMatchObject({ to: getAddress(OPERATOR) });
  });
});

describe('M-3: drip idempotency across a timed-out send', () => {
  async function timedOutDrip() {
    const s = await setup();
    expect((await post(s.app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
    s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 3_600n, maxNotionalPerTradeCNS: 1n, maxNotionalPerDayCNS: 100_000_000n });
    // create and sweep land; the drip's sync send times out (EIP-7966 code 4).
    s.chain.sendQueue.push({ kind: 'success' }, { kind: 'timeout' });
    const first = await post(s.app, '/activate', { account: CLONE });
    expect(first.statusCode).toBe(503);
    expect(first.json().error.code).toBe('RELAY_BUSY');
    const drip = s.chain.sent.find((t) => t.value > 0n)!;
    // On record before broadcast.
    expect(s.ledger.getActivation(CLONE)).toMatchObject({ drip_tx: drip.hash, drip_state: 'signed', drip_nonce: drip.nonce });
    return { ...s, drip };
  }

  test('PoC: the timed-out drip lands, the retry next day finds it and sends nothing (was a second 0.5 MON drip)', async () => {
    const s = await timedOutDrip();
    s.chain.mine(s.drip.hash, 'success', s.chain.head + 1n);
    s.chain.balance(OPERATOR, parseEther('0.45'));
    s.chain.setHead(s.chain.head + 20n);
    s.clock.t += 86_400_000;
    const second = await post(s.app, '/activate', { account: CLONE });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.drip).toMatchObject({ txHash: s.drip.hash });
    expect(s.chain.sent.filter((t) => t.value > 0n)).toHaveLength(1);
  });

  test('while the drip may still land, retries send nothing', async () => {
    const s = await timedOutDrip();
    s.chain.setHead(s.chain.head + 5n);
    const again = await post(s.app, '/activate', { account: CLONE });
    expect(again.json().error.code).toBe('RELAY_BUSY');
    expect(s.chain.sent.filter((t) => t.value > 0n)).toHaveLength(1);
  });

  test('once a finalized tx used its nonce, the dropped drip is cleared and sent once more', async () => {
    const s = await timedOutDrip();
    // Another tx took the drip's nonce, so the first drip can never land.
    s.chain.nonces.set(relayAccount.address.toLowerCase(), s.drip.nonce + 1);
    s.chain.setHead(s.chain.head + 20n);
    const again = await post(s.app, '/activate', { account: CLONE });
    expect(again.statusCode).toBe(200);
    expect(s.events()).toContain('drip.dropped');
    const drips = s.chain.sent.filter((t) => t.value > 0n);
    expect(drips).toHaveLength(2);
    expect(s.chain.receipts.has(drips[0]!.hash)).toBe(false);
    expect(again.json().data.drip.txHash).toBe(drips[1]!.hash);
  });
});

describe('SE2-L2: a copied createAccountFor landing first', () => {
  /** The copier lands the owner's own signed payload: account deployed with that owner and grant, our tx reverts. */
  function frontRun(s: Awaited<ReturnType<typeof setup>>, grantOwner = owner) {
    const orig = s.chain.request.bind(s.chain);
    s.chain.request = async (a: { method: string; params?: unknown[] }) => {
      if (a.method === 'eth_sendRawTransactionSync' && !s.fx.deployed.has(CLONE.toLowerCase())) {
        s.fx.deployed.add(CLONE.toLowerCase());
        s.fx.owners.set(CLONE.toLowerCase(), grantOwner.address);
        s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 14_400n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n });
        s.chain.sendQueue.unshift({ kind: 'revert' });
      }
      return orig(a);
    };
  }

  test('PoC: the demo owner is created and activates (was: 502, then 409 CREATE_FAILED, /activate 403 forever)', async () => {
    const s = await setup({ env: { SPONSOR_ALLOWLIST_ONLY: 'true', SPONSOR_DEMO_OWNER: owner.address } });
    frontRun(s);
    const body = await signCreate();
    const first = await post(s.app, '/sponsor/create', body);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ account: CLONE, status: 'created' });
    expect(s.ledger.getCreate(owner.address)).toMatchObject({ status: 'sent' });
    expect(s.events()).toContain('sponsor.create_front_run_adopted');
    expect((await post(s.app, '/sponsor/create', body)).statusCode).toBe(200);
    s.fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    const act = await post(s.app, '/activate', { account: CLONE });
    expect(act.statusCode).toBe(200);
    expect(act.json().data).toMatchObject({ account: CLONE, perplAccountId: '77' });
  });

  test('an allowlisted owner whose account already exists with the signed grant is adopted, nothing is sent', async () => {
    const s = await setup({ env: { SPONSOR_ALLOWLIST_ONLY: 'true', SPONSOR_OWNER_ALLOWLIST: owner.address } });
    s.fx.deployed.add(CLONE.toLowerCase());
    s.fx.owners.set(CLONE.toLowerCase(), owner.address);
    s.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 14_400n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n });
    const res = await post(s.app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(200);
    expect(s.chain.sent).toHaveLength(0);
    // A different grant onchain is not what this signature authorized: not adopted.
    const t = await setup({ env: { SPONSOR_ALLOWLIST_ONLY: 'true', SPONSOR_OWNER_ALLOWLIST: owner.address } });
    t.fx.deployed.add(CLONE.toLowerCase());
    t.fx.owners.set(CLONE.toLowerCase(), owner.address);
    t.fx.operator.set(CLONE.toLowerCase(), { key: OPERATOR, expiry: NOW_S + 14_400n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 1n });
    expect((await post(t.app, '/sponsor/create', await signCreate())).json().error.code).toBe('ACCOUNT_EXISTS');
  });

  test('owners outside the invite list are never adopted (no sweep or drip for self-made accounts)', async () => {
    const s = await setup();
    frontRun(s);
    const res = await post(s.app, '/sponsor/create', await signCreate());
    expect(res.statusCode).toBe(502);
    expect(s.ledger.getCreate(owner.address)).toMatchObject({ status: 'failed', error_code: 'FRONT_RUN' });
    s.fx.walletAusd.set(CLONE.toLowerCase(), 10_000_000n);
    expect((await post(s.app, '/activate', { account: CLONE })).json().error.code).toBe('NOT_SPONSORED');
  });
});

describe('SE2-L3: sponsoring that starts after boot', () => {
  test('routes answer 503 until the service appears, then serve it without a restart', async () => {
    const s = await setup({ sponsor: false });
    const env = relayEnv({ SPONSOR_ENABLED: 'true', RELAY_KEY: TEST_KEYS.relay, GAPLESS_FACTORY_ADDRESS: FACTORY, SPONSOR_ALLOWLIST_ONLY: 'false' });
    let current: SponsorService | null = null;
    const { log } = captureLogger();
    const app = await buildRelayApp({
      env,
      log,
      db: s.db,
      client: s.chain.client() as unknown as MonadPublicClient,
      readHead: async () => ({ number: s.chain.head, timestamp: NOW_S }),
      resolveAccountId: async () => null,
      sponsor: () => current
    });
    apps.push(app);
    expect((await post(app, '/sponsor/create', await signCreate())).json().error.code).toBe('SPONSOR_DISABLED');
    current = new SponsorService({
      client: s.chain.client(),
      queue: s.queue,
      ledger: s.ledger,
      factory: FACTORY,
      dripWei: env.DRIP_WEI,
      dripAllowlist: new Set(),
      ownerAllowlistOnly: false,
      ownerAllowlist: new Set(),
      grantPolicy: sponsorGrantPolicy(env),
      log,
      now: () => s.clock.t
    });
    expect((await post(app, '/sponsor/create', await signCreate())).statusCode).toBe(200);
  });
});

describe('F-6: relay gas limits from the fork measurement', () => {
  test('createAccountFor and sweep are 1.15 x fork gas (was 900K each)', () => {
    expect(GAS.createAccountFor).toBe(223_156n);
    expect(GAS.sweep).toBe(331_819n);
    expect(GAS.createAccountFor * 100n).toBeGreaterThanOrEqual(RELAY_GAS_MEASURED.createAccountFor * 115n);
    expect(GAS.sweep * 100n).toBeGreaterThanOrEqual(RELAY_GAS_MEASURED.sweep * 115n);
  });

  /** Owners sponsored in one UTC day under the 1 MON cap: the demo owner with its drip first, then owners without. */
  function ownersPerDay(baseFee: bigint): number {
    const db = openDb(':memory:');
    migrate(db, RELAY_MIGRATIONS);
    const cap = parseEther('1');
    const g = new SpendGovernor(db, privateKeyToAccount(TEST_KEYS.relay).address, { capWei: cap, hotReserveWei: 0n, alertWei: cap }, captureLogger().log);
    const fee = feeQuote(baseFee);
    // What the queue does: reserve gas x maxFee (+ value), settle gas x billed price (+ value); Monad bills the limit.
    const send = (action: string, gas: bigint, value = 0n) => {
      const r = g.reserve({ action, amountWei: maxCostWei(gas, fee, value), exempt: false });
      if (r.ok) g.settle(r.id, gas * billedPriceWei(baseFee) + value);
      return r.ok;
    };
    let owners = 0;
    for (const drip of [true, ...Array<boolean>(20).fill(false)]) {
      if (!send('createAccountFor', GAS.createAccountFor) || !send('sweep', GAS.sweep)) break;
      if (drip && !send('drip', GAS.transfer, parseEther('0.5'))) break;
      owners++;
    }
    return owners;
  }

  test('the 1 MON relay day covers the demo owner with its drip plus 7 more owners at 100 gwei, 6 at 110 (was the demo plus 1)', () => {
    expect(ownersPerDay(parseGwei('100'))).toBe(8);
    expect(ownersPerDay(parseGwei('110'))).toBe(7);
  });
});
