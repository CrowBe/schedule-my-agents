import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleCalendar } from '../lib/calendar/google.ts';
import { AppError, ProviderFailure } from '../lib/calendar/types.ts';
import { resolveConnectedProvider } from '../lib/calendar/providers.ts';
import { calendarFixture } from './helpers/calendar-fixture.ts';
import { seal } from '../lib/calendar/crypto.ts';

test('Google rate-limit 403 is retryable rather than lost calendar authority',async()=>{
 const adapter=new GoogleCalendar('access',async()=>Response.json({error:{errors:[{reason:'rateLimitExceeded'}]}},{status:403,headers:{'Retry-After':'4'}}));
 await assert.rejects(adapter.getOccurrence('calendar','instance'),error=>error instanceof AppError && error.status===503 && 'kind' in error && error.kind==='transient');
});
test('provider transport failure is a normalized retryable outcome without exposing the source error',async()=>{
 const adapter=new GoogleCalendar('access',async()=>{throw new Error('private provider URL or token');});
 await assert.rejects(adapter.getOccurrence('calendar','instance'),error=>error instanceof ProviderFailure && error.kind==='transient' && !error.message.includes('private'));
});
test('an expired Google access token is refreshed once inside its connection adapter before declaring authorization lost',async()=>{
 const f=calendarFixture('google');Object.assign(f.env,{TOKEN_ENCRYPTION_KEY:btoa('a'.repeat(32)),GOOGLE_CLIENT_ID:'test',GOOGLE_CLIENT_SECRET:'test'});
 await f.store.run('UPDATE connections SET refresh_token = ?',await seal('refresh',f.env.TOKEN_ENCRYPTION_KEY,'owner'));
 let tokens=0,reads=0;
 const http:typeof fetch=async(input,init)=>{
  if(String(input).includes('/token')) return Response.json({access_token:++tokens===1?'expired':'fresh'});
  if(++reads===1) return Response.json({error:{errors:[{reason:'authError'}]}},{status:401});
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer fresh');
  return Response.json({id:'instance-A',start:{dateTime:'2026-10-13T02:01:00Z'}});
 };
 const provider=await resolveConnectedProvider(f.env,f.store,'owner',http);
 assert.equal((await provider.getOccurrence!('calendar','instance-A'))?.providerEventId,'instance-A');
 assert.equal(tokens,2);assert.equal(reads,2);
});
