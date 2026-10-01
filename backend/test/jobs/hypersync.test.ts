import { describe, expect, test } from 'bun:test';
import type { Query, QueryResponse } from '@envio-dev/hypersync-client';
import { PERPL_EXCHANGE } from '../../src/lib/addresses.ts';
import { createHypersyncSource, type HypersyncLike } from '../../src/jobs/hypersync.ts';
import { PERPL_TOPICS } from '../../src/jobs/perpl.ts';
import { encodeLog } from './synthetic.ts';

// Test-only response in the 1.4.1 QueryResponse shape (index.d.ts): optional numeric fields,
// topics padded with null, blocks joined to the matched logs.
function fakeClient(res: QueryResponse): HypersyncLike & { queries: Query[] } {
  const queries: Query[] = [];
  return {
    queries,
    getHeight: async () => 110_000_000,
    get: async (q) => {
      queries.push(q);
      return res;
    }
  };
}

const mark = encodeLog('MarkUpdated', { perpId: 1n, pricePNS: 830_000n }, 109_000_005, 3);

function response(overrides: Partial<QueryResponse['data']> = {}, nextBlock = 109_000_100): QueryResponse {
  return {
    archiveHeight: 110_000_000,
    nextBlock,
    totalExecutionTime: 12,
    data: {
      blocks: [{ number: 109_000_005, timestamp: 1_791_180_100 }],
      transactions: [],
      logs: [
        {
          blockNumber: 109_000_005,
          logIndex: 3,
          transactionHash: mark.transactionHash,
          data: mark.data,
          topics: [mark.topics[0], null, null, null]
        }
      ],
      traces: [],
      ...overrides
    }
  };
}

describe('createHypersyncSource', () => {
  test('sends one Exchange query with every topic0 and the PascalCase field selection', async () => {
    const client = fakeClient(response());
    await createHypersyncSource(client).getPage(109_000_000, 109_000_500);
    expect(client.queries).toEqual([
      {
        fromBlock: 109_000_000,
        toBlock: 109_000_500,
        logs: [{ address: [PERPL_EXCHANGE], topics: [[...PERPL_TOPICS]] }],
        fieldSelection: {
          log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Data', 'Topic0'],
          block: ['Number', 'Timestamp']
        }
      }
    ]);
  });

  test('maps logs, block timestamps and nextBlock; drops null topic slots', async () => {
    const page = await createHypersyncSource(fakeClient(response())).getPage(109_000_000, 109_000_500);
    expect(page.nextBlock).toBe(109_000_100);
    expect([...page.blockTs]).toEqual([[109_000_005, 1_791_180_100]]);
    expect(page.logs).toEqual([
      { blockNumber: 109_000_005, logIndex: 3, transactionHash: mark.transactionHash, topics: [mark.topics[0]!], data: mark.data }
    ]);
  });

  test('a missing data field maps to empty bytes (decoding then quarantines it)', async () => {
    const res = response();
    delete res.data.logs[0]!.data;
    const page = await createHypersyncSource(fakeClient(res)).getPage(0, 1);
    expect(page.logs[0]!.data).toBe('0x');
  });

  test.each([
    ['block timestamp', { blocks: [{ number: 109_000_005 }] }],
    ['log block number', { logs: [{ logIndex: 3, transactionHash: mark.transactionHash, data: mark.data, topics: [mark.topics[0]] }] }],
    ['tx hash', { logs: [{ blockNumber: 1, logIndex: 0, transactionHash: 'nothex', data: '0x', topics: [] }] }]
  ])('rejects a malformed page (%s) instead of storing it', async (_name, data) => {
    await expect(createHypersyncSource(fakeClient(response(data as Partial<QueryResponse['data']>))).getPage(0, 1)).rejects.toThrow(
      'hypersync: bad'
    );
  });

  test('getHeight passes through', async () => {
    expect(await createHypersyncSource(fakeClient(response())).getHeight()).toBe(110_000_000);
  });
});
