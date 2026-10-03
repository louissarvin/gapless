/**
 * CNS, PNS, LNS conversions (contract/src/types/GaplessTypes.sol header comment):
 * CNS = AUSD, fixed 6 decimals. PNS = Perpl price units, per-perp `priceDecimals`.
 * LNS = Perpl lot units (an integer lot count), per-perp `lotDecimals`.
 * BTC-PERP (perpId 1): priceDecimals 1, lotDecimals 5 (contract/src/Constants.sol listing).
 */

export const CNS_DECIMALS = 6
const CNS_SCALE = 10n ** BigInt(CNS_DECIMALS)

const MINUS_SIGN = '−'
const THIN_SPACE = ' '

export function cnsToDecimal(cns: bigint): number {
  return Number(cns) / Number(CNS_SCALE)
}

export function decimalToCns(value: number): bigint {
  if (!Number.isFinite(value))
    throw new RangeError('decimalToCns: value must be finite')
  return BigInt(Math.round(value * Number(CNS_SCALE)))
}

export function pnsToPrice(pns: bigint, priceDecimals: number): number {
  return Number(pns) / 10 ** priceDecimals
}

export function priceToPns(price: number, priceDecimals: number): bigint {
  if (!Number.isFinite(price))
    throw new RangeError('priceToPns: price must be finite')
  return BigInt(Math.round(price * 10 ** priceDecimals))
}

export function lnsToSize(lns: bigint, lotDecimals: number): number {
  return Number(lns) / 10 ** lotDecimals
}

export function sizeToLns(size: number, lotDecimals: number): bigint {
  if (!Number.isFinite(size))
    throw new RangeError('sizeToLns: size must be finite')
  return BigInt(Math.round(size * 10 ** lotDecimals))
}

function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** "1,234.56" + thin space + unit, e.g. formatCNS(1234560000n, 'AUSD') -> "1,234.56 AUSD". */
export function formatCNS(cns: bigint, unit = 'AUSD', decimals = 2): string {
  const value = cnsToDecimal(cns)
  const fixed = value.toFixed(decimals)
  const [intPart, decPart] = fixed.split('.')
  const grouped = groupThousands(intPart)
  const body = decPart ? `${grouped}.${decPart}` : grouped
  return unit ? `${body}${THIN_SPACE}${unit}` : body
}

/** Always signed: "+12.40", "−03.10". Zero shows unsigned "0.00" (DESIGN 3.4). */
export function formatSigned(value: number, decimals = 2): string {
  if (value === 0) return (0).toFixed(decimals)
  const sign = value > 0 ? '+' : MINUS_SIGN
  return `${sign}${Math.abs(value).toFixed(decimals)}`
}

/** "about 3 h", "about 45 min" (DESIGN 3.4 duration style). Negative or zero reads as "now". */
export function formatApproxDuration(seconds: number): string {
  if (seconds <= 0) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `about ${hours} h`
  const days = Math.round(hours / 24)
  return `about ${days} d`
}

/** "0.00042 MON": gas and native-balance display (DESIGN 9.1 network cost rows). */
export function formatMon(wei: bigint, decimals = 5): string {
  const whole = wei / 10n ** 18n
  const frac = wei % 10n ** 18n
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals)
  return `${whole.toString()}.${fracStr}${THIN_SPACE}MON`
}

/** "0xB07C20…1771": 6 hex after 0x, 4 at the end (DESIGN 3.4, passive display only). */
export function shortenAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new RangeError('shortenAddress: expected a 20-byte hex address')
  }
  return `${address.slice(0, 8)}…${address.slice(-4)}`
}

/** "0xb07c20…9a1f": passive display of a tx hash, same shape as `shortenAddress`. */
export function shortenHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`
}
