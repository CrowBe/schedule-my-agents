// Browser verification only: synthetic Google provider, in-memory SQL, loopback host.
// This fixture is never imported into the production Worker.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { CalendarService } from '../lib/calendar/service.ts';
import { CALENDAR_APP_URI } from '../lib/calendar/setup-contract.ts';
import { buildCalendarApp } from '../scripts/build-calendar-app.mjs';

await buildCalendarApp();
const html=await readFile('.sites-runtime/calendar-app.html','utf8');
const host=await build({entryPoints:['tests/calendar-app-host-client.mjs'],bundle:true,write:false,format:'iife',platform:'browser'});
const sql=new DatabaseSync(':memory:');
for (const file of (await readdir('drizzle')).filter(file=>file.endsWith('.sql')).sort()) sql.exec(await readFile('drizzle/'+file,'utf8'));
class Statement {
  values=[];
  constructor(query) { this.query=query; }
  bind(...values) { this.values=values; return this; }
  async first() { return sql.prepare(this.query).get(...this.values) ?? null; }
  async all() { return {results:sql.prepare(this.query).all(...this.values)}; }
  async run() { return sql.prepare(this.query).run(...this.values); }
}
const DB={prepare:query=>new Statement(query),async batch(statements){sql.exec('BEGIN');try{for(const statement of statements)await statement.run();sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}}};
const env={DB,SITE_ORIGIN:'https://synthetic.chatgpt.site',GOOGLE_CLIENT_ID:'synthetic',GOOGLE_CLIENT_SECRET:'synthetic',TOKEN_ENCRYPTION_KEY:btoa('a'.repeat(32)),GOOGLE_WEBHOOK_VERIFIED:'true'};
let providerUnavailable=false;
const service=new CalendarService(env,{calendarAppHtml:html,provider:async()=>({
  async discoverCalendars(){if(providerUnavailable)throw new Error('Synthetic provider unavailable');return [{id:'personal',summary:'Personal (synthetic)',accessRole:'owner'},{id:'work',summary:'Work (synthetic)',accessRole:'reader'},{id:'busy',summary:'Availability only (synthetic)',accessRole:'freeBusyReader'}];},
  async watchCalendar(calendarId,id,token){return{id,token,resourceId:'synthetic-resource',expiration:Date.now()+86400_000};},
  async stopWatchingCalendar(){}, async syncEvents(){return [];},
})});
const server=createServer(async(incoming,outgoing)=>{
  try {
    const path=new URL(incoming.url,'http://localhost').pathname;
    if (path==='/' && incoming.method==='GET') {
      outgoing.setHeader('Content-Type','text/html;charset=utf-8');outgoing.end('<!doctype html><meta charset="utf-8"><title>Calendar app verification</title><style>body{margin:0;font:15px Arial;color:#132a3a;background:#f5f8fc}header{padding:12px;background:#fff;border-bottom:1px solid #d7e0e9}button{padding:8px}iframe{border:0;width:100%;height:1100px}output{display:block;margin:8px 0}</style><header><strong>Local MCP App host · Synthetic data</strong><p>This uses the production UI and CalendarService with a fake provider. No real Google account or live permissions are changed.</p><button id="connect">Complete synthetic Google connection</button><output id="link"></output></header><iframe id="app" title="Calendar settings" sandbox="allow-scripts allow-same-origin"></iframe><script>'+host.outputFiles[0].text.replace(/<\/script/gi,'<\\/script')+'</script>');return;
    }
    if(path==='/fixture/connect' && incoming.method==='POST') {sql.prepare("INSERT OR IGNORE INTO connections VALUES ('alice','synthetic-encrypted-token',0)").run();outgoing.end('{}');return;}
    if(path==='/fixture/provider-failure' && incoming.method==='POST') {providerUnavailable=true;outgoing.end('{}');return;}
    if(path!== '/mcp' || incoming.method!=='POST') {outgoing.writeHead(404);outgoing.end();return;}
    let body=''; for await(const chunk of incoming)body+=chunk;
    const rpc=JSON.parse(body);
    const headers={'oai-authenticated-user-id':'alice',origin:env.SITE_ORIGIN,'MCP-Protocol-Version':'2026-07-28','Mcp-Method':rpc.method,'Content-Type':'application/json'};
    if(rpc.method==='tools/call')headers['Mcp-Name']=rpc.params.name;
    if(rpc.method==='resources/read')headers['Mcp-Name']=CALENDAR_APP_URI;
    const response=await service.handle(new Request(env.SITE_ORIGIN+'/mcp',{method:'POST',headers,body}));
    outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(await response.text());
  } catch {outgoing.writeHead(500);outgoing.end('Fixture request failed.');}
});
server.listen(0,'127.0.0.1',()=>console.log(`Calendar app preview: http://127.0.0.1:${server.address().port}`));
process.on('SIGINT',()=>server.close(()=>{sql.close();process.exit(0);}));
