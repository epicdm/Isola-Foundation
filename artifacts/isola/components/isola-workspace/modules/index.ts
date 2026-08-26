/**
 * Isola Workspace — module bodies.
 *
 * Every module body in this directory is a PURE PRESENTATIONAL VIEW: props in, markup out. No
 * hooks, no state, no effects, no fetching, no `"use client"`. They render under
 * `renderToStaticMarkup` in a node environment, which is what allows the fourteen states to be
 * asserted over real rendered copy rather than over a claim that the copy is correct.
 *
 * Interactive affordances are `<button type="button">` carrying an `intent` string. Containers
 * bind behaviour to intents; a body never executes anything and never knows what an intent does.
 */

export * from './shared'

export * from './customer/customer-module-view'
export * from './work/work-module-view'
export * from './ai-team/ai-team-module-view'
export * from './today/today-module-view'
export * from './onboarding/onboarding-view'
export * from './phone/phone-module-view'
export * from './billing/billing-module-view'
export * from './unauthorized/unauthorized-module-view'
