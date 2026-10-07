import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, createFetchMock } from 'miniflare';
import { build } from 'esbuild';

test('Workers DNS aliases must not be mistaken for callback IP addresses', async () => {
  const mock = createFetchMock(); mock.disableNetConnect();
  for (const [type, address] of [['A', '8.8.8.8'], ['AAAA', '2606:4700:4700::1111']]) {
    mock.get('https://cloudflare-dns.com').intercept({method:'GET',path:`/dns-query?name=receiver.example&type=${type}`}).reply(200, JSON.stringify({Status:0,Question:[{name:'receiver.example.',type:type==='A'?1:28}],Answer:[{name:'receiver.example.',type:5,TTL:60,data:'edge.example.'},{name:'edge.example.',type:type==='A'?1:28,TTL:60,data:address}]}));
  }
  const {outputFiles} = await build({stdin:{contents:`import {resolveCallbackAddresses} from './lib/calendar/callback-dns.ts'; export default {async fetch(){return Response.json(await resolveCallbackAddresses('receiver.example',AbortSignal.timeout(1000)));}}`,resolveDir:process.cwd(),sourcefile:'callback-dns-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
  const mf = new Miniflare({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],cf:false,fetchMock:mock});
  try { assert.deepEqual(await (await mf.dispatchFetch('https://test.example')).json(), ['8.8.8.8','2606:4700:4700::1111']); }
  finally { await mf.dispose(); }
});

test('typed DNS preserves every IP for policy checks and rejects malformed or excessive responses', async () => {
  const {outputFiles} = await build({stdin:{contents:`import {resolveCallbackAddresses} from './lib/calendar/callback-dns.ts'; import {validatedAddress} from './lib/calendar/callback-policy.ts'; export default {async fetch(request){try{return Response.json({address:validatedAddress(await resolveCallbackAddresses(new URL(request.url).hostname,AbortSignal.timeout(1000)))});}catch(e){return Response.json({error:e.message},{status:502});}}}`,resolveDir:process.cwd(),sourcefile:'callback-dns-policy-worker.ts'},bundle:true,write:false,format:'esm',platform:'browser'});
  const mock = createFetchMock(); mock.disableNetConnect();
  for (const [host, records, expected] of [
    ['mixed.example', [{type:5,data:'edge.example.'},{type:1,data:'8.8.8.8'},{type:1,data:'127.0.0.1'}], 'unsafe_destination'],
    ['private.example', [{type:1,data:'10.0.0.1'}], 'unsafe_destination'],
    ['empty.example', [{type:5,data:'edge.example.'}], 'unsafe_destination'],
    ['malformed.example', [{type:1,data:null}], 'invalid_dns_response'],
    ['many.example', Array.from({length:33},()=>({type:1,data:'8.8.8.8'})), 'unsafe_destination'],
  ] as const) {
    mock.get('https://cloudflare-dns.com').intercept({method:'GET',path:`/dns-query?name=${host}&type=A`}).reply(200,JSON.stringify({Status:0,Answer:records}));
    mock.get('https://cloudflare-dns.com').intercept({method:'GET',path:`/dns-query?name=${host}&type=AAAA`}).reply(200,JSON.stringify({Status:0}));
    const mf = new Miniflare({modules:true,script:outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],cf:false,fetchMock:mock});
    try {
      const response = await mf.dispatchFetch(`https://${host}`);
      assert.equal(response.status,502); assert.deepEqual(await response.json(),{error:expected});
    } finally { await mf.dispose(); }
  }
});
