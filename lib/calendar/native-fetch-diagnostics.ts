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

export function nativeFetchDiagnosticPage(request: Request, kind: 'native-fetch' | 'native-egress' | 'native-connection' | 'native-rebinding' = 'native-fetch') {
 if (!request.headers.get('oai-authenticated-user-id')) return new Response('Sign in through calendar setup first.', { status: 401 });
 if (request.method !== 'GET' || new URL(request.url).search) return new Response('Fixed GET diagnostic only.', { status: 400 });
 const egress = kind !== 'native-fetch';
 const buttonLabel = kind === 'native-connection' ? 'Run connection checks' : kind === 'native-rebinding' ? 'Run DNS change checks' : egress ? 'Run destination checks' : 'Run native fetch checks';
 const intro = kind === 'native-connection' ? 'Test fixed public and non-public address ranges, hostname TLS, literal-address routing and Node TLS lookup. HEAD contents are discarded; TLS probes send no application bytes.' : kind === 'native-rebinding' ? 'Test two existing DNS services that change a synthetic hostname from a public fixture address to loopback. Only empty HEAD requests and public DNS observations are used.' : egress ? 'Send ten empty HEAD requests to fixed public and non-public fixtures. Response contents are discarded.' : 'Send seven requests to fixed public test endpoints. Results show TLS fixture responses, redirect handling, cancellation and the response size limit.';
 return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site native fetch diagnostic</title>
<style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f5f8fc;color:#132a3a;font:16px/1.55 Arial,Helvetica,sans-serif}main{max-width:1120px;margin:auto;padding:32px}header{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #d7e0e9;padding-bottom:24px}.wordmark{font-weight:750;font-size:20px;letter-spacing:-.5px}a{color:#164fea}.intro{padding:36px 0 20px;max-width:720px}.eyebrow{font-size:13px;font-weight:700;letter-spacing:1.6px;color:#46627a}h1{font-size:clamp(32px,5vw,48px);letter-spacing:-2px;line-height:1.08;margin:16px 0 20px}h2{font-size:23px;letter-spacing:-.6px}p{margin:10px 0 20px}.panel{background:white;border:1px solid #d7e0e9;border-radius:12px;padding:28px;min-width:0}button{font:650 14px Arial;border:1px solid #164fea;background:#164fea;color:white;padding:12px 18px;border-radius:7px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible{outline:3px solid #164fea;outline-offset:3px}.table{overflow-x:auto}table{width:100%;text-align:left;border-collapse:collapse}td,th{padding:10px 8px;border-bottom:1px solid #d7e0e9}aside{margin-top:24px;padding:16px 28px;border-left:4px solid #164fea;background:#eaf0ff;border-radius:0 10px 10px 0}footer{font-size:14px;color:#536c80;padding-top:24px}#error{color:#952521}@media(max-width:760px){main{padding:20px}header{flex-direction:column}.panel{padding:20px}}</style></head><body><main>
<header><span class="wordmark">Schedule my agents</span><a href="/">Calendar setup</a></header>
<section class="intro"><p class="eyebrow">${egress ? 'DESTINATION POLICY DIAGNOSTIC' : 'NATIVE FETCH DIAGNOSTIC'}</p><h1>Test the Site transport.</h1><p>${intro}</p></section>
<section class="panel"><button id="run">${buttonLabel}</button><p id="error" role="alert"></p><div id="results" aria-live="polite" hidden><h2>Hosted observations</h2><div class="table"><table><thead><tr><th>Fixture</th><th>Outcome</th><th>HTTP</th><th>Bytes</th><th>Time</th></tr></thead><tbody id="rows"></tbody></table></div><pre id="details" hidden style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></div></section>
<aside><h2>Connection-time validation remains open.</h2><p>DNS answers, requested addresses and HTTP statuses do not establish which address the runtime actually connected to or its full connection-time policy. A timeout, TLS or generic network failure does not prove an address was blocked by policy. These probes do not change subscriptions or event readiness.</p></aside>
<footer>Requests contain no calendar data or credentials. Destinations and payloads cannot be supplied by the caller.</footer></main>
<script>const button=document.getElementById('run');button.addEventListener('click',async()=>{button.disabled=true;button.textContent='Running checks…';document.getElementById('error').textContent='';document.getElementById('results').hidden=true;try{const response=await fetch('/api/diagnostics/${kind}',{method:'${egress ? 'POST' : 'GET'}',cache:'no-store'});if(!response.ok)throw new Error();const result=await response.json();const rows=document.getElementById('rows');rows.replaceChildren();for(const item of result.observations){const row=document.createElement('tr');for(const value of [item.name,item.lookupCalls===undefined?item.outcome:item.outcome+' · lookup '+item.lookupCalls+' · identity '+item.identityChecks,item.status??'—',item.bytes??'—',item.elapsedMs+' ms']){const cell=document.createElement('td');cell.textContent=String(value);row.appendChild(cell);}rows.appendChild(row);}const details=document.getElementById('details');details.hidden=!result.trials;if(result.trials)details.textContent='DNS observations: '+JSON.stringify(result.trials,null,2)+'\\nActual connected address observed: '+result.actualConnectedAddressObserved+'\\nFull callback guarantee verified: '+result.callbackContractVerified;document.getElementById('results').hidden=false;}catch{document.getElementById('error').textContent='The diagnostic could not complete. Try again.';}finally{button.disabled=false;button.textContent='${buttonLabel}';}});</script></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
