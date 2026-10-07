'use client';
import { useState } from 'react';
import Link from 'next/link';
type Result = Awaited<ReturnType<typeof import('../../../lib/calendar/native-fetch-diagnostics').nativeFetchDiagnostics>>;

export default function NativeFetchDiagnostic() {
 const [result, setResult] = useState<Result | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 async function run() {
  setBusy(true); setError(''); setResult(null);
  try {
   const response = await fetch('/api/diagnostics/native-fetch', { cache: 'no-store' });
   if (!response.ok) throw new Error('Diagnostic request failed.');
   setResult(await response.json() as Result);
  } catch { setError('The diagnostic could not complete. Try again.'); }
  finally { setBusy(false); }
 }
 return <main>
  <header><span className="wordmark">Schedule my agents</span><Link href="/">Calendar setup</Link></header>
  <section className="intro"><p className="eyebrow">NATIVE FETCH DIAGNOSTIC</p><h1>Test the Site transport.</h1><p>Send seven requests to fixed public test endpoints. Results show TLS fixture responses, redirect handling, cancellation and the response size limit.</p></section>
  <section className="panel">
   <button className="primary" disabled={busy} onClick={run}>{busy ? 'Running checks…' : 'Run native fetch checks'}</button>
   {error && <p role="alert">{error}</p>}
   {result && <div aria-live="polite"><h2>Hosted observations</h2><div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left' }}><thead><tr><th>Fixture</th><th>Outcome</th><th>HTTP</th><th>Bytes</th><th>Time</th></tr></thead><tbody>{result.observations.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.outcome}</td><td>{item.status ?? '—'}</td><td>{item.bytes ?? '—'}</td><td>{item.elapsedMs} ms</td></tr>)}</tbody></table></div></div>}
  </section>
  <aside><h2>Callback validation remains open.</h2><p>These checks do not test DNS rebinding or establish connection-time IP validation. A failed TLS fixture may also reflect routing or policy rejection. Subscriptions remain disabled.</p></aside>
  <footer>Requests contain no calendar data or credentials. Destinations and payloads cannot be supplied by the caller.</footer>
 </main>;
}
