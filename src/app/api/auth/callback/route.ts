import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCode,
  redirectUri,
  envFromHost,
  newHostSessionId,
  saveHostTokens,
  HOST_SESSION_COOKIE,
  ExchangeError,
} from '@/server/spotify/auth';
import { decodeState } from '@/server/spotify/oauth-state';

export const dynamic = 'force-dynamic';

/**
 * Spotify OAuth callback. Spotify redirects here with ?code=...&state=...
 * (or ?error=...). We exchange the code server-side, store tokens under an
 * opaque host session id cookie, and send the host back to the host screen.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  const back = (qs: string) => NextResponse.redirect(new URL(`/host${qs}`, url.origin));

  if (error || !code) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      scope: 'spotify-auth',
      event: 'oauth_callback_denied',
      error: error ?? 'missing_code',
    }));
    return back('?auth=denied');
  }

  try {
    const redirect = redirectUri(envFromHost(req.headers.get('host')));
    const tokens = await exchangeCode(code, redirect);
    const sessionId = newHostSessionId();
    saveHostTokens(sessionId, tokens);
    const res = back('?auth=ok');
    res.cookies.set(HOST_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: redirect.startsWith('https'),
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (err) {
    // S03-T04 (R021): a 403 from the token exchange = the account is not on
    // the developer-mode allowlist. No raw error ever surfaces — the host
    // screen gets the friend's name + COPY.notAllowlisted / COPY.hostAddFriend.
    if (err instanceof ExchangeError && err.status === 403) {
      const { name } = decodeState(url.searchParams.get('state'));
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        scope: 'spotify-auth',
        event: 'oauth_allowlist_rejected',
        name: name ?? null,
      }));
      const qs = new URLSearchParams({ auth: 'not_allowlisted' });
      if (name) qs.set('name', name);
      return back(`?${qs.toString()}`);
    }
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      scope: 'spotify-auth',
      event: 'oauth_callback_failed',
      detail: String(err),
    }));
    return back('?auth=failed');
  }
}
