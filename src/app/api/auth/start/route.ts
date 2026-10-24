import { NextRequest, NextResponse } from 'next/server';
import { buildAuthUrl, redirectUri, envFromHost } from '@/server/spotify/auth';

export const dynamic = 'force-dynamic';

/** Kicks off the Spotify authorization-code flow. Redirects to Spotify. */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  try {
    const redirect = redirectUri(envFromHost(req.headers.get('host')));
    const authUrl = buildAuthUrl({
      redirectUri: redirect,
      state: `origin:${url.origin}`,
    });
    return NextResponse.redirect(authUrl);
  } catch {
    // credentials missing / misconfigured — one Gen Z recovery path
    return NextResponse.redirect(new URL('/host?auth=unconfigured', url.origin));
  }
}
