import { createInterface } from 'node:readline/promises';

const origin = new URL(process.argv[2]);
if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
  throw new Error('Provide the exact HTTPS Site origin.');
}
let serviceToken;
if (process.argv.includes('--service-token-stdin')) {
  const input = createInterface({ input: process.stdin });
  serviceToken = await input.question('Existing service credential on stdin (not logged):\n');
  input.close();
}
const checks = [];
async function check(path, method, service = false) {
  const headers = service ? { 'OAI-Sites-Authorization': `Bearer ${serviceToken}` } : {};
  if (path === '/api/google/webhook') Object.assign(headers, {
    'x-goog-channel-id': 'ingress-probe-unknown', 'x-goog-channel-token': 'forged-probe',
    'x-goog-resource-id': 'unknown', 'x-goog-resource-state': 'exists', 'x-goog-message-number': '1',
  });
  const response = await fetch(new URL(path, origin), { method, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  const contentType = response.headers.get('content-type');
  const body = contentType?.includes('application/json') ? await response.json() : null;
  const result = { path, service, status: response.status, contentType, requestId: response.headers.get('cf-ray'),
    applicationValidation: response.status === 403 && body?.error === 'Notification channel is not authorized.' };
  checks.push(result);
  return result;
}
const ingress = await check('/api/google/webhook', 'POST');
const status = await check('/api/status', 'GET');
const mcp = await check('/mcp', 'POST');
if (serviceToken) {
  await check('/api/google/webhook', 'POST', true);
  await check('/api/status', 'GET', true);
  await check('/mcp', 'POST', true);
}
const directIngressVerified = ingress.applicationValidation && status.status === 401 && mcp.status === 401;
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), origin: origin.origin, directIngressVerified, checks }, null, 2));
process.exitCode = directIngressVerified ? 0 : 1;
