import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { EXPLORER_URL } from '@/config'
import { shortenHash } from '@/utils/units'
import { cnm } from '@/utils/style'

export interface StepperStep {
  key: string
  title: string
  /** `undefined` while this step hasn't happened yet. */
  block?: number
  txHash?: `0x${string}` | null
  note?: ReactNode
  state: 'done' | 'current' | 'pending'
  color: string
}

/** DESIGN 5.13: vertical timeline, 12px node, 2px connector, done nodes
 * filled with the status color, the current node gets a soft halo. */
export default function CoverStepper({
  steps,
}: {
  steps: ReadonlyArray<StepperStep>
}) {
  return (
    <div className="flex flex-col">
      {steps.map((step, i) => (
        <div key={step.key} className="flex gap-4">
          <div className="flex flex-col items-center">
            <span
              className={cnm(
                'size-3 shrink-0 rounded-full',
                step.state === 'pending' ? 'bg-[#3A3A3C]' : '',
              )}
              style={
                step.state !== 'pending'
                  ? {
                      backgroundColor: step.color,
                      boxShadow:
                        step.state === 'current'
                          ? `0 0 0 6px ${step.color}29`
                          : undefined,
                    }
                  : undefined
              }
            />
            {i < steps.length - 1 && (
              <span className="my-1 w-0.5 flex-1 bg-[#3A3A3C]" />
            )}
          </div>
          <div className="min-w-0 flex-1 pb-6">
            <p
              className={cnm(
                'type-headline',
                step.state === 'pending' ? 'text-[#8E8E93]' : 'text-white',
              )}
            >
              {step.title}
            </p>
            {step.block !== undefined && (
              <p className="type-num-sm text-[#AEAEB2]">Block {step.block}</p>
            )}
            {step.note && (
              <p className="type-footnote mt-1 text-[#AEAEB2]">{step.note}</p>
            )}
            {step.txHash && (
              <a
                href={`${EXPLORER_URL}/tx/${step.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="type-mono-sm mt-1 inline-flex items-center gap-1 text-[#A48FFF]"
              >
                {shortenHash(step.txHash)}
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
