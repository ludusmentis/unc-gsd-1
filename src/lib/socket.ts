'use client';

import { io, type Socket } from 'socket.io-client';
import type { ActionEnvelope, ServerEvent } from '@/server/events';

export const GAME_NS = '/game';

export function connectGameSocket(url?: string): Socket {
  const opts = { path: '/socket.io', transports: ['websocket', 'polling'] as string[] };
  return io(url ? `${url}${GAME_NS}` : GAME_NS, opts);
}

export type { ActionEnvelope, ServerEvent };

export function sendAction(socket: Socket, env: ActionEnvelope) {
  socket.emit('action', env);
}
