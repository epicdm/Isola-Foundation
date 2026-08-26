/**
 * Isola Workspace — shell barrel.
 *
 * The shell is the ONE application mounted inside the conversation. Everything exported here
 * is a pure presentational view: props in, markup out, no hooks, no state, no fetching, and
 * therefore renderable by `renderToStaticMarkup` in a plain node environment (this
 * repository's vitest has no jsdom).
 *
 * Interactive concerns — selection, focus trapping, `Esc`, the sheet's open/closed state —
 * belong to a thin `"use client"` container that wraps these. Every interactive element here
 * carries a `data-iso-*` attribute so a single delegated handler can drive the whole shell.
 */

export { ModuleNavigationView, MORE_TAB_ID } from './module-navigation-view'
export { ModuleSheetView } from './module-sheet-view'
export { IsolaWorkspaceShellView } from './isola-workspace-shell-view'
export { ShellStateBody, stateReplacesModuleBody } from './state-renderers'
