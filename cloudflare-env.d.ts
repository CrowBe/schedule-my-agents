declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    SITE_ORIGIN?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    TOKEN_ENCRYPTION_KEY?: string;
    GOOGLE_WEBHOOK_VERIFIED?: string;
    BUCKET?: R2Bucket;
  }
}
