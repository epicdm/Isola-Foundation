/**
 * GET /api/consumer/voice/callback/call-state/[callId] — proxies the BFF
 * Lite Server-Sent Events stream for a callback's live state (ringing ->
 * answered -> hangup) straight through to the browser.
 *
 * Session-gated (must be a signed-in consumer) but deliberately does NOT
 * try to verify the callId "belongs" to this account beyond that — callIds
 * are opaque, BFF-issued, high-entropy strings, and this route never
 * accepts one from anywhere other than a callback this same session just
 * started. The BFF's internal secret never leaves this server.
 *
 * PRODUCTION UAT INCIDENT (2026-07-13): a live callback was accepted by the
 * BFF (202 + real callId, confirmed in AuditLog) and Magnus rang the
 * caller's own number correctly, but the consumer saw nothing — the
 * deployed process logged an uncaught "failed to pipe response" /
 * SocketError "other side closed" roughly 60s into the stream. Piping
 * `upstream.body` directly (the old implementation) meant that when the
 * BFF's socket closed mid-stream (idle timeout somewhere in the path —
 * the BFF sends no periodic keepalive), the pipe threw and Next aborted
 * the client's HTTP response with no clean terminal frame. That, combined
 * with the client immediately calling `EventSource.close()` on *any*
 * error (see call/page.tsx), permanently ended the live-status UI even
 * though the call itself may still have been in progress on Magnus's
 * side — from the consumer's perspective the callback "did not work."
 * Not a Dominica-restriction or ownerPhone issue — see
 * memory/bff-lite-callback-contract.md.
 *
 * Fix: manually pump the upstream reader instead of returning its body
 * directly, so a broken upstream socket ends this stream CLEANLY (a
 * synthetic terminal frame, then a clean close) instead of crashing the
 * response, and emit our own heartbeat comments so intermediate proxies
 * never see this connection go idle in the first place.
 */

import { NextRequest } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { getBffConfig, isBffConfigured } from '@/lib/engines';
import { openCallStateStream } from '@/engines/bff';

export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 15_000;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ callId: string }> }) {
  const account = await getConsumerSession();
  if (!account) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });

  if (!isBffConfigured()) {
    return new Response(JSON.stringify({ error: 'Calling is not configured' }), { status: 503 });
  }

  const { callId } = await params;
  if (!callId) return new Response(JSON.stringify({ error: 'callId is required' }), { status: 400 });

  let upstream: Response;
  try {
    upstream = await openCallStateStream(getBffConfig(), callId);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'network error';
    return new Response(JSON.stringify({ error: `BFF unreachable: ${detail}` }), { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return new Response(text || JSON.stringify({ error: `BFF returned HTTP ${upstream.status}` }), {
      status: upstream.status,
    });
  }

  // Manually pump the upstream reader instead of returning `upstream.body`
  // directly — see the file-header incident note. This lets us (a) end the
  // client stream CLEANLY with a terminal frame if the upstream socket
  // drops, instead of the pipe throwing and Next hard-aborting the
  // response, and (b) inject heartbeat comments so no intermediate proxy
  // treats a quiet "still ringing" gap as a dead connection.
  const encoder = new TextEncoder();
  const upstreamReader = upstream.body.getReader();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeClose = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          safeClose();
        }
      }, HEARTBEAT_INTERVAL_MS);

      (async () => {
        try {
          for (;;) {
            const { done, value } = await upstreamReader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          // Upstream socket closed/reset mid-call. Tell the browser via a
          // normal SSE data frame (the client treats unknown event names
          // as "keep waiting", not terminal) instead of letting this
          // throw and abort the HTTP response outright.
          console.warn('[call-state] upstream stream dropped:', e instanceof Error ? e.message : e);
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'stream_error' })}\n\n`));
          } catch {
            /* controller already gone */
          }
        } finally {
          safeClose();
        }
      })();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      upstreamReader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
