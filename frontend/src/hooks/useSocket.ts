import { useEffect, useLayoutEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../store/authStore';

let globalSocket: Socket | null = null;

// A new token (password change, another sign-in) reconnects the socket with it
// straight away; the server re-checks the session on connect (U8). Logout is
// handled below, where the socket is dropped.
useAuthStore.subscribe((state, prev) => {
  if (state.token && prev.token && state.token !== prev.token && globalSocket) {
    globalSocket.disconnect().connect();
  }
});

export function getSocket(): Socket | null {
  return globalSocket;
}

export function useSocket(
  events: Record<string, (data: unknown) => void>
): void {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const eventsRef = useRef(events);
  useLayoutEffect(() => { eventsRef.current = events; });

  useEffect(() => {
    if (!isAuthenticated) {
      // Drop the shared socket on logout so a later login reconnects with a fresh token.
      if (globalSocket) {
        globalSocket.disconnect();
        globalSocket = null;
      }
      return;
    }

    if (!globalSocket) {
      globalSocket = io('/', {
        path: '/socket.io',
        // Read at every (re)connect, never frozen (outside review U8): a token
        // reissued by a password change, or a new sign-in, is what the socket
        // presents next time, instead of the old one that the server refuses.
        auth: (cb) => cb({ token: useAuthStore.getState().token }),
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 2000,
      });
    }

    const socket = globalSocket;
    const handlers: Array<[string, (d: unknown) => void]> = [];

    for (const [event, handler] of Object.entries(eventsRef.current)) {
      const wrapped = (data: unknown) => handler(data);
      socket.on(event, wrapped);
      handlers.push([event, wrapped]);
    }

    return () => {
      for (const [event, handler] of handlers) {
        socket.off(event, handler);
      }
    };
  }, [isAuthenticated]);
}
