import { decodeEventLog, decodeFunctionData, parseAbi, toEventSelector, type Address, type Hex } from 'viem';
import { MAX_START_MARK_AGE_BLOCKS } from './config.ts';
import type { RawLog } from './rows.ts';
import { safeNum } from './rows.ts';
import { percentile, round2 } from './stats.ts';

// Exchange 1.7.5 events and calldata for native trigger orders (memory/perpl_stop_semantics_2026-10-05.md).
// Selectors are asserted against Exchange.abi.json in test/jobs/native-stops.test.ts.
export const NATIVE_EVENTS_ABI = parseAbi([
  'event OrderRequestV2(uint256 perpId, uint256 accountId, uint256 orderDescId, uint256 orderId, uint8 orderType, uint256 pricePNS, uint256 lotLNS, uint256 expiryBlock, bool postOnly, bool fillOrKill, bool immediateOrCancel, uint256 maxMatches, uint256 leverageHdths, uint256 lastExecutionBlock, uint256 amountCNS, uint256 maxNegPnlCollatBPS, uint256 gasLeft, bytes extension)',
  'event TriggerOrderRequest(uint256 triggerPricePNS, uint8 triggerPriceCondition, uint256 triggerRequestId, uint256 triggerPositionId)',
  'event TriggerOrderExecution()',
  'event TakerOrderFilledV2(uint256 entryPricePNS, uint256 collatPricePNS, uint256 pnlPricePNS, uint256 lotLNS, uint256 feeCNS, int256 amountCNS, uint256 balanceCNS, uint256 builderId, uint256 builderFeeCNS)'
]);

const topicOf = (name: (typeof NATIVE_EVENTS_ABI)[number]['name']) =>
  toEventSelector(NATIVE_EVENTS_ABI.find((e) => e.name === name)!);

export const NATIVE_TOPICS = {
  orderRequest: topicOf('OrderRequestV2'),
  triggerRequest: topicOf('TriggerOrderRequest'),
  triggerExecution: topicOf('TriggerOrderExecution'),
  takerFill: topicOf('TakerOrderFilledV2')
} as const;

/** The HyperSync log selection: either trigger topic matches a tx; JoinAll then returns every log of it. */
export const TRIGGER_TOPICS: readonly Hex[] = [NATIVE_TOPICS.triggerRequest, NATIVE_TOPICS.triggerExecution];

const FWD_ABI = parseAbi([
  'struct OrderDesc { uint256 orderDescId; uint256 perpId; uint8 orderType; uint256 orderId; uint256 pricePNS; uint256 lotLNS; uint256 expiryBlock; bool postOnly; bool fillOrKill; bool immediateOrCancel; uint256 maxMatches; uint256 leverageHdths; uint256 lastExecutionBlock; uint256 amountCNS; uint256 maxNegPnlCollatBPS; }',
  'struct FwdOrderDesc { uint256 accountId; uint256 feePer100K; OrderDesc orderDesc; bool execTriggerOrder; uint256 triggerPricePNS; uint8 triggerPriceCondition; uint256 triggerRequestId; uint256 triggerPositionId; }',
  'function execFwdPositionOpsV2(FwdOrderDesc[] forwardedOrders, bytes[] extensions)',
  'function execFwdPositionOps(FwdOrderDesc[] forwardedOrders)'
]);

/** OrderDescEnum values seen onchain (0-indexed). */
export const ORDER_TYPE = { CloseLong: 2, CloseShort: 3, Cancel: 4 } as const;
/** TriggerPriceConditionEnum, 0-indexed onchain (the API `tpc` is 1-indexed). */
export const CONDITION = { GTELast: 0, LTELast: 1, GTEMark: 2, LTEMark: 3 } as const;

export type CloseType = 2 | 3;

/** One tx of a JoinAll page: its Exchange logs in logIndex order plus the sender and calldata. */
export interface NativeTx {
  hash: Hex;
  block: number;
  ts: number;
  from: Address | null;
  input: Hex | null;
  logs: RawLog[];
}

export type Placement = {
  block: number;
  logIndex: number;
  ts: number;
  txHash: Hex;
  accountId: number;
  perpId: number;
  closeType: CloseType;
  lotLNS: number;
  triggerPNS: number;
  condition: number;
  kind: 'market' | 'limit';
  limitPNS: number | null;
  requestId: string;
  positionId: string;
};

export type Cancel = {
  block: number;
  logIndex: number;
  ts: number;
  txHash: Hex;
  accountId: number;
  perpId: number;
  triggerPNS: number;
  condition: number;
};

export type Execution = {
  block: number;
  logIndex: number;
  ts: number;
  txHash: Hex;
  execFrom: Address | null;
  /** 1: calldata forwards this order with execTriggerOrder; 0: calldata decoded but no such order; null: not decodable. */
  calldataMatch: number | null;
  accountId: number;
  perpId: number;
  closeType: CloseType;
  lotLNS: number;
  iocLimitPNS: number;
  orderDescId: string;
  filledLNS: number;
  /** sum(collatPricePNS x lotLNS) over TakerOrderFilledV2, decimal string. */
  fillNotional: string;
  fillVwapPNS: number | null;
};

export interface NativeProblem {
  block: number;
  logIndex: number;
  txHash: Hex;
  topic0: Hex | null;
  data: string;
  reason: string;
}

export interface ParsedNative {
  placements: Placement[];
  cancels: Cancel[];
  executions: Execution[];
  problems: NativeProblem[];
}

export const emptyParsed = (): ParsedNative => ({ placements: [], cancels: [], executions: [], problems: [] });

type OrderReq = { logIndex: number; perpId: number; accountId: number; orderType: number; pricePNS: number; lotLNS: number; orderDescId: bigint };

const isClose = (t: number): t is CloseType => t === ORDER_TYPE.CloseLong || t === ORDER_TYPE.CloseShort;

function problem(log: RawLog, reason: string): NativeProblem {
  return {
    block: log.blockNumber,
    logIndex: log.logIndex,
    txHash: log.transactionHash,
    topic0: log.topics[0] ?? null,
    data: log.data.length > 16_384 ? `${log.data.slice(0, 16_384)}...` : log.data,
    reason: `native: ${reason}`.slice(0, 300)
  };
}

/** Forwarded orders flagged execTriggerOrder in the calldata, keyed `${accountId}:${orderDescId}`; null when undecodable. */
export function forwardedTriggerOrders(input: Hex | null): Set<string> | null {
  if (!input || input.length < 10) return null;
  try {
    const { args } = decodeFunctionData({ abi: FWD_ABI, data: input });
    const out = new Set<string>();
    for (const f of args[0]) if (f.execTriggerOrder) out.add(`${f.accountId}:${f.orderDesc.orderDescId}`);
    return out;
  } catch {
    return null;
  }
}

/**
 * Splits one tx into placements, cancels and executions. Measured shape: a placement is OrderRequestV2(Close*)
 * then TriggerOrderRequest; a cancel is OrderRequestV2(Cancel) then TriggerOrderRequest naming the old trigger
 * price; an execution is OrderRequestV2(Close*, IOC limit) then TriggerOrderExecution, its taker fills follow
 * until the next OrderRequestV2.
 */
export function parseNativeTx(tx: NativeTx): ParsedNative {
  const out = emptyParsed();
  const fwd = forwardedTriggerOrders(tx.input);
  let order: OrderReq | null = null;
  let exec: (Execution & { notional: bigint }) | null = null;
  const closeExec = () => {
    if (!exec) return;
    const { notional, ...e } = exec;
    out.executions.push({
      ...e,
      fillNotional: notional.toString(),
      fillVwapPNS: e.filledLNS > 0 ? Number(notional / BigInt(e.filledLNS)) : null
    });
    exec = null;
  };

  for (const log of tx.logs) {
    const t0 = log.topics[0];
    if (t0 !== NATIVE_TOPICS.orderRequest && t0 !== NATIVE_TOPICS.triggerRequest && t0 !== NATIVE_TOPICS.triggerExecution && t0 !== NATIVE_TOPICS.takerFill) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: NATIVE_EVENTS_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    } catch (err) {
      out.problems.push(problem(log, `decode: ${err instanceof Error ? err.message : String(err)}`));
      continue;
    }
    try {
      switch (ev.eventName) {
        case 'OrderRequestV2': {
          closeExec();
          const a = ev.args;
          order = {
            logIndex: log.logIndex,
            perpId: safeNum(a.perpId, 'perpId'),
            accountId: safeNum(a.accountId, 'accountId'),
            orderType: a.orderType,
            pricePNS: safeNum(a.pricePNS, 'pricePNS'),
            lotLNS: safeNum(a.lotLNS, 'lotLNS'),
            orderDescId: a.orderDescId
          };
          break;
        }
        case 'TriggerOrderRequest': {
          const o = order;
          order = null;
          if (!o) {
            out.problems.push(problem(log, 'trigger request without a preceding order request'));
            break;
          }
          const a = ev.args;
          const at = { block: tx.block, logIndex: log.logIndex, ts: tx.ts, txHash: tx.hash, accountId: o.accountId, perpId: o.perpId };
          const triggerPNS = safeNum(a.triggerPricePNS, 'triggerPricePNS');
          if (isClose(o.orderType)) {
            out.placements.push({
              ...at,
              closeType: o.orderType,
              lotLNS: o.lotLNS,
              triggerPNS,
              condition: a.triggerPriceCondition,
              kind: o.pricePNS === 0 ? 'market' : 'limit',
              limitPNS: o.pricePNS === 0 ? null : o.pricePNS,
              requestId: a.triggerRequestId.toString(),
              positionId: a.triggerPositionId.toString()
            });
          } else if (o.orderType === ORDER_TYPE.Cancel) {
            out.cancels.push({ ...at, triggerPNS, condition: a.triggerPriceCondition });
          }
          // Triggers on open orders are not stops; skipped.
          break;
        }
        case 'TriggerOrderExecution': {
          const o = order;
          order = null;
          if (!o || !isClose(o.orderType)) {
            out.problems.push(problem(log, 'trigger execution without a preceding close order request'));
            break;
          }
          exec = {
            block: tx.block,
            logIndex: log.logIndex,
            ts: tx.ts,
            txHash: tx.hash,
            execFrom: tx.from,
            calldataMatch: fwd === null ? null : fwd.has(`${o.accountId}:${o.orderDescId}`) ? 1 : 0,
            accountId: o.accountId,
            perpId: o.perpId,
            closeType: o.orderType,
            lotLNS: o.lotLNS,
            iocLimitPNS: o.pricePNS,
            orderDescId: o.orderDescId.toString(),
            filledLNS: 0,
            fillNotional: '0',
            fillVwapPNS: null,
            notional: 0n
          };
          break;
        }
        case 'TakerOrderFilledV2':
          if (exec) {
            const e: Execution & { notional: bigint } = exec;
            e.filledLNS += safeNum(ev.args.lotLNS, 'lotLNS');
            e.notional += ev.args.collatPricePNS * ev.args.lotLNS;
          }
          break;
      }
    } catch (err) {
      out.problems.push(problem(log, `map: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  closeExec();
  return out;
}

export function parseNativeTxs(txs: readonly NativeTx[]): ParsedNative {
  const out = emptyParsed();
  for (const tx of txs) {
    const p = parseNativeTx(tx);
    out.placements.push(...p.placements);
    out.cancels.push(...p.cancels);
    out.executions.push(...p.executions);
    out.problems.push(...p.problems);
  }
  return out;
}

export type JoinStatus = 'joined' | 'ambiguous' | 'unjoined';

export interface JoinResult {
  /** Per execution key `${block}:${logIndex}`. */
  executions: Map<string, { status: JoinStatus; placement: Placement | null }>;
  /** Per placement key: the cancel or execution that ended it. */
  ended: Map<string, { cancelledBlock?: number; cancelTx?: Hex; executedBlock?: number; execTx?: Hex }>;
}

export const rowKey = (r: { block: number; logIndex: number }) => `${r.block}:${r.logIndex}`;
const byPos = (a: { block: number; logIndex: number }, b: { block: number; logIndex: number }) => a.block - b.block || a.logIndex - b.logIndex;

/**
 * Join rule (memory/perpl_stop_semantics): execution calldata zeroes the trigger fields, so an execution joins the
 * latest live placement with the same account, perp, close type and lots. A cancel ends the latest live placement
 * of that account and perp with the named trigger price. More than one live candidate is `ambiguous` (joined to
 * the latest, kept out of outcome stats); none is `unjoined`.
 */
export function joinNativeStops(placements: readonly Placement[], cancels: readonly Cancel[], executions: readonly Execution[]): JoinResult {
  type Ev = { kind: 'p'; r: Placement } | { kind: 'c'; r: Cancel } | { kind: 'e'; r: Execution };
  const events: Ev[] = [
    ...placements.map((r) => ({ kind: 'p' as const, r })),
    ...cancels.map((r) => ({ kind: 'c' as const, r })),
    ...executions.map((r) => ({ kind: 'e' as const, r }))
  ].sort((a, b) => byPos(a.r, b.r));
  const live = new Map<string, Placement[]>();
  const out: JoinResult = { executions: new Map(), ended: new Map() };
  const acct = (r: { accountId: number; perpId: number }) => `${r.accountId}:${r.perpId}`;
  const remove = (key: string, p: Placement) => {
    const xs = live.get(key)!;
    xs.splice(xs.indexOf(p), 1);
  };

  for (const ev of events) {
    const key = acct(ev.r);
    if (ev.kind === 'p') {
      const xs = live.get(key) ?? [];
      xs.push(ev.r);
      live.set(key, xs);
    } else if (ev.kind === 'c') {
      const c = ev.r;
      const hit = [...(live.get(key) ?? [])].reverse().find((p) => p.triggerPNS === c.triggerPNS);
      if (!hit) continue;
      remove(key, hit);
      out.ended.set(rowKey(hit), { cancelledBlock: c.block, cancelTx: c.txHash });
    } else {
      const e = ev.r;
      const cands = (live.get(key) ?? []).filter((p) => p.closeType === e.closeType && p.lotLNS === e.lotLNS);
      if (cands.length === 0) {
        out.executions.set(rowKey(e), { status: 'unjoined', placement: null });
        continue;
      }
      const p = cands[cands.length - 1]!;
      remove(key, p);
      out.ended.set(rowKey(p), { executedBlock: e.block, execTx: e.txHash });
      out.executions.set(rowKey(e), { status: cands.length === 1 ? 'joined' : 'ambiguous', placement: p });
    }
  }
  return out;
}

/** Adverse bps of a fill vs a reference: closing a long sells (lower is worse), closing a short buys. */
export function adverseBps(closeType: CloseType, fillPNS: number, refPNS: number): number | null {
  if (refPNS <= 0) return null;
  const raw = closeType === ORDER_TYPE.CloseLong ? (refPNS - fillPNS) / refPNS : (fillPNS - refPNS) / refPNS;
  return round2(raw * 1e4);
}

export const isMarkCondition = (c: number) => c === CONDITION.GTEMark || c === CONDITION.LTEMark;

/** Mark reads the delay and mark slippage need; the jobs store implements them. */
export interface MarkLookup {
  markAtOrBefore(perpId: number, block: number): { block: number; pricePNS: number } | null;
  /** First block in (fromBlock, toBlock] whose mark satisfies `gte ? mark >= price : mark <= price`. */
  firstMarkCrossing(perpId: number, fromBlock: number, toBlock: number, pricePNS: number, gte: boolean): number | null;
}

/**
 * Blocks from max(first onchain mark at or through the trigger, placement) to execution. Null for last-price
 * conditions and for stops that fired before any onchain crossing (Perpl's offchain mark leads by under 5 bps).
 */
export function delayBlocks(p: Placement, e: Execution, marks: MarkLookup): number | null {
  if (!isMarkCondition(p.condition)) return null;
  const gte = p.condition === CONDITION.GTEMark;
  const through = (m: number) => (gte ? m >= p.triggerPNS : m <= p.triggerPNS);
  const atPlace = marks.markAtOrBefore(p.perpId, p.block);
  const crossing = atPlace && through(atPlace.pricePNS) ? p.block : marks.firstMarkCrossing(p.perpId, p.block, e.block, p.triggerPNS, gte);
  return crossing === null ? null : e.block - crossing;
}

/** Fill vs the latest onchain mark published before the execution block (within MAX_START_MARK_AGE_BLOCKS). */
export function slippageVsMarkBps(e: Execution, marks: MarkLookup): number | null {
  if (e.fillVwapPNS === null) return null;
  const m = marks.markAtOrBefore(e.perpId, e.block - 1);
  if (!m || e.block - m.block > MAX_START_MARK_AGE_BLOCKS) return null;
  return adverseBps(e.closeType, e.fillVwapPNS, m.pricePNS);
}

export const slippageVsTriggerBps = (p: Placement, e: Execution): number | null =>
  e.fillVwapPNS === null ? null : adverseBps(e.closeType, e.fillVwapPNS, p.triggerPNS);

export interface Spread {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

/** Nearest-rank p50 and p95, rounded to 2 decimals. */
export function spread(values: readonly number[]): Spread {
  const s = [...values].sort((a, b) => a - b);
  const r = (x: number | null) => (x === null ? null : round2(x));
  return { n: s.length, p50: r(percentile(s, 50)), p95: r(percentile(s, 95)), max: r(s.length ? s[s.length - 1]! : null) };
}

export const NATIVE_STOP_METHOD = {
  source:
    'HyperSync JoinAll on Exchange topic0 TriggerOrderRequest and TriggerOrderExecution: every log of each matched tx, plus tx from and input',
  placement: 'OrderRequestV2 (CloseLong 2 or CloseShort 3; pricePNS 0 = market, else limit) followed by TriggerOrderRequest in the same tx',
  cancel: 'OrderRequestV2 (Cancel 4) followed by TriggerOrderRequest naming the cancelled trigger price; ends the latest live placement of that account and perp with that price',
  execution:
    'OrderRequestV2 (close, IOC limit) followed by TriggerOrderExecution; fills = TakerOrderFilledV2 until the next OrderRequestV2; VWAP = sum(collatPricePNS x lot) / filled lots. calldataMatch checks execFwdPositionOpsV2 forwards the order with execTriggerOrder',
  join: 'execution calldata zeroes the trigger fields, so it joins the latest live placement with the same account, perp, close type and lots (cancellations applied). One candidate = joined; several = ambiguous (kept out of outcomes); none = unjoined (placed before ingest coverage, or not matchable). joinRate = joined / executions',
  slippage: 'adverse bps of the fill VWAP vs the trigger price (joined only) and vs the latest onchain mark before the execution block; positive = worse for the closing side',
  delay: 'execution block minus max(placement block, first onchain MarkUpdated at or through the trigger); mark conditions only; null when the stop fired before an onchain crossing',
  outcomes: 'partial = 0 < filled < lots; unfilled = no taker fill. Not a guarantee measure in a gap: the sample window decides what market conditions are covered'
} as const;
