import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Subscriptions, SubscriptionError, signedHeaders, type CallbackTransport } from '../lib/calendar/subscriptions.ts';
import { Store } from '../lib/calendar/store.ts';
import { open } from '../lib/calendar/crypto.ts';
import { callbackFailureCategory } from '../lib/calendar/callback-diagnostics.ts';
import type { Environment, Statement } from '../lib/calendar/types.ts';
function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const f of readdirSync('drizzle').filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync('drizzle/'+f,'utf8'));
  class Prepared implements Statement {
    values: SQLInputValue[] = []; constructor(private query: string) {}
    bind(...v: unknown[]) { this.values=v as SQLInputValue[]; return this; }
    async first<T>() { return (sql.prepare(this.query).get(...this.values) ?? null) as T | null; }
    async all<T>() { return {results:sql.prepare(this.query).all(...this.values) as T[]}; }
    async run() { return sql.prepare(this.query).run(...this.values); }
  }
  const DB = {prepare:(q:string)=>new Prepared(q), async batch(statements:Statement[]) { sql.exec('BEGIN'); try { for(const s of statements) await s.run(); sql.exec('COMMIT'); } catch(e) { sql.exec('ROLLBACK'); throw e; } }};
  const env: Environment = {DB,TOKEN_ENCRYPTION_KEY:btoa('a'.repeat(32))};
  sql.exec("INSERT INTO connections VALUES ('alice','encrypted',0); INSERT INTO calendars VALUES ('alice','personal','Personal',1,'g1'); INSERT INTO calendars VALUES ('alice','disabled','Disabled',0,'g2')");
  let now=1791200000000, calls=0;
  let respond: CallbackTransport['post'] = async (_url,body,headers) => {
    calls++; const expected = await signedHeaders(params.delivery.secret, headers['webhook-id'],headers['X-MCP-Subscription-Id'],body,now);
    assert.deepEqual(headers,expected); assert.equal(JSON.parse(body).type,'verification');
    return Response.json({challenge:JSON.parse(body).challenge});
  };
  const transport:CallbackTransport = {post:(...args)=>respond(...args)};
  const store=new Store(DB);
  const service=()=>new Subscriptions(store,env,()=>now,transport);
  const params={name:'calendar.event.starting',arguments:{calendarId:'personal'},delivery:{mode:'webhook',url:'https://receiver.example.com:443/callback',secret:'whsec_'+btoa('s'.repeat(32))},ttlMs:600_000};
  return {sql,env,store,service,params, setNow:(v:number)=>now=v, now:()=>now,calls:()=>calls,setRespond:(r:CallbackTransport['post'])=>respond=r};
}
test('signed verification, encrypted persistence, canonical identity, restart refresh, expiry and idempotent unsubscribe',async()=>{
  const f=fixture(), s=await f.service().subscribe('alice',f.params);
  assert.equal(f.calls(),1); assert.equal(s.refreshBefore,new Date(f.now()+600_000).toISOString());
  const row=f.sql.prepare('SELECT * FROM subscriptions').get()!;
  assert.ok(!String(row.secret).includes(f.params.delivery.secret));
  assert.equal(await open(String(row.secret),f.env.TOKEN_ENCRYPTION_KEY,`alice:${s.id}`),f.params.delivery.secret);
  const again=await f.service().subscribe('alice',{...f.params,delivery:{...f.params.delivery,url:'https://receiver.example.com/callback'}});
  assert.equal(again.id,s.id); assert.equal(f.calls(),1); assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,1);
  assert.equal(await f.service().active(s.id,'bob'),null);
  f.setNow(f.now()+600_000); assert.equal(await f.service().active(s.id,'alice'),null);
  await f.service().unsubscribe('bob',f.params); assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,1);
  await f.service().unsubscribe('alice',f.params); await f.service().unsubscribe('alice',f.params);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,0);
});
test('rotation re-verifies, retains encrypted previous key for bounded window and failure preserves old subscription',async()=>{
  const f=fixture(), s=await f.service().subscribe('alice',f.params); const before=f.sql.prepare('SELECT secret FROM subscriptions').get()!.secret;
  f.params.delivery.secret='whsec_'+btoa('n'.repeat(32)); await f.service().subscribe('alice',f.params);
  assert.equal(f.calls(),2); const row=f.sql.prepare('SELECT * FROM subscriptions').get()!; assert.equal(row.previous_secret,before); assert.equal(row.rotation_until,f.now()+300_000);
  f.params.delivery.secret='whsec_'+btoa('t'.repeat(32)); f.setRespond(async()=>Response.json({challenge:'wrong'}));
  await assert.rejects(f.service().subscribe('alice',f.params),e=>e instanceof SubscriptionError && e.reason==='challenge_failed');
  assert.equal((await f.service().active(s.id,'alice'))!.secret,row.secret);
});
test('validation and unavailable transport fail closed without callback traffic',async()=>{
  const f=fixture();
  for(const params of [{...f.params,name:'unknown'}, {...f.params,arguments:{calendarId:'personal',extra:true}}, {...f.params,ttlMs:-1}, {...f.params,cursor:'replay'}, ...['http://receiver.example.com','https://localhost/c','https://127.0.0.1/c','https://[::1]/c','https://receiver.example.com/#x','https://a:b@receiver.example.com/c'].map(url=>({...f.params,delivery:{...f.params.delivery,url}})), {...f.params,delivery:{...f.params.delivery,secret:'whsec_'+btoa('short')}}]) await assert.rejects(f.service().subscribe('alice',params),e=>e instanceof SubscriptionError && e.code===-32602);
  for(const owner of ['bob','alice']) await assert.rejects(f.service().subscribe(owner,{...f.params,arguments:{calendarId:'disabled'}}),e=>e instanceof SubscriptionError && e.code===-32001);
  await assert.rejects(new Subscriptions(f.store,f.env,f.now).subscribe('alice',f.params),e=>e instanceof SubscriptionError && e.reason==='transport_unavailable');
  assert.equal(f.calls(),0);
});
test('challenge mismatch, redirects, oversized responses and transport timeout never persist',async()=>{
  const f=fixture();
  for(const response of [Response.json({challenge:'wrong'}),new Response(null,{status:302,headers:{location:'https://receiver.example.com/next'}}),new Response('x'.repeat(4097))]) {
    f.setRespond(async()=>response); await assert.rejects(f.service().subscribe('alice',f.params),SubscriptionError);
  }
  f.setRespond(async()=>{throw new DOMException('timeout','TimeoutError');});
  await assert.rejects(f.service().subscribe('alice',f.params),e=>e instanceof SubscriptionError && e.reason==='timeout');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,0);
});
test('disable, disconnect and unsubscribe during challenge block the persisted commit',async()=>{
  for(const action of ['disable','disconnect','unsubscribe']) {
    const f=fixture(); f.setRespond(async(_url,body)=>{
      if(action==='disable') await f.store.revoke('alice','personal','g2');
      if(action==='disconnect') await f.store.disconnect('alice');
      if(action==='unsubscribe') await f.service().unsubscribe('alice',f.params);
      return Response.json({challenge:JSON.parse(body).challenge});
    });
    await assert.rejects(f.service().subscribe('alice',f.params),e=>e instanceof SubscriptionError && e.code===-32001);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,0);
  }
});
test('revocation clears secrets; generation changes and lost connection make persisted rows inactive',async()=>{
  const f=fixture(),s=await f.service().subscribe('alice',f.params);
  f.sql.exec("UPDATE calendars SET generation='g2'"); assert.equal(await f.service().active(s.id,'alice'),null);
  f.sql.exec("UPDATE calendars SET generation='g1'; DELETE FROM connections"); assert.equal(await f.service().active(s.id,'alice'),null);
  await f.store.revoke('alice','personal','g3'); assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,0);
});
test('overlapping verification commits only the latest persisted revision',async()=>{
  const f=fixture(); let release!:()=>void, entered!:()=>void;
  const waiting=new Promise<void>(r=>release=r), started=new Promise<void>(r=>entered=r); let count=0;
  f.setRespond(async(_url,body)=>{ if(++count===1){entered();await waiting;} return Response.json({challenge:JSON.parse(body).challenge}); });
  const first=f.service().subscribe('alice',f.params); const rejected=assert.rejects(first,e=>e instanceof SubscriptionError && e.code===-32001);
  await started; const second=await f.service().subscribe('alice',f.params); release(); await rejected;
  assert.ok(await f.service().active(second.id,'alice')); assert.equal(f.sql.prepare('SELECT count(*) n FROM subscriptions').get()!.n,1);
});
test('requested short lifetime is honored; null TTL receives finite server maximum',async()=>{
  const f=fixture(); const short=await f.service().subscribe('alice',{...f.params,ttlMs:1000});
  assert.equal(short.refreshBefore,new Date(f.now()+1000).toISOString());
  const finite=await f.service().subscribe('alice',{...f.params,ttlMs:null}); assert.equal(finite.refreshBefore,new Date(f.now()+86400_000).toISOString());
});

test('callback diagnostics distinguish transport, HTTP rejection and echo failure without leaking data', async () => {
  const f = fixture(), logs: unknown[][] = [], original = console.info;
  console.info = (...args: unknown[]) => { logs.push(args); };
  try {
    for (const [respond, expected] of [
      [async () => { throw new Error('certificate invalid for private-callback.example/token'); }, { stage: 'transport', outcome: 'failed' }],
      [async () => new Response(null, { status: 403 }), { stage: 'response_status', outcome: 'failed', status: 403 }],
      [async () => Response.json({ challenge: 'sensitive-wrong-challenge' }), { stage: 'challenge_echo', outcome: 'failed', status: 200 }],
    ] as const) {
      f.setRespond(respond);
      await assert.rejects(f.service().subscribe('alice', f.params), SubscriptionError);
      assert.deepEqual(logs.at(-1), ['calendar_callback_verification', expected]);
    }
    const captured = JSON.stringify(logs);
    for (const privateValue of ['private-callback', 'sensitive-wrong', f.params.delivery.url, f.params.delivery.secret, 'personal', 'alice']) assert.ok(!captured.includes(privateValue));
    assert.equal(callbackFailureCategory(new Error('x509: certificate for private-callback.example/token')), 'certificate');
    assert.equal(callbackFailureCategory(new Error('unknown private-callback.example/token')), 'unknown');
    assert.equal(callbackFailureCategory(new Error('byte transport failed')), 'stream');
    assert.equal(callbackFailureCategory(new DOMException('secret', 'TimeoutError')), 'timeout');
  } finally { console.info = original; }
});
