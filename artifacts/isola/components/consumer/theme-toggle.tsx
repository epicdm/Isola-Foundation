'use client';

import { Moon, Sun } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { usePreferencesStore } from '@/stores/preferences/preferences-provider';
import { cn } from '@/lib/utils';

/**
 * EMA's own theme toggle — reuses the same PreferencesStore/cookie
 * mechanism as the B2B ThemeSwitcher (theme_mode: light | dark | system),
 * so persistence and the "respect prefers-color-scheme" system option keep
 * working unchanged. Simplified to a two-state light/dark pill for the
 * consumer app's single top-bar affordance; "system" stays reachable by
 * clearing the theme_mode cookie, same as before.
 */
export function ConsumerThemeToggle({ className }: { className?: string }) {
  const { themeMode, setPreference } = usePreferencesStore(
    useShallow((state) => ({
      themeMode: state.values.theme_mode,
      setPreference: state.setPreference,
    })),
  );

  const isDark = themeMode === 'dark' || (themeMode === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  return (
    <button
      type="button"
      onClick={() => setPreference('theme_mode', isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'ema-pill ema-interactive flex size-9 items-center justify-center rounded-full border border-border bg-card/80 text-foreground shadow-sm backdrop-blur',
        className,
      )}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
