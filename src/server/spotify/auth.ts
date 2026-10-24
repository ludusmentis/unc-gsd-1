import { randomBytes } from 'node:crypto';
import { saveHostTokens as persistSaveHostTokens, deleteHostTokens, loadAllAtBoot } from '../persist';

/**
 * Spotify authorization-code flow — server-side only. Client secrets are read
 * from env (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET) and never logged.
 *
 * Tokens are stored per host session id (opaque random id kept in a cookie by
 * the Next.js routes) — never per player, never in client-visible state.
 */

export const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com';

/** Cookie name for the opaque host session id (set by the OAuth callback route). */
export const HOST_SESSION_COOKIE = 'host_sid';
export const SPOTIFY_API_URL = 'https://api.spotify.com/v1';

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
  scope?: string;
}

export type RedirectEnv = 'dev' | 'prod';

export function redirectUri(env: RedirectEnv): string {
  return env === 'prod'
    ? 'https://un.clord.org/api/auth/callback'
    : 'http://localhost:3000/api/auth/callback';
}

export function envFromHost(host: string | undefined | null): RedirectEnv {
  return host?.includes('un.clord.org') ? 'prod' : 'dev';
}

function credentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET not configured');
  }
  return { clientId, clientSecret };
}

/** Structured logging — token/session ids only, never secrets. */
function logAuth(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), scope: 'spotify-auth', event, ...extra }));
}


export function buildAuthUrl(opts: { redirectUri: string; state: string; scopes?: string[] }): string {
  const { clientId } = credentials();
  const scopes = opts.scopes ?? [
    'user-read-private',
    'user-read-email',
    'playlist-read-private',
    'playlist-read-collaborative',
    'user-read-playback-state',
    'user-modify-playback-state',
  ];
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    state: opts.state,
    scope: scopes.join(' '),
  });
  return `${SPOTIFY_ACCOUNTS_URL}/authorize?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

/** Exchange an authorization code for tokens. `fetchImpl` injectable for tests. */
export async function exchangeCode(
  code: string,
  redirect: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyTokens> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    logAuth('token_exchange_failed', { status: res.status });
    throw new Error(`spotify token exchange failed: ${res.status}`);
  }
  const json = (await res.json()) as TokenResponse;
  const tokens: SpotifyTokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
  logAuth('token_exchange_ok', { expiresAt: tokens.expiresAt });
  return tokens;
}

/** Refresh an access token with the stored refresh token. */
export async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyTokens> {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetchImpl(`${SPOTIFY_ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    logAuth('token_refresh_failed', { status: res.status });
    throw new Error(`spotify token refresh failed: ${res.status}`);
  }
  const json = (await res.json()) as TokenResponse;
  const tokens: SpotifyTokens = {
    accessToken: json.access_token,
    // Spotify may not return a new refresh token; keep the old one.
    refreshToken: json.refresh_token ?? refreshToken,
    expiresAt: Date.now() + json.expires_in * 1000,
    scope: json.scope,
  };
  logAuth('token_refresh_ok', { expiresAt: tokens.expiresAt });
  return tokens;
}

// ---------------------------------------------------------------------------
// Per-host-session token store (in-memory; S03 may extend to redis/db).
// ---------------------------------------------------------------------------

const REFRESH_EARLY_MS = 60_000; // refresh 1 min before expiry

interface HostSession {
  tokens: SpotifyTokens;
  createdAt: number;
}

const hostSessions = new Map<string, HostSession>();

/** S03 boot restore: rehydrate the host token store from the DB (T01).
 * Tokens (incl. refreshToken) are persisted so a restart never forces
 * re-auth; never logged. */
export function restoreHostSessions(): void {
  for (const h of loadAllAtBoot().hostTokens) {
    hostSessions.set(h.sessionId, { tokens: h.tokens, createdAt: 0 });
  }
}

export function newHostSessionId(): string {
  return randomBytes(24).toString('base64url');
}

export function saveHostTokens(sessionId: string, tokens: SpotifyTokens): void {
  hostSessions.set(sessionId, { tokens, createdAt: Date.now() });
  persistSaveHostTokens(sessionId, tokens);
  logAuth('host_tokens_saved', { session: sessionId.slice(0, 8) });
}

export function getHostTokens(sessionId: string): SpotifyTokens | null {
  return hostSessions.get(sessionId)?.tokens ?? null;
}

export function clearHostSession(sessionId: string): void {
  hostSessions.delete(sessionId);
  deleteHostTokens(sessionId);
  logAuth('host_session_cleared', { session: sessionId.slice(0, 8) });
}

/**
 * Auto-refresh hook: returns a valid access token, refreshing when the
 * stored one is missing, expired, or within the early-refresh window.
 * Throws if no session or no refresh token is available.
 */
export async function getValidAccessToken(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const session = hostSessions.get(sessionId);
  if (!session) throw new Error('no host session');
  const { tokens } = session;
  if (tokens.expiresAt - REFRESH_EARLY_MS > Date.now()) return tokens.accessToken;
  if (!tokens.refreshToken) throw new Error('host session expired (no refresh token)');
  const fresh = await refreshTokens(tokens.refreshToken, fetchImpl);
  session.tokens = fresh;
  persistSaveHostTokens(sessionId, fresh);
  return fresh.accessToken;
}

export function _resetAuthStoreForTests(): void {
  hostSessions.clear();
}
