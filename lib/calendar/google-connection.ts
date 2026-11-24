import { digest, open, random, seal } from './crypto.ts';
import { GoogleCalendar, SCOPES, WRITE_SCOPE, tokenRequest, type Fetch } from './google.ts';
import { AppError, type Environment } from './types.ts';
import type { CalendarConnection, Store } from './store.ts';

// Only this connection adapter handles the encrypted Google refresh credential.
export function googleConnection(env: Environment, http: Fetch, store:Store) {
 return async (connection: CalendarConnection) => {
  const credential=await store.first<{refresh_token:string}>("SELECT refresh_token FROM connections WHERE owner = ? AND provider_id = 'google' AND CASE WHEN connection_id = '' THEN 'legacy:' || provider_id || ':' || owner || ':' || created_at ELSE connection_id END = ?",connection.owner,connection.id);
  if(!credential) throw new AppError(403,'Calendar connection changed during authorization.');
  const refresh = await open(credential.refresh_token, env.TOKEN_ENCRYPTION_KEY, connection.owner);
  const refreshedAccess=async()=> (await tokenRequest(env, { grant_type:'refresh_token',refresh_token:refresh }, http)).access_token!;
  return new GoogleCalendar(await refreshedAccess(), http, refreshedAccess);
 };
}

export class GoogleAuthorization {
  private env: Environment;
  private store: Store;
  private http: Fetch;
  private now: () => number;
  private origin: () => string;
  constructor(env: Environment, store: Store, http: Fetch, now: () => number, origin: () => string) {
    this.env = env; this.store = store; this.http = http; this.now = now; this.origin = origin;
  }
  get configured() {return Boolean(this.env.GOOGLE_CLIENT_ID&&this.env.GOOGLE_CLIENT_SECRET&&this.env.TOKEN_ENCRYPTION_KEY&&this.env.SITE_ORIGIN);}
  private scopes() {
    return this.env.GOOGLE_WRITE_SCOPE_ENABLED === 'true' ? [...SCOPES, WRITE_SCOPE] : SCOPES;
  }
  async start(owner:string) {
        if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET || !this.env.TOKEN_ENCRYPTION_KEY) throw new AppError(503, 'Google OAuth is not configured.');
        const state = random(), verifier = random() + random();
        await this.store.run('DELETE FROM oauth_states WHERE expires_at <= ?', this.now());
        await this.store.run('INSERT INTO oauth_states (state, owner, verifier, expires_at) VALUES (?, ?, ?, ?)', await digest(state), owner, await seal(verifier, this.env.TOKEN_ENCRYPTION_KEY, owner), this.now() + 600_000);
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: this.env.GOOGLE_CLIENT_ID, redirect_uri: this.origin() + '/api/google/callback', response_type: 'code', scope: this.scopes().join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: await digest(verifier), code_challenge_method: 'S256' }).toString();
        return new Response(null, { status: 303, headers: { Location: url.href, 'Cache-Control': 'no-store', 'Set-Cookie': `calendar_oauth=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/google/callback; Max-Age=600` } });
  }
  async complete(owner: string, request: Request) {
    const params = new URL(request.url).searchParams;
    const state = params.get('state'), code = params.get('code');
    const cookie = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('calendar_oauth='))?.slice('calendar_oauth='.length);
    if (!state || state !== cookie || !code) throw new AppError(400, 'Google authorization was cancelled or invalid.');
    const hashed = await digest(state), claimed = 'claimed:' + hashed;
    const pending = await this.store.first<{ verifier: string }>(
      'UPDATE oauth_states SET state = ? WHERE state = ? AND owner = ? AND expires_at > ? RETURNING verifier',
      claimed, hashed, owner, this.now());
    if (!pending) throw new AppError(400, 'Google authorization expired or was already used.');
    try {
      // Avoid silently replacing an account while resource grants from another account remain.
      if (await this.store.connection(owner)) throw new AppError(409, 'This account is already connected. Disconnect before changing Google accounts.');
      const verifier = await open(pending.verifier, this.env.TOKEN_ENCRYPTION_KEY, owner);
      const tokens = await tokenRequest(this.env, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: this.origin() + '/api/google/callback' }, this.http);
      if (!tokens.refresh_token || !this.scopes().every(scope => tokens.scope?.split(' ').includes(scope) ||
        (scope === SCOPES[1] && tokens.scope?.split(' ').includes(WRITE_SCOPE)))) throw new AppError(400, 'The requested Calendar permissions and offline access are required.');
      const sealed = await seal(tokens.refresh_token, this.env.TOKEN_ENCRYPTION_KEY, owner), connectionId = random();
      // Disconnect deletes oauth_states; fail closed if disconnect committed during token exchange.
      const inserted = await this.store.first<{ owner: string }>(`INSERT INTO connections (owner, refresh_token, created_at, provider_id, connection_id)
        SELECT ?, ?, ?, 'google', ? WHERE EXISTS (SELECT 1 FROM oauth_states WHERE state = ? AND owner = ?)
          AND NOT EXISTS (SELECT 1 FROM connections WHERE owner = ?) RETURNING owner`,
        owner, sealed, this.now(), connectionId, claimed, owner, owner);
      if (!inserted) throw new AppError(409, 'Google authorization was cancelled because account state changed.');
      return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': 'calendar_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/google/callback; Max-Age=0' } });
    } finally {
      await this.store.run('DELETE FROM oauth_states WHERE state = ? AND owner = ?', claimed, owner);
    }
  }
}
