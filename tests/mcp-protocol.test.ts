import test from 'node:test';
import assert from 'node:assert/strict';
import { readMcpMessage, McpProtocolError } from '../lib/calendar/mcp-protocol.ts';

const version='2026-07-28';
const metadata={'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientInfo':{name:'conformance-client',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
function request({method='tools/call',name='enabled_calendars',meta=metadata,headers={}}: {method?:string;name?:string;meta?:Record<string,unknown>;headers?:Record<string,string>}={}) {
  const params={...(method==='tools/call' ? {name,arguments:{}} : method==='resources/read' ? {uri:name} : {}),_meta:meta};
  const mirrored = new Headers({'MCP-Protocol-Version':version,'Mcp-Method':method,...(['tools/call','resources/read'].includes(method)?{'Mcp-Name':name}:{}),...headers});
  for (const [key,value] of Object.entries(headers)) if (value==='') mirrored.delete(key);
  return new Request('https://site.example/mcp',{method:'POST',headers:mirrored,body:JSON.stringify({jsonrpc:'2.0',id:'check',method,params})});
}
async function rejected(input:Request,code:number,id:string|null='check',status=400) {
  await assert.rejects(readMcpMessage(input,'https://site.example'),error => error instanceof McpProtocolError && error.code===code && error.id===id && error.status===status);
}
test('modern protocol accepts mirrored headers, client identity and capabilities',async()=>{
  const parsed=await readMcpMessage(request(),'https://site.example');
  assert.equal(parsed.version,version); assert.equal(parsed.modern,true); assert.equal(parsed.rpc.id,'check');
  for (const origin of ['https://site.example','https://chatgpt.com']) await readMcpMessage(request({headers:{Origin:origin}}),'https://site.example');
});
test('explicit unsupported versions report requested and supported versions',async()=>{
  await assert.rejects(readMcpMessage(request({meta:{...metadata,'io.modelcontextprotocol/protocolVersion':'2099-01-01'},headers:{'MCP-Protocol-Version':'2099-01-01'}})),error=>{
    assert.ok(error instanceof McpProtocolError); assert.equal(error.code,-32022); assert.equal(error.status,400);
    assert.deepEqual(error.data,{supported:['2026-07-28','2025-11-25','2025-06-18','2025-03-26'],requested:'2099-01-01'}); return true;
  });
});
test('modern protocol enforces version, method and resource/tool name mirroring',async()=>{
  const mismatches:Record<string,string>[]=[{'MCP-Protocol-Version':''},{'Mcp-Method':''},{'Mcp-Method':'tools/list'},{'Mcp-Name':''},{'Mcp-Name':'other'}];
  for (const headers of mismatches) await rejected(request({headers}),-32020);
  await rejected(request({meta:{...metadata,'io.modelcontextprotocol/protocolVersion':'2025-03-26'}}),-32020);
  await rejected(request({method:'resources/read',name:'ui://calendar/settings',headers:{'Mcp-Name':'other'}}),-32020);
});
test('modern metadata validates optional client identity and requires object capabilities',async()=>{
  for (const meta of [{...metadata,'io.modelcontextprotocol/clientInfo':null},{...metadata,'io.modelcontextprotocol/clientInfo':{name:'',version:'1'}},{...metadata,'io.modelcontextprotocol/clientCapabilities':[]},{...metadata,'io.modelcontextprotocol/clientCapabilities':undefined}]) await rejected(request({meta}),-32602);
});
test('modern clients may omit the recommended client identity',async()=>{
  const meta={'io.modelcontextprotocol/protocolVersion':version,'io.modelcontextprotocol/clientCapabilities':{}};
  assert.equal((await readMcpMessage(request({meta}))).modern,true);
});
test('MCP name headers accept canonical encoded UTF-8 and reject malformed encodings',async()=>{
  const name='ui://calendar/設定.html';
  const encoded=btoa(String.fromCharCode(...new TextEncoder().encode(name)));
  await readMcpMessage(request({method:'resources/read',name,headers:{'Mcp-Name':`=?base64?${encoded}?=`}}));
  await rejected(request({headers:{'Mcp-Name':'=?base64?***?='}}),-32020,'check');
});
test('invalid JSON-RPC envelopes and notifications never reach a tool handler',async()=>{
  for (const body of [null,[],{}, {jsonrpc:'1.0',id:1,method:'tools/list'}, {jsonrpc:'2.0',id:null,method:'tools/list'}, {jsonrpc:'2.0',id:1,method:'tools/list',params:[]}, {jsonrpc:'2.0',method:'notifications/custom'}]) {
    await rejected(new Request('https://site.example/mcp',{method:'POST',body:JSON.stringify(body)}),-32600,null);
  }
  await rejected(new Request('https://site.example/mcp',{method:'POST',body:'{'}),-32700,null);
  await rejected(request({headers:{Origin:'https://foreign.example'}}),-32600,null,403);
});
test('headerless legacy calls remain supported and modern initialization notifications are rejected',async()=>{
  const legacy=await readMcpMessage(new Request('https://site.example/mcp',{method:'POST',body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}})}));
  assert.equal(legacy.version,'2025-03-26');assert.equal(legacy.modern,false);
  await rejected(new Request('https://site.example/mcp',{method:'POST',headers:{'MCP-Protocol-Version':version,'Mcp-Method':'notifications/initialized'},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{_meta:metadata}})}),-32600,null);
});
