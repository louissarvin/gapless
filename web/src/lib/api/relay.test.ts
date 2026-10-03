import { describe, expect, it } from 'vitest'
import {
  activateDataSchema,
  keeperConsoleDataSchema,
  nativeStopsDataSchema,
  sponsorCreateDataSchema,
  sponsorCreateRequestSchema,
  stalenessDataSchema,
  statsDataSchema,
  summaryDataSchema,
  walletDataSchema,
} from './relay'

describe('sponsorCreateRequestSchema', () => {
  const valid = {
    owner: '0xb07C20cb5328d5208A1453521b94beeB3Faa1771',
    grant: {
      key: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
      expiry: '1700000000',
      maxNotionalPerTradeCNS: '25000000',
      maxNotionalPerDayCNS: '100000000',
    },
    deadline: '1700086400',
    sig: `0x${'a'.repeat(130)}`,
  }

  it('accepts a well-formed grant and signature', () => {
    expect(sponsorCreateRequestSchema.parse(valid)).toEqual(valid)
  })

  it('rejects a signature that is not 65 bytes', () => {
    expect(() =>
      sponsorCreateRequestSchema.parse({ ...valid, sig: '0x1234' }),
    ).toThrow()
  })

  it('rejects an unknown extra key (relay bodies are strict)', () => {
    expect(() =>
      sponsorCreateRequestSchema.strict().parse({ ...valid, extra: 'nope' }),
    ).toThrow()
  })
})

describe('sponsorCreateDataSchema', () => {
  it('accepts the documented 200 shape', () => {
    const data = {
      owner: '0xb07C20cb5328d5208A1453521b94beeB3Faa1771',
      account: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
      status: 'created',
      txHash: '0x' + 'ab'.repeat(32),
      blockNumber: '111101834',
    }
    expect(sponsorCreateDataSchema.parse(data)).toEqual(data)
  })

  it('accepts null txHash and blockNumber (pending)', () => {
    const data = {
      owner: '0xb07C20cb5328d5208A1453521b94beeB3Faa1771',
      account: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
      status: 'pending',
      txHash: null,
      blockNumber: null,
    }
    expect(sponsorCreateDataSchema.parse(data)).toEqual(data)
  })
})

describe('activateDataSchema', () => {
  it('accepts a drip-skipped shape', () => {
    const data = {
      account: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
      perplAccountId: '7',
      sweepTx: null,
      drip: null,
      dripSkipped: 'already_funded',
    }
    expect(activateDataSchema.parse(data)).toEqual(data)
  })

  it('rejects an unrecognized dripSkipped reason', () => {
    const data = {
      account: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
      perplAccountId: '7',
      sweepTx: null,
      drip: null,
      dripSkipped: 'made_up_reason',
    }
    expect(() => activateDataSchema.parse(data)).toThrow()
  })
})

describe('statsDataSchema (phase 2 section 6)', () => {
  const valid = {
    methodVersion: 'gapless-gap-index/4',
    generatedAt: '2026-10-08T17:27:00.000Z',
    stale: false,
    gapless: {
      covers: {
        total: 0,
        live: 0,
        armed: 0,
        triggered: 0,
        finalized: 0,
        expired: 0,
        cancelled: 0,
        voided: 0,
      },
      owners: 0,
      accounts: 0,
      notionalCoveredCNS: '0',
      premiums: {
        escrowToVaultCNS: '0',
        rentCNS: '0',
        toLpsCNS: '0',
        toTreasuryCNS: '0',
      },
      payouts: { count: 0, paidCNS: '0', owedCNS: '0' },
      armToTriggerBlocks: { n: 0, p50: null, max: null },
      vault: { totalAssetsCNS: '4000000', lpCount: 2, utilizationBps: 0 },
      cre: { reports: 0, armed: 0, triggered: 0 },
      firsts: { deployTx: null, firstCoverTx: null, firstTriggerTx: null },
    },
    perplNativeStops: {
      window: { fromBlock: 111_000_000, toBlock: 111_383_252 },
      executions: 905,
      joinRate: 0.61,
      slippageVsTriggerBps: { p50: 1.36, p95: 6.36 },
      delayBlocks: { p50: 4, p95: 4 },
    },
  }

  it('accepts the documented 200 shape, including a null perplNativeStops', () => {
    expect(statsDataSchema.parse(valid)).toEqual(valid)
    expect(
      statsDataSchema.parse({ ...valid, perplNativeStops: null })
        .perplNativeStops,
    ).toBeNull()
  })

  it('strips unknown keys instead of rejecting them (additive fields never break the page)', () => {
    const withExtra = {
      ...valid,
      gapless: { ...valid.gapless, undecodedLogs: 3 },
    }
    expect(statsDataSchema.parse(withExtra)).not.toHaveProperty('undecodedLogs')
  })

  it('rejects a cns field that is not a plain digit string', () => {
    expect(() =>
      statsDataSchema.parse({
        ...valid,
        gapless: { ...valid.gapless, notionalCoveredCNS: '12.5' },
      }),
    ).toThrow()
  })
})

describe('stalenessDataSchema', () => {
  it('accepts the documented shape', () => {
    const valid = {
      generatedAt: '2026-10-08T17:00:00.000Z',
      stale: false,
      window: {
        fromBlock: 111_000_000,
        toBlock: 111_383_252,
        seconds: 604_800,
      },
      perps: [
        {
          perpId: 1,
          symbol: 'BTC',
          mark: {
            publishes: 17_515,
            intervalSec: { p50: 50, p90: 51, max: 120, mean: 36 },
            staleFraction: 0,
            ageSecAtWindowEnd: 12,
          },
          oracle: {
            intervalSec: { p50: 50, p90: 51, max: 120, mean: 36 },
            reportLagSec: { p50: 1, p90: 2, max: 5, mean: 1.36 },
            staleFraction: 0,
          },
          markOracleDivergenceBps: { p50: 1.69, p99: 11.94, max: 25.08 },
        },
      ],
      method: 'onchain MarkUpdated vs oracle report lag',
    }
    expect(stalenessDataSchema.parse(valid)).toEqual(valid)
  })
})

describe('summaryDataSchema', () => {
  it('accepts a live decimal-string lastMark price', () => {
    const valid = {
      generatedAt: '2026-10-08T17:00:00.000Z',
      stale: false,
      perps: [
        {
          perpId: 1,
          symbol: 'BTC',
          lastMark: { pricePNS: 831_521, price: '83152.1', block: 111_389_182 },
          headline: [
            {
              side: 'long',
              distanceBps: 100,
              horizonBlocks: 12_000,
              pHit: 0.0289,
              markGapP99Bps: 16.85,
              markGapMaxBps: 25.88,
              distinctTriggers: 76,
            },
          ],
        },
      ],
    }
    expect(summaryDataSchema.parse(valid)).toEqual(valid)
  })
})

describe('nativeStopsDataSchema', () => {
  it('accepts totals and per-perp aggregates', () => {
    const aggregate = {
      executions: 905,
      joined: 601,
      joinRate: 0.61,
      full: 851,
      partial: 4,
      unfilled: 50,
      slippageVsTriggerBps: { n: 601, p50: 1.36, p95: 6.36, max: 18.11 },
      delayBlocks: { n: 601, p50: 4, p95: 4, max: 10 },
    }
    const valid = {
      generatedAt: '2026-10-08T17:00:00.000Z',
      stale: false,
      window: { fromBlock: 111_000_000, toBlock: 111_383_252 },
      totals: aggregate,
      perps: [{ ...aggregate, perpId: 1, symbol: 'BTC' }],
      method: {
        joinRule: 'JoinAll, placement matched by account/perp/side/lots',
      },
    }
    expect(nativeStopsDataSchema.parse(valid)).toEqual(valid)
  })
})

describe('keeperConsoleDataSchema', () => {
  it('accepts nullable coverId and txHash (section 1 note)', () => {
    const valid = {
      status: 'up' as const,
      head: { block: 111_383_252, lagBlocks: 1 },
      signer: {
        address: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
        balanceWei: '5100000000000000000',
      },
      governor: {
        utcDay: '2026-10-08',
        capWei: '4600000000000000000',
        usedWei: '0',
        exemptUsedWei: '0',
        remainingWei: '4600000000000000000',
      },
      markets: [{ perpId: 1, gated: false, maxMatchesClose: 8, liveCovers: 0 }],
      recent: [
        {
          block: 111_383_000,
          action: 'arm',
          coverId: null,
          txHash: null,
          outcome: 'pending' as const,
          gasLimit: null,
        },
      ],
      walks: {
        samples: 0,
        chainGapP50: null,
        chainGapMax: null,
        laneShare: null,
      },
      uptimeS: 3_600,
    }
    expect(keeperConsoleDataSchema.parse(valid)).toEqual(valid)
  })

  it('rejects an outcome outside the enum', () => {
    expect(() =>
      keeperConsoleDataSchema.parse({
        status: 'up',
        head: { block: 1, lagBlocks: 0 },
        signer: {
          address: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
          balanceWei: '0',
        },
        governor: {
          utcDay: '2026-10-08',
          capWei: '0',
          usedWei: '0',
          exemptUsedWei: '0',
          remainingWei: '0',
        },
        markets: [],
        recent: [
          {
            block: 1,
            action: 'arm',
            coverId: null,
            txHash: null,
            outcome: 'bogus',
            gasLimit: null,
          },
        ],
        walks: {
          samples: 0,
          chainGapP50: null,
          chainGapMax: null,
          laneShare: null,
        },
        uptimeS: 0,
      }),
    ).toThrow()
  })
})

describe('walletDataSchema', () => {
  it('accepts a joined native stop row', () => {
    const valid = {
      address: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
      nativeStops: [
        {
          perpId: 1,
          side: 'long' as const,
          triggerPNS: 624_300,
          lotLNS: 22_000,
          executedBlock: 111_200_000,
          execTx: `0x${'ab'.repeat(32)}`,
          fillVwapPNS: 624_250,
          filledLNS: 22_000,
          slippageVsTriggerBps: 0.8,
          delayBlocks: 4,
          joinStatus: 'joined' as const,
        },
      ],
    }
    expect(walletDataSchema.parse(valid)).toEqual(valid)
  })
})
