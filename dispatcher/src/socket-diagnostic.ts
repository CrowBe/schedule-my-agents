import { connect } from 'cloudflare:sockets';
import { resolveCallbackAddresses } from '../../lib/calendar/callback-dns.ts';
import { validatedAddress } from '../../lib/calendar/callback-policy.ts';
import { openCallbackSocket } from '../../lib/calendar/callback-socket.ts';
import { callbackFailureCategory } from '../../lib/calendar/callback-diagnostics.ts';
import { verified } from '../../shared/alarm.ts';
import { boundedProbe } from '../../shared/probe-deadline.ts';

export const SOCKET_DIAGNOSTIC_PATH = '/diagnostics/callback-socket';

// Only the Site can authorize these fixed, empty TCP probes. The timer still
// receives no calendar identities, event plaintext, OAuth or decryption keys.
export async function socketDiagnosticResponse(request: Request, secret: string) {
 if (request.method !== 'POST' || new URL(request.url).search) return new Response(null, { status: 400 });
 if (request.body) {
  const reader = request.body.getReader();
  try {
   if (!(await boundedProbe(reader.read(), AbortSignal.any([request.signal, AbortSignal.timeout(1000)]))).done) return new Response(null, { status: 400 });
  } catch { return new Response(null, { status: 400 }); }
  finally { void reader.cancel().catch(() => {}); }
 }
 if (!await verified(request, '', secret, Date.now())) return new Response(null, { status: 401 });
 const observations = (await Promise.all(['httpbin.org', 'connectors.api.openai.com'].map(async host => {
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(6000)]);
  try {
   const addresses = await boundedProbe(resolveCallbackAddresses(host, signal), signal);
   validatedAddress(addresses);
   return await Promise.all([...new Set(addresses)].map(async address => {
    const started = Date.now();
    try {
     const socket = await openCallbackSocket([address], signal, ip => connect({ hostname: ip, port: 443 }, { secureTransport: 'off', allowHalfOpen: false }));
     void socket.close().catch(() => {});
     return { name: host, address, outcome: 'socket_opened', elapsedMs: Date.now() - started };
    } catch (error) {
     const policy = error instanceof Error && /disallowed|prohibited|forbidden/i.test(error.message);
     return { name: host, address, outcome: signal.aborted ? 'timeout' : policy ? 'policy_rejection' : 'socket_failure', failureCategory: callbackFailureCategory(error), elapsedMs: Date.now() - started };
    }
   }));
  } catch { return [{ name: host, outcome: 'resolution_or_address_policy_failure', elapsedMs: 0 }]; }
 }))).flat();
 const result = { observations, applicationBytesSent: 0, actualConnectedAddressObserved: false, callbackContractVerified: false };
 console.info('opaque_timer_socket_diagnostic', result);
 return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
}
