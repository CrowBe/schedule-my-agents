import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Subscriptions, type CallbackTransport } from '../lib/calendar/subscriptions.ts';
import { calendarFixture } from './helpers/calendar-fixture.ts';

for (const kind of ['google', 'opaque'] as const) {
 test(`${kind}: equivalent timezone offsets retain the same recurring occurrence and alarm identity`,async()=>{
  const f=calendarFixture(kind),first=await f.seed();
  f.edit({when:'2026-10-13T13:01:00+11:00',...(kind==='google'?{slot:'2026-10-13T13:01:00+11:00'}:{})});
  const second=await f.seed();assert.equal(second.id,first.id);
  f.setNow(first.dueAt);assert.equal((await f.wake(first)).status,204);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
 });
 test(`${kind}: a valid recurring wake registers only its successor and replay preserves logical identity`, async () => {
  const f = calendarFixture(kind), current = await f.seed();
  assert.equal(f.jobs.length, 1);
  f.setNow(current.dueAt);
  assert.equal((await f.wake(current)).status, 204);
  assert.equal(f.jobs.length, 2, 'the next instance is registered after the current instance is revalidated');
  assert.equal(f.jobs[1].dueAt, Date.parse('2026-10-20T02:01:00Z'));
  assert.equal((await f.wake(current)).status, 204);
  assert.equal(f.jobs[1].id, f.jobs[2].id);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n, 1);
 });
}

for (const kind of ['google', 'opaque'] as const) {
 test(`${kind}: signed subscription and lost acknowledgement survive restart and replay`,async()=>{
  const f=calendarFixture(kind), secret='whsec_'+Buffer.alloc(32,7).toString('base64');
  const bodies:string[]=[], ids:string[]=[], timestamps:string[]=[];
  const transport:CallbackTransport={post:async(_url,body,headers)=>{
   const expected=createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`).digest('base64');
   assert.equal(headers['webhook-signature'],'v1,'+expected);
   const data=JSON.parse(body);
   if(data.type==='verification') return Response.json({challenge:data.challenge});
   bodies.push(body); ids.push(headers['webhook-id']); timestamps.push(headers['webhook-timestamp']);
   assert.equal(data.data.eventId,'instance-A'); assert.equal(data.data.calendarId,'calendar');
   assert.notEqual(data.eventId,data.data.eventId);
   if(bodies.length===1) throw new Error('receiver accepted; response lost');
   return new Response(null,{status:204});
  }};
  await new Subscriptions(f.store,f.env,f.now,transport).subscribe('owner',{name:'calendar.event.starting',arguments:{calendarId:'calendar'},delivery:{mode:'webhook',url:'https://receiver.example/callback',secret}});
  const job=await f.seed();f.setNow(job.dueAt);
  assert.equal((await f.wake(job,transport)).status,503);
  assert.equal((await f.wake(job,transport)).status,503);assert.equal(bodies.length,1);
  f.setNow(f.now()+2000);assert.equal((await f.wake(job,transport)).status,204);
  assert.equal((await f.wake(job,transport)).status,204);
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(ids[0],ids[1]);assert.notEqual(timestamps[0],timestamps[1]);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
  assert.deepEqual({...await f.store.first<{status:string;attempts:number;body:string}>('SELECT status,attempts,body FROM deliveries')},{status:'accepted',attempts:2,body:''});
 });
 test(`${kind}: moving an instance preserves its slot and suppresses its old wake`,async()=>{
  for(const shift of [-30_000,60_000]) {
   const f=calendarFixture(kind),old=await f.seed();
   f.edit({when:new Date(old.dueAt+shift).toISOString()}); const moved=await f.seed();
   assert.notEqual(moved.id,old.id);
   f.setNow(old.dueAt);assert.equal((await f.wake(old)).status,204);
   assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,0);
   assert.equal(f.jobs.length,2,'stale wake does not advance the series');
   f.setNow(moved.dueAt);assert.equal((await f.wake(moved)).status,204);
   assert.equal(f.jobs.length,3);
   assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
  }
 });
 test(`${kind}: cancellation and restoration revalidate immutable alarms`,async()=>{
  const f=calendarFixture(kind),job=await f.seed();f.edit({cancelled:true});f.setNow(job.dueAt);
  assert.equal((await f.wake(job)).status,204);assert.equal(f.jobs.length,1);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,0);
  f.edit({cancelled:false});assert.equal((await f.wake(job)).status,204);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
 });
}
