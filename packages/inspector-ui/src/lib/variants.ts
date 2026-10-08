import { tv } from 'tailwind-variants'

export const inspectorButton = tv({
  base: 'inline-flex items-center justify-center rounded-md border text-[13px] transition-[background-color,border-color,color,transform] duration-150 active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--doctor-accent-fg)] disabled:pointer-events-none disabled:opacity-50',
  variants: {
    intent: {
      neutral: 'border-[var(--doctor-border-strong)] text-[var(--doctor-muted)] hover:bg-[var(--doctor-panel)] hover:text-[var(--doctor-text)]',
      active: 'border-[color-mix(in_srgb,var(--doctor-accent)_45%,transparent)] bg-[var(--doctor-accent-muted)] text-[var(--doctor-accent-fg)] hover:bg-[color-mix(in_srgb,var(--doctor-accent)_22%,transparent)]',
      danger: 'border-[color-mix(in_srgb,var(--doctor-error-fg)_40%,transparent)] bg-[var(--doctor-error-bg)] text-[var(--doctor-error-fg)]',
      ghost: 'border-transparent text-[var(--doctor-muted)] hover:bg-[var(--doctor-panel)] hover:text-[var(--doctor-text)]'
    },
    size: {
      sm: 'min-h-8 px-2.5',
      md: 'min-h-9 px-3',
      icon: 'size-8 px-0'
    }
  },
  defaultVariants: { intent: 'neutral', size: 'sm' }
})

export const severityBadge = tv({
  base: 'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase',
  variants: {
    severity: {
      error: 'border-[color-mix(in_srgb,var(--doctor-error-fg)_35%,transparent)] bg-[var(--doctor-error-bg)] text-[var(--doctor-error-fg)]',
      warning: 'border-[color-mix(in_srgb,var(--doctor-warning-fg)_35%,transparent)] bg-[var(--doctor-warning-bg)] text-[var(--doctor-warning-fg)]',
      info: 'border-[color-mix(in_srgb,var(--doctor-info-fg)_35%,transparent)] bg-[var(--doctor-info-bg)] text-[var(--doctor-info-fg)]'
    }
  },
  defaultVariants: { severity: 'info' }
})

export const coverageChip = tv({
  base: 'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium uppercase',
  variants: {
    status: {
      complete: 'border-[color-mix(in_srgb,var(--doctor-accent)_40%,transparent)] bg-[var(--doctor-accent-muted)] text-[var(--doctor-accent-fg)]',
      partial: 'border-[color-mix(in_srgb,var(--doctor-warning-fg)_35%,transparent)] bg-[var(--doctor-warning-bg)] text-[var(--doctor-warning-fg)]',
      blocked: 'border-[color-mix(in_srgb,var(--doctor-error-fg)_35%,transparent)] bg-[var(--doctor-error-bg)] text-[var(--doctor-error-fg)]'
    }
  },
  defaultVariants: { status: 'complete' }
})
