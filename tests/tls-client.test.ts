import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:tls';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
const root=process.cwd();
const fixtures=mkdtempSync(join(tmpdir(),'site-tls-certs-'));
execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(fixtures,'key.pem'),'-out',join(fixtures,'cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
const cert=readFileSync(join(fixtures,'cert.pem'),'utf8'),key=readFileSync(join(fixtures,'key.pem'),'utf8');
let received=0; let responseMode='ok';
const server=createServer({cert,key},socket=>{socket.on('error',()=>{});socket.once('data',()=>{received++;if(responseMode==='stall')return;const body=responseMode==='large'?'x'.repeat(4097):'{}';socket.end(responseMode==='redirect'?'HTTP/1.1 302 Found\r\nLocation: https://localhost/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n':`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);});});
server.on('tlsClientError',()=>{});
async function listen(){if(!server.listening)await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return (server.address() as {port:number}).port;}
test('Go standard TLS over raw TCP verifies certificate and hostname before sending application data',async()=>{
 const port=await listen();
 createRequire(import.meta.url)(join(root,'tls-client/wasm-exec.cjs'));
 const globals=globalThis as unknown as {Go:new()=>{importObject:WebAssembly.Imports;run:(instance:WebAssembly.Instance)=>Promise<void>};siteTLSRequest:(host:string,pem:string,read:()=>Promise<Uint8Array|null>,write:(bytes:Uint8Array)=>Promise<void>,close:()=>void,request:Uint8Array)=>Promise<Uint8Array>};
 const go=new globals.Go(),wasm=await WebAssembly.compile(new Uint8Array(readFileSync('tls-client/tls.wasm')).buffer);void go.run(await WebAssembly.instantiate(wasm,go.importObject));
 async function request(host:string,pem:string,corrupt=false){
  const socket=createConnection({host:'127.0.0.1',port});socket.on('error',()=>{});
  const iterator=socket[Symbol.asyncIterator]();
  const response=globals.siteTLSRequest(host,pem,async()=>{const v=await iterator.next();if(v.done)return null;const bytes=new Uint8Array(v.value);if(corrupt)bytes[0]^=255;return bytes;},bytes=>new Promise<void>((resolve,reject)=>socket.write(bytes,e=>e?reject(e):resolve())),()=>socket.destroy(),new TextEncoder().encode('POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  const timer=setTimeout(()=>socket.destroy(),responseMode==='stall'?100:5000);try{return await response;}finally{clearTimeout(timer);socket.destroy();}
 }
 try {
  assert.equal(new TextDecoder().decode(await request('localhost',cert)),'{}');assert.equal(received,1);
  await assert.rejects(request('wrong.example',cert),/certificate|valid for/i);assert.equal(received,1);
  // Use a separate unrelated trusted certificate, never a verification bypass.
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(fixtures,'other-key.pem'),'-out',join(fixtures,'other.pem'),'-days','2','-subj','/CN=other'],{stdio:'ignore'});
  await assert.rejects(request('localhost',readFileSync(join(fixtures,'other.pem'),'utf8')),/unknown authority|certificate/i);assert.equal(received,1);
  await assert.rejects(request('localhost',cert,true));assert.equal(received,1);
  responseMode='redirect';await assert.rejects(request('localhost',cert),/non-success/);
  responseMode='large';await assert.rejects(request('localhost',cert),/response too large/);
  responseMode='stall';await assert.rejects(request('localhost',cert));responseMode='ok';
  execFileSync('openssl',['req','-new','-key',join(fixtures,'key.pem'),'-out',join(fixtures,'expired.csr'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  execFileSync('openssl',['x509','-req','-in',join(fixtures,'expired.csr'),'-signkey',join(fixtures,'key.pem'),'-out',join(fixtures,'expired.pem'),'-days','0','-copy_extensions','copy'],{stdio:'ignore'});
  const expired=createServer({key,cert:readFileSync(join(fixtures,'expired.pem'),'utf8')},()=>{throw new Error('Application data must not be sent');});expired.on('tlsClientError',()=>{});
  await new Promise<void>(r=>expired.listen(0,'127.0.0.1',r));
  // The exported TLS call receives the expired certificate through an independent byte stream.
  await new Promise(r=>setTimeout(r,1100));
  const socket=createConnection({host:'127.0.0.1',port:(expired.address() as {port:number}).port});socket.on('error',()=>{});const iterator=socket[Symbol.asyncIterator]();
  try{await assert.rejects(globals.siteTLSRequest('localhost',cert,async()=>{const v=await iterator.next();return v.done?null:new Uint8Array(v.value);},bytes=>new Promise<void>((r,j)=>socket.write(bytes,e=>e?j(e):r())),()=>socket.destroy(),new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n')),/expired|certificate/i);}finally{socket.destroy();await new Promise<void>(r=>expired.close(()=>r()));}
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('actual Workers runtime loads the standard Go TLS WASM and connects directly without a TLS override',async()=>{
 const port=await listen();
 const result=await build({stdin:{contents:`import './tls-client/wasm-exec.cjs';import module from './tls.wasm';import {connect} from 'cloudflare:sockets';
  let ready;
  export default {async fetch(request,env){
   if(!ready){const go=new globalThis.Go();ready=WebAssembly.instantiate(module,go.importObject).then(instance=>{void go.run(instance);});}await ready;
   const socket=connect({hostname:'127.0.0.1',port:env.PORT},{secureTransport:'off',allowHalfOpen:false});
   const reader=socket.readable.getReader(),writer=socket.writable.getWriter();
   const timer=setTimeout(()=>socket.close(),5000);
   try {const data=await globalThis.siteTLSRequest(new URL(request.url).searchParams.get('host')||'localhost',env.CERT,async()=>{const v=await reader.read();return v.done?null:v.value;},bytes=>writer.write(bytes),()=>socket.close(),new TextEncoder().encode('POST / HTTP/1.1\\r\\nHost: localhost\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'));return new Response(data);}catch(e){return Response.json({error:e.message},{status:502});}finally{clearTimeout(timer);socket.close();}
  }};`,resolveDir:root,sourcefile:'wasm-probe.js'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['./tls.wasm','cloudflare:sockets']});
 const mf=new Miniflare({modules:[{type:'ESModule',path:'main.js',contents:result.outputFiles[0].text},{type:'CompiledWasm',path:'tls.wasm',contents:readFileSync('tls-client/tls.wasm')}],compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],cf:false,bindings:{PORT:port,CERT:cert}});
 try {
  const good=await mf.dispatchFetch('https://probe.example/');assert.equal(good.status,200,await good.clone().text());assert.equal(await good.text(),'{}');
  const bad=await mf.dispatchFetch('https://probe.example/?host=wrong.example');assert.equal(bad.status,502);assert.match(await bad.text(),/certificate|valid for/);
 }finally{await mf.dispose();await new Promise<void>(r=>server.close(()=>r()));}
});
