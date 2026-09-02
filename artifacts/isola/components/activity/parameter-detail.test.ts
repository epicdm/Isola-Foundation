/**
 * The API's detail string, translated -- and, just as importantly, NOT
 * translated when translating it would corrupt the sentence.
 */

import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { parameterLabel } from "./labels"
import { PARAMETER_NAMES, humaniseDetail } from "./parameter-detail"

describe("the reported defect", () => {
  it("REGRESSION: pageSize no longer reaches the reader", () => {
    // The whole sentence a reader saw: "The filter Records per page was
    // refused: pageSize may not exceed 100".
    expect(humaniseDetail("pageSize may not exceed 100")).toBe(
      "Records per page may not exceed 100",
    )
    expect(humaniseDetail("pageSize may not exceed 100")).not.toContain("pageSize")
  })

  it("translates the other pageSize refusals the API can produce", () => {
    expect(humaniseDetail("pageSize must be a whole number")).toBe(
      "Records per page must be a whole number",
    )
    expect(humaniseDetail("pageSize must be at least 1")).toBe(
      "Records per page must be at least 1",
    )
  })

  it("translates a parameter name that opens the sentence", () => {
    expect(humaniseDetail("occurredTo is not a date")).toBe("To is not a date")
    expect(humaniseDetail("status is not a valid identifier")).toBe(
      "Status is not a valid identifier",
    )
    expect(humaniseDetail("customer was given more than once")).toBe(
      "Customer reference was given more than once",
    )
    expect(humaniseDetail("cursor was given with no value")).toBe(
      "Page position was given with no value",
    )
  })
})

describe("what it deliberately leaves alone", () => {
  it("an unmapped detail is passed through unchanged, never swallowed", () => {
    const detail = "frobnicate is not a filter this endpoint implements"
    expect(humaniseDetail(detail)).toBe(detail)
  })

  it("a detail that names no parameter at all is unchanged", () => {
    expect(humaniseDetail("the range ends before it begins")).toBe(
      "the range ends before it begins",
    )
  })

  it("does not rewrite a parameter name being used as an English word", () => {
    // `source` and `filter` are both parameter names AND words the API writes
    // in the middle of its own sentences. Only a LEADING occurrence is a name.
    expect(humaniseDetail("odoo is not a source this endpoint reads")).toBe(
      "odoo is not a source this endpoint reads",
    )
    expect(humaniseDetail("whatever is not a filter this endpoint implements")).toBe(
      "whatever is not a filter this endpoint implements",
    )
  })

  it("empty and missing details stay empty rather than becoming a label", () => {
    expect(humaniseDetail("")).toBe("")
    expect(humaniseDetail("   ")).toBe("")
    expect(humaniseDetail(null)).toBe("")
    expect(humaniseDetail(undefined)).toBe("")
  })
})

describe("camelCase names are safe to replace anywhere", () => {
  it("translates one that is not the first word", () => {
    expect(humaniseDetail("the value given for eventFamily is not one of them")).toBe(
      "the value given for Kind of record is not one of them",
    )
    expect(humaniseDetail("try ownershipState instead")).toBe(
      "try Who was handling it instead",
    )
  })

  it("does not match a longer identifier that merely starts the same way", () => {
    // `eventTypes` is not `eventFamily`, and `pageSizes` is not `pageSize`.
    expect(humaniseDetail("one or more eventTypes are not recognised")).toBe(
      "one or more eventTypes are not recognised",
    )
    expect(humaniseDetail("no pageSizes here")).toBe("no pageSizes here")
  })
})

describe("one table, not two", () => {
  const source = fs.readFileSync(path.join(__dirname, "labels.ts"), "utf8")

  it("names exactly the parameters PARAMETER_LABELS defines", () => {
    const block = /const PARAMETER_LABELS[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1]
    expect(block).toBeDefined()

    const keys = [...(block ?? "").matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    // A parameter added to labels.ts and not here would go on reaching readers
    // as a raw name. This is the test that catches that, rather than a comment
    // asking the next person to remember.
    expect([...keys].sort()).toEqual([...PARAMETER_NAMES].sort())
  })

  it("uses the labels from labels.ts rather than a copy of them", () => {
    for (const name of PARAMETER_NAMES) {
      expect(humaniseDetail(name + " is refused")).toBe(parameterLabel(name) + " is refused")
    }
  })
})
