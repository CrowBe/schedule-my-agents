type Observation = {
 name: string;
 outcome: 'response' | 'policy_rejection' | 'network_failure' | 'timeout';
 status?: number;
 elapsedMs: number;
};

// Fixed, empty HEAD probes. No visitor-provided URLs, ports, headers, payloads,
// calendar identifiers or credentials. Never read or return response contents.
// Static private DNS fixtures are not a controlled DNS-rebinding experiment.
const fixtures = [
 { name: 'public_https_control', url: 'https://example.com/' },
 { name: 'loopback_v4', url: 'http://127.0.0.1/' },
 { name: 'private_v4', url: 'http://10.255.255.254/' },
 { name: 'link_local_v4', url: 'http://169.254.254.254/' },
 { name: 'documentation_v4', url: 'http://192.0.2.1/' },
 { name: 'loopback_v6', url: 'http://[::1]/' },
 { name: 'private_v6', url: 'http://[fd00::1]/' },
 { name: 'mapped_loopback_v6', url: 'http://[::ffff:127.0.0.1]/' },
 { name: 'dns_loopback', url: 'http://127.0.0.1.sslip.io/' },
 { name: 'redirect_to_loopback', url: 'https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%2F' },
] as const;

export async function nativeEgressDiagnostics(signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
 const observations = await Promise.all(fixtures.map(async (fixture): Promise<Observation> => {
  const started = Date.now();
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
  try {
   boundedSignal.throwIfAborted();
   const response = await fetcher(fixture.url, {
    method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: boundedSignal,
   });
   void response.body?.cancel().catch(() => {});
   return { name: fixture.name, outcome: 'response', status: response.status, elapsedMs: Date.now() - started };
  } catch (error) {
   // A refused socket, timeout, TLS failure or HTTP error is not proof that the
   // platform applied an address policy. Keep raw runtime messages private.
   const explicitPolicy = error instanceof Error && /(?:destination|address|network).{0,40}(?:disallowed|prohibited|forbidden)|(?:disallowed|prohibited|forbidden).{0,40}(?:destination|address|network)/i.test(error.message);
   return { name: fixture.name, outcome: boundedSignal.aborted ? 'timeout' : explicitPolicy ? 'policy_rejection' : 'network_failure', elapsedMs: Date.now() - started };
  }
 }));
 return { observations, dnsRebindingTested: false, callbackContractVerified: false, responseContents: 'discarded' };
}

export async function nativeEgressDiagnosticResponse(request: Request, siteOrigin?: string, fetcher?: typeof fetch) {
 return authenticatedDiagnosticResponse(request, siteOrigin, () => nativeEgressDiagnostics(request.signal, fetcher), 'calendar_native_egress_diagnostics');
}

export async function authenticatedDiagnosticResponse(request: Request, siteOrigin: string | undefined, run: () => Promise<unknown>, auditName: string) {
 if (!request.headers.get('oai-authenticated-user-id')) return Response.json({ error: 'Sign in.' }, { status: 401 });
 if (request.method !== 'POST' || new URL(request.url).search) return Response.json({ error: 'Fixed POST diagnostic only.' }, { status: 400 });
 if (!siteOrigin || request.headers.get('origin') !== siteOrigin) return Response.json({ error: 'Request origin is not allowed.' }, { status: 403 });
 // Sites may forward an empty POST as a non-null, already-ended stream.
 // Check its first read rather than treating the stream object as payload.
 if (request.body) {
  const reader = request.body.getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(1000)]);
  let abort!: () => void;
  try {
   signal.throwIfAborted();
   const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
   });
   if (!(await Promise.race([reader.read(), stopped])).done) return Response.json({ error: 'No request body is accepted.' }, { status: 400 });
  } catch { return Response.json({ error: 'No request body is accepted.' }, { status: 400 }); }
  finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); }
 }
 const result = await run();
 console.info(auditName, result);
 return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
