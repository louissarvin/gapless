/**
 * ADR-W15: `/proof` only claims "same stop, same market" when every one of
 * these holds. Pure so it is unit-testable without a chain or relay call.
 */
export const PROOF_PAIRING_WINDOW_BLOCKS = 200n

export interface PairCandidate {
  gaplessPerpId: number
  gaplessIsLong: boolean
  gaplessStopPNS: bigint
  gaplessTriggerBlock: bigint
  nativePerpId: number
  nativeSide: 'long' | 'short'
  nativeTriggerPNS: bigint
  nativeExecutedBlock: bigint
}

export function isValidPair(c: PairCandidate): boolean {
  if (c.gaplessPerpId !== 1 || c.nativePerpId !== 1) return false
  const gaplessSide = c.gaplessIsLong ? 'long' : 'short'
  if (gaplessSide !== c.nativeSide) return false
  if (c.gaplessStopPNS !== c.nativeTriggerPNS) return false
  const delta =
    c.gaplessTriggerBlock > c.nativeExecutedBlock
      ? c.gaplessTriggerBlock - c.nativeExecutedBlock
      : c.nativeExecutedBlock - c.gaplessTriggerBlock
  return delta <= PROOF_PAIRING_WINDOW_BLOCKS
}
