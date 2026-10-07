type Observation = { name: string; outcome: 'response' | 'rejected' | 'timeout' | 'response_limit'; status?: number; bytes?: number; elapsedMs: number };

// Fixed public fixtures only. This cannot accept callback URLs, credentials,
// request payloads or private-network destinations, or activate subscriptions.
const fixtures = [
 { name: 'public_https', url: 'https://httpbin.org/get' },
 { name: 'tls_valid_control', url: 'https://badssl.com/' },
 { name: 'tls_wrong_hostname', url: 'https://wrong.host.badssl.com/' },
 { name: 'tls_untrusted_certificate', url: 'https://self-signed.badssl.com/' },
 { name: 'redirect_manual', url: 'https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Fget' },
 { name: 'timeout', url: 'https://httpbin.org/delay/5', timeoutMs: 1000 },
 { name: 'response_limit', url: 'https://httpbin.org/bytes/8192', maxBytes: 4096 },
] as const;

export async function nativeFetchDiagnostics(signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
 const observations = await Promise.all(fixtures.map(async (fixture): Promise<Observation> => {
  const started = Date.now();
  const deadline = AbortSignal.timeout('timeoutMs' in fixture ? fixture.timeoutMs : 8000);
  const boundedSignal = AbortSignal.any([signal, deadline]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
   const response = await fetcher(fixture.url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: boundedSignal });
   const status = response.status;
   reader = response.body?.getReader();
   if ('maxBytes' in fixture) {
    let bytes = 0;
    if (reader) for (;;) {
     const part = await reader.read();
     if (part.done) break;
     bytes += part.value.byteLength;
     if (bytes > fixture.maxBytes) return { name: fixture.name, outcome: 'response_limit', status, bytes, elapsedMs: Date.now() - started };
    }
    return { name: fixture.name, outcome: 'response', status, bytes, elapsedMs: Date.now() - started };
   }
   return { name: fixture.name, outcome: 'response', status, elapsedMs: Date.now() - started };
  } catch {
   return { name: fixture.name, outcome: boundedSignal.aborted ? 'timeout' : 'rejected', elapsedMs: Date.now() - started };
  } finally { await reader?.cancel().catch(() => {}); }
 }));
 // A failed TLS fixture may also reflect routing or policy rejection. These
 // observations never establish a platform DNS-rebinding or IP-pinning guarantee.
 return { observations, dnsRebindingTested: false, callbackContractVerified: false, subscriptionActivation: 'disabled' };
}

export async function nativeFetchDiagnosticResponse(request: Request, fetcher?: typeof fetch) {
 if (!request.headers.get('oai-authenticated-user-id')) return Response.json({ error: 'Sign in.' }, { status: 401 });
 if (request.method !== 'GET' || new URL(request.url).search) return Response.json({ error: 'Fixed GET diagnostic only.' }, { status: 400 });
 const result = await nativeFetchDiagnostics(request.signal, fetcher);
 console.info('calendar_native_fetch_diagnostics', result);
 return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
