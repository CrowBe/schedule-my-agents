import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(readFileSync('dist/server/wrangler.json', 'utf8'));
mkdirSync('.wrangler', { recursive: true });
const local = {
  name: config.name,
  compatibility_date: config.compatibility_date,
  d1_databases: config.d1_databases.map(db => ({ ...db, migrations_dir: resolve('drizzle') })),
};
writeFileSync('.wrangler/migrations.json', JSON.stringify(local));
const result = spawnSync(
  process.execPath,
  ['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'schedule-my-agents-d1', '--local', '--config', '.wrangler/migrations.json', '--persist-to', '.wrangler/state'],
  { stdio: 'inherit', env: process.env },
);
process.exit(result.status ?? 1);
