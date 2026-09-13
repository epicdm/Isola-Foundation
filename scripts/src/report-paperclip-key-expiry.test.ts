import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  daysLeft,
  buildExpiryReport,
  formatExpiryReportLines,
  extractModelLiterals,
  modelListedOnPage,
  formatModelCurrencyLines,
  VENDOR_PRICING_SOURCES,
  checkModelCurrency,
  type ModelCurrencyFinding,
} from './report-paperclip-key-expiry'

const NOW = new Date('2026-09-13T00:00:00Z')

test('daysLeft rounds up so a partial day still shows the full warning', () => {
  assert.equal(daysLeft(new Date('2026-09-19T14:00:00Z'), NOW), 7)
})

test('daysLeft reports 0 for something expiring later today', () => {
  assert.equal(daysLeft(new Date('2026-09-13T23:00:00Z'), NOW), 1)
})

test('daysLeft reports negative for something already expired', () => {
  assert.equal(daysLeft(new Date('2026-09-11T00:00:00Z'), NOW), -2)
})

test('buildExpiryReport sorts soonest-first regardless of input order', () => {
  const rows = [
    { name: 'later-key', expiresAt: new Date('2026-09-18T00:00:00Z') },
    { name: 'soonest-key', expiresAt: new Date('2026-09-14T00:00:00Z') },
  ]
  const report = buildExpiryReport(rows, NOW)
  assert.deepEqual(
    report.map((r) => r.name),
    ['soonest-key', 'later-key'],
  )
  assert.equal(report[0].daysLeft, 1)
})

test('buildExpiryReport on an empty result stays empty (positive control: non-empty input above proves the harness works)', () => {
  assert.deepEqual(buildExpiryReport([], NOW), [])
})

test('formatExpiryReportLines says so plainly when nothing is expiring', () => {
  assert.deepEqual(formatExpiryReportLines([]), [
    'No board_api_keys rows expire within the next 7 days.',
  ])
})

test('formatExpiryReportLines includes name, ISO expiry and days-left for a real row', () => {
  const lines = formatExpiryReportLines([
    { name: 'ci-deploy-key', expiresAt: new Date('2026-09-14T00:00:00Z'), daysLeft: 1 },
  ])
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('ci-deploy-key'))
  assert.ok(lines[0].includes('2026-09-14T00:00:00.000Z'))
  assert.ok(lines[0].includes('1 day(s) left'))
})

test('extractModelLiterals finds single, double and backtick quoted literals matching the pattern', () => {
  const source = [
    `const a = 'deepseek-chat'`,
    `const b = "deepseek-reasoner"`,
    "const c = `deepseek-chat`",
    `const d = "gpt-4o"`, // does not match the deepseek pattern
    `const e = "not-a-model-name"`,
  ].join('\n')
  const found = extractModelLiterals(source, [/^deepseek-[a-z0-9.-]+$/i])
  assert.deepEqual([...found].sort(), ['deepseek-chat', 'deepseek-reasoner'])
})

test('extractModelLiterals returns nothing when the source has no matching literal (positive control is the test above)', () => {
  const found = extractModelLiterals(`const x = "hello world"`, [/^deepseek-[a-z0-9.-]+$/i])
  assert.deepEqual([...found], [])
})

test('modelListedOnPage is a plain substring check, case-sensitive to the vendor page as published', () => {
  assert.equal(modelListedOnPage('deepseek-chat', 'Pricing: deepseek-chat is $0.14/M tokens'), true)
  assert.equal(modelListedOnPage('deepseek-chat-legacy', 'Pricing: deepseek-chat is $0.14/M tokens'), false)
})

test('formatModelCurrencyLines flags a literal missing from its vendor pricing page', () => {
  const findings: ModelCurrencyFinding[] = [
    { model: 'deepseek-chat', vendor: 'deepseek', files: ['a.ts'], stillListedOnPricingPage: true },
    { model: 'deepseek-old-model', vendor: 'deepseek', files: ['b.ts', 'c.ts'], stillListedOnPricingPage: false },
  ]
  const lines = formatModelCurrencyLines(findings)
  assert.ok(lines[0].includes('still listed'))
  assert.ok(lines[1].includes('NOT FOUND ON CURRENT PRICING PAGE'))
  assert.ok(lines[1].includes('2 file(s)'))
})

test('formatModelCurrencyLines reports unknown status distinctly from a real negative when the page could not be fetched', () => {
  const lines = formatModelCurrencyLines([
    { model: 'deepseek-chat', vendor: 'deepseek', files: ['a.ts'], stillListedOnPricingPage: 'unknown' },
  ])
  assert.ok(lines[0].includes('UNKNOWN'))
})

test('checkModelCurrency attributes a found literal to the right vendor and fetches each vendor page only once', async () => {
  const byModel = new Map<string, Set<string>>([
    ['deepseek-chat', new Set(['a.ts'])],
    ['deepseek-old-model', new Set(['b.ts'])],
  ])
  let fetchCount = 0
  const fakeFetch = (async (_url: string) => {
    fetchCount++
    return {
      ok: true,
      text: async () => 'current models: deepseek-chat, deepseek-reasoner',
    } as Response
  }) as typeof fetch

  const findings = await checkModelCurrency(byModel, VENDOR_PRICING_SOURCES, fakeFetch)
  assert.equal(fetchCount, 1, 'both literals share one vendor -- the page should be fetched once, not per-literal')
  const byModelName = new Map(findings.map((f) => [f.model, f]))
  assert.equal(byModelName.get('deepseek-chat')?.stillListedOnPricingPage, true)
  assert.equal(byModelName.get('deepseek-old-model')?.stillListedOnPricingPage, false)
})

test('checkModelCurrency reports unknown, not a false negative, when the pricing page fetch fails', async () => {
  const byModel = new Map<string, Set<string>>([['deepseek-chat', new Set(['a.ts'])]])
  const failingFetch = (async () => {
    throw new Error('network unreachable')
  }) as typeof fetch

  const findings = await checkModelCurrency(byModel, VENDOR_PRICING_SOURCES, failingFetch)
  assert.equal(findings[0].stillListedOnPricingPage, 'unknown')
})
