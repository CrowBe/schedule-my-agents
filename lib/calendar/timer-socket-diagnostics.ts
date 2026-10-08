import { signedHeaders } from '../../shared/alarm.ts';
import { boundedProbe } from '../../shared/probe-deadline.ts';

export async function timerSocketDiagnostics(env: { DISPATCHER_ORIGIN?: string; ALARM_REGISTRATION_KEY?: string }, signal: AbortSignal) {
 if (!env.DISPATCHER_ORIGIN || !env.ALARM_REGISTRATION_KEY) throw new Error('timer_unavailable');
 const origin = new URL(env.DISPATCHER_ORIGIN);
 if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('invalid_timer_origin');
 const path = '/diagnostics/callback-socket';
 const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
 const pending = fetch(new URL(path, origin), { method: 'POST', headers: await signedHeaders(env.ALARM_REGISTRATION_KEY, path, ''),
  redirect: 'manual', credentials: 'omit', signal: deadline });
 void pending.then(response => { if (deadline.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
 const response = await boundedProbe(pending, deadline);
 if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('timer_diagnostic_failed'); }
 const reader = response.body.getReader(); let text = '', size = 0; const decoder = new TextDecoder();
 try {
  for (;;) {
   const next = await boundedProbe(reader.read(), deadline); if (next.done) break;
   size += next.value.byteLength; if (size > 16384) throw new Error('timer_diagnostic_too_large');
   text += decoder.decode(next.value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
 } finally { void reader.cancel().catch(() => {}); }
}
