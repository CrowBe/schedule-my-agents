import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarFixture } from './helpers/calendar-fixture.ts';
import { CalendarService } from '../lib/calendar/service.ts';
import { digest } from '../lib/calendar/crypto.ts';

test('provider authorization belongs to the registered adapter and never grants calendar consent implicitly',async()=>{
 const f=calendarFixture('opaque'),owners:string[]=[];await f.store.revoke('owner','calendar','revoked');
 const service=new CalendarService(f.env,{providerAdapters:{opaque:{connect:async()=>({...f.provider,providerId:'opaque'}),ingressVerified:false,
  readChange:()=>{throw new Error('not used');},isNewer:()=>true,
  authorization:()=>({configured:true,start:async owner=>{owners.push(owner);return new Response(null,{status:303,headers:{Location:'https://provider.example/authorize'}});},
   complete:async owner=>{owners.push(owner);return Response.json({connected:true});}}),
 }}});
 const request=(path:string,method:string,origin=f.env.SITE_ORIGIN!)=>service.handle(new Request(f.env.SITE_ORIGIN+path,{method,headers:{'oai-authenticated-user-id':'owner',origin},...(method==='POST'?{body:JSON.stringify({owner:'forged'})}:{})}));
 assert.equal((await request('/api/providers/opaque/connect','POST')).status,303);
 assert.equal((await request('/api/providers/opaque/callback','GET')).status,200);
 assert.equal((await request('/api/providers/opaque/connect','POST','https://foreign.example')).status,403);
 assert.deepEqual(owners,['owner','owner']);
 assert.equal((await f.store.calendar('owner','calendar'))?.enabled,0);
});

test('a second provider decodes its change notifications and converges through shared consent, sync and alarm handling',async()=>{
 const f=calendarFixture('opaque'),token='test-private-watch-token';
 await f.store.run("INSERT INTO watches (id,owner,calendar_id,generation,token_hash,resource_id,expiration,provider_id,connection_id,status) VALUES ('watch','owner','calendar','grant',?,'resource',?,'opaque','connection-opaque','active')",await digest(token),f.now()+3600_000);
 const service=()=>new CalendarService(f.env,{now:f.now,providerAdapters:{opaque:{
  connect:async()=>({...f.provider,providerId:'opaque'}),ingressVerified:true,
  readChange:async request=>{const data=await request.json() as {stream:string;proof:string;collection:string;revision:string};return {watchId:data.stream,token:data.proof,resourceId:data.collection,cursor:data.revision,state:'changed' as const};},
  isNewer:(cursor,previous)=>!previous || Number(cursor.slice(4))>Number(previous.slice(4)),
 }},http:async(_url,init)=>{const job=JSON.parse(String(init?.body));f.jobs.push(job);return Response.json({registered:true,id:job.id});}});
 const notify=async(cursor:string)=>service().handle(new Request(f.env.SITE_ORIGIN+'/api/providers/opaque/webhook',{method:'POST',body:JSON.stringify({stream:'watch',proof:token,collection:'resource',revision:cursor})}));
 assert.equal((await notify('rev-2')).status,204);
 assert.equal(f.jobs.length,1);
 assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM events'))?.n,1);
 f.edit({when:'2026-10-13T03:01:00Z'});
 assert.equal((await notify('rev-4')).status,204);
 assert.equal(f.jobs.at(-1)?.dueAt,Date.parse('2026-10-13T03:01:00Z'));
 assert.equal((await notify('rev-3')).status,204);
 assert.equal((await notify('rev-4')).status,204);
 assert.equal(f.jobs.length,2);
 const current=await f.store.first<{payload:string}>('SELECT payload FROM events');
 assert.equal(JSON.parse(current!.payload).start,'2026-10-13T03:01:00Z');
 await f.store.revoke('owner','calendar','revoked');
 assert.equal((await notify('rev-5')).status,403);
 assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM events'))?.n,0);
});

for (const kind of ['google', 'opaque'] as const) {
 test(`${kind}: delayed notification cursor persistence cannot overwrite a newer cursor`, async () => {
  const f = calendarFixture(kind), token = 'private-watch-token';
  await f.store.run("INSERT INTO watches (id,owner,calendar_id,generation,token_hash,resource_id,expiration,provider_id,connection_id,status) VALUES ('watch','owner','calendar','grant',?,'resource',?,?,?,'active')", await digest(token), f.now()+3600_000, kind, `connection-${kind}`);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = f.DB.prepare;
  f.env.DB = { ...f.DB, prepare(query) {
   const statement = original(query), bind = statement.bind.bind(statement), run = statement.run.bind(statement);
   let cursor: unknown;
   statement.bind = (...values: unknown[]) => { cursor = values[0]; return bind(...values); };
   statement.run = async () => {
    if (query.startsWith('UPDATE watches SET last_message') && cursor === '2') { entered.resolve(); await release.promise; }
    return run();
   };
   return statement;
  }};
  const service = () => new CalendarService(f.env, { now: f.now, provider: async () => f.provider,
   providerAdapters: { [kind]: { connect: async () => ({...f.provider, providerId:kind}), ingressVerified:true,
    readChange: async request => ({ watchId:'watch', token, resourceId:'resource', cursor:await request.text(), state:'changed' as const }),
    isNewer:(cursor, previous) => !previous || BigInt(cursor)>BigInt(previous) } },
   http: async (_url, init) => { const job=JSON.parse(String(init?.body)); f.jobs.push(job); return Response.json({registered:true,id:job.id}); },
  });
  const notify = (cursor:string) => service().handle(new Request(f.env.SITE_ORIGIN+`/api/providers/${kind}/webhook`, {method:'POST',body:cursor}));
  const first = notify('2'); await entered.promise;
  const overlapping = await notify('4');
  release.resolve(); assert.equal((await first).status,204);
  // A busy channel asks for retry; a completed newer sync must never be rolled back.
  if (overlapping.status===503) assert.equal((await notify('4')).status,204);
  else assert.equal(overlapping.status,204);
  assert.equal((await f.store.first<{last_message:string}>('SELECT last_message FROM watches'))?.last_message,'4');
  const registrations=f.jobs.length;
  assert.equal((await notify('3')).status,204);
  assert.equal(f.jobs.length,registrations);
  // A delayed initial read can pass the outer ordering check with an old row.
  const captured=Promise.withResolvers<void>(), resume=Promise.withResolvers<void>();
  const prepare=f.env.DB!.prepare.bind(f.env.DB);let armed=true;
  f.env.DB={...f.DB,prepare(query){
   const statement=prepare(query),first=statement.first.bind(statement);
   statement.first=async <T>()=>{
    const row=await first<T>();
    if(armed && query==='SELECT * FROM watches WHERE id = ?'){armed=false;captured.resolve();await resume.promise;}
    return row;
   };
   return statement;
  }};
  const delayed=notify('5');await captured.promise;
  assert.equal((await notify('6')).status,204);const afterNewer=f.jobs.length;
  await f.store.run('UPDATE watches SET sync_failed = 1');
  resume.resolve();assert.equal((await delayed).status,204);
  assert.equal((await f.store.first<{last_message:string}>('SELECT last_message FROM watches'))?.last_message,'6');
  assert.equal(f.jobs.length,afterNewer,'ordering is checked again under the lock');
  assert.equal((await f.store.first<{sync_failed:number}>('SELECT sync_failed FROM watches'))?.sync_failed,1,'skipped stale notifications preserve a recovery warning');
  const fetching=Promise.withResolvers<void>(), finish=Promise.withResolvers<void>();
  const sync=f.provider.syncEvents.bind(f.provider);let hold=true;
  f.provider.syncEvents=async(...args)=>{
   const events=await sync(...args);
   if(hold){hold=false;fetching.resolve();await finish.promise;}
   return events;
  };
  const expired=notify('7');await fetching.promise;
  f.setNow(f.now()+180_001);f.edit({title:'Newer snapshot',when:new Date(f.now()+60000).toISOString()});
  const saving=Promise.withResolvers<void>(), saved=Promise.withResolvers<void>();
  const latestPrepare=f.env.DB!.prepare.bind(f.env.DB);
  f.env.DB={...f.DB,prepare(query){
   const statement=latestPrepare(query),bind=statement.bind.bind(statement),run=statement.run.bind(statement);let cursor:unknown;
   statement.bind=(...values:unknown[])=>{cursor=values[0];return bind(...values);};
   statement.run=async()=>{if(query.startsWith('UPDATE watches SET last_message')&&cursor==='8'){saving.resolve();await saved.promise;}return run();};
   return statement;
  }};
  const newer=notify('8');await saving.promise;
  const snapshot=await f.store.all('SELECT * FROM events');
  const lease=await f.store.first('SELECT sync_until,sync_failed FROM watches');
  finish.resolve();assert.equal((await expired).status,503);
  assert.deepEqual(await f.store.first('SELECT sync_until,sync_failed FROM watches'),lease,'expired sync cannot release or mark its successor failed');
  saved.resolve();assert.equal((await newer).status,204);
  assert.equal((await f.store.first<{last_message:string}>('SELECT last_message FROM watches'))?.last_message,'8');
  assert.deepEqual(await f.store.all('SELECT * FROM events'),snapshot,'expired sync cannot replace a newer snapshot');
 });
}
