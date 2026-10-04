import { useEffect, useId, useRef, useState } from 'react'

/**
 * DESIGN R.2 item 2 (2026-10-08 review): hand-drawn SVG, no chart dependency
 * (R.8: react-bits has nothing closer). One repaint per sample, no
 * transitions — this is data, not motion, so reduced motion changes nothing.
 */
const WINDOW_S = 600
const STALE_THRESHOLD_S = 60

export interface SawtoothSample {
  tS: number
  markAgeS: number
}

export default function Sawtooth({
  samples,
}: {
  samples: ReadonlyArray<SawtoothSample>
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const clipId = useId()
  const [size, setSize] = useState({ width: 600, height: 120 })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const entry = entries.at(0)
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setSize({ width, height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const hasData = samples.length >= 2
  const highest = hasData ? Math.max(...samples.map((s) => s.markAgeS)) : 0
  const ceiling = Math.max(90, Math.ceil(highest / 30) * 30)
  const { width, height } = size

  const toXY = (s: SawtoothSample, now: number) => {
    const x = width - ((now - s.tS) / WINDOW_S) * width
    const y = height - (Math.min(s.markAgeS, ceiling) / ceiling) * height
    return [x, y] as const
  }

  let pointsStr = ''
  let lastPoint: readonly [number, number] | null = null
  if (hasData) {
    const now = samples[samples.length - 1].tS
    const points = samples.map((s) => toXY(s, now))
    pointsStr = points
      .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
      .join(' ')
    lastPoint = points[points.length - 1]
  }

  const thresholdY =
    STALE_THRESHOLD_S <= ceiling
      ? height - (STALE_THRESHOLD_S / ceiling) * height
      : null

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div ref={containerRef} className="relative min-h-0 flex-1">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Mark age over the last 10 minutes"
          className="block"
        >
          {thresholdY !== null && (
            <>
              <defs>
                <clipPath id={clipId}>
                  <rect x={0} y={0} width={width} height={thresholdY} />
                </clipPath>
              </defs>
              <line
                x1={0}
                y1={thresholdY}
                x2={width}
                y2={thresholdY}
                stroke="#3A3A3C"
                strokeWidth={1}
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={width}
                y={thresholdY - 4}
                textAnchor="end"
                fontSize={12}
                fontWeight={500}
                fill="#8E8E93"
              >
                60 s
              </text>
            </>
          )}
          {hasData && (
            <>
              <polyline
                points={pointsStr}
                fill="none"
                stroke="#FFFFFF"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {thresholdY !== null && (
                <polyline
                  points={pointsStr}
                  fill="none"
                  stroke="#FF9230"
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  clipPath={`url(#${clipId})`}
                />
              )}
              {lastPoint && (
                <circle
                  cx={lastPoint[0]}
                  cy={lastPoint[1]}
                  r={3}
                  fill="#FFFFFF"
                />
              )}
            </>
          )}
        </svg>
        {!hasData && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="type-caption text-[#8E8E93]">
              Collecting samples…
            </span>
          </div>
        )}
      </div>
      <div className="type-caption flex items-center justify-between text-[#8E8E93]">
        <span>10 min ago</span>
        <span>Now</span>
      </div>
    </div>
  )
}
