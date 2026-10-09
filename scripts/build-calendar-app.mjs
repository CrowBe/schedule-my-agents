import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function buildCalendarApp() {
  const result = await build({ entryPoints: ['mcp-app/calendar-app.tsx'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'none' });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const css = (await readFile('app/globals.css', 'utf8')).replace('@import "tailwindcss";', '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Calendar settings</title><style>${css}\nmain.embedded{padding:24px;max-width:1120px}.embedded .intro{padding:24px 0}.embedded h1{font-size:36px}.refresh{margin-bottom:20px}@media(max-width:600px){main.embedded{padding:16px}.embedded h1{font-size:28px}}</style></head><body><div id="root"><main class="embedded"><h1>Calendar settings</h1><p>Loading your connection and permissions…</p></main></div><script>${script}</script></body></html>`;
  await mkdir('.sites-runtime', { recursive: true });
  await writeFile('.sites-runtime/calendar-app.html', html);
}
if (process.argv[1]?.endsWith('/build-calendar-app.mjs')) await buildCalendarApp();
