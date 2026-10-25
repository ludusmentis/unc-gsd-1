/**
 * OAuth `state` codec (S03-T04 / R021): the login attempt's display name
 * rides in the OAuth state so a 403 allowlist rejection can surface the
 * friend's name on the host screen with Gen Z copy instead of a raw error.
 *
 * Kept outside the Next route files — route modules may only export route
 * handlers.
 */

export function encodeState(origin: string, name?: string): string {
  const base = `origin:${origin}`;
  return name ? `${base}&name:${encodeURIComponent(name)}` : base;
}

export function decodeState(state: string | null): { origin: string; name?: string } {
  if (!state) return { origin: '' };
  const m = /^origin:([^&]*)(?:&name:(.*))?$/.exec(state);
  if (!m) return { origin: state };
  return { origin: m[1], name: m[2] ? decodeURIComponent(m[2]) : undefined };
}