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
    BUCKET?: R2Bucket;
  }
}
