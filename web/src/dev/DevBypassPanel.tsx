import { useEffect, useState } from 'react'
import type { DevBypassStage } from '@/dev/devBypass'
import {
  isDevBypassPanelRequested,
  readDevBypassStage,
  writeDevBypassStage,
} from '@/dev/devBypass'

/**
 * Dev-only. Lazily imported from onboard.tsx / home.tsx behind
 * `import.meta.env.DEV` (same pattern as DevtoolsPanel / ARCHITECTURE ADR-W3)
 * so this never ships in the production bundle.
 *
 * Deliberately styled to look nothing like the product (DESIGN.md does not
 * apply here): a raw monospace debug overlay, so there is zero chance of
 * mistaking it for real UI, even in a screenshot.
 */
export function useDevBypassStage(): [
  DevBypassStage,
  (stage: DevBypassStage) => void,
] {
  const [stage, setStage] = useState<DevBypassStage>(() => readDevBypassStage())

  useEffect(() => {
    writeDevBypassStage(stage)
  }, [stage])

  return [stage, setStage]
}

const STAGES: ReadonlyArray<{ key: DevBypassStage; label: string }> = [
  { key: 'off', label: 'off (real chain data)' },
  { key: 'funded', label: 'funded' },
  { key: 'deployed', label: 'deployed' },
  { key: 'activated', label: 'activated' },
]

export function DevBypassPanel({
  stage,
  onChange,
}: {
  stage: DevBypassStage
  onChange: (stage: DevBypassStage) => void
}) {
  if (!isDevBypassPanelRequested()) return null

  return (
    <div
      role="region"
      aria-label="Dev bypass panel"
      style={{
        position: 'fixed',
        bottom: 12,
        left: 12,
        right: 12,
        zIndex: 9999,
        maxWidth: 480,
        marginInline: 'auto',
        border: '2px dashed #ffb400',
        borderRadius: 6,
        background: 'rgba(20, 0, 0, 0.92)',
        color: '#ffb400',
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 11,
        lineHeight: 1.4,
        padding: 10,
      }}
    >
      <p style={{ fontWeight: 700, letterSpacing: 0.5, margin: 0 }}>
        DEV ONLY — not in production
      </p>
      <p style={{ margin: '4px 0 8px', opacity: 0.8 }}>
        Fakes chain-read results for this account. Never calls /sponsor/create
        or /activate, never signs a transaction.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => onChange(s.key)}
            style={{
              fontFamily: 'inherit',
              fontSize: 11,
              padding: '4px 8px',
              borderRadius: 4,
              border: '1px solid #ffb400',
              background: stage === s.key ? '#ffb400' : 'transparent',
              color: stage === s.key ? '#1a0a00' : '#ffb400',
              cursor: 'pointer',
            }}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}
