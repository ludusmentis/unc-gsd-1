import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl, redirectUri, envFromHost } from '@/server/spotify/auth';
import { encodeState } from '@/server/spotify/oauth-state';

export const dynamic = 'force-dynamic';

/**
 * State shape lives in @/server/spotify/oauth-state (S03-T04 / R021: the
 * display name rides in state so a 403 allowlist rejection can surface the
 * friend's name on the host screen with Gen Z copy).
 */

/** Kicks off the Spotify authorization-code flow. Redirects to Spotify. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  try {
    const redirect = redirectUri(envFromHost(req.headers.get('host')));
    // Optional ?name= — the login attempt's display name (R021 friend-name
    // plumbing; the host screen needs it when Spotify 403s on the allowlist).
    const name = url.searchParams.get('name') ?? undefined;
    const authUrl = buildAuthUrl({
      redirectUri: redirect,
      state: encodeState(url.origin, name ?? undefined),
    });
    return NextResponse.redirect(authUrl);
  } catch {
    // credentials missing / misconfigured — one Gen Z recovery path
    return NextResponse.redirect(new URL('/host?auth=unconfigured', url.origin));
  }
}
