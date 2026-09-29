import type { Config } from 'tailwindcss';

/**
 * Colours are not values here, they are the theme variables from
 * src/app/theme.css, which are the ones the Second Brain desktop app uses.
 * A class such as `bg-panel` therefore follows light and dark on its own, and
 * nothing in a component names a colour by what it looks like.
 *
 * `<alpha-value>` is what lets `border-accent/40` work with a variable.
 */
const token = (name: string): string => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    // Replaced, not extended: the default palette is not part of this look.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      canvas: token('bg-primary'), // the page and the centre pane
      panel: token('bg-secondary'), // sidebars, headers, cards
      raised: token('bg-tertiary'), // buttons, pills, anything lifted off a panel
      line: token('border'),
      ink: token('text-normal'),
      muted: token('text-muted'),
      faint: token('text-faint'),
      accent: token('accent'),
      'accent-hover': token('accent-hover'),
      'on-accent': token('text-on-accent'),
      link: token('link'),
      danger: token('danger'),
      success: token('success'),
      warning: token('warning'),
      hover: 'var(--bg-hover)',
      active: 'var(--bg-active)',
    },
    fontFamily: {
      sans: ['var(--font-ui)'],
      mono: ['var(--font-mono)'],
    },
    fontSize: {
      tiny: ['11px', { lineHeight: '1.4' }],
      small: ['12px', { lineHeight: '1.45' }],
      ui: ['13px', { lineHeight: '1.5' }],
      body: ['14px', { lineHeight: '1.55' }],
      text: ['16px', { lineHeight: '1.6' }],
      title: ['18px', { lineHeight: '1.3' }],
      display: ['24px', { lineHeight: '1.25' }],
    },
    borderRadius: {
      none: '0',
      sm: '4px',
      DEFAULT: '6px',
      lg: '10px',
      full: '9999px',
    },
    boxShadow: {
      none: 'none',
      // Only for things that float over the page: menus, dialogs, toasts.
      float: '0 8px 24px rgba(0, 0, 0, 0.25)',
    },
    extend: {
      maxWidth: {
        content: 'var(--content-width)',
        prose: '72ch',
      },
      zIndex: {
        overlay: '200',
        modal: '300',
      },
      keyframes: {
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
      },
      animation: {
        pulse: 'pulse 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

export default config;
