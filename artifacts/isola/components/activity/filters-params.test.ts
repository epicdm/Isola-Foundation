/**
 * Defect 10: a parameter this page does not implement must be acknowledged.
 *
 * The API refuses an unknown parameter with a 400 by design. The page never let
 * it get that far: filtersToParams emits a fixed key list, so `?nonsense=1` was
 * dropped on the way out and the reader saw an ordinary list with no sign that
 * part of their link had been discarded. The stripping happens here, so the
 * detection has to happen here too.
 *
 * Also covers the cursor, which is NOT a filter but IS a parameter this page
 * understands and forwards -- so it must not be reported as nonsense.
 */

import { describe, expect, it } from "vitest"

import {
  CURSOR_PARAM,
  EMPTY_FILTERS,
  RECOGNISED_PARAM_KEYS,
  SUPPORTED_FILTER_KEYS,
  activityQueryString,
  cursorFromParams,
  filtersFromParams,
  filtersToParams,
  unrecognisedParamKeys,
} from "./filters"

describe("an unrecognised parameter is detected", () => {
  it("REGRESSION: ?nonsense=1 is reported rather than silently dropped", () => {
    const params = new URLSearchParams("nonsense=1")

    // Still stripped from the request -- that part was always correct.
    expect(filtersToParams(filtersFromParams(params)).toString()).toBe("")
    // But no longer silent.
    expect(unrecognisedParamKeys(params)).toEqual(["nonsense"])
  })

  it("reports every unrecognised key, in the order they appear, once each", () => {
    const params = new URLSearchParams("zzz=1&source=lane2&aaa=2&zzz=3")
    expect(unrecognisedParamKeys(params)).toEqual(["zzz", "aaa"])
  })

  it("reports nothing when every parameter is one this page implements", () => {
    const params = new URLSearchParams(
      "source=lane2&source=audit_log&status=pending&pageSize=25&customer=c-1",
    )
    expect(unrecognisedParamKeys(params)).toEqual([])
  })

  it("does not report the cursor, which this page forwards to the server", () => {
    expect(unrecognisedParamKeys(new URLSearchParams("cursor=abc"))).toEqual([])
  })

  it("reports nothing for an empty address", () => {
    expect(unrecognisedParamKeys(new URLSearchParams(""))).toEqual([])
  })

  it("works through forEach when a params object has no keys()", () => {
    // The Next.js wrapper and URLSearchParams both have keys(); a hand-rolled
    // stub may not, and the fallback must not silently report nothing.
    const stub = {
      get: () => null,
      getAll: () => [],
      forEach: (cb: (value: string, key: string) => void) => {
        cb("1", "nonsense")
        cb("lane2", "source")
      },
    }
    expect(unrecognisedParamKeys(stub)).toEqual(["nonsense"])
  })
})

describe("the recognised set", () => {
  it("is exactly the filters plus the cursor", () => {
    expect([...RECOGNISED_PARAM_KEYS]).toEqual([...SUPPORTED_FILTER_KEYS, CURSOR_PARAM])
  })

  it("does not let the cursor leak into the filter model", () => {
    // A cursor in the address must not become a filter, or the semantic key
    // would change and the server's own fingerprint check would reject it.
    const filters = filtersFromParams(new URLSearchParams("cursor=abc"))
    expect(filters).toEqual(EMPTY_FILTERS)
    // ...and must not be re-emitted as one.
    expect(filtersToParams(filters).toString()).toBe("")
  })
})

describe("a cursor carried by the address", () => {
  it("is read, trimmed, and never invented", () => {
    expect(cursorFromParams(new URLSearchParams("cursor=abc"))).toBe("abc")
    expect(cursorFromParams(new URLSearchParams("cursor=%20%20"))).toBeNull()
    expect(cursorFromParams(new URLSearchParams(""))).toBeNull()
  })

  it("is appended to the API query verbatim", () => {
    const query = activityQueryString(EMPTY_FILTERS, "garbage")
    expect(query).toBe("?cursor=garbage")
  })
})
