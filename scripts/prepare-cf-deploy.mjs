import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const distServer = resolve('dist/server');
const distClient = resolve('dist/client');
if (!existsSync(join(distServer, 'index.js'))) {
  console.error('dist/server/index.js not found. Run `npm run build` first.');
  process.exit(1);
}

const d1Id = process.env.D1_DATABASE_ID;
const siteOrigin = process.env.SITE_ORIGIN;
const dispatcherOrigin = process.env.DISPATCHER_ORIGIN ?? '';
const workerName = process.env.WORKER_NAME ?? 'schedule-my-agents';
if (!d1Id || !siteOrigin) {
  console.error('D1_DATABASE_ID and SITE_ORIGIN environment variables are required.');
  process.exit(1);
}

const outRoot = resolve('.cloudflare/output/v1');
const workerDir = join(outRoot, 'workers/default');
const bundleDir = join(workerDir, 'bundle');
const assetsDir = join(workerDir, 'assets');

rmSync(resolve('.cloudflare/output'), { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
mkdirSync(assetsDir, { recursive: true });

// Copy built static assets.
cpSync(distClient, assetsDir, { recursive: true, dereference: true });

// Copy Worker modules (excluding wrangler/build metadata files).
const skipFiles = new Set(['wrangler.json', 'BUILD_ID', 'vinext-externals.json']);
const modules = {};
const moduleType = (file) => {
  const ext = extname(file);
  if (ext === '.js' || ext === '.mjs') return 'esm';
  if (ext === '.wasm') return 'wasm';
  if (ext === '.json') return 'json';
  return 'text';
};

function copyServerTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.vite') continue;
    const src = join(dir, entry.name);
    const rel = relative(distServer, src).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      mkdirSync(join(bundleDir, rel), { recursive: true });
      copyServerTree(src);
      continue;
    }
    if (skipFiles.has(rel)) continue;
    const dest = join(bundleDir, rel);
    cpSync(src, dest, { dereference: true });
    modules[rel] = { type: moduleType(rel) };
  }
}
copyServerTree(distServer);

const text = (value) => ({ type: 'text', value });
const env = {
  DB: { type: 'd1', id: d1Id, name: process.env.D1_DATABASE_NAME ?? 'schedule-my-agents-d1' },
  SITE_ORIGIN: text(siteOrigin),
  OWNER_ID: text(process.env.OWNER_ID ?? 'owner'),
  GOOGLE_WEBHOOK_VERIFIED: text(process.env.GOOGLE_WEBHOOK_VERIFIED ?? 'false'),
  MCP_EVENTS_READY: text(process.env.MCP_EVENTS_READY ?? 'false'),
  GOOGLE_WRITE_SCOPE_ENABLED: text(process.env.GOOGLE_WRITE_SCOPE_ENABLED ?? 'false'),
  ...(dispatcherOrigin ? { DISPATCHER_ORIGIN: text(dispatcherOrigin) } : {}),
  GOOGLE_CLIENT_ID: { type: 'secret' },
  GOOGLE_CLIENT_SECRET: { type: 'secret' },
  TOKEN_ENCRYPTION_KEY: { type: 'secret' },
  ALARM_ENCRYPTION_KEY: { type: 'secret' },
  ALARM_REGISTRATION_KEY: { type: 'secret' },
  ALARM_CALLBACK_KEY: { type: 'secret' },
  ADMIN_SECRET: { type: 'secret' },
  MCP_AUTH_TOKEN: { type: 'secret' },
};

writeFileSync(join(outRoot, 'config.json'), JSON.stringify({ buildContext: { isPreview: false } }));
writeFileSync(join(workerDir, 'worker.config.json'), JSON.stringify({
  name: workerName,
  compatibilityDate: '2026-05-15',
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  workersDev: true,
  previewUrls: false,
  assets: {},
  triggers: [{ type: 'scheduled', schedule: '*/15 * * * *' }],
  observability: { enabled: true, logs: { enabled: true, invocationLogs: false } },
  env,
  manifest: { type: 'complete', mainModule: 'index.js', modules },
}, null, 2));

console.log(`Prepared Cloudflare Build Output v1 at ${outRoot} (${Object.keys(modules).length} modules).`);
