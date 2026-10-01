import { encodeAbiParameters, type Hex } from 'viem';
import { PERPL_EVENTS_ABI, PERPL_TOPICS } from '../../src/jobs/perpl.ts';
import type { RawLog } from '../../src/jobs/rows.ts';

// Test-only: builds Exchange logs in the real ABI encoding from hand-picked values.

type EventName = (typeof PERPL_EVENTS_ABI)[number]['name'];

export function encodeLog(name: EventName, args: Record<string, bigint | number | boolean>, block: number, logIndex: number, tx?: Hex): RawLog {
  const i = PERPL_EVENTS_ABI.findIndex((e) => e.name === name);
  const ev = PERPL_EVENTS_ABI[i]!;
  const data = encodeAbiParameters(
    ev.inputs,
    ev.inputs.map((p) => {
      const v = args[p.name!];
      if (v === undefined) throw new Error(`missing ${p.name}`);
      return v;
    }) as never
  );
  return {
    blockNumber: block,
    logIndex,
    transactionHash: tx ?? (`0x${block.toString(16).padStart(64, '0')}` as Hex),
    topics: [PERPL_TOPICS[i]!],
    data
  };
}
