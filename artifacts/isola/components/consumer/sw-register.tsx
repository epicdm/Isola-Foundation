'use client';

import { useEffect } from 'react';

/** Registers the consumer PWA service worker. Scoped to /consumer/ only —
 *  never touches the operator app (no SW registration there). */
export function ConsumerServiceWorkerRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/consumer/sw.js', { scope: '/consumer/' }).catch((err) => {
        console.error('[consumer-pwa] Service worker registration failed:', err);
      });
    }
  }, []);
  return null;
}
