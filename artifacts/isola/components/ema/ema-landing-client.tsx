'use client';

import { useEffect, useRef } from 'react';

export interface EmaUtmParams {
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
}

const UTM_COOKIE = 'ema_utm';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days — carries attribution to signup

function hasAnyUtm(utm: EmaUtmParams): boolean {
  return Boolean(utm.utm_source || utm.utm_medium || utm.utm_campaign || utm.utm_term || utm.utm_content);
}

/**
 * Fires once on landing-page view: persists UTM params in a cookie (so
 * attribution survives even if the visitor doesn't click a CTA immediately)
 * and records a "view" lead via /api/consumer/lead. A sessionStorage guard
 * avoids double-counting on client-side re-renders / back-navigation within
 * the same tab.
 */
export function EmaLandingTracker({ utm, landingPath }: { utm: EmaUtmParams; landingPath: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    if (hasAnyUtm(utm)) {
      document.cookie = `${UTM_COOKIE}=${encodeURIComponent(JSON.stringify(utm))}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`;
    }

    const alreadyCaptured = sessionStorage.getItem('ema_lead_view_captured');
    if (alreadyCaptured) return;
    sessionStorage.setItem('ema_lead_view_captured', '1');

    fetch('/api/consumer/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...utm,
        referrer: document.referrer || null,
        landing_path: landingPath,
        cta: 'view',
      }),
      keepalive: true,
    }).catch(() => {
      // Attribution is best-effort; never block the page on this.
    });
  }, [utm, landingPath]);

  return null;
}

/** Records which CTA was clicked before navigating away. Fire-and-forget. */
export function trackEmaCta(cta: 'signup' | 'whatsapp', utm: EmaUtmParams, landingPath: string) {
  try {
    fetch('/api/consumer/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...utm, referrer: document.referrer || null, landing_path: landingPath, cta }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never block navigation on attribution
  }
}
