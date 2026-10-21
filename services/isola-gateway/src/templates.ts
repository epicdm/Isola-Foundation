/**
 * The template ids a binding's `senderTemplates` may name.
 *
 * THIS IS A COPY, AND IT IS KEPT HONEST BY A TEST. The authority on templates
 * is isola-runtime's registry (`services/isola-runtime/src/registry.ts`); this
 * gateway builds standalone and cannot import it. The list exists so a typo in
 * a per-sender override fails the BOOT loudly, instead of failing every one of
 * that person's messages with `unknown_template` at reply time.
 *
 * `test/templates-registry-parity.test.ts` loads the runtime registry and
 * asserts every id here exists there with exposure INTERNAL. Adding a template
 * to the runtime does not require adding it here; naming one here that the
 * runtime does not hold as INTERNAL fails that test.
 *
 * Only INTERNAL templates are listed. A per-sender override exists only on an
 * INTERNAL binding (it keys on a verified staff sender), so a PUBLIC template
 * id is never a valid value — the runtime would refuse it on the INTERNAL
 * credential anyway, and refusing it here says so at boot.
 */
export const KNOWN_INTERNAL_TEMPLATE_IDS: readonly string[] = Object.freeze([
  "isola-internal-manager@v1",
  "isola-owner-manager@v1",
  "epic-staff-operations-coordinator@v1",
]);

export function isKnownInternalTemplateId(value: unknown): value is string {
  return typeof value === "string" && KNOWN_INTERNAL_TEMPLATE_IDS.includes(value);
}
