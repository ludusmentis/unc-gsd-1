import { NextRequest, NextResponse } from 'next/server';
import {
  exchangeCode,
  redirectUri,
  envFromHost,
  newHostSessionId,
  saveHostTokens,
  HOST_SESSION_COOKIE,
} from '@/server/spotify/auth';

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
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      scope: 'spotify-auth',
      event: 'oauth_callback_failed',
      detail: String(err),
    }));
    return back('?auth=failed');
  }
}
