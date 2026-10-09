import { directCallbackTransport } from '../lib/calendar/callback-transport';
import { nativeVerificationProbe } from '../lib/calendar/callback-probe';
import { nativeOpenAICallbackTransport } from '../lib/calendar/native-callback-transport';
import { nativeFetchDiagnosticResponse, nativeFetchDiagnosticPage } from '../lib/calendar/native-fetch-diagnostics';
import { authenticatedDiagnosticResponse, nativeEgressDiagnosticResponse } from '../lib/calendar/native-egress-diagnostics';
import { nativeConnectionDiagnostics, nativeRebindingDiagnostics } from '../lib/calendar/native-connection-diagnostics';
import { timerSocketDiagnostics } from '../lib/calendar/timer-socket-diagnostics';
import { CalendarService } from "../lib/calendar/service";
import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import calendarAppHtml from '../.sites-runtime/calendar-app.html?raw';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const path = new URL(request.url).pathname;
    if (path === '/diagnostics/timer-socket') return nativeFetchDiagnosticPage(request, 'timer-socket');
    if (path === '/api/diagnostics/timer-socket') return authenticatedDiagnosticResponse(request,
      (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN, () => timerSocketDiagnostics(env, request.signal), 'calendar_timer_socket_diagnostics');
    if (path === '/diagnostics/native-fetch') {
      return nativeFetchDiagnosticPage(request);
    }
    if (path === '/diagnostics/native-egress') {
      return nativeFetchDiagnosticPage(request, 'native-egress');
    }
    if (path === '/diagnostics/native-connection' || path === '/diagnostics/native-rebinding') {
      return nativeFetchDiagnosticPage(request, path === '/diagnostics/native-connection' ? 'native-connection' : 'native-rebinding');
    }
    if (path === '/api/diagnostics/native-fetch') {
      return nativeFetchDiagnosticResponse(request);
    }
    if (path === '/api/diagnostics/native-egress') {
      return nativeEgressDiagnosticResponse(request, (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN);
    }
    if (path === '/api/diagnostics/native-connection' || path === '/api/diagnostics/native-rebinding') {
      const run = path === '/api/diagnostics/native-connection' ? nativeConnectionDiagnostics : nativeRebindingDiagnostics;
      return authenticatedDiagnosticResponse(request, (env as unknown as { SITE_ORIGIN?: string }).SITE_ORIGIN,
        () => run(request.signal), path === '/api/diagnostics/native-connection' ? 'calendar_native_connection_diagnostics' : 'calendar_native_rebinding_diagnostics');
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
      const mode = env as unknown as { MCP_CALLBACK_PROBE?: string; MCP_CALLBACK_TRANSPORT?: string };
      const callbackTransport = mode.MCP_CALLBACK_PROBE === 'true' ? nativeVerificationProbe :
        mode.MCP_CALLBACK_TRANSPORT === 'native-openai' ? nativeOpenAICallbackTransport : directCallbackTransport;
      try { return new CalendarService(env, { callbackTransport, calendarAppHtml }).handle(request); }
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
