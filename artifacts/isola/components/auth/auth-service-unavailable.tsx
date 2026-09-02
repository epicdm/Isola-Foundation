import { AUTH_GATE_COPY } from '@/lib/auth-gate'

/**
 * Shown when we could not find out whether the reader is signed in.
 *
 * NOT shown when they are signed out — that case redirects to sign-in, and
 * conflating the two is the defect this whole path exists to fix.
 */
export function AuthServiceUnavailable({
  detail,
  retryTo,
}: {
  /** The probe's own sanitised sentence. Never a driver message, host or port. */
  detail: string
  retryTo: string
}) {
  return (
    <main className="flex min-h-svh w-full items-center justify-center p-4">
      <div
        role="alert"
        aria-live="assertive"
        className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground"
      >
        <h1 className="text-lg font-semibold tracking-tight">
          {AUTH_GATE_COPY.serviceUnavailable}
        </h1>

        <p className="mt-3 text-sm text-muted-foreground">
          {AUTH_GATE_COPY.serviceUnavailableBody}
        </p>

        {/*
          The specific failure, in the probe's words. An operator reading a
          screenshot can tell a timeout from a refusal without asking for logs.
        */}
        <p className="mt-3 text-sm text-muted-foreground">
          What happened: {detail}.
        </p>

        <a
          href={retryTo}
          className="mt-6 flex min-h-11 w-full items-center justify-center rounded-md border px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {AUTH_GATE_COPY.retryLabel}
        </a>
      </div>
    </main>
  )
}
