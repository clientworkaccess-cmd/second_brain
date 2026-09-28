import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The primitive set, straight off Desing.md §Components. Everything else in the
 * app composes these — no one-off button styling further down the tree.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-lg font-medium text-small transition-all duration-150 ' +
  'disabled:opacity-40 disabled:pointer-events-none active:translate-y-px select-none';

const VARIANTS = {
  // Primary CTA: Solid Amethyst (#7c3aed) with White (#ffffff) text, 8px radius, subtle inset glow
  primary:
    'bg-amethyst text-white px-5 py-2.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] hover:bg-[#6d28d9] active:bg-[#5b21b6]',
  // Secondary Ghost Button: Transparent background with Medium Gray (#bcbcbc) text
  ghost: 'border border-graphite text-medium px-4 py-2.5 hover:text-bright hover:bg-white/[0.04]',
  quiet: 'text-medium px-3 py-2 hover:text-bright hover:bg-white/[0.04]',
  danger: 'border border-error/40 text-error px-4 py-2.5 hover:bg-error/10',
} as const;

type Variant = keyof typeof VARIANTS;

export function Button({
  variant = 'primary',
  className,
  ...rest
}: ComponentProps<'button'> & { variant?: Variant }) {
  return <button className={cx(BUTTON_BASE, VARIANTS[variant], className)} {...rest} />;
}

export function ButtonLink({
  variant = 'primary',
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={cx(BUTTON_BASE, VARIANTS[variant], className)} {...rest} />;
}

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={cx('rounded-xl border border-graphite bg-surface shadow-subtle text-bright', className)}
      {...rest}
    />
  );
}

/** Label above the input. No floating labels — the spec rules them out. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-small font-medium text-bright tracking-normal">{label}</span>
      {hint && <span className="mt-1 block text-small text-muted">{hint}</span>}
      <div className="mt-2">{children}</div>
      {error && <span className="mt-1.5 block text-small text-error">{error}</span>}
    </label>
  );
}

const INPUT =
  'w-full rounded-lg border border-graphite bg-abyss/80 px-3.5 py-2.5 text-body text-bright ' +
  'placeholder:text-muted/60 transition-colors focus:border-amethyst focus:ring-1 focus:ring-amethyst shadow-subtle';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx(INPUT, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(INPUT, 'resize-y min-h-[7rem]', className)} {...rest} />;
}

/** Shimmer, sized to the thing it stands in for. Desing.md forbids circular spinners. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('shimmer rounded-lg bg-surface border border-graphite/40', className)} aria-hidden />;
}

/** Icon composition + descriptive text + an action. Never a bare "no data". */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-graphite bg-surface/30 px-6 py-16 text-center shadow-subtle">
      <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-graphite bg-surface shadow-subtle">
        <Icon className="h-5 w-5 text-lavender" strokeWidth={1.75} />
      </span>
      <h2 className="text-h2 font-semibold text-bright">{title}</h2>
      <p className="mt-2 max-w-prose text-body text-medium">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'danger' | 'accent';
}) {
  const tones = {
    neutral: 'border-graphite bg-surface text-medium',
    success: 'border-success/30 bg-success/15 text-success',
    danger: 'border-error/30 bg-error/15 text-error',
    accent: 'border-lavender/30 bg-tag-bg text-lavender',
  } as const;
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-normal',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export { cx };
