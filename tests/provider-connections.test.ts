import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarFixture } from './helpers/calendar-fixture.ts';
import { resolveConnectedProvider } from '../lib/calendar/providers.ts';
import { open } from '../lib/calendar/crypto.ts';
import { GoogleCalendar } from '../lib/calendar/google.ts';
import type { ProviderFactory } from '../lib/calendar/providers.ts';
import { readFileSync } from 'node:fs';
import type { AlarmJob } from '../shared/alarm.ts';
const registration=(connect:ProviderFactory)=>({connect,readChange:()=>{throw new Error('not used');},isNewer:()=>true,ingressVerified:false});

test('scheduling connection metadata does not expose the stored provider credential',async()=>{
 const f=calendarFixture('google'),connection=await f.store.connection('owner');
 assert.ok(connection);assert.ok(!JSON.stringify(connection).includes('encrypted'));
});

test('Google adapter does not expose its bearer credential when a caller inspects or serializes it',()=>{
 const adapter=new GoogleCalendar('private-access-token',async()=>Response.json({items:[]}));
 assert.ok(!JSON.stringify(adapter).includes('private-access-token'));
});

test('migrated legacy Google connections retain the deployed v1 alarm identity and can finish an existing occurrence',async()=>{
 const f=calendarFixture('google');await f.store.run("UPDATE connections SET connection_id = ''");
 const job=await f.seed();
 // Reference generated independently by the unchanged PR #15 checkout.
 assert.equal(job.id,'cWRSq59OSHI_Ma5BfAUyL04A7kgSPQz1BtWLm7-EgDk');
 const envelope=JSON.parse(await open(job.envelope,f.env.ALARM_ENCRYPTION_KEY,'calendar-alarm:v1'));
 assert.equal(envelope.seriesId,'series');assert.equal(envelope.originalStartTime,'2026-10-13T02:01:00Z');
 assert.equal(envelope.connectionId,undefined);
 f.setNow(job.dueAt);assert.equal((await f.wake(job)).status,204);
 assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
});
test('deployed offset-based and newly canonicalized Google alarms share one persisted occurrence receipt',async()=>{
 const f=calendarFixture('google');await f.store.run("UPDATE connections SET connection_id = ''");
 f.edit({slot:'2026-10-13T13:01:00+11:00',when:'2026-10-13T13:01:00+11:00'});
 // Sealed fixture produced by unchanged PR #15, using only test identities/keys.
 const deployed=JSON.parse(readFileSync(new URL('./fixtures/legacy-google-alarm.json',import.meta.url),'utf8')) as AlarmJob;
 const current=await f.seed();f.setNow(deployed.dueAt);
 assert.equal((await f.wake(deployed)).status,204);
 assert.equal((await f.wake(current)).status,204);
 assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
});

test('connection-selected adapters hide credentials from scheduling and reject replacement during authorization', async () => {
 const f = calendarFixture('opaque');
 await f.store.run("UPDATE connections SET provider_id = 'opaque', connection_id = 'connection-A'");
 const identities: string[] = [];
 const adapters = { opaque: registration(async (connection: {id:string}) => { identities.push(connection.id); return {...f.provider,providerId:'opaque'}; }) };
 const provider = await resolveConnectedProvider(f.env, f.store, 'owner', fetch, adapters);
 assert.equal(provider.providerId, 'opaque'); assert.deepEqual(identities, ['connection-A']);
 assert.ok(!JSON.stringify(provider).includes('encrypted'));
 await assert.rejects(resolveConnectedProvider(f.env, f.store, 'owner', fetch, {opaque:registration(async () => {
  await f.store.run("UPDATE connections SET connection_id = 'connection-B'");
  return {...f.provider,providerId:'opaque'};
 })}), /connection changed/i);
});

test('unknown or mismatched provider factories fail closed instead of falling back to Google', async () => {
 const f = calendarFixture('opaque');
 await f.store.run("UPDATE connections SET provider_id = 'opaque', connection_id = 'connection-A'");
 await assert.rejects(resolveConnectedProvider(f.env,f.store,'owner',fetch), /provider is unavailable/i);
 await assert.rejects(resolveConnectedProvider(f.env,f.store,'owner',fetch,{opaque:registration(async()=>({...f.provider,providerId:'google'}))}), /provider identity/i);
});

for(const kind of ['google','opaque'] as const) {
 test(`${kind}: replacing a connection during provider revalidation cannot claim work or advance the series`,async()=>{
  const f=calendarFixture(kind),job=await f.seed();f.setNow(job.dueAt);
  f.lookup(async()=>{await f.store.run("UPDATE connections SET connection_id = 'replacement'");});
  assert.equal((await f.wake(job)).status,204);
  assert.equal(f.jobs.length,1);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,0);
 });
 test(`${kind}: connection replacement suppresses a previously valid alarm even when source IDs and grant are unchanged`, async()=>{
  const f=calendarFixture(kind);
  await f.store.run('UPDATE connections SET provider_id = ?, connection_id = ?',kind,'connection-A');
  const old=await f.seed();
  await f.store.run("UPDATE connections SET connection_id = 'connection-B'");
  const current=await f.seed();assert.notEqual(current.id,old.id);
  f.setNow(old.dueAt);assert.equal((await f.wake(old)).status,204);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,0);
  assert.equal((await f.wake(current)).status,204);
  assert.equal((await f.store.first<{n:number}>('SELECT count(*) n FROM occurrence_outbox'))?.n,1);
 });
}
