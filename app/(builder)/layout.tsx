import '@/app/globals.css';
import { Inter } from 'next/font/google';
import RootLayoutShell, { getDefaultMetadata } from '@/components/RootLayoutShell';

// Inter powers the builder's UI. It is loaded here (not in the shared shell)
// so published public pages don't ship the builder's font.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export function generateMetadata() {
  return getDefaultMetadata();
}

export default function BuilderLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <RootLayoutShell lang="en" bodyClassName={`${inter.variable} font-sans antialiased text-xs`}>
      {children}
    </RootLayoutShell>
  );
}
