/**
 * The wording rules, tested where they are decided.
 *
 * Covers defect 3 and 7 (a failed or refused request may not be described as a
 * complete one, nor as a loading one), 8 (second precision and a per-record
 * reference), 9 (raw identifiers), and 11 (the API's parameter names in the
 * page's own words).
 */

import { describe, expect, it } from "vitest"

import {
  CURSOR_RESET_TITLE,
  absoluteTime,
  actorDisplay,
  cursorResetNotice,
  customerDisplay,
  dataStateNotice,
  isOpaqueIdentifier,
  parameterLabel,
  problemStateNotice,
  recordReference,
  relatedDisplay,
  shortReference,
} from "./labels"

// ── defect 8: timestamps ──

describe("an absolute time is precise to the second", () => {
  it("prints seconds", () => {
    expect(absoluteTime("2026-07-31T22:00:07.000Z")).toBe("2026-07-31 22:00:07 UTC")
  })

  it("pads every field, so the column is fixed width and sorts as text", () => {
    expect(absoluteTime("2026-01-02T03:04:05.000Z")).toBe("2026-01-02 03:04:05 UTC")
  })

  it("REGRESSION: two records seconds apart no longer render identically", () => {
    // Seven of fifty rows collided at minute precision. The data was never the
    // problem; the display was.
    const a = absoluteTime("2026-07-31T22:00:03.000Z")
    const b = absoluteTime("2026-07-31T22:00:41.000Z")
    expect(a).not.toBe(b)
  })

  it("still refuses to guess when there is no time to print", () => {
    expect(absoluteTime(null)).toBe("Unknown time")
    expect(absoluteTime("not a date")).toBe("Unknown time")
  })
})

describe("a record reference distinguishes rows that share a timestamp", () => {
  it("shows a short suffix and keeps the whole id available", () => {
    const ref = recordReference("cmrewdo5b0005s61765xj85i4")
    expect(ref).not.toBeNull()
    expect(ref?.text).toBe("…j85i4")
    expect(ref?.title).toBe("cmrewdo5b0005s61765xj85i4")
  })

  it("gives different rows different references", () => {
    const a = recordReference("cmrewcr5e0001s617dpr2qm3e")
    const b = recordReference("cmrewdo5b0005s61765xj85i4")
    expect(a?.text).not.toBe(b?.text)
  })

  it("is omitted rather than invented when there is no id", () => {
    expect(recordReference("")).toBeNull()
    expect(recordReference(null)).toBeNull()
  })
})

// ── defect 9: raw identifiers ──

describe("an identifier is recognised as an identifier", () => {
  it("matches a cuid, bare or prefixed", () => {
    expect(isOpaqueIdentifier("cmrewcr5e0001s617dpr2qm3e")).toBe(true)
    expect(isOpaqueIdentifier("agent:cmrewcr5e0001s617dpr2qm3e")).toBe(true)
  })

  it("does not match anything a person would have typed", () => {
    expect(isOpaqueIdentifier("Maria")).toBe(false)
    expect(isOpaqueIdentifier("Maria Charles")).toBe(false)
    // Long, but no digits: a name, not a key.
    expect(isOpaqueIdentifier("Bartholomewsmithson")).toBe(false)
    // Short internal refs are not shortened either; there is nothing to shorten.
    expect(isOpaqueIdentifier("staff:99")).toBe(false)
  })
})

describe("shortReference", () => {
  it("marks the value as a fragment", () => {
    expect(shortReference("cmrewcr5e0001s617dpr2qm3e")).toBe("…2qm3e")
  })

  it("does not pad a value shorter than the suffix", () => {
    expect(shortReference("ab")).toBe("…ab")
  })
})

describe("an actor is never fabricated", () => {
  it("REGRESSION: a raw cuid label becomes the kind plus a short suffix", () => {
    const display = actorDisplay({
      label: "agent:cmrewcr5e0001s617dpr2qm3e",
      kind: "agent",
    })
    // The kind is real -- the API told us. The suffix is real. Nothing else is
    // asserted about who this is.
    expect(display.text).toBe("Assistant · …2qm3e")
    expect(display.title).toBe("agent:cmrewcr5e0001s617dpr2qm3e")
    // No invented name anywhere.
    expect(display.text).not.toMatch(/cmrewcr5e0001s617dpr/)
  })

  it("leaves a real label completely alone", () => {
    expect(actorDisplay({ label: "Maria", kind: "staff" })).toEqual({
      text: "Maria (team member)",
      title: null,
    })
  })

  it("says Unknown rather than substituting the reference", () => {
    const display = actorDisplay({ label: "", kind: "staff" })
    expect(display.text).toBe("Unknown (team member)")
    expect(display.title).toBeNull()
  })

  it("says Unknown when there is no kind either", () => {
    expect(actorDisplay(null)).toEqual({ text: "Unknown", title: null })
  })
})

describe("a related object is never fabricated", () => {
  it("REGRESSION: a raw conversation cuid is shortened, not printed whole", () => {
    const display = relatedDisplay("conversation", "cmrewdo5b0005s61765xj85i4")
    expect(display?.text).toBe("Conversation …j85i4")
    expect(display?.title).toBe("Conversation cmrewdo5b0005s61765xj85i4")
  })

  it("prints a readable id in full, because there is nothing to hide", () => {
    expect(relatedDisplay("invoice", "INV-204")).toEqual({
      text: "Invoice INV-204",
      title: null,
    })
  })

  it("is omitted when either half is missing", () => {
    expect(relatedDisplay("conversation", null)).toBeNull()
    expect(relatedDisplay(null, "abc")).toBeNull()
  })
})

describe("a customer with a proven id but no label still shows, and still links", () => {
  it("REGRESSION: an id with no label is not withheld -- it falls through to the id", () => {
    // This is the exact shape customer_tool_operation sends: a real,
    // Odoo-verified customerId and a customerLabel of null, by design.
    expect(customerDisplay("42", null)).toEqual({ text: "Customer #42", title: null })
  })

  it("prints a short partner id in full, because there is nothing to hide", () => {
    expect(customerDisplay("7", null)).toEqual({ text: "Customer #7", title: null })
  })

  it("shortens a long opaque id and keeps the whole value in title", () => {
    const display = customerDisplay("cmrewdo5b0005s61765xj85i4", null)
    expect(display?.text).toBe("Customer · …j85i4")
    expect(display?.title).toBe("cmrewdo5b0005s61765xj85i4")
  })

  it("prefers a real label when one arrives, and invents nothing beyond it", () => {
    expect(customerDisplay("42", "Island Hardware Ltd")).toEqual({
      text: "Island Hardware Ltd",
      title: null,
    })
  })

  it("is omitted, not printed as Unknown, when there is no id and no label", () => {
    expect(customerDisplay(null, null)).toBeNull()
    expect(customerDisplay("", "")).toBeNull()
  })
})

// ── defect 11: parameter names ──

describe("a refused parameter is named in the page's own words", () => {
  it("REGRESSION: pageSize is Records per page", () => {
    expect(parameterLabel("pageSize")).toBe("Records per page")
  })

  it("maps every parameter the filter bar exposes", () => {
    expect(parameterLabel("source")).toBe("System")
    expect(parameterLabel("eventFamily")).toBe("Kind of record")
    expect(parameterLabel("ownershipState")).toBe("Who was handling it")
    expect(parameterLabel("occurredFrom")).toBe("From")
    expect(parameterLabel("occurredTo")).toBe("To")
    expect(parameterLabel("customer")).toBe("Customer reference")
    expect(parameterLabel("actor")).toBe("Person or assistant reference")
    expect(parameterLabel("cursor")).toBe("Page position")
  })

  it("humanises rather than printing a raw key it has never seen", () => {
    expect(parameterLabel("some_new_param")).toBe("Some new param")
    expect(parameterLabel("")).toBe("Filter")
  })
})

// ── defects 3 and 7: the freshness line ──

describe("a request that failed is not described as one that never happened", () => {
  it("REGRESSION: an invalid filter does not read as Not loaded yet", () => {
    const notice = problemStateNotice({ kind: "invalid_filter" })
    // The contradiction was this exact pair of strings on screen together.
    expect(notice.label).not.toBe("Not loaded yet")
    expect(notice.explanation).not.toBe("This list has not been loaded yet.")
    expect(notice.tone).toBe("warning")
  })

  it("never claims success for any failure", () => {
    for (const kind of [
      "auth_expired",
      "not_permitted",
      "unavailable",
      "invalid_filter",
      "invalid_cursor",
      "unexpected",
    ]) {
      const notice = problemStateNotice({ kind })
      expect(notice.tone).toBe("warning")
      expect(notice.label).not.toBe("Complete")
      expect(notice.explanation).not.toContain("Every system answered")
    }
  })
})

describe("a refused cursor is not described as a complete answer", () => {
  const notice = cursorResetNotice()

  it("REGRESSION: it does not read Complete", () => {
    expect(notice.label).not.toBe("Complete")
    expect(notice.explanation).not.toContain("Every system answered")
    expect(notice.tone).toBe("warning")
  })

  it("says the position was refused, and that nothing was skipped", () => {
    expect(notice.explanation).toContain("was not valid")
    expect(notice.explanation).toContain("refused")
    expect(notice.explanation).toContain("first page")
    expect(notice.explanation).toContain("Nothing was skipped")
  })

  it("the notice and the problem branch share one title", () => {
    expect(CURSOR_RESET_TITLE).toBe("Back to the first page")
  })
})

describe("a clean answer still gets to describe itself", () => {
  it("is unchanged", () => {
    expect(dataStateNotice("available_with_records")).toEqual({
      tone: "neutral",
      label: "Complete",
      explanation: "Every system answered.",
    })
  })
})
