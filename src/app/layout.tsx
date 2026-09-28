import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Knowledge Graph',
  description: 'Crystalline Knowledge Vault. A sharp, faceted digital space built for clarity and focus.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-[100dvh] bg-abyss text-bright font-sans antialiased">{children}</body>
    </html>
  );
}

