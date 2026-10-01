import {
  BaseError,
  ContractFunctionRevertedError,
  decodeEventLog,
  parseAbi,
  toEventSelector,
  type Address,
  type DecodeEventLogReturnType,
  type Hex
} from 'viem';
import { PERPL_EXCHANGE } from '../lib/addresses.ts';
import type { MonadPublicClient } from '../lib/chain.ts';

// Exchange v1.7.5 events, asserted against Exchange.abi.json in perpl-events.test.ts. No param is
// indexed, so topic0 is the only filter. V1 fill/open/increase are omitted: 1.7.5 emits only V2.
export const PERPL_EVENTS_ABI = parseAbi([
  'event MarkUpdated(uint256 perpId, uint256 pricePNS)',
  'event LinkPriceUpdated(uint256 perpId, uint256 oraclePricePNS, uint256 timestamp)',
  'event UpdateOracleFailed(uint256 perpId)',
  'event ReportAgeExceedsLastUpdate(uint256 perpId, uint256 lastUpdateTimestamp, uint256 reportValidFromTimestamp)',
  'event MarkExceedsTol(uint256 perpId, uint256 markPNS, uint256 spotOraclePricePNS, uint256 tolerancePer100k)',
  'event MakerOrderFilledV2(uint256 perpId, uint256 accountId, uint256 orderId, uint256 pricePNS, uint256 lotLNS, uint256 feeCNS, uint256 lockedBalanceCNS, int256 amountCNS, uint256 balanceCNS, uint256 builderId, uint256 builderFeeCNS)',
  'event PositionOpenedV2(uint256 perpId, uint256 accountId, uint8 positionType, uint256 leverageHdths, uint256 depositCNS, int256 pnlCollateralizedCNS, uint256 pricePNS, uint256 lotLNS, uint256 insFeeCNS, uint256 protFeeCNS, uint256 priceResiduePNSQ16)',
  'event PositionIncreasedV2(uint256 perpId, uint256 accountId, uint8 positionType, uint256 leverageHdths, uint256 startDepositCNS, uint256 endDepositCNS, int256 pnlCollateralizedCNS, int256 premiumPnlSettledCNS, uint256 maxNegPnlCollatBPS, uint256 pricePNS, uint256 startLotLNS, uint256 endLotLNS, uint256 insFeeCNS, uint256 protFeeCNS, uint256 priceResiduePNSQ16)',
  'event PositionDecreased(uint256 perpId, uint256 accountId, uint8 positionType, uint256 startDepositCNS, uint256 endDepositCNS, uint256 startLotLNS, uint256 endLotLNS, int256 deltaPnlCNS, int256 fundingCNS)',
  'event PositionClosed(uint256 perpId, uint256 accountId, uint8 positionType, uint256 pricePNS, int256 deltaPnlCNS, int256 fundingCNS)',
  'event PositionInverted(uint256 perpId, uint256 accountId, uint8 positionType, uint256 leverageHdths, uint256 startDepositCNS, uint256 endDepositCNS, int256 pnlCollateralizedCNS, uint256 pricePNS, uint256 startLotLNS, uint256 endLotLNS, int256 deltaPnlCNS, int256 fundingCNS, uint256 insFeeCNS, uint256 protFeeCNS)',
  'event PositionLiquidated(uint256 perpId, uint256 posAccountId, uint8 positionType, uint256 markPricePNS, uint256 liqPricePNS, uint256 liqLotLNS, uint256 posLotLNS, int256 deltaPnlCNS, int256 fundingCNS, int256 posAmountCNS, uint256 posDepositCNS, int256 accAmountCNS, uint256 accBalanceCNS, bool onOrderBook)',
  'event PositionDeleveragedV2(uint256 perpId, uint256 accountId, bool forceClose, uint8 positionType, uint256 entryPricePNS, uint256 markPricePNS, uint256 deleveragePricePNS, int256 deltaPnlCNS, int256 fundingCNS, uint256 startDepositCNS, uint256 endDepositCNS, uint256 startLotLNS, uint256 endLotLNS, uint256 amountCNS, uint256 balanceCNS, uint256 priceResiduePNSQ16)',
  'event CollateralDeposit(uint256 accountId, uint256 amountCNS, uint256 balanceCNS)',
  'event CollateralWithdrawal(uint256 accountId, uint256 amountCNS, uint256 balanceCNS)'
]);

/** topic0 per event, computed (keccak of the canonical signature), never copied. */
export const PERPL_TOPICS: readonly Hex[] = PERPL_EVENTS_ABI.map((e) => toEventSelector(e));

export type PerplEvent = DecodeEventLogReturnType<typeof PERPL_EVENTS_ABI>;

/** Decodes one Exchange log; null for any topic0 outside PERPL_EVENTS_ABI. Throws on malformed data. */
export function decodePerplLog(topics: readonly Hex[], data: Hex): PerplEvent | null {
  const [topic0] = topics;
  if (!topic0 || !PERPL_TOPICS.includes(topic0)) return null;
  return decodeEventLog({
    abi: PERPL_EVENTS_ABI,
    topics: topics as [Hex, ...Hex[]],
    data,
    strict: true
  });
}

const EXCHANGE_READ_ABI = parseAbi([
  'struct PerpetualInfo { string name; string symbol; uint256 priceDecimals; uint256 lotDecimals; bytes32 linkFeedId; uint256 priceTolPer100K; uint256 marginTol; uint256 marginTolDecimals; uint256 refPriceMaxAgeSec; uint256 positionBalanceCNS; uint256 insuranceBalanceCNS; uint256 markPNS; uint256 markTimestamp; uint256 lastPNS; uint256 lastTimestamp; uint256 oraclePNS; uint256 oracleTimestampSec; uint256 longOpenInterestLNS; uint256 shortOpenInterestLNS; uint256 fundingStartBlock; int16 fundingRatePct100k; uint256 absFundingClampPctPer100K; uint8 status; uint256 basePricePNS; uint256 maxBidPriceONS; uint256 minBidPriceONS; uint256 maxAskPriceONS; uint256 minAskPriceONS; uint256 numOrders; bool ignOracle; }',
  'struct PositionBitMap { uint256 bank1; uint256 bank2; uint256 bank3; uint256 bank4; }',
  'struct AccountInfo { uint256 accountId; uint256 balanceCNS; uint256 lockedBalanceCNS; uint8 frozen; address accountAddr; PositionBitMap positions; }',
  'function getPerpetualExistsBitmap() view returns (uint256[4] bitmap)',
  'function getPerpetualInfo(uint256 perpId) view returns (PerpetualInfo perpetualInfo)',
  'function getAccountByAddr(address accountAddress) view returns (AccountInfo accountInfo)',
  'error AccountDoesNotExist(address accountAddress)'
]);

export interface PerpMeta {
  perpId: number;
  name: string;
  symbol: string;
  priceDecimals: number;
  lotDecimals: number;
  status: number;
}

/** Perp ids set in a uint256[4] bitmap (bit i of word k is perp k * 256 + i). */
export function perpIdsFromBitmap(words: readonly bigint[]): number[] {
  const ids: number[] = [];
  words.forEach((w, k) => {
    for (let i = 0; i < 256; i++) if ((w >> BigInt(i)) & 1n) ids.push(k * 256 + i);
  });
  return ids;
}

/** Every perp in the Exchange bitmap with its decimals and status, in one multicall. */
export async function readPerps(client: MonadPublicClient): Promise<PerpMeta[]> {
  const bitmap = await client.readContract({
    address: PERPL_EXCHANGE,
    abi: EXCHANGE_READ_ABI,
    functionName: 'getPerpetualExistsBitmap'
  });
  const ids = perpIdsFromBitmap(bitmap);
  const infos = await client.multicall({
    allowFailure: false,
    contracts: ids.map((id) => ({
      address: PERPL_EXCHANGE,
      abi: EXCHANGE_READ_ABI,
      functionName: 'getPerpetualInfo' as const,
      args: [BigInt(id)] as const
    }))
  });
  return infos.map((p, i) => ({
    perpId: ids[i]!,
    name: p.name,
    symbol: p.symbol,
    priceDecimals: Number(p.priceDecimals),
    lotDecimals: Number(p.lotDecimals),
    status: p.status
  }));
}

/** Perpl account id owned by `address` (01 §2); null on AccountDoesNotExist, any other failure throws. */
export async function resolvePerplAccountId(client: MonadPublicClient, address: Address): Promise<bigint | null> {
  try {
    const info = await client.readContract({
      address: PERPL_EXCHANGE,
      abi: EXCHANGE_READ_ABI,
      functionName: 'getAccountByAddr',
      args: [address]
    });
    return info.accountId === 0n ? null : info.accountId;
  } catch (err) {
    const revert = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === 'AccountDoesNotExist') return null;
    throw err;
  }
}
