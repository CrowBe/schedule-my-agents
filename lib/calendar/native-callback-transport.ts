import type { CallbackTransport } from './subscriptions.ts';
import { resolveCallbackAddresses } from './callback-dns.ts';
import { validatedAddress } from './callback-policy.ts';

// Explicit owner-authorized experiment. Native fetch owns DNS resolution/TLS;
// the preflight below does not establish connection-time address pinning.
// Only the observed OpenAI callback host is supported, never arbitrary URLs.
export function createNativeOpenAICallbackTransport(options: {
 fetcher?: typeof fetch;
 resolve?: typeof resolveCallbackAddresses;
 timeoutMs?: number;
} = {}): CallbackTransport {
 const fetcher = options.fetcher ?? fetch;
 const resolve = options.resolve ?? resolveCallbackAddresses;
 return { async post(destination, body, headers, callerSignal) {
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.hostname !== 'connectors.api.openai.com' ||
      url.port || url.username || url.password || url.hash) throw new Error('unsupported_callback_destination');
  if (new TextEncoder().encode(body).byteLength > 256 * 1024) throw new Error('callback_body_too_large');
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(options.timeoutMs ?? 8000)]);
  signal.throwIfAborted();
  validatedAddress(await resolve(url.hostname, signal));
  signal.throwIfAborted();
  const response = await fetcher(url.href, { method: 'POST', body, headers, signal, redirect: 'manual', credentials: 'omit' });
  if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error('callback_redirected'); }
  // Verification echoes are small. Delivery needs only the status; bound and
  // cancel every response so an endpoint cannot keep a lease open indefinitely.
  const reader = response.body?.getReader();
  let text = '', size = 0;
  try {
   if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
     signal.throwIfAborted();
     const part = await reader.read(); if (part.done) break;
     size += part.value.byteLength;
     if (size > 4096) throw new Error('callback_response_too_large');
     text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
   }
   signal.throwIfAborted();
   return new Response([204, 205, 304].includes(response.status) ? null : text, { status: response.status });
  } finally { void reader?.cancel().catch(() => {}); }
 } };
}

export const nativeOpenAICallbackTransport = createNativeOpenAICallbackTransport();
