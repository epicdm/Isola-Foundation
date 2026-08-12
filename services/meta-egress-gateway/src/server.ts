/**
 * HTTP entry point.
 *
 * Binds inside the container network only. Nothing here is publicly routable:
 * the deployment does not attach this service to the ingress network and
 * publishes no port.
 *
 * Proxy environment variables are sanitised at boot, before any request is
 * served, so a `HTTPS_PROXY` inherited from the platform cannot silently become
 * the route to Meta.
 */

import { createServer } from 'node:http';
import { handle } from './app.js';
import { handleAdapter, ADAPTER_PREFIX } from './adapter-handler.js';
import { loadSecrets } from './credentials.js';
import { setContinuationKey } from './continuation.js';

const PORT = Number(process.env.PORT ?? 3000);
const SECRETS_PATH = process.env.META_GATEWAY_SECRETS_PATH ?? '/run/secrets/meta_gateway';
const MAX_BODY_BYTES = 64 * 1024;

/** Remove every proxy hint from this process's environment. */
function sanitiseProxyEnv(): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) {
      delete process.env[key];
      removed.push(key);
    }
  }
  return removed;
}

function boot(): void {
  const removed = sanitiseProxyEnv();
  if (removed.length) {
    console.log(JSON.stringify({ event: 'meta.gateway.boot', proxy_env_removed: removed }));
  }

  let summary;
  try {
    summary = loadSecrets(SECRETS_PATH);
  } catch (err) {
    // Fail to start rather than start without custody. A gateway that cannot
    // read its secret store must not accept traffic — every request would fail
    // anyway, and a half-working boundary invites a "temporary" workaround.
    console.error(
      JSON.stringify({
        event: 'meta.gateway.boot_failed',
        reason: err instanceof Error ? err.message : 'unknown',
        secrets_path: SECRETS_PATH,
      }),
    );
    process.exit(1);
  }

  setContinuationKey(process.env.META_GATEWAY_CONTINUATION_KEY ?? null);

  console.log(
    JSON.stringify({
      event: 'meta.gateway.boot',
      port: PORT,
      workloads: summary.workloads,
      tenants: summary.tenants,
      graph_version: process.env.META_GRAPH_VERSION ?? 'v23.0',
      disabled: String(process.env.META_GATEWAY_DISABLED ?? '').toLowerCase() === 'true',
    }),
  );

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'request body too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });

    req.on('end', () => {
      if (aborted) return;
      void (async () => {
        // The EXACT bytes received are what the signature covers. Re-serialising
        // a parsed object would change whitespace and key order and break every
        // signature, so the digest is taken over the raw body.
        const rawBody = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        let body: unknown = undefined;
        if (rawBody.length) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'body must be valid JSON' }));
            return;
          }
        }

        try {
          const url = new URL(req.url ?? '/', 'http://gateway.internal');
          const hdr = (n: string): string | null => {
            const v = req.headers[n];
            return typeof v === 'string' ? v : null;
          };

          // The Chatwoot compatibility surface, kept on its own prefix and its
          // own handler so its query-token exception cannot reach the operation
          // API. Nothing on this branch logs url.search.
          if (url.pathname.startsWith(ADAPTER_PREFIX)) {
            const out = await handleAdapter({
              method: req.method ?? 'GET',
              path: url.pathname,
              query: url.searchParams,
              authorization: req.headers.authorization ?? null,
              body,
            });
            res.writeHead(out.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body));
            return;
          }

          const out = await handle({
            method: req.method ?? 'GET',
            path: url.pathname,
            authorization: req.headers.authorization ?? null,
            body,
            rawBody,
            // Read only by the operator inspection surface; every other route
            // ignores it entirely.
            inspectPhoneId: url.searchParams.get('phone_number_id') ?? undefined,
            signing: {
              timestamp: hdr('x-isola-timestamp'),
              nonce: hdr('x-isola-nonce'),
              signature: hdr('x-isola-signature'),
            },
          });
          res.writeHead(out.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out.body));
        } catch {
          // No error detail crosses the boundary: an exception message can carry
          // request content, and this service returns only what it projected.
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      })();
    });
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(JSON.stringify({ event: 'meta.gateway.listening', port: PORT }));
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
    });
  }
}

boot();
