import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Second Brain',
  description: 'The team wiki, kept by an agent. Documents go in, linked pages come out, and questions are answered from what is there.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f5f5f5' },
    { media: '(prefers-color-scheme: dark)', color: '#262626' },
  ],
};

/**
 * Runs before the first paint. It puts the reader's theme and the sidebars they
 * closed onto <html>, where the stylesheet looks for them, so that none of it
 * flashes by in the wrong state while the page wakes up.
 *
 * It reads three settings and writes three attributes. It takes nothing from the
 * address or the page, so there is nothing in it for a visitor to influence.
 */
const BOOT = `(function(){try{var d=document.documentElement.dataset,s=localStorage,t=s.getItem('sb-theme');if(t==='light'||t==='dark')d.theme=t;if(s.getItem('sb-left')==='0')d.left='0';if(s.getItem('sb-right')==='0')d.right='0'}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The attributes the script sets are not in the server's markup, by design.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
