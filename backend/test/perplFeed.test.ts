import { describe, expect, test } from 'bun:test';
import { CHAIN_HEAD_MAX_AGE_MS, MarketStore, MAX_FEED_LAG_BLOCKS, STATE_STALE_MS } from '../src/relay/perpl/store.ts';
import {
  MT,
  RELAY_STATUS_MT,
  marketDataStreams,
  parseFrame,
  parseRelayFrame,
  pingMessage,
  subscribeMessage,
  type PerplFrame
} from '../src/relay/perpl/types.ts';
import { backoffDelay } from '../src/relay/perpl/upstream.ts';
import { loadWsFixture } from './perplFixtures.ts';

// Captured live from wss://app.perpl.xyz/ws/v1/market-data on 2026-10-05 (8 s, production
// streams plus order-book@999999 to record the 404 path, and one ping).
const raw = loadWsFixture();

function parsedFrames(): PerplFrame[] {
  return raw.map((r) => {
    const res = parseFrame(r);
    if (!res.ok) throw new Error(`fixture frame rejected: ${res.reason}`);
    return res.frame;
  });
}

describe('parseFrame on captured frames', () => {
  test('accepts every captured frame and covers each stream type', () => {
    const counts = new Map<number, number>();
    for (const f of parsedFrames()) counts.set(f.mt, (counts.get(f.mt) ?? 0) + 1);
    for (const mt of [MT.SUBSCRIPTION, MT.PONG, MT.HEARTBEAT, MT.MARKET_STATE, MT.BOOK_SNAPSHOT, MT.BOOK_UPDATE, MT.TRADES_SNAPSHOT]) {
      expect(counts.get(mt) ?? 0).toBeGreaterThan(0);
    }
    expect(counts.get(MT.BOOK_SNAPSHOT)).toBe(2);
  });

  test('subscription response reports the unknown stream as 404', () => {
    const sub = parsedFrames().find((f) => f.mt === MT.SUBSCRIPTION);
    if (sub?.mt !== MT.SUBSCRIPTION) throw new Error('no mt 6');
    expect(sub.subs.find((s) => s.stream === 'order-book@999999')?.status).toEqual({ code: 404, error: 'unknown stream' });
    expect(sub.subs.filter((s) => s.status?.code === 0)).toHaveLength(6);
  });

  test('rejects malformed frames without throwing', () => {
    expect(parseFrame('not json')).toEqual({ ok: false, reason: 'json' });
    expect(parseFrame('[1,2]')).toEqual({ ok: false, reason: 'not_object' });
    expect(parseFrame('{"mt":42}')).toEqual({ ok: false, reason: 'unknown_mt', mt: 42 });
    expect(parseFrame('{"mt":1,"t":1}')).toMatchObject({ ok: false, reason: 'unknown_mt' });
    expect(parseFrame('{"mt":16,"sid":1,"sn":1,"at":{},"bid":[{"p":-1,"s":1,"o":1}]}')).toEqual({
      ok: false,
      reason: 'schema',
      mt: 16
    });
    expect(parseFrame('{"mt":100,"sn":"1","h":1}')).toMatchObject({ ok: false, reason: 'schema' });
  });

  test('outbound frames match the documented shapes', () => {
    expect(JSON.parse(subscribeMessage(['heartbeat@143', 'order-book@1']))).toEqual({
      mt: 5,
      subs: [
        { stream: 'heartbeat@143', subscribe: true },
        { stream: 'order-book@1', subscribe: true }
      ]
    });
    expect(JSON.parse(pingMessage(1_790_000_000_000))).toEqual({ mt: 1, t: 1_790_000_000_000 });
  });

  test('stream list follows spec §4.2 and enforces the 16 subscription cap', () => {
    expect(marketDataStreams(143, [1, 10])).toEqual([
      'heartbeat@143',
      'market-state@143',
      'order-book@1',
      'trades@1',
      'order-book@10',
      'trades@10'
    ]);
    expect(() => marketDataStreams(143, [1, 2, 3, 4, 5, 6, 7, 8])).toThrow('too many upstream subscriptions');
  });
});

describe('MarketStore replay', () => {
  function replay(now = () => 1_791_181_970_000) {
    const store = new MarketStore({ now });
    const forwarded: number[] = [];
    let compared = 0;
    let mismatched = 0;
    let lastState: { b?: number; bid: number; ask: number } | null = null;
    for (const f of parsedFrames()) {
      if (store.apply(f)) forwarded.push(f.mt);
      if (f.mt === MT.SUBSCRIPTION) store.setConnected(true);
      // market-state only carries markets that changed. The heartbeat for block N+1 arrives after
      // every frame of block N, so the rebuilt top must equal the latest reported bid and ask then.
      if (f.mt === MT.HEARTBEAT && lastState) {
        const top = store.getBookTop(1);
        if (top) {
          compared++;
          if (top.bid?.p !== lastState.bid || top.ask?.p !== lastState.ask) mismatched++;
        }
      }
      if (f.mt === MT.MARKET_STATE && f.d['1']) lastState = { b: f.d['1'].at.b, bid: f.d['1'].bid, ask: f.d['1'].ask };
    }
    return { store, forwarded, compared, mismatched };
  }

  test('rebuilt BTC book matches market-state best bid and ask', () => {
    const { compared, mismatched } = replay();
    expect(compared).toBeGreaterThan(5);
    expect(mismatched).toBe(0);
  });

  test('forwards state frames, not pongs', () => {
    const { forwarded } = replay();
    expect(forwarded).not.toContain(MT.PONG);
    expect(forwarded).toContain(MT.BOOK_UPDATE);
  });

  test('getQuote exposes typed scaled prices with staleness', () => {
    let t = 1_791_181_970_000;
    const { store } = replay(() => t);
    const q = store.getQuote(1);
    if (!q) throw new Error('no BTC quote');
    expect(q.marketId).toBe(1);
    for (const v of [q.oracle, q.mark, q.mid, q.last]) expect(Number.isInteger(v) && v > 0).toBe(true);
    expect(q.bookTop?.bid?.p).toBeLessThan(q.bookTop!.ask!.p);
    expect(q.stale).toBe(false);
    t += STATE_STALE_MS + 1;
    expect(store.getQuote(1)?.stale).toBe(true);
    expect(store.getQuote(424242)).toBeNull();
  });

  test('disconnect invalidates quotes, books and trades until fresh data arrives', () => {
    const { store } = replay();
    store.setConnected(false);
    // Pre-outage state must not reach a snapshot or the keeper.
    expect(store.getQuote(1)).toBeNull();
    expect(store.getHeartbeat()).toBeNull();
    expect(store.getBookTop(1)).toBeNull();
    expect(store.getRecentTrades(1)).toEqual([]);
    const frames = store.snapshotFrames();
    expect(frames).toHaveLength(1);
    expect(parseRelayFrame(frames[0]!)).toMatchObject({ ok: true, frame: { mt: RELAY_STATUS_MT, status: 'down' } });
    // A diff before the next snapshot must not be applied to the old book.
    const update = parsedFrames().find((f) => f.mt === MT.BOOK_UPDATE)!;
    expect(store.apply(update)).toBe(false);
  });

  test('snapshotFrames re-parse and describe the current state', () => {
    const { store } = replay();
    const frames = store.snapshotFrames().map((s) => {
      const r = parseRelayFrame(s);
      if (!r.ok) throw new Error(`snapshot frame rejected: ${r.reason}`);
      return r.frame;
    });
    expect(frames[0]).toMatchObject({ mt: RELAY_STATUS_MT, status: 'up' });
    // The merged state is current as of the latest market-state frame, not its newest entry.
    const lastStateSn = parsedFrames().filter((f) => f.mt === MT.MARKET_STATE).at(-1)!;
    const merged = frames.find((f) => f.mt === MT.MARKET_STATE);
    if (merged?.mt !== MT.MARKET_STATE || lastStateSn.mt !== MT.MARKET_STATE) throw new Error('no market-state');
    expect(merged.sn).toBe(lastStateSn.sn!);
    expect(frames.map((f) => f.mt)).toEqual([
      RELAY_STATUS_MT,
      MT.SUBSCRIPTION,
      MT.HEARTBEAT,
      MT.MARKET_STATE,
      MT.BOOK_SNAPSHOT,
      MT.TRADES_SNAPSHOT,
      MT.BOOK_SNAPSHOT,
      MT.TRADES_SNAPSHOT
    ]);
    const btc = frames.find((f) => f.mt === MT.BOOK_SNAPSHOT && f.sid === 1000001);
    if (btc?.mt !== MT.BOOK_SNAPSHOT) throw new Error('no BTC book');
    expect(btc.bid[0]!.p).toBe(store.getBookTop(1)!.bid!.p);
    expect(btc.bid.every((l, i) => i === 0 || l.p < btc.bid[i - 1]!.p)).toBe(true);
    expect(btc.ask.every((l, i) => i === 0 || l.p > btc.ask[i - 1]!.p)).toBe(true);
  });

  test('trades ring keeps the newest entries only', () => {
    const store = new MarketStore({ tradesPerMarket: 4 });
    for (const f of parsedFrames()) store.apply(f);
    store.setConnected(true);
    const trades = store.getRecentTrades(1);
    expect(trades).toHaveLength(4);
    const all = parsedFrames().filter((f) => (f.mt === MT.TRADES_SNAPSHOT || f.mt === MT.TRADES_UPDATE) && f.sid === 2000001);
    const last = all.flatMap((f) => (f.mt === MT.TRADES_SNAPSHOT || f.mt === MT.TRADES_UPDATE ? f.d : [])).slice(-4);
    expect(trades).toEqual(last);
  });
});

describe('MarketStore freshness (keeper input)', () => {
  const hb = (sn: number) => ({ mt: MT.HEARTBEAT, sid: 5000, sn, h: sn }) as const;
  const state = (b: number, mid: number) => ({
    at: { b, t: 1_791_181_967_000 },
    orl: mid,
    mrk: mid,
    lst: mid,
    mid,
    bid: mid - 1,
    ask: mid + 1,
    prv: mid,
    dv: 0,
    dva: '0',
    oi: 0,
    tvl: '0'
  });

  function live() {
    let t = 1_000_000;
    const store = new MarketStore({ now: () => t });
    store.setConnected(true);
    store.apply({ mt: MT.MARKET_STATE, sid: 3000, sn: 100, d: { '1': state(100, 500), '10': state(100, 30) } });
    store.apply(hb(100));
    return { store, advance: (ms: number) => (t += ms), now: () => t };
  }

  test('a quiet market stays fresh while heartbeats flow (only the other market changes)', () => {
    const { store, advance } = live();
    for (let b = 101; b <= 160; b++) {
      advance(400);
      store.apply(hb(b));
      store.apply({ mt: MT.MARKET_STATE, sid: 3000, sn: b, d: { '1': state(b, 500 + b) } });
    }
    const quiet = store.getQuote(10)!;
    expect(quiet.ageMs).toBeGreaterThan(STATE_STALE_MS);
    expect(quiet.block).toBe(100);
    expect(quiet.headBlock).toBe(160);
    expect(quiet.stale).toBe(false);
    expect(store.getQuote(1)!.stale).toBe(false);
  });

  test('heartbeat silence marks every market stale', () => {
    const { store, advance } = live();
    advance(STATE_STALE_MS);
    expect(store.getQuote(1)!.stale).toBe(false);
    advance(1);
    expect(store.getQuote(1)!.stale).toBe(true);
    expect(store.getQuote(10)!.stale).toBe(true);
  });

  test('a Perpl head lagging our RPC head by more than MAX_FEED_LAG_BLOCKS is stale', () => {
    const { store, advance } = live();
    store.observeChainHead(100 + MAX_FEED_LAG_BLOCKS);
    expect(store.getQuote(1)).toMatchObject({ feedLagBlocks: MAX_FEED_LAG_BLOCKS, stale: false });
    store.observeChainHead(100 + MAX_FEED_LAG_BLOCKS + 1);
    expect(store.getQuote(1)).toMatchObject({ feedLagBlocks: MAX_FEED_LAG_BLOCKS + 1, stale: true });
    // An old RPC observation is not evidence either way.
    advance(CHAIN_HEAD_MAX_AGE_MS + 1);
    store.apply(hb(101));
    expect(store.getQuote(1)).toMatchObject({ feedLagBlocks: null, stale: false });
  });

  test('getFreshState serves only a fresh feed, as of the latest market-state block', () => {
    const { store, advance } = live();
    expect(store.getFreshState(10)).toMatchObject({ sn: 100, state: { mid: 30 } });
    advance(STATE_STALE_MS + 1);
    expect(store.getFreshState(10)).toBeNull();
  });

  test('a relay client store follows the status frame', () => {
    const { store } = live();
    const down = parseRelayFrame('{"mt":9000,"status":"down","t":1}');
    if (!down.ok) throw new Error('status frame rejected');
    expect(store.apply(down.frame)).toBe(true);
    expect(store.getQuote(1)).toBeNull();
    expect(store.feedHealth().status).toBe('down');
    expect(parseRelayFrame('{"mt":9000,"status":"weird","t":1}')).toMatchObject({ ok: false, reason: 'schema' });
    // The Perpl parser never accepts the relay frame, so an upstream cannot spoof it.
    expect(parseFrame('{"mt":9000,"status":"down","t":1}')).toMatchObject({ ok: false, reason: 'unknown_mt' });
  });
});

describe('backoffDelay', () => {
  test('grows exponentially, is jittered within [d/2, d] and capped', () => {
    expect(backoffDelay(0, 1000, 60_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelay(3, 1000, 60_000, () => 0)).toBe(4000);
    expect(backoffDelay(20, 1000, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelay(1000, 1000, 60_000, () => 0.5)).toBe(45_000);
  });
});
