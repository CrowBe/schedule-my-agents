const root = document.getElementById('root')!;
root.textContent = 'Calendar host diagnostic: frame mounted';
window.addEventListener('message', event => {
  if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
  if (event.data.id === 1 && event.data.result) {
    root.textContent = 'Calendar host diagnostic: handshake complete';
    window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'}, '*');
    window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:400,height:100}}, '*');
  }
  if (event.data.method === 'ui/notifications/tool-result') root.textContent = 'Calendar host diagnostic: tool result received';
});
window.parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{appInfo:{name:'Calendar settings',version:'0.1.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']},protocolVersion:'2026-01-26'}}, '*');
