import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, parseEther, parseGwei, toFunctionSelector, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ICoverManagerAbi } from '../src/abi/index.ts';
import { migrate, openDb, type Database } from '../src/lib/db.ts';
import { GAS, PRIORITY_FEE_WEI } from '../src/lib/gas.ts';
import { KEEPER_MIGRATIONS } from '../src/keeper/migrations.ts';
import { classifySendError, SEND_DEFAULTS, SendQueue, type ContractSend } from '../src/lib/sendQueue.ts';
import { SignerLease } from '../src/lib/signerLease.ts';
import { SpendGovernor } from '../src/lib/spendGovernor.ts';
import { captureLogger, FakeChain, TEST_KEYS } from './fakeChain.ts';

const MANAGER = '0x1111111111111111111111111111111111111111' as const;
const COVER = `0x${'ab'.repeat(32)}` as Hex;
const ARM = toFunctionSelector('arm(bytes32)');
const account = privateKeyToAccount(TEST_KEYS.keeper);
const DAY_MS = Date.UTC(2026, 9, 5, 12);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function governorDb(path = ':memory:'): Database {
  const db = openDb(path);
  migrate(db, KEEPER_MIGRATIONS);
  return db;
}

function setup(
  opts: { balance?: bigint; capWei?: bigint; hotWei?: bigint; alertWei?: bigint; db?: Database; armResult?: boolean | 'revert'; strict?: boolean; actionCapsWei?: Record<string, bigint> } = {}
) {
  const chain = new FakeChain();
  chain.balance(account.address, opts.balance ?? parseEther('1.5'));
  chain.nonces.set(account.address.toLowerCase(), 7);
  chain.handlers.push((c) => {
    if (c.to !== MANAGER || !c.data.startsWith(ARM)) return undefined;
    const r = opts.armResult ?? true;
    if (r === 'revert') {
      return { revert: encodeErrorResult({ abi: ICoverManagerAbi, errorName: 'BadStatus', args: [COVER, 4] }) };
    }
    return encodeFunctionResult({ abi: ICoverManagerAbi, functionName: 'arm', result: r });
  });
  const db = opts.db ?? governorDb();
  const cap = captureLogger();
  let now = DAY_MS;
  const capWei = opts.capWei ?? parseEther('1');
  const governor = new SpendGovernor(
    db,
    account.address,
    { capWei, hotReserveWei: opts.hotWei ?? 0n, alertWei: opts.alertWei ?? capWei, actionCapsWei: opts.actionCapsWei },
    cap.log,
    () => now
  );
  const queue = new SendQueue({
    client: chain.client(),
    account,
    governor,
    log: cap.log,
    head: async () => ({ number: chain.head, baseFeePerGas: chain.baseFee }),
    // Each poll while waiting for the reserve window advances one block.
    sleep: async () => {
      chain.head += 1n;
    },
    pollMs: 1,
    now: () => now,
    strictReserveSpacing: opts.strict
  });
  return { chain, queue, governor, db, ...cap, setNow: (ms: number) => (now = ms) };
}

const arm = (over: Partial<ContractSend> = {}): ContractSend => ({
  label: 'arm',
  ref: COVER,
  dedupeKey: `arm:${COVER}`,
  exempt: true,
  address: MANAGER,
  abi: ICoverManagerAbi,
  functionName: 'arm',
  args: [COVER],
  gas: GAS.arm,
  ...over
});

describe('send queue: nonce and fees', () => {
  test('starts from the chain nonce, increments per receipt, signs explicit gas and Monad fees', async () => {
    const { chain, queue } = setup();
    expect(await queue.init()).toBe(7);
    const a = await queue.send(arm({ dedupeKey: 'a' }));
    chain.setHead(chain.head + 4n);
    const b = await queue.send(arm({ dedupeKey: 'b' }));
    expect(a.status).toBe('confirmed');
    expect(b.status).toBe('confirmed');
    expect(chain.sent.map((t) => t.nonce)).toEqual([7, 8]);
    const tx = chain.sent[0]!;
    expect(tx.chainId).toBe(143);
    expect(tx.gas).toBe(GAS.arm);
    expect(tx.maxPriorityFeePerGas).toBe(PRIORITY_FEE_WEI);
    expect(tx.maxFeePerGas).toBe(parseGwei('100') * 2n + parseGwei('2'));
    expect(decodeFunctionData({ abi: ICoverManagerAbi, data: tx.data! }).args).toEqual([COVER]);
    // eth_call ran with the same explicit gas limit before the send.
    expect(chain.methods.indexOf('eth_call')).toBeLessThan(chain.methods.indexOf('eth_sendRawTransactionSync'));
  });

  test('a node rejection releases the reservation and resyncs the nonce from chain', async () => {
    const { chain, queue, governor, events } = setup();
    await queue.init();
    chain.sendQueue.push({ kind: 'error', code: -32000, message: 'nonce too low' });
    chain.nonces.set(account.address.toLowerCase(), 9);
    const out = await queue.send(arm());
    expect(out).toEqual({ status: 'skipped', reason: 'rejected' });
    expect(governor.usage().committedWei).toBe(0n);
    chain.setHead(chain.head + 4n);
    await queue.send(arm({ dedupeKey: 'x' }));
    expect(chain.sent.at(-1)!.nonce).toBe(9);
    expect(events()).toContain('send.nonce_resync');
  });

  test('SE3-M1: the drift check and the resync after a revert never lower the nonce below our own receipts', async () => {
    const { chain, queue, events } = setup();
    await queue.init();
    expect((await queue.send(arm({ dedupeKey: 'a' }))).status).toBe('confirmed');
    // A read node one block behind still reports the nonce before our receipt.
    const lag = () => {
      chain.nonces.set(account.address.toLowerCase(), 7);
      chain.pendingNonces.set(account.address.toLowerCase(), 7);
    };
    lag();
    chain.finalized = chain.head + 1n;
    for (let i = 0; i < 50; i++) await queue.reconcile(chain.finalized);
    expect(events().filter((e) => e === 'send.nonce_resync')).toHaveLength(1);
    chain.setHead(chain.head + 4n);
    expect((await queue.send(arm({ dedupeKey: 'b' }))).status).toBe('confirmed');
    // Was: 7 again (rejected "nonce too low", and the lane attempt lost).
    expect(chain.sent.map((t) => t.nonce)).toEqual([7, 8]);
    chain.sendQueue.push({ kind: 'revert' });
    chain.setHead(chain.head + 4n);
    expect((await queue.send(arm({ dedupeKey: 'c' }))).status).toBe('reverted');
    lag();
    chain.setHead(chain.head + 4n);
    await queue.send(arm({ dedupeKey: 'd' }));
    expect(chain.sent.map((t) => t.nonce)).toEqual([7, 8, 9, 10]);
  });

  test('a timed-out send holds the queue until its receipt shows up', async () => {
    const { chain, queue, governor } = setup();
    await queue.init();
    chain.sendQueue.push({ kind: 'timeout' });
    const first = await queue.send(arm());
    expect(first.status).toBe('pending');
    expect(governor.usage().committedWei).toBe(GAS.arm * (parseGwei('202')));
    chain.setHead(chain.head + 1n);
    expect(await queue.send(arm({ dedupeKey: 'other' }))).toEqual({ status: 'skipped', reason: 'blocked' });
    chain.mine((first as { hash: Hex }).hash, 'success', chain.head);
    chain.setHead(chain.head + 3n);
    const next = await queue.send(arm({ dedupeKey: 'other' }));
    expect(next.status).toBe('confirmed');
    expect(chain.sent.map((t) => t.nonce)).toEqual([7, 8]);
    // Settled at the billed price (base + tip), not the reserved maxFee.
    expect(governor.usage().committedWei).toBe(2n * GAS.arm * parseGwei('102'));
  });

  test('L-3: a send unseen after the TTL unblocks the queue but stays counted until the finalized nonce passes it', async () => {
    const { chain, queue, governor, events } = setup();
    await queue.init();
    chain.sendQueue.push({ kind: 'timeout' });
    await queue.send(arm());
    const reserved = GAS.arm * parseGwei('202');
    chain.setHead(chain.head + 10n);
    await queue.reconcile(chain.head);
    expect(events()).toContain('send.dropped');
    expect(governor.usage().committedWei).toBe(reserved);
    expect(queue.status().unresolved).toBe(1);
    chain.setHead(chain.head + 1n);
    // A different call (another cover), so the replacement is not byte-identical to the dropped tx.
    await queue.send(arm({ dedupeKey: 'retry', args: [`0x${'cd'.repeat(32)}`] }));
    // The replacement reuses nonce 7; once it is finalized the dropped one can never land.
    expect(chain.sent.at(-1)!.nonce).toBe(7);
    await queue.reconcile(chain.head + 1n);
    expect(events()).toContain('send.drop_confirmed');
    expect(queue.status().unresolved).toBe(0);
    expect(governor.usage().committedWei).toBe(GAS.arm * parseGwei('102'));
  });

  test('L-3 and SE3-I5: a send treated as dropped that lands later is settled at its bill and leaves the balance cache', async () => {
    const { chain, queue, governor, events } = setup();
    await queue.init();
    chain.sendQueue.push({ kind: 'timeout' });
    const out = await queue.send(arm());
    const cached = await queue.balanceAt(chain.head);
    chain.setHead(chain.head + 10n);
    await queue.reconcile(chain.head);
    chain.finalizedNonces.set(account.address.toLowerCase(), 7);
    chain.mine((out as { hash: Hex }).hash, 'success', chain.head);
    await queue.reconcile(chain.head + 1n);
    expect(events()).toContain('send.landed_after_drop');
    const billed = GAS.arm * parseGwei('102');
    expect(governor.usage().committedWei).toBe(billed);
    expect(queue.status().unresolved).toBe(0);
    // Was: the cache kept the pre-send balance until its next refresh (overestimate by one call).
    expect(await queue.balanceAt(chain.head)).toBe(cached - billed);
  });

  test('a transport failure is treated as possibly sent, never as rejected', async () => {
    expect(classifySendError(new Error('socket hang up'))).toBe('pending');
    const { chain, queue, governor } = setup();
    await queue.init();
    chain.sendQueue.push({ kind: 'transport' });
    expect((await queue.send(arm())).status).toBe('pending');
    // Still counted: the tx may have landed.
    expect(governor.usage().committedWei).toBe(GAS.arm * parseGwei('202'));
    expect(queue.status().pending).toBe(1);
  });

  test('a reverted receipt consumes the nonce and bills gas only', async () => {
    const { chain, queue, governor } = setup();
    await queue.init();
    chain.sendQueue.push({ kind: 'revert' });
    const out = await queue.send(arm());
    expect(out.status).toBe('reverted');
    expect(governor.usage().committedWei).toBe(GAS.arm * parseGwei('102'));
    chain.setHead(chain.head + 4n);
    await queue.send(arm({ dedupeKey: 'n' }));
    expect(chain.sent.at(-1)!.nonce).toBe(8);
  });

  test('Finalized heads faster than sends coalesce and never fill the send queue', async () => {
    const { queue } = setup();
    await queue.init();
    const reconciles = Array.from({ length: 20 }, (_, i) => queue.reconcile(990n + BigInt(i)));
    expect((await queue.send(arm())).status).toBe('confirmed');
    await Promise.all(reconciles);
    expect(new Set(reconciles).size).toBeLessThanOrEqual(2);
  });

  test('a receipt that vanishes (abandoned proposal) resyncs the nonce once the confirm window passes', async () => {
    const { chain, queue, events } = setup();
    await queue.init();
    const out = await queue.send(arm());
    const included = chain.head + 1n;
    chain.forget((out as { hash: Hex }).hash);
    chain.nonces.set(account.address.toLowerCase(), 7);
    await queue.reconcile(included);
    expect(events()).not.toContain('send.receipt_vanished');
    expect(queue.status().nonce).toBe(8);
    await queue.reconcile(included + SEND_DEFAULTS.vanishConfirmBlocks);
    expect(events()).toContain('send.receipt_vanished');
    expect(queue.status().nonce).toBe(7);
  });

  test('F-1: a receipt hidden by a lagging read node keeps the nonce, and the next send lands (was: nonce too low)', async () => {
    const { chain, queue, events } = setup();
    chain.strictNonces = true;
    await queue.init();
    expect((await queue.send(arm({ dedupeKey: 'a' }))).status).toBe('confirmed');
    const included = chain.head + 1n;
    // Fork repro: plain newHeads (Finalized == head) and a read node one block behind the node that took the send.
    chain.setHead(included);
    chain.finalized = included;
    chain.readHead = included - 1n;
    await queue.reconcile(included);
    expect(events()).toContain('send.receipt_lagging');
    expect(events()).not.toContain('send.receipt_vanished');
    expect(events()).not.toContain('send.nonce_resync');
    expect(queue.status().nonce).toBe(8);
    // Still lagging at the next Finalized head: logged once, nonce kept.
    chain.setHead(included + 1n);
    chain.readHead = included;
    await queue.reconcile(included);
    expect(events().filter((e) => e === 'send.receipt_lagging')).toHaveLength(1);
    chain.setHead(chain.head + 3n);
    const next = await queue.send(arm({ dedupeKey: 'b' }));
    // Was: resync to the node's stale nonce 7, then "nonce too low" and the lane attempt lost.
    expect(next.status).toBe('confirmed');
    expect(chain.sent.map((t) => t.nonce)).toEqual([7, 8]);
    expect(events()).not.toContain('send.rejected');
    // The node catches up: every receipt resolves, nothing was declared vanished.
    chain.readHead = null;
    await queue.reconcile(chain.head + 1n);
    expect(queue.status().tracked).toBe(0);
    expect(events()).not.toContain('send.receipt_vanished');
  });

  test('F-1: a missing receipt whose nonce a finalized tx already used is settled without a resync', async () => {
    const { chain, queue, events } = setup();
    await queue.init();
    const out = await queue.send(arm());
    // Load-balanced reads: the receipt query hits a node without it, the nonce query one that finalized it.
    chain.forget((out as { hash: Hex }).hash);
    chain.finalizedNonces.set(account.address.toLowerCase(), 8);
    chain.nonces.set(account.address.toLowerCase(), 7);
    await queue.reconcile(chain.head + 1n);
    expect(queue.status().tracked).toBe(0);
    expect(queue.status().nonce).toBe(8);
    expect(events()).not.toContain('send.receipt_vanished');
    expect(events()).not.toContain('send.nonce_resync');
  });
});

describe('send queue: simulate first', () => {
  test('a simulation revert sends nothing and books nothing', async () => {
    const { chain, queue, governor } = setup({ armResult: 'revert' });
    const out = await queue.send(arm());
    expect(out).toEqual({ status: 'skipped', reason: 'simulation_reverted', detail: 'BadStatus' });
    expect(chain.sent).toHaveLength(0);
    expect(governor.usage().committedWei).toBe(0n);
  });

  test('accept() sees the decoded result and can veto the send', async () => {
    const { chain, queue } = setup({ armResult: false });
    let seen: unknown;
    const out = await queue.send(arm({ accept: (r) => ((seen = r), r === true) }));
    expect(seen).toBe(false);
    expect(out).toEqual({ status: 'skipped', reason: 'not_needed' });
    expect(chain.sent).toHaveLength(0);
  });
});

describe('send queue: reserve balance', () => {
  const OP = '0x00000000000000000000000000000000000000a1' as const;

  test('M-2: below 10 MON gas-only calls go back to back; only the consensus budget limits them', async () => {
    const { chain, queue } = setup({ balance: parseEther('1.5') });
    await queue.send(arm({ dedupeKey: '1' }));
    chain.setHead(chain.head + 1n);
    expect((await queue.send(arm({ dedupeKey: '2' }))).status).toBe('confirmed');
    expect((await queue.send(arm({ dedupeKey: '3' }))).status).toBe('confirmed');
    expect(chain.sent).toHaveLength(3);
  });

  test('M-2: a value transfer below 10 MON is an emptying tx: no other send from the key in the last 3 blocks', async () => {
    const { chain, queue } = setup({ balance: parseEther('1.5') });
    await queue.send(arm({ dedupeKey: '1' }));
    const included = chain.head + 1n;
    for (const head of [included, included + 1n, included + 2n]) {
      chain.setHead(head);
      expect(await queue.send({ label: 'drip', to: OP, value: parseEther('0.5') })).toEqual({ status: 'skipped', reason: 'reserve_window' });
    }
    chain.setHead(included + 3n);
    expect((await queue.send({ label: 'drip', to: OP, value: parseEther('0.5') })).status).toBe('confirmed');
  });

  test('M-2: STRICT_RESERVE_SPACING restores spacing for every send below 10 MON', async () => {
    const { chain, queue } = setup({ balance: parseEther('1.5'), strict: true });
    await queue.send(arm({ dedupeKey: '1' }));
    const included = chain.head + 1n;
    chain.setHead(included);
    expect(await queue.send(arm({ dedupeKey: '2' }))).toEqual({ status: 'skipped', reason: 'reserve_window' });
    chain.setHead(included + 3n);
    expect((await queue.send(arm({ dedupeKey: '3' }))).status).toBe('confirmed');
  });

  test('M-2: inflight spend is counted at gas x maxFee (what consensus budgets), not the billed price', async () => {
    // 1.5M gas x 202 gwei = 0.303 MON per send. The cached balance drops by each billed send (0.153), as a fresh read
    // would on mainnet: three fit in 1.25 MON, a fourth does not (0.909 + 0.303 > 0.791; at 102 gwei it would).
    const { chain, queue } = setup({ balance: parseEther('1.25'), capWei: parseEther('5') });
    const big = (k: string) => arm({ dedupeKey: k, gas: 1_500_000n });
    for (const k of ['a', 'b', 'c']) expect((await queue.send(big(k))).status).toBe('confirmed');
    expect(await queue.send(big('d'))).toEqual({ status: 'skipped', reason: 'reserve_budget' });
    chain.setHead(chain.head + 4n);
    expect((await queue.send(big('d'))).status).toBe('confirmed');
  });

  test('waitForWindowMs waits for the window instead of skipping (relay drip)', async () => {
    const { chain, queue } = setup({ balance: parseEther('1.5') });
    await queue.send(arm({ dedupeKey: '1' }));
    const included = chain.head + 1n;
    chain.setHead(included);
    const out = await queue.send({ label: 'drip', to: account.address, value: parseEther('0.5'), waitForWindowMs: 10_000 });
    expect(out.status).toBe('confirmed');
    expect(chain.sent.at(-1)!.sentAtHead - included).toBeGreaterThanOrEqual(3n);
  });

  test('well above 10 MON, back-to-back sends are allowed', async () => {
    const { chain, queue } = setup({ balance: parseEther('50') });
    await queue.send(arm({ dedupeKey: '1' }));
    chain.setHead(chain.head + 1n);
    expect((await queue.send(arm({ dedupeKey: '2' }))).status).toBe('confirmed');
  });

  test('inflight dedupe holds a key for 3 blocks after inclusion', async () => {
    const { chain, queue } = setup({ balance: parseEther('50') });
    await queue.send(arm());
    const included = chain.head + 1n;
    chain.setHead(included + 3n);
    expect(await queue.send(arm())).toEqual({ status: 'skipped', reason: 'inflight' });
    chain.setHead(included + 4n);
    expect((await queue.send(arm())).status).toBe('confirmed');
  });

  test('insufficient balance for gas x maxFee is refused before simulation', async () => {
    const { chain, queue } = setup({ balance: parseEther('0.01') });
    expect(await queue.send(arm())).toEqual({ status: 'skipped', reason: 'insufficient_balance' });
    expect(chain.methods).not.toContain('eth_call');
  });
});

describe('spend governor', () => {
  const cost = GAS.arm * parseGwei('202');

  test('non-exempt sends stop at cap minus the hot-path reserve; arm and trigger may use it', async () => {
    const { queue, governor } = setup({ balance: parseEther('50'), capWei: cost * 3n, hotWei: cost * 2n });
    expect((await queue.send(arm({ exempt: false, dedupeKey: 'a' }))).status).toBe('confirmed');
    expect(await queue.send(arm({ exempt: false, dedupeKey: 'b' }))).toEqual({ status: 'skipped', reason: 'governor_cap', detail: 'cap' });
    expect((await queue.send(arm({ exempt: true, dedupeKey: 'c' }))).status).toBe('confirmed');
    expect(governor.usage().committedWei).toBeLessThanOrEqual(cost * 3n);
  });

  test('hard cap applies to exempt sends too', async () => {
    const { queue } = setup({ balance: parseEther('50'), capWei: cost - 1n });
    expect(await queue.send(arm())).toEqual({ status: 'skipped', reason: 'governor_cap', detail: 'cap' });
  });

  test('alerts once per day at the threshold', async () => {
    const { queue, events } = setup({ balance: parseEther('50'), capWei: cost * 10n, alertWei: cost });
    await queue.send(arm({ dedupeKey: '1' }));
    await queue.send(arm({ dedupeKey: '2' }));
    expect(events().filter((e) => e === 'spend.alert_threshold')).toHaveLength(1);
  });

  test('persists across restarts; reservations left mid-send stay counted as unknown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gapless-gov-'));
    dirs.push(dir);
    const path = join(dir, 'keeper.sqlite');
    const cfg = { capWei: parseEther('1'), hotReserveWei: 0n, alertWei: parseEther('1') };
    const { log } = captureLogger();
    const g1 = new SpendGovernor(governorDb(path), account.address, cfg, log, () => DAY_MS);
    const settled = g1.reserve({ action: 'observe', amountWei: 300n, exempt: false });
    if (!settled.ok) throw new Error('reserve');
    g1.settle(settled.id, 100n);
    const crashed = g1.reserve({ action: 'finalize', amountWei: 500n, exempt: false });
    expect(crashed.ok).toBe(true);

    const g2 = new SpendGovernor(governorDb(path), account.address, cfg, log, () => DAY_MS);
    expect(g2.recover()).toBe(1);
    expect(g2.usage().committedWei).toBe(600n);
    // A new UTC day starts from zero.
    const g3 = new SpendGovernor(governorDb(path), account.address, cfg, log, () => DAY_MS + 86_400_000);
    expect(g3.usage().committedWei).toBe(0n);
  });

  test('concurrent reservations cannot both pass the cap', () => {
    const db = governorDb();
    const { log } = captureLogger();
    const g = new SpendGovernor(db, account.address, { capWei: 1_000n, hotReserveWei: 0n, alertWei: 1_000n }, log, () => DAY_MS);
    const results = [g.reserve({ action: 'a', amountWei: 600n, exempt: false }), g.reserve({ action: 'b', amountWei: 600n, exempt: false })];
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe('send queue: restart seeding (L-1)', () => {
  const OP = '0x00000000000000000000000000000000000000a1' as const;
  const relay = privateKeyToAccount(TEST_KEYS.relay);

  function restartable() {
    const chain = new FakeChain();
    chain.balance(relay.address, parseEther('1.3'));
    const db = governorDb();
    const { log, events } = captureLogger();
    const queue = () =>
      new SendQueue({
        client: chain.client(),
        account: relay,
        governor: new SpendGovernor(db, relay.address, { capWei: parseEther('5'), hotReserveWei: 0n, alertWei: parseEther('5') }, log),
        log
      });
    return { chain, queue, events };
  }

  test('a restarted queue keeps the emptying-tx spacing of the previous process (PoC: drip went out a block later)', async () => {
    const { chain, queue } = restartable();
    const q1 = queue();
    expect((await q1.send({ label: 'sweep', to: OP, value: 0n })).status).toBe('confirmed');
    const included = chain.head + 1n;
    chain.setHead(included);
    expect(await q1.send({ label: 'drip', to: OP, value: parseEther('0.5') })).toMatchObject({ status: 'skipped', reason: 'reserve_window' });
    // Restarted at the same head: before the fix this drip was confirmed (and reverts on mainnet).
    const q2 = queue();
    await q2.init();
    expect(q2.status().lastIncludedBlock).toBe(included.toString());
    expect(await q2.send({ label: 'drip', to: OP, value: parseEther('0.5') })).toMatchObject({ status: 'skipped', reason: 'reserve_window' });
    chain.setHead(included + 3n);
    expect((await q2.send({ label: 'drip', to: OP, value: parseEther('0.5') })).status).toBe('confirmed');
  });

  test('the nonce at head - 3 seeds the window even without a ledger row (another process, same key)', async () => {
    const { chain, queue } = restartable();
    chain.nonces.set(relay.address.toLowerCase(), 1);
    chain.receipts.set(`0x${'aa'.repeat(32)}`, { from: relay.address, blockNumber: `0x${chain.head.toString(16)}` });
    const q = queue();
    await q.init();
    expect(q.status().lastIncludedBlock).toBe(chain.head.toString());
  });

  test('dedupe keys survive a restart: the same action is not resent while its first copy is inflight', async () => {
    const { chain, queue } = restartable();
    const q1 = queue();
    await q1.send({ label: 'sweep', to: OP, value: 0n, dedupeKey: 'trigger:x' });
    const q2 = queue();
    await q2.init();
    expect(await q2.send({ label: 'sweep', to: OP, value: 0n, dedupeKey: 'trigger:x' })).toEqual({ status: 'skipped', reason: 'inflight' });
    expect(chain.sent).toHaveLength(1);
  });

  test('an open send from the previous process blocks the queue until its receipt shows up', async () => {
    const { chain, queue, events } = restartable();
    const q1 = queue();
    chain.sendQueue.push({ kind: 'timeout' });
    const first = await q1.send({ label: 'sweep', to: OP, value: 0n, dedupeKey: 'k' });
    expect(first.status).toBe('pending');
    const q2 = queue();
    await q2.init();
    expect(events()).toContain('send.recovered_pending');
    expect(await q2.send({ label: 'other', to: OP, value: 0n })).toMatchObject({ status: 'skipped', reason: 'blocked' });
    chain.mine((first as { hash: Hex }).hash, 'success', chain.head + 1n);
    chain.setHead(chain.head + 1n);
    expect((await q2.send({ label: 'other', to: OP, value: 0n })).status).toBe('confirmed');
    expect(chain.sent.map((t) => t.nonce)).toEqual([0, 1]);
  });

  test('a reservation that was never signed is released at startup', async () => {
    const { queue } = restartable();
    const db = governorDb();
    const { log } = captureLogger();
    const g = new SpendGovernor(db, relay.address, { capWei: parseEther('5'), hotReserveWei: 0n, alertWei: parseEther('5') }, log);
    expect(g.reserve({ action: 'x', amountWei: 1_000n, exempt: false }).ok).toBe(true);
    g.recover();
    const chain = new FakeChain();
    const q = new SendQueue({ client: chain.client(), account: relay, governor: g, log });
    await q.init();
    expect(g.usage().committedWei).toBe(0n);
    void queue;
  });
});

describe('send queue: persistence hook and logs', () => {
  test('onSigned runs before broadcast; a throw cancels the send and frees the reservation', async () => {
    const { chain, queue, governor } = setup();
    const seen: string[] = [];
    const out = await queue.send(
      arm({
        onSigned: ({ hash }) => {
          seen.push(`${hash}:${chain.methods.includes('eth_sendRawTransactionSync')}`);
        }
      })
    );
    expect(out.status).toBe('confirmed');
    expect(seen).toEqual([`${(out as { hash: Hex }).hash}:false`]);
    const failed = await queue.send(arm({ dedupeKey: 'b', onSigned: () => { throw new Error('disk full'); } }));
    expect(failed).toEqual({ status: 'skipped', reason: 'rejected', detail: 'persist' });
    expect(chain.sent).toHaveLength(1);
    expect(governor.usage().committedWei).toBe(GAS.arm * parseGwei('102'));
  });

  test('I-2: a rejected send logs no raw signed tx', async () => {
    const { chain, queue, lines } = setup();
    chain.sendQueue.push({ kind: 'error', code: -32000, message: 'insufficient funds' });
    await queue.send(arm());
    const rejected = lines.find((l) => l.msg === 'send.rejected')!;
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected)).not.toMatch(/0x02f8[0-9a-f]{40,}/i);
    expect(rejected.err).toMatchObject({ code: -32000, message: 'insufficient funds' });
  });

  test('confirmed outcomes carry receipt logs; accept can re-book a send under another label', async () => {
    const { chain, queue, governor } = setup({ actionCapsWei: { arm_zero: GAS.arm * parseGwei('202') } });
    chain.logsFor = () => [{ address: MANAGER, topics: [`0x${'01'.repeat(32)}`], data: '0x', blockHash: `0x${'00'.repeat(32)}`, blockNumber: '0x1', logIndex: '0x0', removed: false, transactionHash: `0x${'00'.repeat(32)}`, transactionIndex: '0x0' }];
    const out = await queue.send(arm({ exempt: true, accept: () => ({ label: 'arm_zero', exempt: false }) }));
    expect(out.status === 'confirmed' && out.logs.length).toBe(1);
    expect(governor.countToday('arm_zero')).toBe(1);
    expect(governor.countToday('arm')).toBe(0);
    // The sub-cap now refuses a second one; other labels are unaffected.
    expect(await queue.send(arm({ dedupeKey: 'z', accept: () => ({ label: 'arm_zero', exempt: false }) }))).toEqual({ status: 'skipped', reason: 'governor_cap', detail: 'action_cap' });
    expect((await queue.send(arm({ dedupeKey: 'y' }))).status).toBe('confirmed');
  });
});

describe('signer lease and foreign senders (L-4)', () => {
  test('one holder per signer; an expired lease can be taken over; release frees it', () => {
    const db = governorDb();
    const { log } = captureLogger();
    let t = 1_000;
    const a = new SignerLease({ db, signer: account.address, log, now: () => t });
    const b = new SignerLease({ db, signer: account.address, log, now: () => t });
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    expect(a.acquire()).toBe(true);
    t += 31_000;
    expect(b.acquire()).toBe(true);
    expect(a.acquire()).toBe(false);
    b.release();
    expect(a.acquire()).toBe(true);
  });

  test('SE2-L3: a restart inside the TTL of a crashed holder waits and takes the lease (was: exit or sponsoring off)', async () => {
    const db = governorDb();
    const { log, events } = captureLogger();
    let t = 1_000;
    const sleep = async (ms: number) => {
      t += ms;
    };
    const crashed = new SignerLease({ db, signer: account.address, log, now: () => t });
    expect(crashed.acquire()).toBe(true);
    // The crashed process never renews; the new one polls past the 30 s TTL.
    t += 2_000;
    const next = new SignerLease({ db, signer: account.address, log, now: () => t, sleep });
    expect(await next.acquireWait()).toBe(true);
    expect(t - 1_000).toBeGreaterThanOrEqual(30_000);
    expect(t - 1_000).toBeLessThanOrEqual(31_000);
    expect(events()).toContain('signer.lease_wait');
    // A live holder that keeps renewing still wins: the wait gives up after TTL plus slack.
    const live = new SignerLease({ db, signer: account.address, log, now: () => t, sleep: async (ms) => {
      t += ms;
      next.acquire();
    } });
    expect(await live.acquireWait()).toBe(false);
  });

  test('SE3-I3: a start step that fails under the lease releases it, so the next retry is not locked out for the TTL', async () => {
    const db = governorDb();
    const { log } = captureLogger();
    const first = new SignerLease({ db, signer: account.address, log });
    expect(first.acquire()).toBe(true);
    await expect(first.holding(async () => Promise.reject(new Error('queue init failed')))).rejects.toThrow('queue init failed');
    // Was: held for 30 s with no renewal.
    const retry = new SignerLease({ db, signer: account.address, log });
    expect(retry.acquire()).toBe(true);
    expect(await retry.holding(async () => 'started')).toBe('started');
    expect(new SignerLease({ db, signer: account.address, log }).acquire()).toBe(false);
  });

  test('SE2-L3: release is idempotent and survives a closed db (exit handler after shutdown)', () => {
    const db = governorDb();
    const { log } = captureLogger();
    const a = new SignerLease({ db, signer: account.address, log });
    expect(a.acquire()).toBe(true);
    a.release();
    db.close(false);
    expect(() => a.release()).not.toThrow();
    const db2 = governorDb();
    const b = new SignerLease({ db: db2, signer: account.address, log });
    b.acquire();
    db2.close(false);
    expect(() => b.release()).not.toThrow();
  });

  test('a pending nonce with no ledger row of ours is reported as foreign', async () => {
    const { chain, queue } = setup();
    await queue.init();
    expect(await queue.foreignPending()).toBe(0);
    chain.pendingNonces.set(account.address.toLowerCase(), 9);
    expect(await queue.foreignPending()).toBe(2);
    // Our own timed-out send explains one of them.
    chain.pendingNonces.set(account.address.toLowerCase(), 8);
    chain.sendQueue.push({ kind: 'timeout' });
    await queue.send(arm());
    expect(await queue.foreignPending()).toBe(0);
  });

  test('a halted queue sends nothing', async () => {
    const { chain, queue } = setup();
    queue.halt('lease_lost');
    expect(await queue.send(arm())).toEqual({ status: 'skipped', reason: 'halted', detail: 'lease_lost' });
    expect(chain.sent).toHaveLength(0);
  });
});
