import handler from 'vinext/server/fetch-handler';
import { directCallbackTransport } from '../lib/calendar/callback-transport';
import { CalendarService } from '../lib/calendar/service';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/mcp') {
      try {
        return new CalendarService(env, { callbackTransport: directCallbackTransport }).handle(request);
      } catch {
        return Response.json({ error: 'Persistent storage is unavailable.' }, { status: 503 });
      }
    }
    return handler.fetch(request, env, ctx);
  },
};
