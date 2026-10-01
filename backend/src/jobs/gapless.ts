import type { Query, QueryResponse } from '@envio-dev/hypersync-client';
import { decodeEventLog, getAddress, pad, type Abi, type Address, type Hex } from 'viem';
import { ICoverManagerAbi, ICoverVaultAbi, IGaplessCreSinkAbi, IGaplessFactoryAbi } from '../abi/index.ts';
import type { MonadPublicClient } from '../lib/chain.ts';
import type { Database } from '../lib/db.ts';
import type { Logger } from '../lib/log.ts';
import { CONFIRMATION_BLOCKS } from './config.ts';
import type { HypersyncLike } from './hypersync.ts';
import { percentile } from './stats.ts';

export type GaplessSourceKind = 'manager' | 'vault' | 'factory' | 'sink';

/** From the jobs env (COVER_MANAGER_ADDRESS etc.); never hardcoded. */
export interface GaplessConfig {
  startBlock: number;
  addresses: Partial<Record<GaplessSourceKind, Address>>;
}

// Type alias, not interface: it is bound directly as a bun:sqlite record.
export type GaplessLog = {
  block: number;
  logIndex: number;
  ts: number;
  txHash: Hex;
  address: Hex;
  source: GaplessSourceKind;
  topic0: Hex | null;
  topic1: Hex | null;
  topic2: Hex | null;
  topic3: Hex | null;
  data: Hex;
};

export interface GaplessPage {
  logs: GaplessLog[];
  nextBlock: number;
}

export interface GaplessSource {
  getHeight(): Promise<number>;
  getPage(fromBlock: number, toBlock: number): Promise<GaplessPage>;
}

export const GAPLESS_QUERY_FIELDS = {
  log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Address', 'Data', 'Topic0', 'Topic1', 'Topic2', 'Topic3'],
  block: ['Number', 'Timestamp']
} as const satisfies Query['fieldSelection'];

/** Every log of the configured contracts (no topic filter: role and pause events count too). */
export function gaplessQuery(cfg: GaplessConfig, fromBlock: number, toBlock: number): Query {
  return {
    fromBlock,
    toBlock,
    logs: [{ address: Object.values(cfg.addresses) }],
    fieldSelection: { log: [...GAPLESS_QUERY_FIELDS.log], block: [...GAPLESS_QUERY_FIELDS.block] }
  };
}

const HEX = /^0x[0-9a-fA-F]*$/;
const asHex = (v: unknown, field: string): Hex => {
  if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`hypersync: bad ${field}`);
  return v.toLowerCase() as Hex;
};
const optHex = (v: unknown, field: string): Hex | null => (v === undefined || v === null ? null : asHex(v, field));
const asInt = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`hypersync: bad ${field}`);
  return v;
};

/** Maps a response to stored rows; a log from an address outside the config fails the page. */
export function mapGaplessPage(cfg: GaplessConfig, res: QueryResponse): GaplessPage {
  const kinds = new Map<string, GaplessSourceKind>(
    (Object.entries(cfg.addresses) as [GaplessSourceKind, Address][]).map(([k, a]) => [a.toLowerCase(), k])
  );
  const ts = new Map<number, number>();
  for (const b of res.data.blocks) ts.set(asInt(b.number, 'block.number'), asInt(b.timestamp, 'block.timestamp'));
  const logs = res.data.logs.map((l): GaplessLog => {
    const address = asHex(l.address, 'log.address');
    const source = kinds.get(address);
    if (!source) throw new Error('hypersync: log from an unexpected address');
    const block = asInt(l.blockNumber, 'log.blockNumber');
    const t = ts.get(block);
    if (t === undefined) throw new Error(`hypersync: missing timestamp for block ${block}`);
    return {
      block,
      logIndex: asInt(l.logIndex, 'log.logIndex'),
      ts: t,
      txHash: asHex(l.transactionHash, 'log.transactionHash'),
      address,
      source,
      topic0: optHex(l.topics[0], 'log.topic0'),
      topic1: optHex(l.topics[1], 'log.topic1'),
      topic2: optHex(l.topics[2], 'log.topic2'),
      topic3: optHex(l.topics[3], 'log.topic3'),
      data: asHex(l.data ?? '0x', 'log.data')
    };
  });
  return { logs, nextBlock: asInt(res.nextBlock, 'nextBlock') };
}

export function createGaplessSource(client: HypersyncLike, cfg: GaplessConfig): GaplessSource {
  return {
    getHeight: () => client.getHeight(),
    getPage: async (from, to) => mapGaplessPage(cfg, await client.get(gaplessQuery(cfg, from, to)))
  };
}

const addressKey = (cfg: GaplessConfig) =>
  JSON.stringify(Object.fromEntries(Object.entries(cfg.addresses).sort().map(([k, a]) => [k, a.toLowerCase()])));

export function gaplessState(db: Database): { nextBlock: number; startBlock: number; addresses: string } | null {
  return (
    db
      .query<{ nextBlock: number; startBlock: number; addresses: string }, []>(
        'SELECT next_block AS nextBlock, start_block AS startBlock, addresses FROM gapless_state WHERE id = 1'
      )
      .get() ?? null
  );
}

export interface GaplessIngestResult {
  fromBlock: number;
  toBlock: number;
  pages: number;
  logs: number;
  /** The configured addresses or start block changed: stored logs were cleared and re-fetched from the start. */
  reset: boolean;
}

const MAX_PAGES_PER_RUN = 200;

/** All-time Gapless logs from GAPLESS_START_BLOCK (no window, no prune): the protocol's whole history is small. */
export async function ingestGapless(
  db: Database,
  source: GaplessSource,
  cfg: GaplessConfig,
  opts: { signal: AbortSignal; log: Logger; now?: () => Date; renewLease?: () => void }
): Promise<GaplessIngestResult> {
  const now = opts.now ?? (() => new Date());
  const key = addressKey(cfg);
  const state = gaplessState(db);
  const reset = state !== null && (state.addresses !== key || state.startBlock !== cfg.startBlock);
  if (reset) {
    // Public, re-fetchable data (not a ledger): a new address set must not mix with the old one.
    opts.log.warn({ startBlock: cfg.startBlock }, 'jobs.gapless_config_changed: refetching from the start block');
    db.transaction(() => {
      db.run('DELETE FROM gapless_logs');
      db.run('DELETE FROM gapless_state');
    }).immediate();
  }
  const target = (await source.getHeight()) - CONFIRMATION_BLOCKS;
  let from = !reset && state ? state.nextBlock : cfg.startBlock;
  const res: GaplessIngestResult = { fromBlock: from, toBlock: from, pages: 0, logs: 0, reset };
  const ins = db.query(
    `INSERT OR IGNORE INTO gapless_logs (block, log_index, ts, tx_hash, address, source, topic0, topic1, topic2, topic3, data)
     VALUES ($block, $logIndex, $ts, $txHash, $address, $source, $topic0, $topic1, $topic2, $topic3, $data)`
  );
  const put = db.query(
    `INSERT INTO gapless_state (id, next_block, start_block, addresses, updated_at) VALUES (1, $next, $start, $key, $at)
     ON CONFLICT (id) DO UPDATE SET next_block = MAX(next_block, $next), updated_at = $at`
  );
  const commit = (logs: readonly GaplessLog[], next: number) =>
    db.transaction(() => {
      for (const l of logs) ins.run(l);
      put.run({ next, start: cfg.startBlock, key, at: now().toISOString() });
    }).immediate();
  while (from < target && !opts.signal.aborted && res.pages < MAX_PAGES_PER_RUN) {
    const page = await source.getPage(from, target);
    if (page.nextBlock <= from) throw new Error(`hypersync: no progress at block ${from}`);
    const next = Math.min(page.nextBlock, target);
    opts.renewLease?.();
    commit(page.logs, next);
    res.pages++;
    res.logs += page.logs.length;
    from = next;
  }
  if (res.pages === 0) commit([], from);
  res.toBlock = from;
  return res;
}

const ABI_BY_SOURCE: Record<GaplessSourceKind, Abi> = {
  manager: ICoverManagerAbi,
  vault: ICoverVaultAbi,
  factory: IGaplessFactoryAbi,
  sink: IGaplessCreSinkAbi
};

export interface DecodedGapless {
  log: GaplessLog;
  name: string;
  args: Record<string, unknown>;
}

const LOG_COLS = `block, log_index AS logIndex, ts, tx_hash AS txHash, address, source, topic0, topic1, topic2, topic3, data`;

/** Decodes with the frozen ABI of the emitting contract; unknown topics (none expected) are counted, not fatal. */
export function decodeGaplessLogs(logs: readonly GaplessLog[]): { decoded: DecodedGapless[]; undecoded: number } {
  const decoded: DecodedGapless[] = [];
  let undecoded = 0;
  for (const log of logs) {
    const topics = [log.topic0, log.topic1, log.topic2, log.topic3].filter((t): t is Hex => t !== null);
    try {
      const ev = decodeEventLog({ abi: ABI_BY_SOURCE[log.source], topics: topics as [Hex, ...Hex[]], data: log.data, strict: true });
      decoded.push({ log, name: String(ev.eventName), args: (ev.args ?? {}) as unknown as Record<string, unknown> });
    } catch {
      undecoded++;
    }
  }
  return { decoded, undecoded };
}

export function loadGaplessLogs(db: Database): GaplessLog[] {
  return db.query<GaplessLog, []>(`SELECT ${LOG_COLS} FROM gapless_logs ORDER BY block, log_index`).all();
}

/** Onchain vault reads at stats time (ERC-4626 totalAssets, utilizationBps); null when unavailable. */
export type VaultRead = { totalAssetsCNS: bigint; utilizationBps: number } | null;

/** One multicall at latest; utilizationBps above 2^53 is impossible (bps), so Number is exact. */
export async function readVault(client: MonadPublicClient, vault: Address | undefined): Promise<VaultRead> {
  if (!vault) return null;
  const [totalAssets, util] = await client.multicall({
    allowFailure: false,
    contracts: [
      { address: vault, abi: ICoverVaultAbi, functionName: 'totalAssets' },
      { address: vault, abi: ICoverVaultAbi, functionName: 'utilizationBps' }
    ]
  });
  return { totalAssetsCNS: totalAssets, utilizationBps: Number(util) };
}

const STATUS_NAMES = ['none', 'live', 'armed', 'triggered', 'finalized', 'cancelled', 'expired', 'voided'] as const;
type CoverStatusName = (typeof STATUS_NAMES)[number];

export interface CoverSummary {
  coverId: Hex;
  account: Address;
  perpId: number;
  status: CoverStatusName;
  stopPNS: string;
  paidCNS: string;
  boughtTx: Hex;
}

const big = (v: unknown) => (typeof v === 'bigint' ? v : 0n);
const p50Max = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), max: s.length ? s[s.length - 1]! : null };
};

/**
 * Cover lifecycle from events: CoverBought (live), Armed, Disarmed (live), Triggered, Finalized, CoverEnded (its
 * status: cancelled, expired or voided). Armed past armTtl reads as Live onchain; events cannot see that lapse.
 */
export function coverStates(decoded: readonly DecodedGapless[]): Map<Hex, CoverSummary & { armedAt: number | null; armToTrigger: number | null }> {
  const covers = new Map<Hex, CoverSummary & { armedAt: number | null; armToTrigger: number | null }>();
  for (const d of decoded) {
    if (d.log.source !== 'manager') continue;
    const id = d.args.coverId as Hex | undefined;
    if (d.name === 'CoverBought' && id) {
      covers.set(id, {
        coverId: id,
        account: getAddress(d.args.account as string),
        perpId: Number(big(d.args.perpId)),
        status: 'live',
        stopPNS: big(d.args.stopPNS).toString(),
        paidCNS: '0',
        boughtTx: d.log.txHash,
        armedAt: null,
        armToTrigger: null
      });
      continue;
    }
    const c = id ? covers.get(id) : undefined;
    if (!c) continue;
    switch (d.name) {
      case 'Armed':
        c.status = 'armed';
        c.armedAt = d.log.block;
        break;
      case 'Disarmed':
        c.status = 'live';
        c.armedAt = null;
        break;
      case 'Triggered':
        if (c.status !== 'triggered' && c.armedAt !== null) c.armToTrigger = d.log.block - c.armedAt;
        c.status = 'triggered';
        c.paidCNS = (BigInt(c.paidCNS) + big(d.args.paidNowCNS)).toString();
        break;
      case 'Finalized':
        c.status = 'finalized';
        c.paidCNS = big(d.args.totalPaidCNS).toString();
        break;
      case 'CoverEnded': {
        const s = STATUS_NAMES[Number(d.args.status)];
        if (s) c.status = s;
        break;
      }
    }
  }
  return covers;
}

export const GAPLESS_STATS_METHOD = {
  source: 'HyperSync over the configured CoverManager, CoverVault, GaplessFactory and GaplessCreSink addresses from GAPLESS_START_BLOCK, decoded with the frozen ABIs',
  covers: 'status from the latest lifecycle event per cover (CoverBought live, Armed, Disarmed live, Triggered, Finalized, CoverEnded status). Armed past armTtl still reads armed here; onchain it is lazily Live',
  owners: 'distinct factory owners whose account bought at least one cover; accounts = AccountCreated count',
  notionalCoveredCNS: 'sum over CoverBought of lots x stopPNS x scale (MarketListed cfg.scale of the perp), at purchase',
  premiums: 'rentCNS = sum CoverBought.rentCNS; escrowToVaultCNS = sum Finalized.escrowToVaultCNS + EscrowForfeited; toLpsCNS and toTreasuryCNS = sum PremiumReceived',
  payouts: 'count = covers with a payout; paidCNS = sum vault Paid; owedCNS = latest OwedUpdated (outstanding)',
  armToTriggerBlocks: 'first Triggered block minus the latest Armed block before it; fast-path triggers without an arm are not counted',
  vault: 'totalAssetsCNS and utilizationBps read onchain at generation time; lpCount = addresses holding vault shares by Transfer events (excluding the vault and zero address)',
  firsts: 'deployTx = earliest indexed Gapless log tx (the deploy tx when GAPLESS_START_BLOCK is the deploy block)'
} as const;

const ZERO = '0x0000000000000000000000000000000000000000';

/** Every number of the `gapless` block of /api/stats, from decoded logs plus one onchain vault read. */
export function computeGaplessStats(decoded: readonly DecodedGapless[], vault: VaultRead, vaultAddress: Address | undefined) {
  const covers = coverStates(decoded);
  const by = (src: GaplessSourceKind, name: string) => decoded.filter((d) => d.log.source === src && d.name === name);
  const scale = new Map<number, bigint>();
  for (const d of by('manager', 'MarketListed')) scale.set(Number(big(d.args.perpId)), big((d.args.cfg as { scale?: bigint } | undefined)?.scale));
  const counts = { total: covers.size, live: 0, armed: 0, triggered: 0, finalized: 0, expired: 0, cancelled: 0, voided: 0 };
  for (const c of covers.values()) if (c.status !== 'none') counts[c.status]++;

  let notional = 0n;
  let rent = 0n;
  for (const d of by('manager', 'CoverBought')) {
    notional += big(d.args.lots) * big(d.args.stopPNS) * (scale.get(Number(big(d.args.perpId))) ?? 0n);
    rent += big(d.args.rentCNS);
  }
  const sum = (src: GaplessSourceKind, name: string, field: string) => by(src, name).reduce((s, d) => s + big(d.args[field]), 0n);
  const owedUpdates = by('vault', 'OwedUpdated');

  const ownerOf = new Map<string, string>();
  for (const d of by('factory', 'AccountCreated')) ownerOf.set((d.args.account as string).toLowerCase(), (d.args.owner as string).toLowerCase());
  const coveredOwners = new Set([...covers.values()].map((c) => ownerOf.get(c.account.toLowerCase()) ?? c.account.toLowerCase()));

  const shares = new Map<string, bigint>();
  for (const d of by('vault', 'Transfer')) {
    const from = (d.args.from as string).toLowerCase();
    const to = (d.args.to as string).toLowerCase();
    const v = big(d.args.value);
    shares.set(from, (shares.get(from) ?? 0n) - v);
    shares.set(to, (shares.get(to) ?? 0n) + v);
  }
  const skip = new Set([ZERO, vaultAddress?.toLowerCase()]);
  const lpCount = [...shares].filter(([a, v]) => v > 0n && !skip.has(a)).length;

  const arm = p50Max([...covers.values()].map((c) => c.armToTrigger).filter((x): x is number => x !== null));
  const firstOf = (name: string) => by('manager', name)[0]?.log.txHash ?? null;
  const reports = by('sink', 'CreReport');

  return {
    covers: counts,
    owners: [...coveredOwners].length,
    accounts: by('factory', 'AccountCreated').length,
    notionalCoveredCNS: notional.toString(),
    premiums: {
      escrowToVaultCNS: (sum('manager', 'Finalized', 'escrowToVaultCNS') + sum('manager', 'EscrowForfeited', 'amountCNS')).toString(),
      rentCNS: rent.toString(),
      toLpsCNS: sum('vault', 'PremiumReceived', 'toLpsCNS').toString(),
      toTreasuryCNS: sum('vault', 'PremiumReceived', 'toTreasuryCNS').toString()
    },
    payouts: {
      count: [...covers.values()].filter((c) => BigInt(c.paidCNS) > 0n).length,
      paidCNS: sum('vault', 'Paid', 'amountCNS').toString(),
      owedCNS: owedUpdates.length ? big(owedUpdates[owedUpdates.length - 1]!.args.owedTotalCNS).toString() : '0'
    },
    armToTriggerBlocks: arm,
    vault: {
      totalAssetsCNS: vault ? vault.totalAssetsCNS.toString() : null,
      lpCount,
      utilizationBps: vault ? vault.utilizationBps : null
    },
    cre: {
      reports: reports.length,
      armed: reports.reduce((s, d) => s + Number(big(d.args.armed)), 0),
      triggered: reports.reduce((s, d) => s + Number(big(d.args.triggered)), 0)
    },
    firsts: {
      deployTx: decoded[0]?.log.txHash ?? null,
      firstCoverTx: firstOf('CoverBought'),
      firstTriggerTx: firstOf('Triggered')
    }
  };
}

export type GaplessStats = ReturnType<typeof computeGaplessStats>;

/** Wallet drill-down: the Gapless account an owner or clone address maps to, with its covers (newest first). */
export function gaplessForAddress(db: Database, address: Address, maxCovers = 50): { account: Address; owner: Address; covers: CoverSummary[] } | null {
  const padded = pad(address.toLowerCase() as Hex, { size: 32 });
  const created = db
    .query<GaplessLog, { t: string }>(
      `SELECT ${LOG_COLS} FROM gapless_logs WHERE source = 'factory' AND (topic1 = $t OR topic2 = $t) ORDER BY block DESC, log_index DESC LIMIT 1`
    )
    .get({ t: padded });
  if (!created) return null;
  const ev = decodeGaplessLogs([created]).decoded[0];
  if (!ev || ev.name !== 'AccountCreated') return null;
  const account = getAddress(ev.args.account as string);
  const owner = getAddress(ev.args.owner as string);
  const accountTopic = pad(account.toLowerCase() as Hex, { size: 32 });
  // CoverBought: topic2 is the indexed account. Then every manager log keyed by those cover ids (topic1).
  const bought = db
    .query<GaplessLog, { t: string; limit: number }>(
      `SELECT ${LOG_COLS} FROM gapless_logs WHERE source = 'manager' AND topic2 = $t ORDER BY block DESC, log_index DESC LIMIT $limit`
    )
    .all({ t: accountTopic, limit: maxCovers * 4 });
  const ids = [...new Set(decodeGaplessLogs(bought).decoded.filter((d) => d.name === 'CoverBought').map((d) => d.args.coverId as Hex))].slice(0, maxCovers);
  const byId = db.query<GaplessLog, { id: string }>(`SELECT ${LOG_COLS} FROM gapless_logs WHERE source = 'manager' AND topic1 = $id ORDER BY block, log_index`);
  const logs = ids.flatMap((id) => byId.all({ id })).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const states = coverStates(decodeGaplessLogs(logs).decoded);
  const covers = ids
    .map((id) => states.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map(({ armedAt: _a, armToTrigger: _t, ...c }) => c);
  return { account, owner, covers };
}
