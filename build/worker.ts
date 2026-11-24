import handler from 'vinext/server/fetch-handler';
import { authorizeRequest } from '../lib/calendar/auth';
import { directCallbackTransport } from '../lib/calendar/callback-transport';
import { CalendarService } from '../lib/calendar/service';

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/mcp') {
      try {
        const authorized = await authorizeRequest(request, env, Date.now());
        if (authorized instanceof Response) return authorized;
        return new CalendarService(env, { callbackTransport: directCallbackTransport }).handle(authorized);
      } catch {
        return Response.json({ error: 'Persistent storage is unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
      }
    }
    return handler.fetch(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    let service: CalendarService;
    try { service = new CalendarService(env, { callbackTransport: directCallbackTransport }); } catch { return; }
    // Activates once CalendarService exposes unattended maintenance.
    if ('runMaintenance' in service && typeof service.runMaintenance === 'function') {
      ctx.waitUntil(Promise.resolve(service.runMaintenance()).catch(error => {
        console.error('calendar_maintenance_failed', { stage: 'scheduled', name: error instanceof Error ? error.name : 'unknown' });
      }));
    }
  },
};
