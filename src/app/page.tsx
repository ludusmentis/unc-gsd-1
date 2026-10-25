'use client';

import Link from 'next/link';

export default function Home() {
  return (
    <main style={styles.main}>
      <h1 style={styles.title}>uncover</h1>
      <p style={styles.sub}>place songs in time. embarrass your friends.</p>
      <div style={styles.stack}>
        <Link href="/host" style={styles.primaryBtn}>host a room</Link>
        <Link href="/join" style={styles.ghostBtn}>join with a code</Link>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: 24, background: '#0b0d12', color: '#f2f4f8', fontFamily: 'system-ui, sans-serif' },
  title: { fontSize: 44, margin: 0, letterSpacing: -1 },
  sub: { margin: 0, opacity: 0.7 },
  stack: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 360 },
  primaryBtn: { display: 'block', textAlign: 'center', padding: '18px 24px', borderRadius: 16, background: '#1db954', color: '#04120a', fontWeight: 700, fontSize: 18, textDecoration: 'none', minHeight: 48 },
  ghostBtn: { display: 'block', textAlign: 'center', padding: '18px 24px', borderRadius: 16, background: 'transparent', color: '#f2f4f8', fontWeight: 600, fontSize: 18, textDecoration: 'none', border: '2px solid #2a2f3a', minHeight: 48 },
};
