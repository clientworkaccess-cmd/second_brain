import type { Config } from 'tailwindcss';

// Tokens are lifted verbatim from Desing.md (Obsidian — Style Reference: Crystalline Knowledge Vault).
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Core Obsidian Palette
        white: '#ffffff',
        bright: '#eeeeee',
        medium: '#bcbcbc',
        muted: '#a3a3a3',
        graphite: '#3f3f3f',
        surface: '#1e1e1e',
        abyss: '#171717',
        amethyst: '#7c3aed',
        lavender: '#a78bfa',
        'tag-bg': 'rgba(138, 92, 245, 0.15)',
        success: '#4ade80',
        warning: '#facc15',
        error: '#f87171',

        // Semantic mapping to Obsidian theme
        base: '#171717', // maps to Abyss
        elevated: '#1e1e1e', // maps to Surface
        line: '#3f3f3f', // maps to Graphite
        glass: 'rgba(30, 30, 30, 0.85)',
        ink: '#eeeeee', // maps to Bright Gray
        accent: '#7c3aed', // maps to Amethyst
        danger: '#f87171', // maps to Error Red
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      fontSize: {
        caption: ['12px', { lineHeight: '1.5', letterSpacing: '-0.24px' }],
        'body-sm': ['14px', { lineHeight: '1.5', letterSpacing: '-0.28px' }],
        small: ['14px', { lineHeight: '1.5', letterSpacing: '-0.28px' }],
        body: ['16px', { lineHeight: '1.5', letterSpacing: '-0.32px' }],
        subheading: ['18px', { lineHeight: '1.4', letterSpacing: '-0.36px' }],
        'heading-sm': ['24px', { lineHeight: '1.33', letterSpacing: '-0.48px' }],
        h2: ['24px', { lineHeight: '1.33', letterSpacing: '-0.48px' }],
        heading: ['28px', { lineHeight: '1.25', letterSpacing: '-0.56px' }],
        h1: ['28px', { lineHeight: '1.25', letterSpacing: '-0.56px' }],
        'heading-lg': ['36px', { lineHeight: '1.25', letterSpacing: '-0.72px' }],
        display: ['60px', { lineHeight: '1.1', letterSpacing: '-1.2px' }],
        hero: ['60px', { lineHeight: '1.1', letterSpacing: '-1.2px' }],
      },
      borderRadius: {
        DEFAULT: '8px',
        md: '4px',
        lg: '8px', // inputs, buttons
        xl: '12px', // cards
        '2xl': '16px',
        full: '9999px', // tags, badges
      },
      maxWidth: {
        shell: '1120px', // Page max-width: 1120px from Desing.md
        prose: '72ch',
      },
      boxShadow: {
        subtle: 'rgba(255, 255, 255, 0.05) 0px 0px 0px 1px inset',
        'subtle-2': 'rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset',
        'subtle-3':
          'rgba(255, 255, 255, 0.1) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px',
        card: 'rgba(255, 255, 255, 0.05) 0px 0px 0px 1px inset',
        lift: 'rgba(255, 255, 255, 0.08) 0px 0px 0px 1px inset, rgba(0, 0, 0, 0.25) 0px 25px 50px -12px',
      },
      zIndex: {
        sticky: '100',
        overlay: '200',
        modal: '300',
        toast: '500',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
