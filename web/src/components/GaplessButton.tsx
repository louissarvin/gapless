import { Button as HeroButton } from '@heroui/react'
import type { ComponentProps } from 'react'
import { cnm } from '@/utils/style'

/**
 * DESIGN 5.1: every button is a pill. Primary is "porcelain", not HeroUI's
 * blue accent fill, so it composes HeroUI's Button and overrides the CSS
 * variables its variants read (button.css) rather than forking the component.
 */
type Variant = 'primary' | 'secondary' | 'text' | 'destructive'

const HERO_VARIANT: Record<
  Variant,
  ComponentProps<typeof HeroButton>['variant']
> = {
  primary: 'primary',
  secondary: 'secondary',
  text: 'ghost',
  destructive: 'secondary',
}

const VARIANT_CLASSES: Record<Variant, string> = {
  // DESIGN 7.8: lifts 1px and gains a purple glow on hover, fine pointers only; never on touch, never at rest.
  primary:
    '[--button-bg:var(--color-porcelain)] [--button-bg-hover:var(--color-porcelain)] [--button-bg-pressed:var(--color-porcelain-pressed)] [--button-fg:var(--color-porcelain-foreground)] transition-[transform,box-shadow] duration-150 [transition-timing-function:var(--ease-out-quart,ease-out)] [@media(hover:hover)_and_(pointer:fine)]:hover:-translate-y-px [@media(hover:hover)_and_(pointer:fine)]:hover:shadow-[0_8px_32px_-8px_var(--color-accent-glow)]',
  secondary: '[--button-fg:#ffffff]',
  // DESIGN 2.3: the text-weight accent (`#A48FFF`), never HeroUI's `accent` fill (`#6E54FF`, fails as text).
  text: '[--button-bg-hover:transparent] [--button-bg-pressed:transparent] [--button-fg:var(--color-accent)] active:[--button-fg:var(--color-accent-pressed)]',
  destructive: '[--button-fg:var(--danger)]',
}

interface GaplessButtonProps extends Omit<
  ComponentProps<typeof HeroButton>,
  'variant'
> {
  variant: Variant
}

export default function GaplessButton({
  variant,
  className,
  ...props
}: GaplessButtonProps) {
  return (
    <HeroButton
      variant={HERO_VARIANT[variant]}
      className={cnm('rounded-full', VARIANT_CLASSES[variant], className)}
      {...props}
    />
  )
}
