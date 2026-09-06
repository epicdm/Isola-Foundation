import { describe, expect, it } from 'vitest'

import { buildWorkspaceLink, workspaceLinkNoteContent, WORKSPACE_LINK_MARKER } from './chatwoot-workspace-link'

describe('buildWorkspaceLink', () => {
  it('builds a clean link from a valid base and customer id', () => {
    expect(buildWorkspaceLink('https://isola-lumen.saas00.epic.dm', 42)).toBe(
      'https://isola-lumen.saas00.epic.dm/customer/42',
    )
  })

  it('strips a trailing slash on the base', () => {
    expect(buildWorkspaceLink('https://isola-lumen.saas00.epic.dm/', 42)).toBe(
      'https://isola-lumen.saas00.epic.dm/customer/42',
    )
  })

  it('refuses when the base is unset', () => {
    expect(buildWorkspaceLink(undefined, 42)).toBeNull()
    expect(buildWorkspaceLink('', 42)).toBeNull()
    expect(buildWorkspaceLink('   ', 42)).toBeNull()
  })

  it('refuses a non-http(s) base', () => {
    expect(buildWorkspaceLink('javascript:alert(1)', 42)).toBeNull()
    expect(buildWorkspaceLink('ftp://host', 42)).toBeNull()
  })

  it('refuses a base carrying a query string or fragment, rather than silently absorbing the customer id into it', () => {
    expect(buildWorkspaceLink('https://host?x=1', 42)).toBeNull()
    expect(buildWorkspaceLink('https://host#frag', 42)).toBeNull()
  })

  it('refuses a malformed base', () => {
    expect(buildWorkspaceLink('not a url', 42)).toBeNull()
  })

  it('refuses a non-positive or non-integer customer id', () => {
    expect(buildWorkspaceLink('https://host', 0)).toBeNull()
    expect(buildWorkspaceLink('https://host', -1)).toBeNull()
    expect(buildWorkspaceLink('https://host', 1.5)).toBeNull()
  })
})

describe('workspaceLinkNoteContent', () => {
  it('carries the marker so a redelivered event can recognise its own note', () => {
    const content = workspaceLinkNoteContent('https://host/customer/42')
    expect(content).toContain(WORKSPACE_LINK_MARKER)
    expect(content).toContain('https://host/customer/42')
  })
})
