/** DESIGN 10 `/vault`: 88px utilization ring on the TVL card. Hand-drawn SVG, no chart dependency. */
const SIZE = 88
const STROKE = 8
const RADIUS = (SIZE - STROKE) / 2
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export default function UtilizationRing({ bps }: { bps: number }) {
  const pct = Math.min(Math.max(bps, 0), 10_000) / 10_000
  const offset = CIRCUMFERENCE * (1 - pct)
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`${(pct * 100).toFixed(0)}% utilized`}
    >
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="#3A3A3C"
        strokeWidth={STROKE}
      />
      <circle
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={RADIUS}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="middle"
        textAnchor="middle"
        className="type-num"
        fill="#FFFFFF"
      >
        {(pct * 100).toFixed(0)}%
      </text>
    </svg>
  )
}
