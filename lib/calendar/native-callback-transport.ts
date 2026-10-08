import type { CallbackTransport } from './subscriptions.ts';
import { resolveCallbackAddresses } from './callback-dns.ts';
import { validatedAddress } from './callback-policy.ts';

async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
 signal.throwIfAborted();
 let abort!: () => void;
 const stopped = new Promise<never>((_, reject) => {
  abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
 });
 try { return await Promise.race([work, stopped]); }
 finally { signal.removeEventListener('abort', abort); }
}

const allowedHeaders = new Set(['content-type', 'webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-mcp-subscription-id']);

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
 return { async post(destination, body, headers, callerSignal, responseMode = 'body') {
  const url = new URL(destination);
  if (url.protocol !== 'https:' || url.hostname !== 'connectors.api.openai.com' ||
      url.port || url.username || url.password || url.hash || url.href.length > 2048) throw new Error('unsupported_callback_destination');
  if (new TextEncoder().encode(body).byteLength > 256 * 1024) throw new Error('callback_body_too_large');
  let headerBytes = 0;
  for (const [name, value] of Object.entries(headers)) {
   if (!allowedHeaders.has(name.toLowerCase()) || /[\r\n]/.test(value)) throw new Error('invalid_callback_header');
   headerBytes += new TextEncoder().encode(`${name}: ${value}\r\n`).byteLength;
  }
  if (headerBytes > 8192) throw new Error('callback_headers_too_large');
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(options.timeoutMs ?? 8000)]);
  signal.throwIfAborted();
  validatedAddress(await bounded(resolve(url.hostname, signal), signal));
  signal.throwIfAborted();
  const pending = fetcher(url.href, { method: 'POST', body, headers, signal, redirect: 'manual', credentials: 'omit' });
  void pending.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
  const response = await bounded(pending, signal);
  if (response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error('callback_redirected'); }
  // Receipt and terminal statuses must survive oversized or stalled bodies.
  // Only successful verification replies need their bounded challenge echo.
  if (!response.ok || responseMode === 'status') {
   void response.body?.cancel().catch(() => {});
   return new Response(null, { status: response.status });
  }
  // Verification needs a bounded challenge echo. Delivery discards the body
  // as soon as headers acknowledge receipt, even if the body never finishes.
  const reader = response.body?.getReader();
  let text = '', size = 0;
  try {
   if (reader) {
    const decoder = new TextDecoder();
    for (;;) {
     signal.throwIfAborted();
     const part = await bounded(reader.read(), signal); if (part.done) break;
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
