import { App } from '@modelcontextprotocol/ext-apps';
import { createRoot } from 'react-dom/client';
import Setup from '../app/setup';
import { SETUP_ACTIONS, type SetupClient, type SetupSnapshot } from '../lib/calendar/setup-contract';

const app = new App({ name: 'Calendar settings', version: '0.1.0' }, { availableDisplayModes: ['inline', 'fullscreen'] }, { autoResize: true });
const root = createRoot(document.getElementById('root')!);
let rendered = false;
let snapshot: SetupSnapshot | undefined;
function resultData(result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] }): SetupSnapshot {
  if (result.isError) throw new Error(result.content.find(item => item.type === 'text')?.text ?? 'Calendar settings could not be loaded.');
  const data = result.structuredContent;
  if (!data || !data.status || typeof data.status !== 'object' || !Array.isArray(data.calendars) || typeof data.siteUrl !== 'string') throw new Error('Calendar settings returned an invalid response.');
  const url = new URL(data.siteUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Calendar settings returned an invalid Site URL.');
  snapshot = data as unknown as SetupSnapshot;
  return snapshot;
}
const client: SetupClient = {
  async load() { return resultData(await app.callServerTool({ name: 'calendar_setup', arguments: {} })); },
  async action(path, calendarId) {
    const action = Object.entries(SETUP_ACTIONS).find(([, value]) => value === path)?.[0];
    if (!action) throw new Error('Unknown calendar action.');
    resultData(await app.callServerTool({ name: 'calendar_setup_action', arguments: { action, ...(calendarId === undefined ? {} : { calendarId }) } }));
  },
  async connect() {
    if (!snapshot) throw new Error('Refresh calendar settings first.');
    const result = await app.openLink({ url: snapshot.siteUrl });
    if (result.isError) throw new Error('Open your Site in a browser to connect Google, then refresh here.');
  },
};
function showError(error: unknown) {
  root.render(<main className="embedded"><h1>Calendar settings</h1><p role="alert">{error instanceof Error ? error.message : 'Please try again.'}</p><button onClick={() => client.load().then(render).catch(showError)}>Retry</button></main>);
}
function render(data: SetupSnapshot) { rendered = true; root.render(<Setup client={client} initialSnapshot={data} embedded />); }
// Register before connecting so the host's initial tool result is never lost.
app.ontoolresult = result => { if (!rendered) { try { render(resultData(result)); } catch (error) { showError(error); } } };
app.connect().then(() => {
  // Hosts normally send the entrypoint result. Recover if a host omits it.
  setTimeout(() => { if (!rendered) client.load().then(render).catch(showError); }, 2_000);
}).catch(showError);
