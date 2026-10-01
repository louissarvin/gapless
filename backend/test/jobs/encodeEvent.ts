import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Hex } from 'viem';

// Test-only: real ABI encoding of hand-picked event values (topics for indexed params, data for the rest).
export function encodeEvent(abi: Abi, name: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const ev = abi.find((x): x is AbiEvent => x.type === 'event' && x.name === name);
  if (!ev) throw new Error(`no event ${name}`);
  const indexedArgs = Object.fromEntries(ev.inputs.filter((i) => i.indexed).map((i) => [i.name!, args[i.name!]]));
  const topics = encodeEventTopics({ abi: [ev], eventName: name, args: indexedArgs } as never) as Hex[];
  const rest = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(
    rest,
    rest.map((i) => {
      if (!(i.name! in args)) throw new Error(`missing ${name}.${i.name}`);
      return args[i.name!];
    }) as never
  );
  return { topics, data };
}
