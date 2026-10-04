import { encode } from 'uqr'

interface QrCodeProps {
  data: string
  size?: number
}

/**
 * Drawn from `uqr`'s `encode()` matrix as JSX rects, never `renderSVG`'s
 * string output (ARCHITECTURE 8.4: no `dangerouslySetInnerHTML` anywhere).
 * DESIGN 5.11: porcelain card, black modules, 4-module quiet zone.
 */
export default function QrCode({ data, size = 240 }: QrCodeProps) {
  const qr = encode(data, { border: 4 })

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="QR code"
    >
      <title>QR code for {data}</title>
      <rect width={qr.size} height={qr.size} fill="#F5F5F7" />
      {qr.data.map((row, y) =>
        row.map((isDark, x) =>
          isDark ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill="#000000"
            />
          ) : null,
        ),
      )}
    </svg>
  )
}
