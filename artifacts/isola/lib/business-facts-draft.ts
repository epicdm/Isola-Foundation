/**
 * Pure conversion from a discovery-engine business profile (the JSON shape
 * `isolav2`'s `POST /api/business/scan` route returns — `ValidatedBusinessProfile`
 * in `app/lib/business-scan/profile-schema.ts`, epicdm/isolav2) into the
 * `BUSINESS.md` markdown an operator uploads to a Paperclip employee's
 * instructions bundle.
 *
 * This is the smallest missing connection between the discovery engine (PR172,
 * epicdm/isolav2 — hardens the scan, unrelated to this file) and the existing
 * native hiring mechanism already in this repo
 * (`artifacts/isola/scripts/provision-employees.ts`, the board-authenticated
 * instructions-bundle write in `artifacts/isola/charters/pending/apply-*.sh`).
 * Nothing here talks to a network, mints a hire, or uploads anything — it is a
 * pure string transform, kept free of I/O exactly like `employee-provisioning.ts`
 * next to it, so the connection is unit-testable without a live scan or a live
 * Paperclip write.
 *
 * `ValidatedBusinessProfile` lives in a different repository (isolav2) and is
 * duck-typed here rather than imported across repos — `DiscoveredBusinessProfile`
 * below is the subset of its fields this converter actually uses, kept
 * structurally compatible on purpose.
 *
 * Provenance discipline is structural, not a convention to remember: every field
 * the scan prompt asks the model to INFER (targetAudience, pricingTier) is
 * rendered under an explicit INFERRED heading; every field the scan sourced from
 * the page itself is rendered under SOURCED; anything absent is rendered as an
 * explicit "not sourced" / "Left blank" line — never a fabricated placeholder,
 * never an invented price or hours figure.
 */

export interface DiscoveredBusinessProfile {
  name: string;
  industry: string | null;
  description: string | null;
  phone: string | null;
  email: string | null;
  location: { city?: string | null; country?: string | null; address?: string | null } | null;
  hours: Record<string, unknown> | null;
  services: string[];
  website: string | null;
  targetAudience: string | null;
  pricingTier: string | null;
}

export interface BusinessMdOptions {
  /**
   * How this employee should refer a caller for contact, e.g. "the WhatsApp
   * number this conversation is already running on". Never invented if omitted
   * — the section falls back to "not sourced" instead of guessing a number.
   */
  contactRouteGuidance?: string;
}

const GUARDRAIL =
  "Every fact below is labeled SOURCED or INFERRED. Never state an INFERRED fact " +
  "to a customer as if it were confirmed. Never invent a figure for anything " +
  "marked \"not sourced\" — escalate or say you don't have that information " +
  "instead of guessing.";

function formatLocation(location: DiscoveredBusinessProfile["location"]): string | null {
  if (!location) return null;
  const parts = [location.address, location.city, location.country].filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function formatHours(hours: DiscoveredBusinessProfile["hours"]): string {
  if (!hours || Object.keys(hours).length === 0) {
    return (
      "Not sourced. If asked, say hours are not confirmed here and offer to " +
      "connect with a human for exact availability."
    );
  }
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const rows: string[] = ["| Day | Hours |", "|---|---|"];
  let any = false;
  for (const day of days) {
    const raw = (hours as Record<string, unknown>)[day];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { open?: unknown; close?: unknown; closed?: unknown };
    any = true;
    const label = day.charAt(0).toUpperCase() + day.slice(1);
    if (entry.closed === true) {
      rows.push(`| ${label} | Closed |`);
    } else if (typeof entry.open === "string" && typeof entry.close === "string") {
      rows.push(`| ${label} | ${entry.open}–${entry.close} |`);
    } else {
      rows.push(`| ${label} | Not sourced |`);
    }
  }
  return any
    ? rows.join("\n") + "\n\n**SOURCED** from the discovery scan. Confirm before quoting to a customer if in doubt."
    : "Not sourced. If asked, say hours are not confirmed here and offer to connect with a human for exact availability.";
}

/** Builds the BUSINESS.md markdown. Pure — no I/O, no network, no upload. */
export function buildBusinessMdFromProfile(
  profile: DiscoveredBusinessProfile,
  opts: BusinessMdOptions = {},
): string {
  const name = profile.name.trim();
  if (!name) {
    throw new Error("buildBusinessMdFromProfile: profile.name is required and must be non-empty");
  }

  const lines: string[] = [`# BUSINESS.md — ${name}`, "", GUARDRAIL, "", "## Business identity", ""];

  lines.push(`- **Legal / trading name:** ${name} — **SOURCED**.`);
  const loc = formatLocation(profile.location);
  lines.push(
    loc
      ? `- **Location:** ${loc} — **SOURCED**.`
      : "- **Location:** not established — left blank rather than invented.",
  );
  lines.push(
    profile.industry || profile.description
      ? `- **What we do:** ${[profile.industry, profile.description].filter(Boolean).join(" — ")} — **SOURCED**.`
      : "- **What we do:** not established — left blank rather than invented.",
  );

  lines.push("", "## Services (SOURCED — discovery scan)", "");
  if (profile.services.length > 0) {
    lines.push("| Service | Price / lead time |", "|---|---|");
    for (const service of profile.services) {
      lines.push(`| ${service} | Not sourced — do not invent a figure |`);
    }
  } else {
    lines.push("No services listed by the scan. **Left blank rather than invented.**");
  }
  lines.push(
    "",
    "**Do not invent a figure** for pricing, plan tiers, or lead times. If asked, say a " +
      "current price sheet is not available here and offer to connect the customer with a human.",
  );

  lines.push("", "## Contact routes", "");
  const contactRows: string[] = [];
  if (profile.phone) contactRows.push(`- Phone: \`${profile.phone}\` — **SOURCED**.`);
  if (profile.email) contactRows.push(`- Email: \`${profile.email}\` — **SOURCED**.`);
  if (profile.website) contactRows.push(`- Website: ${profile.website} — **SOURCED**.`);
  if (opts.contactRouteGuidance) contactRows.push(`- ${opts.contactRouteGuidance}`);
  lines.push(
    contactRows.length > 0
      ? contactRows.join("\n")
      : "Not sourced. If asked, offer to connect the customer with a human rather than inventing a contact route.",
  );

  lines.push("", "## Hours / availability", "", formatHours(profile.hours));

  const inferred: string[] = [];
  if (profile.targetAudience) {
    inferred.push(`- **Target audience:** ${profile.targetAudience} **INFERRED**, not confirmed by any record.`);
  }
  if (profile.pricingTier) {
    inferred.push(`- **Pricing tier:** ${profile.pricingTier} **INFERRED.**`);
  }
  if (inferred.length > 0) {
    lines.push(
      "",
      "## Inferred (NOT sourced — do not present to a customer as fact)",
      "",
      ...inferred,
    );
  }

  return lines.join("\n") + "\n";
}
