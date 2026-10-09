import { App } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'Calendar settings', version: '0.1.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: true });
const root = document.getElementById('root')!;
root.textContent = 'Calendar panel host check';
app.ontoolresult = () => { root.textContent = 'Calendar panel host connected'; };
app.connect().catch(() => { root.textContent = 'Calendar panel host could not connect'; });
