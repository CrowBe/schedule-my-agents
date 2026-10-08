import { publicAddress, validatedAddress } from './callback-policy.ts';
import { resolveCallbackAddresses } from './callback-dns.ts';

export type ConnectionObservation = { name: string; outcome: string; status?: number; elapsedMs: number; lookupCalls?: number; identityChecks?: number };

export async function boundedProbe<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
 signal.throwIfAborted();
 let abort!: () => void;
 const stopped = new Promise<never>((_, reject) => {
  abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
 });
 try { return await Promise.race([work, stopped]); }
 finally { signal.removeEventListener('abort', abort); }
}

export async function emptyHead(name: string, url: string, signal: AbortSignal, fetcher: typeof fetch, host?: string): Promise<ConnectionObservation> {
 const started = Date.now(), deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
 try {
  deadline.throwIfAborted();
  const pending = fetcher(url, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: deadline, ...(host ? { headers: { Host: host } } : {}) });
  void pending.then(response => { if (deadline.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
  const response = await boundedProbe(pending, deadline);
  void response.body?.cancel().catch(() => {});
  return { name, outcome: 'response', status: response.status, elapsedMs: Date.now() - started };
 } catch {
  return { name, outcome: deadline.aborted ? 'timeout' : 'network_or_tls_failure', elapsedMs: Date.now() - started };
 }
}

export async function nodeTlsProbe(name: string, host: string, address: string, servername: string, signal: AbortSignal): Promise<ConnectionObservation> {
 const started = Date.now(), deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
 let lookupCalls = 0, identityChecks = 0;
 const result = (outcome: string) => ({ name, outcome, lookupCalls, identityChecks, elapsedMs: Date.now() - started });
 try {
  validatedAddress([address]); deadline.throwIfAborted();
  const tls = await import('node:tls');
  return await new Promise<ConnectionObservation>(resolve => {
   // Fixed synthetic handshakes only. Never send HTTP/application bytes.
   const socket = tls.connect({ host, port: 443, servername, rejectUnauthorized: true,
    lookup: (_hostname, _options, callback) => { lookupCalls++; callback(null, address, address.includes(':') ? 6 : 4); },
    checkServerIdentity: (identity, certificate) => { identityChecks++; return tls.checkServerIdentity(identity, certificate); },
   });
   let finished = false;
   const finish = (outcome: string) => {
    if (finished) return; finished = true;
    deadline.removeEventListener('abort', abort); socket.destroy(); resolve(result(outcome));
   };
   const abort = () => finish('timeout');
   socket.once('secureConnect', () => finish(socket.authorized ? 'secure_connected' : 'identity_not_authorized'));
   socket.on('error', error => finish(/disallowed|prohibited|forbidden/i.test(error.message) ? 'policy_rejection' : 'socket_or_tls_failure'));
   socket.once('close', () => finish('socket_closed'));
   deadline.addEventListener('abort', abort, { once: true });
   if (deadline.aborted) abort();
  });
 } catch { return result(deadline.aborted ? 'timeout' : 'api_or_option_unavailable'); }
}

export async function nativeConnectionDiagnostics(signal: AbortSignal, options: {
 fetcher?: typeof fetch; resolve?: typeof resolveCallbackAddresses; tlsProbe?: typeof nodeTlsProbe;
} = {}) {
 const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
 const resolve = options.resolve ?? resolveCallbackAddresses, tlsProbe = options.tlsProbe ?? nodeTlsProbe;
 const fixtures = [
  ['public_https_control', 'https://httpbin.org/status/204'],
  ['public_http_control', 'http://httpbin.org/status/204'],
  ['unspecified_v4', 'http://0.0.0.0/'], ['loopback_https', 'https://127.0.0.1/'],
  ['private_172', 'http://172.16.255.254/'], ['private_192', 'http://192.168.255.254/'],
  ['cgnat', 'http://100.64.0.1/'], ['reserved_protocol', 'http://192.0.0.1/'],
  ['documentation_2', 'http://198.51.100.1/'], ['documentation_3', 'http://203.0.113.1/'],
  ['benchmarking', 'http://198.18.0.1/'], ['multicast_v4', 'http://224.0.0.1/'],
  ['reserved_v4', 'http://240.0.0.1/'], ['unspecified_v6', 'http://[::]/'],
  ['link_local_v6', 'http://[fe80::1]/'], ['multicast_v6', 'http://[ff02::1]/'],
  ['documentation_v6', 'http://[2001:db8::1]/'], ['documentation_v6_new', 'http://[3fff::1]/'],
  ['six_to_four_loopback', 'http://[2002:7f00:1::]/'], ['nat64_loopback', 'http://[64:ff9b::7f00:1]/'],
  ['wrong_hostname_tls', 'https://wrong.host.badssl.com/'], ['expired_tls', 'https://expired.badssl.com/'],
 ] as const;
 const observations = await Promise.all(fixtures.map(([name, url]) => emptyHead(name, url, signal, fetcher)));
 try {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const address = validatedAddress(await boundedProbe(resolve('httpbin.org', deadline), deadline));
  observations.push(...await Promise.all([
   emptyHead('public_literal_original_host', `https://${address}/status/204`, signal, fetcher, 'httpbin.org'),
   emptyHead('public_literal_without_host', `https://${address}/status/204`, signal, fetcher),
   emptyHead('public_literal_wrong_host', `https://${address}/status/204`, signal, fetcher, 'example.com'),
   emptyHead('loopback_literal_original_host', 'https://127.0.0.1/status/204', signal, fetcher, 'httpbin.org'),
   emptyHead('documentation_literal_original_host', 'https://192.0.2.1/status/204', signal, fetcher, 'httpbin.org'),
   tlsProbe('node_tls_public_custom_lookup', 'httpbin.org', address, 'httpbin.org', signal),
   tlsProbe('node_tls_wrong_identity', 'httpbin.org', address, 'example.com', signal),
  ]));
 } catch { observations.push({ name: 'public_fixture_resolution', outcome: 'resolution_or_address_policy_failure', elapsedMs: 0 }); }
 try {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const address = validatedAddress(await boundedProbe(resolve('connectors.api.openai.com', deadline), deadline));
  observations.push(await tlsProbe('node_tls_callback_custom_lookup', 'connectors.api.openai.com', address, 'connectors.api.openai.com', signal));
 } catch { observations.push({ name: 'callback_resolution', outcome: 'resolution_or_address_policy_failure', elapsedMs: 0 }); }
 return { observations, responseContents: 'discarded', applicationBytesSentByTlsProbes: 0,
  actualConnectedAddressObserved: false, callbackContractVerified: false,
  literalHostRoutingFalsified: observations.some(x => ['loopback_literal_original_host', 'documentation_literal_original_host'].includes(x.name) && x.status === 204),
 };
}

export async function fixtureAddresses(host: string, signal: AbortSignal, fetcher: typeof fetch): Promise<string[]> {
 const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
 const url = new URL('https://cloudflare-dns.com/dns-query'); url.searchParams.set('name', host); url.searchParams.set('type', 'A');
 deadline.throwIfAborted();
 const pending = fetcher(url, { headers: { Accept: 'application/dns-json' }, redirect: 'manual', credentials: 'omit', signal: deadline });
 void pending.then(response => { if (deadline.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
 const response = await boundedProbe(pending, deadline);
 if (!response.ok || response.redirected || !response.body) { void response.body?.cancel().catch(() => {}); throw new Error('fixture_dns_unavailable'); }
 const reader = response.body.getReader(); let text = '', size = 0;
 try {
  const decoder = new TextDecoder();
  for (;;) {
   const next = await boundedProbe(reader.read(), deadline); if (next.done) break;
   size += next.value.byteLength; if (size > 4096) throw new Error('fixture_dns_response_too_large');
   text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  const body = JSON.parse(text) as { Status?: number; Answer?: { type: number; data: string }[] };
  if (body.Status !== 0 || !Array.isArray(body.Answer) || body.Answer.length > 16) throw new Error('fixture_dns_unavailable');
  return body.Answer.filter(x => x.type === 1).map(x => x.data);
 } finally { void reader.cancel().catch(() => {}); }
}

export async function nativeRebindingDiagnostics(signal: AbortSignal, options: { fetcher?: typeof fetch; resolve?: typeof resolveCallbackAddresses } = {}) {
 const fetcher = options.fetcher ?? ((input, init) => fetch(input, init)), resolve = options.resolve ?? resolveCallbackAddresses;
 const observations: ConnectionObservation[] = [], trials: { fixture: string; before: string[]; after: string[]; publicThenLoopbackObserved: boolean }[] = [];
 try {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const address = validatedAddress(await boundedProbe(resolve('httpbin.org', deadline), deadline));
  if (!publicAddress(address) || address.includes(':')) throw new Error('ipv4_fixture_required');
  const control = `make-${address.replaceAll('.', '-')}-rr.1u.ms`;
  observations.push(await emptyHead('rebind_service_public_control', `http://${control}/status/204`, signal, fetcher));
  for (const fixture of ['oneums', 'whonow'] as const) {
   const nonce = crypto.randomUUID();
   const host = fixture === 'oneums' ? `${nonce}.make-${address.replaceAll('.', '-')}-rebindfor1m-127-0-0-1-rr.1u.ms` : `a.${address}.1time.127.0.0.1.forever.${nonce}.rebind.network`;
   let before: string[] = [], after: string[] = [];
   try {
    before = await fixtureAddresses(host, signal, fetcher);
    if (!before.length || before.some(ip => ip !== address)) throw new Error('public_preflight_not_observed');
    observations.push(await emptyHead(`${fixture}_after_public_preflight`, `http://${host}/status/204`, signal, fetcher));
    after = await fixtureAddresses(host, signal, fetcher);
    if (after.some(ip => ip !== address && ip !== '127.0.0.1')) throw new Error('unexpected_fixture_answer');
   } catch { observations.push({ name: `${fixture}_dns_sequence`, outcome: 'fixture_unavailable_or_unexpected_answer', elapsedMs: 0 }); }
   trials.push({ fixture, before, after, publicThenLoopbackObserved: before.length > 0 && before.every(ip => ip === address) && after.length > 0 && after.every(ip => ip === '127.0.0.1') });
  }
 } catch { observations.push({ name: 'rebinding_fixture_resolution', outcome: 'resolution_or_address_policy_failure', elapsedMs: 0 }); }
 return { observations, trials, responseContents: 'discarded', actualConnectedAddressObserved: false,
  dnsAnswerChangeObserved: trials.some(x => x.publicThenLoopbackObserved), callbackContractVerified: false };
}
