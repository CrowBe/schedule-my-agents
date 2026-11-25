declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SITE_ORIGIN?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    TOKEN_ENCRYPTION_KEY?: string;
    GOOGLE_WEBHOOK_VERIFIED?: string;
    DISPATCHER_ORIGIN?: string;
    ALARM_ENCRYPTION_KEY?: string;
    ALARM_REGISTRATION_KEY?: string;
    ALARM_CALLBACK_KEY?: string;
    MCP_EVENTS_READY?: string;
    OWNER_ID?: string;
    ADMIN_SECRET?: string;
    MCP_AUTH_TOKEN?: string;
    SESSION_SECRET?: string;
    TRUST_PROXY_AUTH_HEADER?: string;
    GOOGLE_WRITE_SCOPE_ENABLED?: string;
  }
}
