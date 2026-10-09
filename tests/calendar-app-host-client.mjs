import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const metadata={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'synthetic-browser-host',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}};
let id=0;
async function rpc(method,params) {
  const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params:{...params,_meta:metadata}})});
  const value=await response.json();if(value.error)throw new Error(value.error.message);return value.result;
}
const iframe=document.getElementById('app');
const compact=document.createElement('button');compact.textContent='Toggle compact view';
document.querySelector('header').append(compact);
compact.onclick=()=>{iframe.style.width=iframe.style.width==='420px'?'100%':'420px';};
const bridge=new AppBridge(null,{name:'Synthetic calendar host',version:'1'},{openLinks:{},serverTools:{},logging:{}},{hostContext:{displayMode:'fullscreen'}});
bridge.oncalltool=params=>rpc('tools/call',params);
bridge.onopenlink=async({url})=>{document.getElementById('link').textContent='Browser sign-in link: '+url;return {};};
bridge.onsizechange=({height})=>{if(height)iframe.style.height=height+'px';};
bridge.oninitialized=async()=>{bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await rpc('tools/call',{name:'calendar_setup',arguments:{}}));};
document.getElementById('connect').onclick=async()=>{await fetch('/fixture/connect',{method:'POST'});document.getElementById('link').textContent='Synthetic authorization completed. Use Refresh connection in the calendar view.';};
async function start() {
  await bridge.connect(new PostMessageTransport(iframe.contentWindow,iframe.contentWindow));
  iframe.srcdoc=(await rpc('resources/read',{uri:'ui://schedule-my-agents/calendar-settings.html'})).contents[0].text;
}
start().catch(error=>{document.getElementById('link').textContent=error.message;});
