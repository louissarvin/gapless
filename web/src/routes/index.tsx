import { useRef } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react'
import { CircleAlert, Eye, ShieldCheck, Zap } from 'lucide-react'
import GaplessButton from '@/components/GaplessButton'
import GrainientHero from '@/components/GrainientHero'
import { errorCopyFor } from '@/lib/errors'
import { isInAppBrowser } from '@/utils/browser'
import { usePrfPreflight } from '@/hooks/usePrfPreflight'
import { useAuthActions } from '@/hooks/useAuthActions'
import { STAGGER_LOOSE, TRANSITION_REVEAL } from '@/config/animation'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/')({ component: LandingPage })

const HEADLINE = ['Stop-loss', 'that', 'actually', 'stops.']

const FEATURES = [
  {
    icon: ShieldCheck,
    title: 'Set a stop, get a guarantee',
    body: 'Pick the price where your position should close. If the market gaps past it, Gapless pays the difference instead of your stop just failing to fill.',
  },
  {
    icon: Zap,
    title: 'Trade from a passkey',
    body: 'No seed phrase, no extension. One passkey derives a trading key that signs on your behalf inside the limits you set.',
  },
  {
    icon: Eye,
    title: 'Everything is onchain',
    body: 'Every cover, trigger and payout is a transaction on Monad. Nothing about your position is held off-chain.',
  },
] as const

const STATEMENTS = [
  'A stop-loss is a request, not a promise.',
  'When price gaps through it, you fill wherever the market lands.',
  'Gapless covers the gap and pays you the difference.',
] as const

function LandingPage() {
  const navigate = useNavigate()
  const prf = usePrfPreflight()
  const inAppBrowser = isInAppBrowser()
  const { pending, error, createAccount, signIn } = useAuthActions(() =>
    navigate({ to: '/onboard' }),
  )
  const reducedMotion = useReducedMotion()

  const heroRef = useRef<HTMLElement | null>(null)
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  })
  const plasmaScale = useTransform(scrollYProgress, [0, 1], [1, 1.15])
  const plasmaOpacity = useTransform(scrollYProgress, [0, 1], [1, 0])
  const headlineY = useTransform(scrollYProgress, [0, 0.6], [0, -80])
  const headlineOpacity = useTransform(scrollYProgress, [0, 0.6], [1, 0])

  const errorCopy = error ? errorCopyFor(error) : null

  return (
    <div className="min-h-screen">
      <nav className="fixed inset-x-0 top-[calc(12px+env(safe-area-inset-top))] z-50 mx-auto flex h-14 w-[calc(100%-24px)] max-w-[560px] items-center justify-between rounded-full bg-[var(--color-glass)] px-5 backdrop-blur-xl [box-shadow:inset_0_1px_0_rgba(255,255,255,0.08)]">
        <span className="type-headline font-display text-[20px]">Gapless</span>
        <div className="flex items-center gap-2">
          <GaplessButton
            variant="text"
            size="sm"
            isDisabled={pending !== null}
            isPending={pending === 'signin'}
            onPress={signIn}
          >
            Sign in
          </GaplessButton>
          <GaplessButton
            variant="primary"
            size="sm"
            isDisabled={pending !== null}
            isPending={pending === 'create'}
            onPress={createAccount}
          >
            Create account
          </GaplessButton>
        </div>
      </nav>

      <section
        ref={heroRef}
        className="relative flex min-h-[100svh] flex-col items-center justify-end overflow-hidden px-5 pb-16 pt-24"
      >
        <motion.div
          className="absolute inset-0"
          style={
            reducedMotion
              ? undefined
              : { scale: plasmaScale, opacity: plasmaOpacity }
          }
        >
          <GrainientHero />
        </motion.div>
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(to top, #000000 0%, rgba(0, 0, 0, 0) 60%)',
          }}
        />

        <motion.div
          className="relative z-10 flex w-full max-w-[640px] flex-col items-center gap-6 text-center"
          style={
            reducedMotion
              ? undefined
              : { y: headlineY, opacity: headlineOpacity }
          }
        >
          {inAppBrowser && (
            <Banner
              title="Open this in Safari or Chrome"
              body="This in-app browser cannot complete the passkey step. Open gapless in your regular browser to continue."
            />
          )}
          {!inAppBrowser && prf === 'unsupported' && (
            <Banner
              title="This device may not support passkeys"
              body="iCloud Keychain, Google Password Manager, 1Password, Proton Pass and YubiKey 5 all work. You can still continue from your phone."
            />
          )}
          {errorCopy && (
            <Banner
              title={errorCopy.title}
              body={errorCopy.body}
              tone="danger"
            />
          )}

          <h1
            className="type-display-hero mx-auto"
            aria-label={HEADLINE.join(' ')}
          >
            {HEADLINE.map((word, index) => (
              <motion.span
                key={word}
                aria-hidden
                className={cnm('inline-block', word === 'actually' && 'italic')}
                initial={
                  reducedMotion
                    ? undefined
                    : { opacity: 0, y: 24, filter: 'blur(12px)' }
                }
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{
                  ...TRANSITION_REVEAL,
                  delay: 0.15 + index * STAGGER_LOOSE,
                }}
              >
                {word}
                {index < HEADLINE.length - 1 ? ' ' : ''}
              </motion.span>
            ))}
          </h1>
          <p className="type-body text-[#AEAEB2]">
            Guaranteed covers for perps on Monad. Set your stop, trade from a
            passkey, get paid if the market gaps past it.
          </p>

          <div className="flex w-full flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <GaplessButton
              variant="primary"
              size="lg"
              isDisabled={pending !== null}
              isPending={pending === 'create'}
              onPress={createAccount}
            >
              Create account
            </GaplessButton>
            <GaplessButton
              variant="secondary"
              size="lg"
              isDisabled={pending !== null}
              isPending={pending === 'signin'}
              onPress={signIn}
            >
              Sign in
            </GaplessButton>
          </div>
          <p className="type-footnote text-[#AEAEB2]">
            Creating an account makes a new passkey. Already have one? Sign in
            instead.
          </p>
        </motion.div>
      </section>

      <section className="mx-auto flex max-w-[1120px] flex-col gap-16 px-5 py-16 sm:px-10 lg:gap-24 lg:px-16 lg:py-24">
        {STATEMENTS.map((line) => (
          <Statement key={line}>{line}</Statement>
        ))}
      </section>

      <section className="mx-auto grid max-w-[1120px] gap-6 px-5 pb-16 sm:px-10 lg:grid-cols-3 lg:px-16 lg:pb-24">
        {FEATURES.map((feature, index) => (
          <motion.div
            key={feature.title}
            className="card-big flex min-h-[320px] flex-col justify-between p-8 lg:min-h-[400px] lg:p-10 transition-transform duration-300 [transition-timing-function:var(--ease-out-quart,ease-out)] [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-1"
            initial={
              reducedMotion ? undefined : { opacity: 0, y: 32, scale: 0.98 }
            }
            whileInView={{ opacity: 1, y: 0, scale: 1 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{
              type: 'spring',
              stiffness: 180,
              damping: 24,
              mass: 1,
              delay: index * STAGGER_LOOSE,
            }}
          >
            <feature.icon
              className="size-8 text-[var(--color-accent)]"
              strokeWidth={1.75}
            />
            <div>
              <h2 className="type-title-1 mb-2">{feature.title}</h2>
              <p className="type-body max-w-[32ch] text-[#AEAEB2]">
                {feature.body}
              </p>
            </div>
          </motion.div>
        ))}
      </section>
    </div>
  )
}

function Statement({ children }: { children: string }) {
  const ref = useRef<HTMLParagraphElement | null>(null)
  const reducedMotion = useReducedMotion()
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start 0.9', 'start 0.4'],
  })
  const opacity = useTransform(scrollYProgress, [0, 1], [0.16, 1])
  const y = useTransform(scrollYProgress, [0, 1], [24, 0])

  return (
    <motion.p
      ref={ref}
      className="type-display relative text-center lg:type-display-xl"
      style={reducedMotion ? undefined : { opacity, y }}
    >
      {children}
    </motion.p>
  )
}

function Banner({
  title,
  body,
  tone = 'warning',
}: {
  title: string
  body: string
  tone?: 'warning' | 'danger'
}) {
  return (
    <div
      className={cnm(
        'flex items-start gap-3 rounded-md px-4 py-3 text-left',
        tone === 'warning' ? 'bg-[#402F21]' : 'bg-[#2C2C2E]',
      )}
    >
      <CircleAlert
        className={cnm(
          'mt-0.5 size-5 shrink-0',
          tone === 'warning' ? 'text-[#FF9230]' : 'text-[#FF6165]',
        )}
        strokeWidth={1.75}
      />
      <div>
        <p className="type-headline text-white">{title}</p>
        <p className="type-callout text-[#AEAEB2]">{body}</p>
      </div>
    </div>
  )
}
