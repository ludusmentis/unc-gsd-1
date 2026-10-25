/**
 * Session identity persistence (R009): the session token, room code, and
 * player id live in localStorage so a locked phone, dead battery, or closed
 * tab never destroys a game — sessionStorage dies with the tab.
 * Falls back to a memory shim when window is unavailable (SSR/tests).
 */

export interface Identity {
  token: string;
  code: string;
  playerId: string;
  isHost: boolean;
}

const KEYS = ['token', 'code', 'playerId', 'isHost'] as const;

function backing(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.getItem('token');
      return window.localStorage;
    } catch {
      // private mode / disabled — fall through to shim
    }
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
}

/** Persist the identity issued at room_created / joined time. */
export function saveIdentity(v: Identity): void {
  const s = backing();
  s.setItem('token', v.token);
  s.setItem('code', v.code);
  s.setItem('playerId', v.playerId);
  s.setItem('isHost', v.isHost ? '1' : '0');
  // Best-effort legacy cleanup: old sessionStorage copies are stale by design.
  try { sessionStorage?.removeItem('token'); } catch { /* noop */ }
}

/**
 * Load the identity, migrating from legacy sessionStorage if localStorage
 * has nothing (pre-T02 tabs that still hold a sessionStorage token).
 */
export function loadIdentity(): Identity | null {
  const s = backing();
  let token = s.getItem('token');
  let code = s.getItem('code');
  let playerId = s.getItem('playerId');
  let isHost = s.getItem('isHost') === '1';
  if (!token || !code || !playerId) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        token = token || sessionStorage.getItem('token');
        code = code || sessionStorage.getItem('code');
        playerId = playerId || sessionStorage.getItem('playerId');
        isHost = isHost || sessionStorage.getItem('isHost') === '1';
      }
    } catch { /* private mode — shim only */ }
  }
  if (!token || !code || !playerId) return null;
  return { token, code, playerId, isHost };
}

/** Explicit value getter for pages that read keys individually. */
export function readIdentityValue(key: (typeof KEYS)[number]): string | null {
  return backing().getItem(key);
}

/** Drop the identity (leave_room / new game). */
export function clearIdentity(): void {
  const s = backing();
  for (const k of KEYS) s.removeItem(k);
}