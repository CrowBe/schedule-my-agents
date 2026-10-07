import { connect } from 'cloudflare:sockets';
import { resolve4, resolve6 } from 'node:dns/promises';
import '../../tls-client/wasm-exec.cjs';
import module from '../../tls-client/tls.wasm';
import roots from '../../tls-client/roots.pem?raw';
import type { CallbackTransport } from './subscriptions.ts';
import { publicAddress, validatedAddress } from './callback-policy.ts';
import { callbackFailureCategory } from './callback-diagnostics.ts';

declare global {
 var Go: new () => { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
 var siteTLSRequest: (host:string, roots:string, read:()=>Promise<Uint8Array|null>, write:(value:Uint8Array)=>Promise<void>, close:()=>void, request:Uint8Array, includeStatus?:boolean)=>Promise<Uint8Array>;
}
let ready: Promise<void> | undefined;
async function initialize(){
 if(!ready){const go=new Go();ready=WebAssembly.instantiate(module,go.importObject).then(instance=>{void go.run(instance);});}
 await ready;
}
async function bounded<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();let abort!:()=>void;
 const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener('abort',abort);}
}
async function records(host:string,resolve:(host:string)=>Promise<string[]>){
 try{return await resolve(host);}catch(e){if(['ENODATA','ENOTFOUND'].includes((e as {code?:string}).code??''))return [];throw e;}
}
export const directCallbackTransport: CallbackTransport={
 async post(destination,body,headers,callerSignal){
  let stage = 'destination';
  let addressCount: number | undefined, nonPublicCount: number | undefined;
  try {
  const signal=AbortSignal.any([callerSignal,AbortSignal.timeout(10_000)]),url=new URL(destination);
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash)throw new Error('Invalid callback destination');
  stage = 'dns';
  const addresses=(await bounded(Promise.all([records(url.hostname,resolve4),records(url.hostname,resolve6)]),signal)).flat();
  addressCount = addresses.length; nonPublicCount = addresses.filter(value => !publicAddress(value)).length;
  stage = 'address_policy';
  const address=validatedAddress(addresses); // All answers must be public; connect only to this literal IP.
  stage = 'tls_initialize';
  await bounded(initialize(),signal);
  const allowed=new Set(['content-type','webhook-id','webhook-timestamp','webhook-signature','x-mcp-subscription-id']);
  const lines=Object.entries(headers).map(([name,value])=>{
   if(!allowed.has(name.toLowerCase())||/[\r\n]/.test(value))throw new Error('Invalid callback header');return `${name}: ${value}`;
  });
  const length=new TextEncoder().encode(body).byteLength;
  const bytes=new TextEncoder().encode(`POST ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.hostname}\r\nContent-Length: ${length}\r\nConnection: close\r\nAccept-Encoding: identity\r\n${lines.join('\r\n')}\r\n\r\n${body}`);
  if(length>262144||bytes.length>270336)throw new Error('Callback exceeds byte budget');
  stage = 'socket_connect';
  const socket=connect({hostname:address,port:443},{secureTransport:'off',allowHalfOpen:false});
  void socket.closed.catch(()=>{});
  const close=()=>{void socket.close().catch(()=>{});};signal.addEventListener('abort',close,{once:true});
  try{
   await bounded(socket.opened,signal);
   const reader=socket.readable.getReader(),writer=socket.writable.getWriter();
   stage = 'tls_http';
   const data=await bounded(siteTLSRequest(url.hostname,roots,async()=>{const v=await reader.read();return v.done?null:v.value;},value=>writer.write(value),close,bytes,true),signal);
   const status=data[0]*256+data[1];
   return new Response(status===204||status===205||status===304?null:new Uint8Array(data.slice(2)).buffer,{status});
  }finally{signal.removeEventListener('abort',close);close();}
  } catch (error) {
   console.info('calendar_callback_transport', { stage, outcome: 'failed', category: callbackFailureCategory(error), ...(stage === 'address_policy' ? { addressCount, nonPublicCount } : {}) });
   throw error;
  }
 }
};
