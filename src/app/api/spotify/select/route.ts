import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { HOST_SESSION_COOKIE } from '@/server/spotify/auth';
import { registerHostPlaylist } from '@/server/game';
import { COPY } from '@/lib/copy';

export const dynamic = 'force-dynamic';

/**
 * Host locks in a playlist + speaker for their room. The room code comes
 * from the body (client knows it from the WS session); the Spotify session
 * comes from the host cookie. Never returns or logs tokens.
 */
export async function POST(req: Request) {
  const sid = cookies().get(HOST_SESSION_COOKIE)?.value;
  if (!sid) {
    return NextResponse.json({ ...COPY.connectSpotifyFirst }, { status: 401 });
  }
  let body: { code?: unknown; playlistId?: unknown; playlistName?: unknown; speakerName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ...COPY.noPlaylist, error: 'bad request' }, { status: 400 });
  }
  const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
  const playlistId = typeof body.playlistId === 'string' ? body.playlistId : '';
  const playlistName = typeof body.playlistName === 'string' ? body.playlistName : 'playlist';
  const speakerName = typeof body.speakerName === 'string' ? body.speakerName.trim() : '';
  if (!code || !playlistId || !speakerName) {
    return NextResponse.json(
      { error: 'need a room code, playlist, and speaker name', recovery: 'fill it all in and try again' },
      { status: 400 },
    );
  }
  const result = await registerHostPlaylist(code, {
    sessionId: sid,
    playlistId,
    playlistName,
    speakerName,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json({ ok: true, eligibleCount: result.eligibleCount, playlistName });
}