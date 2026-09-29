import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The primitive set. Everything that only this app has (upload, plan review,
 * chat, the wizard) is built from these, so that it sits beside the frame,
 * which is the desktop app's own CSS, without looking like a guest.
 *
 * The rules they follow are the desktop app's: flat surfaces, one-pixel
 * borders, a six-pixel radius, 13px text, and the accent only on the one thing
 * a screen is for.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded border px-3 py-1.5 text-ui font-medium select-none ' +
  'disabled:opacity-45 disabled:pointer-events-none';

const VARIANTS = {
  primary: 'border-transparent bg-accent text-on-accent hover:bg-accent-hover',
  ghost: 'border-line bg-raised text-ink hover:bg-hover',
  quiet: 'border-transparent text-muted hover:bg-hover hover:text-ink',
  danger: 'border-danger/40 text-danger hover:bg-danger/10',
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
  return <div className={cx('rounded border border-line bg-panel text-ink', className)} {...rest} />;
}

/** Label above the input. */
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
      <span className="block text-ui font-medium text-ink">{label}</span>
      {hint && <span className="mt-0.5 block text-small text-muted">{hint}</span>}
      <div className="mt-1.5">{children}</div>
      {error && <span className="mt-1 block text-small text-danger">{error}</span>}
    </label>
  );
}

export const INPUT =
  'w-full rounded border border-line bg-canvas px-2.5 py-1.5 text-body text-ink ' +
  'placeholder:text-faint focus:border-accent focus:outline-none';

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx(INPUT, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(INPUT, 'min-h-[7rem] resize-y', className)} {...rest} />;
}

/** A line of text that has not arrived yet. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-sm bg-raised', className)} aria-hidden />;
}

/** An icon, what is missing, and what to do about it. Never a bare "no data". */
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
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <Icon className="mb-3 h-6 w-6 text-faint" strokeWidth={1.75} />
      <h2 className="text-title font-medium text-muted">{title}</h2>
      <p className="mt-1.5 max-w-prose text-body text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
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
    neutral: 'bg-raised text-muted',
    success: 'bg-success/15 text-success',
    danger: 'bg-danger/15 text-danger',
    accent: 'bg-raised text-accent',
  } as const;
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 text-small leading-[1.6]', tones[tone])}>
      {children}
    </span>
  );
}

/** The small uppercase line above a group of things, as in the sidebars. */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cx('section-title', className)}>{children}</h2>;
}

export { cx };
