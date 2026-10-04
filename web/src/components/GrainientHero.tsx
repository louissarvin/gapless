import { Suspense, lazy, useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { GrainientErrorBoundary } from '@/components/GrainientErrorBoundary'
import { TRANSITION_HERO } from '@/config/animation'

const Plasma = lazy(() => import('@/components/Plasma'))
const Grainient = lazy(() => import('@/components/Grainient'))

const STATIC_FALLBACK = {
  backgroundImage:
    'radial-gradient(40% 55% at 50% 40%, rgba(110, 84, 255, 0.45), transparent 70%), radial-gradient(18% 30% at 50% 35%, rgba(164, 143, 255, 0.25), transparent 70%)',
  backgroundColor: '#000000',
}

/** `canvas.getContext('webgl2')` before mounting Plasma: its shader is GLSL
 * 300 es and `ogl` silently falls back to WebGL1, where it compile-fails to
 * a blank canvas instead of throwing (DESIGN 7.4). */
function supportsWebgl2(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2'))
  } catch {
    return false
  }
}

/**
 * Landing hero background only (DESIGN 7.4, r2): react-bits Plasma, tinted
 * monochrome purple. Dynamic-imported after first paint, static fallback
 * while loading, under `prefers-reduced-motion`, or when WebGL2 is
 * unavailable. Falls back to the retuned Grainient (not a blank canvas) when
 * Plasma's WebGL2 requirement isn't met.
 */
export default function GrainientHero() {
  const [ready, setReady] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)
  const [webgl2, setWebgl2] = useState(true)
  const [coarsePointer, setCoarsePointer] = useState(false)

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReducedMotion(query.matches)
    const onChange = (event: MediaQueryListEvent) =>
      setReducedMotion(event.matches)
    query.addEventListener('change', onChange)

    setWebgl2(supportsWebgl2())
    setCoarsePointer(window.matchMedia('(pointer: coarse)').matches)

    // Dynamic import after first paint.
    const id = requestAnimationFrame(() => setReady(true))
    return () => {
      query.removeEventListener('change', onChange)
      cancelAnimationFrame(id)
    }
  }, [])

  const fallback = <div className="absolute inset-0" style={STATIC_FALLBACK} />

  if (!ready || reducedMotion) {
    return fallback
  }

  return (
    <motion.div
      className="absolute inset-0"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={TRANSITION_HERO}
    >
      <GrainientErrorBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          {webgl2 ? (
            <Plasma
              color="#6E54FF"
              speed={0.5}
              direction="forward"
              scale={1.1}
              opacity={1}
              mouseInteractive={false}
              renderScale={0.5}
              maxDpr={1.5}
              targetFps={30}
              iterations={coarsePointer ? 48 : 60}
            />
          ) : (
            <Grainient
              color1="#000000"
              color2="#6E54FF"
              color3="#A48FFF"
              timeSpeed={0.2}
              warpStrength={1.4}
              contrast={1.4}
              saturation={1.0}
              grainAmount={0.1}
              zoom={0.8}
              lightMode={false}
            />
          )}
        </Suspense>
      </GrainientErrorBoundary>
    </motion.div>
  )
}
