import { NextRequest, NextResponse } from 'next/server';
import { getConsumerSession } from '@/lib/consumer-session';
import { prisma } from '@/lib/prisma';
import { MAGNUS_REGISTRATION_SERVER } from '@/lib/magnus-voice';
import { redactSecret } from '@/lib/redact-secret';

/**
 * GET /api/consumer/voice/line — the signed-in consumer's own voice line.
 *
 * P0 CONTAINMENT 2026-08-12: this route used to return `sip_password` —
 * `voiceLine.magnus_sip_password`, the plaintext SIP registration secret — in
 * the JSON body. The consumer softphone page then rendered it as visible text,
 * built a `csc:<user>:<pass>@…` link from it, and encoded that same string into
 * a QR image. The secret was therefore in the response body, the DOM, the
 * rendered page, any proxy/CDN log that captures bodies, any screenshot, and a
 * photographable QR code — retrievable at will by anyone holding the session,
 * with no one-time property at all.
 *
 * The credential is now emitted by exactly one mechanism: the server-side
 * activation flow, which hands it to the provisioning client and nothing else.
 * It never travels to a browser again. This mirrors the projection discipline
 * already applied to the admin tenant routes (`omit: { magnus_sip_password }`,
 * with route.credentials.test.ts guarding it) — those routes got it; these
 * two (here and the operator twin at app/api/voice/line) never did.
 *
 * `sip_password` is REMOVED, not masked. A masked value is still a value in the
 * response body; only absence is containment. `activation_state` replaces it so
 * the UI can still say something true about setup without holding a secret.
 */
export async function GET(_req: NextRequest) {
  const account = await getConsumerSession();
  if (!account) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const voiceLine = await prisma.voiceLine.findFirst({
    where: { identity_id: account.identityId, owner_kind: 'consumer' },
  });
  if (!voiceLine) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    state: voiceLine.provisioning_state,
    // `provisioning_error` is assembled from upstream Magnus responses. An
    // upstream error that echoes the credential it rejected would leak it
    // through a field nobody classifies as sensitive — so redact before it
    // leaves the server. Caught by route.credentials.test.ts, not by review.
    error: redactSecret(voiceLine.provisioning_error, voiceLine.magnus_sip_password),
    sip_username: voiceLine.magnus_sip_username,
    // Secure activation is not yet proven end-to-end (it depends on an
    // unverified Acrobits InitialProvisioningUrl capability), so the honest
    // answer today is "unavailable" rather than a link that cannot be issued
    // safely. See docs/isola/ACROBITS-PROVISIONING-AND-SECURITY-DESIGN.md.
    activation_state: 'unavailable' as const,
    did_number: voiceLine.magnus_did_number,
    registration_server: MAGNUS_REGISTRATION_SERVER,
    forward_to_cell: voiceLine.voice_forward_to_cell,
    cell_number: voiceLine.voice_cell_number,
  });
}
