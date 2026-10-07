import { directCallbackTransport } from '../lib/calendar/callback-transport';
import { nativeVerificationProbe } from '../lib/calendar/callback-probe';
import { nativeFetchDiagnosticResponse } from '../lib/calendar/native-fetch-diagnostics';
import { CalendarService } from "../lib/calendar/service";
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const path = new URL(request.url).pathname;
    if (path === '/api/diagnostics/native-fetch') {
      return nativeFetchDiagnosticResponse(request);
    }
    // Fixed synthetic diagnostic; never accepts a destination, headers or private payload.
    if (path === '/api/diagnostics/tls' && request.method === 'GET') {
      if (!request.headers.get('oai-authenticated-user-id')) return Response.json({ error: 'Sign in.' }, { status: 401 });
      try {
        const response = await directCallbackTransport.post('https://httpbin.org/post', JSON.stringify({ probe: 'site-direct-tls' }), { 'Content-Type': 'application/json' }, AbortSignal.timeout(10_000));
        const echoed = await response.json() as { json?: { probe?: string } };
        return Response.json({ verified: echoed.json?.probe === 'site-direct-tls' }, { headers: { 'Cache-Control': 'no-store' } });
      } catch { return Response.json({ verified: false, error: 'Direct TLS probe failed.' }, { status: 502 }); }
    }

    if (path.startsWith('/api/') || path === '/mcp') {
      try { return new CalendarService(env, { callbackTransport: (env as unknown as { MCP_CALLBACK_PROBE?: string }).MCP_CALLBACK_PROBE === 'true' ? nativeVerificationProbe : directCallbackTransport }).handle(request); }
      catch { return Response.json({ error: 'Persistent storage is unavailable.' }, { status: 503 }); }
    }
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },
};
