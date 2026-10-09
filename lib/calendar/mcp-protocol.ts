export const SUPPORTED_MCP_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
export type McpMessage = { jsonrpc: '2.0'; id?: string | number; method: string; params?: Record<string, unknown> };
export class McpProtocolError extends Error {
  constructor(public code: number, message: string, public status = 400, public id: string | number | null = null, public data?: unknown) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function decodedHeader(value: string | null, id: string | number | null) {
  if (!value?.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try {
    const encoded = value.slice(9, -2), bytes = atob(encoded);
    if (btoa(bytes) !== encoded) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes, c => c.charCodeAt(0)));
  } catch { throw new McpProtocolError(-32020, 'Malformed encoded MCP header.', 400, id); }
}
export async function readMcpMessage(request: Request, siteOrigin?: string) {
  const origin = request.headers.get('origin');
  if (origin && origin !== siteOrigin && origin !== 'https://chatgpt.com') throw new McpProtocolError(-32600, 'Request origin is not allowed.', 403);
  let value: unknown;
  try { value = await request.json(); } catch { throw new McpProtocolError(-32700, 'Parse error.'); }
  if (!object(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string' || !value.method ||
      (value.id !== undefined && typeof value.id !== 'string' && !(typeof value.id === 'number' && Number.isSafeInteger(value.id))) ||
      (value.params !== undefined && !object(value.params))) throw new McpProtocolError(-32600, 'Invalid JSON-RPC request.');
  const rpc = value as McpMessage, id = rpc.id ?? null;
  if (rpc.id === undefined && rpc.method !== 'notifications/initialized') throw new McpProtocolError(-32600, 'Unsupported notification.', 400);
  const meta = rpc.params?._meta;
  if (meta !== undefined && !object(meta)) throw new McpProtocolError(-32602, 'Invalid request metadata.', 400, id);
  const bodyVersion = object(meta) ? meta['io.modelcontextprotocol/protocolVersion'] : undefined;
  const headerVersion = request.headers.get('MCP-Protocol-Version');
  const version = headerVersion ?? bodyVersion ?? '2025-03-26';
  if (typeof version !== 'string' || !SUPPORTED_MCP_VERSIONS.includes(version)) throw new McpProtocolError(-32022, 'Unsupported protocol version.', 400, id, { supported: SUPPORTED_MCP_VERSIONS, requested: version });
  const modern = version === '2026-07-28';
  const mismatch = () => { throw new McpProtocolError(-32020, 'MCP headers do not match the request body.', 400, id); };
  if (modern && (!headerVersion || bodyVersion !== headerVersion)) mismatch();
  if (bodyVersion !== undefined && headerVersion && bodyVersion !== headerVersion) mismatch();
  if (modern) {
    const info = object(meta) ? meta['io.modelcontextprotocol/clientInfo'] : undefined;
    const capabilities = object(meta) ? meta['io.modelcontextprotocol/clientCapabilities'] : undefined;
    if (!object(info) || typeof info.name !== 'string' || !info.name || typeof info.version !== 'string' || !info.version || !object(capabilities)) throw new McpProtocolError(-32602, 'Client identity and capabilities are required.', 400, id);
    if (rpc.method === 'notifications/initialized') throw new McpProtocolError(-32600, 'Initialization notifications are legacy-only.', 400);
  }
  const method = request.headers.get('Mcp-Method');
  if ((modern && !method) || (method && method !== rpc.method)) mismatch();
  const named = ['tools/call', 'resources/read', 'prompts/get'].includes(rpc.method);
  const name = request.headers.get('Mcp-Name');
  if (named && ((modern && !name) || (name && decodedHeader(name, id) !== (rpc.method === 'resources/read' ? rpc.params?.uri : rpc.params?.name)))) mismatch();
  return { rpc, version, modern };
}
export function mcpErrorResponse(error: McpProtocolError) {
  return Response.json({ jsonrpc: '2.0', id: error.id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
}
export function emptyToolArguments(value: unknown) {
  return value === undefined || (object(value) && Object.keys(value).length === 0);
}
