/**
 * Structural contracts for /activity that no rendered-markup test can reach.
 *
 * Three of the twelve defects were about where things sit in the TREE rather
 * than about what any one component renders:
 *
 *   2  the route's guard was awaited above the Suspense boundary, so nothing
 *      -- not even the skeleton -- was emitted until it resolved;
 *   4  the layout's Topbar rendered an h1 alongside every page's own h1;
 *   5  the feed has to end up inside the single <main> that SidebarInset
 *      renders, rather than beside it.
 *
 * The first is a property of a module that cannot be rendered here at all: the
 * page is a server component whose children await a real session. The second and
 * third live in files the page does not import. So these are asserted against
 * the source, the way tests/route-runtime-config-contract.test.ts already does
 * for a defect of the same shape.
 */

import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "..")
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8")

const PAGE = "app/(owner)/activity/page.tsx"
const LAYOUT = "app/(owner)/layout.tsx"
const TOPBAR = "components/topbar.tsx"
const SIDEBAR = "components/ui/sidebar.tsx"

/** Strips comments so a rule is never satisfied by prose describing it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

describe("defect 2: the route emits its shell before it awaits anything", () => {
  const source = code(read(PAGE))

  it("the default export is NOT async", async () => {
    // The property that matters, checked on the real binding rather than the
    // text: an async component returns a promise, and Next cannot flush a
    // segment -- including a Suspense fallback inside it -- until it settles.
    const mod = await import("@/app/(owner)/activity/page")
    expect(typeof mod.default).toBe("function")
    expect(mod.default.constructor.name).toBe("Function")
    expect(mod.default.constructor.name).not.toBe("AsyncFunction")
  })

  it("awaits the session inside the boundary, never above it", () => {
    const boundary = source.indexOf("<Suspense")
    const session = source.indexOf("await getSession()")
    const guard = source.indexOf("await requireWorkspaceAccess")

    expect(boundary).toBeGreaterThanOrEqual(0)
    expect(session).toBeGreaterThan(boundary)
    expect(guard).toBeGreaterThan(boundary)
  })

  it("still guards: nothing renders the feed without passing both checks", () => {
    expect(source).toContain("await getSession()")
    expect(source).toContain("await requireWorkspaceAccess(session, \"manager\")")
    expect(source).toContain("WorkspaceAccessDenied")
    // The feed is reached only after the guard, in the guarded child.
    const guard = source.indexOf("if (!guard.ok)")
    const feed = source.indexOf("<RecentWork />")
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(feed).toBeGreaterThan(guard)
  })

  it("the fallback is the full-page skeleton", () => {
    expect(source).toContain("fallback={<RecentWorkLoading />}")
  })
})

describe("defect 4: the layout chrome does not render a second h1", () => {
  const topbar = code(read(TOPBAR))

  it("REGRESSION: the topbar title is no longer a heading", () => {
    // It repeats the sidebar nav item on every owner route; the page owns the
    // document title. Two h1s left a reader navigating by heading unable to say
    // which one was the page.
    expect(topbar).not.toMatch(/<h1[\s>]/)
    expect(topbar).not.toMatch(/<\/h1>/)
  })

  it("keeps the label itself, which is still useful as text", () => {
    expect(topbar).toContain("Activity & Reports")
    expect(topbar).toContain("titleFor(pathname)")
  })

  it("renders no heading of any level, so it cannot skip a page's levels either", () => {
    expect(topbar).not.toMatch(/<h[1-6][\s>]/)
  })
})

describe("defect 5: the feed is nested inside the layout's main", () => {
  const layout = code(read(LAYOUT))
  const sidebar = code(read(SIDEBAR))

  it("SidebarInset is the element that renders main", () => {
    expect(sidebar).toMatch(/function SidebarInset[\s\S]{0,200}<main/)
  })

  it("the layout puts children INSIDE SidebarInset, not beside it", () => {
    const open = layout.indexOf("<SidebarInset")
    const children = layout.indexOf("{children}")
    const close = layout.indexOf("</SidebarInset>")

    expect(open).toBeGreaterThanOrEqual(0)
    expect(close).toBeGreaterThan(open)
    expect(children).toBeGreaterThan(open)
    expect(children).toBeLessThan(close)
  })

  it("the layout renders exactly one SidebarInset, so there is one main", () => {
    expect((layout.match(/<SidebarInset[\s>]/g) ?? []).length).toBe(1)
  })

  it("no route file under (owner) renders a main of its own", () => {
    const dir = path.join(ROOT, "app/(owner)")
    const offenders: string[] = []
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".tsx") && /<main[\s>]/.test(code(fs.readFileSync(full, "utf8")))) {
          offenders.push(path.relative(ROOT, full))
        }
      }
    }
    walk(dir)
    expect(offenders).toEqual([])
  })
})
