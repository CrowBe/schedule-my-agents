import type { CallbackTransport } from './subscriptions.ts';
import { resolveCallbackAddresses } from './callback-dns.ts';
import { validatedAddress } from './callback-policy.ts';
import { callbackFailureCategory } from './callback-diagnostics.ts';

// Diagnostic only: never returns acceptance to the subscription service.
// Native fetch is not established as a production-safe pinned transport.
export const nativeVerificationProbe: CallbackTransport = {
 async post(destination, body, headers, callerSignal) {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(8000)]);
  const url = new URL(destination);
  const payload = JSON.parse(body) as { type?: unknown; challenge?: unknown };
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
      payload.type !== 'verification' || typeof payload.challenge !== 'string' ||
      payload.challenge.length > 256 || Object.keys(payload).some(key => !['type', 'challenge'].includes(key))) {
   throw new Error('Verification-only diagnostic rejected input');
  }
  validatedAddress(await resolveCallbackAddresses(url.hostname, signal));
  try {
   const response = await fetch(destination, { method: 'POST', headers, body, signal, redirect: 'manual' });
   const reader = response.body?.getReader(); let text = '', size = 0;
   try {
    if (reader) { const decoder = new TextDecoder(); for (;;) {
     const part = await reader.read(); if (part.done) break;
     size += part.value.byteLength; if (size > 4096) throw new Error('Response exceeds diagnostic budget');
     text += decoder.decode(part.value, { stream: true });
    } text += decoder.decode(); }
    let echo = false;
    try { echo = (JSON.parse(text) as { challenge?: unknown }).challenge === payload.challenge; } catch { /* Only report a boolean. */ }
    console.info('calendar_native_callback_probe', { status: response.status, echo, hostname: url.hostname, activation: 'disabled' });
   } finally { await reader?.cancel().catch(() => {}); }
  } catch (error) {
   console.info('calendar_native_callback_probe', { outcome: 'failed', category: callbackFailureCategory(error), activation: 'disabled' });
  }
  throw new Error('Verification diagnostic cannot activate subscriptions');
 }
};
