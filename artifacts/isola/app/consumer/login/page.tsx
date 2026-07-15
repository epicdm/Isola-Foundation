'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Phone, ShieldCheck, ClipboardCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Step = 'phone' | 'code';

/** A bare 6-digit numeric string — what the "Copy code" button on the WhatsApp AUTHENTICATION template puts on the clipboard. */
const SIX_DIGIT_CODE = /^\d{6}$/;

export default function ConsumerLoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [autoFilled, setAutoFilled] = useState(false);
  // Guards against re-submitting the same clipboard code repeatedly (e.g. the
  // user re-focuses the tab several times without copying a new code).
  const lastAutoSubmittedCode = useRef<string | null>(null);

  async function handleRequestOtp(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setDevCode(null);
    try {
      const res = await fetch('/api/consumer/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to send code');
        return;
      }
      if (data.dev_code) setDevCode(data.dev_code);
      setStep('code');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to send code');
    } finally {
      setLoading(false);
    }
  }

  const verifyCode = useCallback(
    async (codeToVerify: string) => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/consumer/auth/verify-otp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone_number: phone.trim(), code: codeToVerify.trim() }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error ?? 'Invalid code');
          return;
        }
        router.replace('/consumer');
        router.refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Verification failed');
      } finally {
        setLoading(false);
      }
    },
    [phone, router],
  );

  function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    void verifyCode(code);
  }

  // Clipboard auto-fill: when the user returns to the tab/PWA (e.g. after
  // tapping "Copy code" on the WhatsApp AUTHENTICATION message and switching
  // back), check whether the clipboard holds a plausible 6-digit code and,
  // if so, fill + auto-submit it. Only runs on the code step, only reads the
  // clipboard on an actual user-return gesture (never polls in the
  // background), and fails silently if permission is denied — manual entry
  // still works either way.
  useEffect(() => {
    if (step !== 'code') return;
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;

    async function tryAutoFillFromClipboard() {
      if (loading) return;
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (!SIX_DIGIT_CODE.test(text)) return;
        if (lastAutoSubmittedCode.current === text) return;
        lastAutoSubmittedCode.current = text;
        setCode(text);
        setAutoFilled(true);
        await verifyCode(text);
      } catch {
        // Clipboard permission denied/unavailable — degrade to manual entry.
      }
    }

    function onUserReturn() {
      if (document.visibilityState === 'visible') void tryAutoFillFromClipboard();
    }

    // Covers both the tab regaining focus and the PWA coming back to the
    // foreground (visibilitychange fires reliably on iOS/Android PWAs where
    // `focus` sometimes doesn't).
    window.addEventListener('focus', onUserReturn);
    document.addEventListener('visibilitychange', onUserReturn);
    // Also try once immediately in case the code step just mounted after a
    // redirect-back (e.g. from a WhatsApp deep link).
    void tryAutoFillFromClipboard();

    return () => {
      window.removeEventListener('focus', onUserReturn);
      document.removeEventListener('visibilitychange', onUserReturn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, loading]);

  return (
    <div className="ema-texture mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-10" data-theme-preset="epic">
      <div className="ema-rise ema-rise-1 mb-8 flex flex-col items-center gap-2">
        <div className="ema-shadow flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Phone className="size-8" />
        </div>
        <h1 className="font-display text-2xl font-extrabold tracking-tight">EMA</h1>
        <p className="text-center text-sm text-muted-foreground">Your phone line, in your pocket.</p>
      </div>

      <Card className="ema-rise ema-rise-2 ema-card ema-shadow w-full border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">
            {step === 'phone' ? 'Sign in with your number' : 'Enter the code we sent you'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {devCode && (
            <Alert className="mb-4">
              <AlertDescription>Dev mode — your code is <strong>{devCode}</strong></AlertDescription>
            </Alert>
          )}
          {step === 'code' && (
            <p className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ClipboardCheck className="size-3.5" />
              {autoFilled
                ? 'Code filled automatically from your clipboard.'
                : 'Tap "Copy code" in WhatsApp, then come back here — we\u2019ll fill it in for you.'}
            </p>
          )}

          {step === 'phone' ? (
            <form onSubmit={handleRequestOtp} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="phone">Phone number</Label>
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1767xxxxxxx"
                  autoComplete="tel"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send code via WhatsApp'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerify} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">6-digit code</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setAutoFilled(false);
                  }}
                  placeholder="123456"
                  inputMode="numeric"
                  maxLength={6}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                <ShieldCheck className="size-4" />
                {loading ? 'Verifying…' : 'Verify & sign in'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStep('phone');
                  setCode('');
                  setAutoFilled(false);
                  lastAutoSubmittedCode.current = null;
                }}
                disabled={loading}
              >
                Use a different number
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
