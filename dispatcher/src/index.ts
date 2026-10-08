import { DurableObject } from 'cloudflare:workers';
import { boundedBody, CALLBACK_PATH, MAX_HORIZON, parseJob, signedHeaders, verified, type AlarmJob } from '../../shared/alarm.ts';
import { SOCKET_DIAGNOSTIC_PATH, socketDiagnosticResponse } from './socket-diagnostic.ts';

export interface Env {
  ALARMS: DurableObjectNamespace;
  REGISTRATION_KEY: string;
  CALLBACK_KEY: string;
  CALLBACK_URL: string;
}
type State = { job: AlarmJob; attempts: number; complete?: boolean };
const RETENTION = 86400_000;
const LATE_CLEANUP = 5 * 60_000;

export class Alarm extends DurableObject<Env> {
  async fetch(request: Request) {
    const job = parseJob(await request.json());
    if (!job) return new Response(null, { status: 400 });
    // A logical job is immutable. Repeated registration never resets its retry/ack state.
    return this.ctx.storage.transaction(async tx => {
      const existing = await tx.get<State>('state');
      if (existing) {
        if (existing.job.id !== job.id || existing.job.dueAt !== job.dueAt || existing.job.expiresAt !== job.expiresAt) return new Response(null, { status: 409 });
      } else {
        await tx.put('state', { job, attempts: 0 } satisfies State);
        await tx.setAlarm(Math.max(Date.now(), job.dueAt));
      }
      return Response.json({ registered: true, id: job.id });
    });
  }
  async alarm() {
    const state = await this.ctx.storage.get<State>('state');
    if (!state) return;
    const now = Date.now();
    if (state.complete || now > state.job.expiresAt) {
      const cleanupAt = state.job.expiresAt + RETENTION;
      if (now >= cleanupAt) {
        // Return the same expired envelope so the Site can remove its delivery ledger too.
        if (now < cleanupAt + LATE_CLEANUP && !await this.post(state.job)) {
          await this.ctx.storage.setAlarm(Math.min(cleanupAt + LATE_CLEANUP, Date.now() + 60_000));
          return;
        }
        await this.ctx.storage.deleteAll(); return;
      }
      console.info('alarm_terminal', { outcome: state.complete ? 'acknowledged' : 'expired', attempts: state.attempts });
      state.complete = true;
      await this.ctx.storage.transaction(async tx => { await tx.put('state', state); await tx.setAlarm(state.job.expiresAt + RETENTION); });
      return;
    }
    if (now < state.job.dueAt) { await this.ctx.storage.setAlarm(state.job.dueAt); return; }
    const acknowledged = await this.post(state.job);
    state.attempts++;
    state.complete = acknowledged;
    const next = acknowledged ? state.job.expiresAt + RETENTION : Math.min(state.job.expiresAt + 1, Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(state.attempts - 1, 5)));
    await this.ctx.storage.transaction(async tx => { await tx.put('state', state); await tx.setAlarm(next); });
    console.info('alarm_attempt', { outcome: acknowledged ? 'acknowledged' : 'retry', attempts: state.attempts, latenessMs: now - state.job.dueAt });
  }
  private async post(job: AlarmJob) {
    const body = JSON.stringify(job);
    try {
      const callback = new URL(this.env.CALLBACK_URL);
      if (callback.protocol !== 'https:' || callback.pathname !== CALLBACK_PATH || callback.username || callback.password || callback.search || callback.hash) throw new Error('Invalid callback configuration.');
      const response = await fetch(callback, { method: 'POST', body, headers: await signedHeaders(this.env.CALLBACK_KEY, CALLBACK_PATH, body),
        redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      // Only the exact acknowledgement from application validation ends retries.
      const acknowledged = response.status === 204;
      await response.body?.cancel();
      return acknowledged;
    } catch { /* Persist retry state, never log payloads, URLs, credentials or identities. */ }
    return false;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const path = new URL(request.url).pathname;
    if (path === SOCKET_DIAGNOSTIC_PATH) return socketDiagnosticResponse(request, env.REGISTRATION_KEY);
    if (path === '/health' && request.method === 'GET') return Response.json({ service: 'opaque-alarm', version: 1 });
    if (path !== '/alarms' || request.method !== 'POST') return new Response(null, { status: 404 });
    let body: string;
    try { body = await boundedBody(request); } catch { return new Response(null, { status: 413 }); }
    if (!await verified(request, body, env.REGISTRATION_KEY, Date.now())) return new Response(null, { status: 401 });
    let job: AlarmJob | null;
    try { job = parseJob(JSON.parse(body)); } catch { return new Response(null, { status: 400 }); }
    if (!job || job.expiresAt <= Date.now() || job.dueAt > Date.now() + MAX_HORIZON) return new Response(null, { status: 400 });
    return env.ALARMS.get(env.ALARMS.idFromName(job.id)).fetch(new Request('https://alarm.internal/', { method: 'POST', body: JSON.stringify(job) }));
  },
} satisfies ExportedHandler<Env>;
