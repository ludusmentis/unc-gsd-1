import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getValidAccessToken, HOST_SESSION_COOKIE } from '@/server/spotify/auth';
import { fetchPlaylists } from '@/server/spotify/api';

export const dynamic = 'force-dynamic';

/** Lists the host's playlists. Requires a host session cookie from OAuth. */
export async function GET() {
  const sid = cookies().get(HOST_SESSION_COOKIE)?.value;
  if (!sid) {
    return NextResponse.json(
      { error: 'connect spotify first', recovery: 'tap "connect spotify" on the host screen' },
      { status: 401 },
    );
  }
  try {
    const accessToken = await getValidAccessToken(sid);
    const playlists = await fetchPlaylists(accessToken);
    return NextResponse.json({
      playlists: playlists.map((p) => ({ id: p.id, name: p.name, total: p.tracks?.total ?? 0 })),
    });
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      scope: 'spotify-api',
      event: 'playlists_route_failed',
      detail: String(err),
    }));
    return NextResponse.json(
      { error: 'spotify link expired', recovery: 'reconnect spotify on the host screen' },
      { status: 401 },
    );
  }
}
