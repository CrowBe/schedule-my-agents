import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { seal } from '../lib/calendar/crypto.ts';
import { signedHeaders, CALLBACK_PATH, type AlarmJob } from '../shared/alarm.ts';

test('Workers/D1 revocation races during provider revalidation prevent signed dispatch',async()=>{
  const script=(await build({stdin:{contents:`import {CalendarService} from './lib/calendar/service.ts';export default {fetch(r,e){return new CalendarService(e,{callbackTransport:{post:(url,body,headers,signal)=>fetch(url,{method:'POST',body,headers,signal,redirect:'manual'})}}).handle(r)}};`,resolveDir:process.cwd(),sourcefile:'delivery-races.ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'})).outputFiles[0].text;
  for(const action of ['disable','disconnect','unsubscribe','expiry','edit','cancel']) {
    const encryption=btoa('e'.repeat(32)),registration=btoa('r'.repeat(32)),callback=btoa('c'.repeat(32));
    let hold=false;let job:AlarmJob|undefined, delivered=0, arrived!:()=>void,release!:()=>void;
    const lookup=new Promise<void>(r=>arrived=r), blocked=new Promise<void>(r=>release=r);
    let dueAt=Date.now()+5000;
    const event={id:'one',summary:'Synthetic race test',start:{dateTime:new Date(dueAt).toISOString()},status:'confirmed'};
    const mf=new Miniflare({modules:true,script,compatibilityDate:'2026-05-15',cf:false,d1Databases:{DB:'race-'+action},bindings:{SITE_ORIGIN:'https://site.example',TOKEN_ENCRYPTION_KEY:encryption,GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',DISPATCHER_ORIGIN:'https://alarm.example',ALARM_ENCRYPTION_KEY:encryption,ALARM_REGISTRATION_KEY:registration,ALARM_CALLBACK_KEY:callback},outboundService:async(request)=>{
      const url=new URL(request.url);
      if(url.origin==='https://receiver.example'){const data=JSON.parse(await request.text());if(data.type==='verification')return Response.json({challenge:data.challenge});delivered++;return new Response(null,{status:503});}
      if(url.origin==='https://alarm.example'){job=await request.json() as AlarmJob;return Response.json({registered:true,id:job.id});}
      if(url.origin==='https://oauth2.googleapis.com')return Response.json({access_token:'access'});
      if(url.pathname.endsWith('/one')){if(hold){arrived();await blocked;}return Response.json(event);}
      if(url.pathname.endsWith('/stop'))return new Response(null,{status:204});
      if(url.pathname.endsWith('/events'))return Response.json({items:[event]});
      throw new Error('Unexpected provider request');
    }});
    try {
      const db=await mf.getD1Database('DB');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())for(const sql of readFileSync('drizzle/'+file,'utf8').split('--> statement-breakpoint').filter(s=>s.trim()))await db.prepare(sql).run();
      await db.prepare('INSERT INTO connections VALUES (?, ?, ?)').bind('alice',await seal('refresh',encryption,'alice'),Date.now()).run();
      await db.prepare("INSERT INTO calendars VALUES ('alice','personal','Personal',1,'g1')").run();
      await db.prepare("INSERT INTO watches (id,owner,calendar_id,generation,token_hash,resource_id,expiration,status) VALUES ('watch','alice','personal','g1','hash','resource',?,'active')").bind(Date.now()+3600_000).run();
      const params={name:'calendar.event.starting',arguments:{calendarId:'personal'},delivery:{mode:'webhook',url:'https://receiver.example/callback',secret:'whsec_'+btoa('s'.repeat(32))}};
      const call=(path:string,body:unknown)=>mf.dispatchFetch('https://site.example'+path,{method:'POST',headers:{origin:'https://site.example','oai-authenticated-user-id':'alice'},body:JSON.stringify(body)});
      assert.ok(((await (await call('/mcp',{id:1,method:'events/subscribe',params})).json()) as {result?:unknown}).result);
      dueAt=Date.now()+250;event.start.dateTime=new Date(dueAt).toISOString();
      assert.equal((await call('/api/calendars/resync',{calendarId:'personal'})).status,200);assert.ok(job);
      await new Promise(r=>setTimeout(r,Math.max(0,dueAt-Date.now()+10)));
      const body=JSON.stringify(job);
      assert.equal((await mf.dispatchFetch('https://site.example'+CALLBACK_PATH,{method:'POST',body,headers:await signedHeaders(callback,CALLBACK_PATH,body)})).status,503);
      assert.equal(delivered,1);assert.ok(await db.prepare("SELECT subscription_id FROM deliveries WHERE status = 'pending'").first());
      await db.prepare('UPDATE deliveries SET next_at = 0').run();hold=true;
      const wake=mf.dispatchFetch('https://site.example'+CALLBACK_PATH,{method:'POST',body,headers:await signedHeaders(callback,CALLBACK_PATH,body)});
      await lookup;
      if(action==='disable')assert.equal((await call('/api/calendars/disable',{calendarId:'personal'})).status,200);
      if(action==='disconnect')assert.equal((await call('/api/google/disconnect',{})).status,200);
      if(action==='unsubscribe')await call('/mcp',{id:2,method:'events/unsubscribe',params});
      if(action==='expiry')await db.prepare('UPDATE subscriptions SET expires_at = ?').bind(Date.now()-1).run();
      if(action==='edit')event.start.dateTime=new Date(dueAt+60_000).toISOString();
      if(action==='cancel')event.status='cancelled';
      release();assert.equal((await wake).status,204);assert.equal(delivered,1,action);
      assert.equal(await db.prepare("SELECT subscription_id FROM deliveries WHERE status = 'pending'").first(),null);
    }finally{release?.();await mf.dispose();}
  }
});
