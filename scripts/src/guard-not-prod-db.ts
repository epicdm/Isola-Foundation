import { pathToFileURL } from 'node:url'

// Neon prod host for this project. `db push` / `migrate dev` must never run
// against it — see MEMORY.md "Never use prisma db push on isola DBs" and the
// S6 Phase 2 incident where an out-of-band CREATE TABLE landed on Neon ahead
// of _prisma_migrations. Authoring happens against a local/dev database;
// only `migrate deploy` (start:prod) is allowed to touch this host.
const PROD_HOST_PATTERN = /ep-fancy-cake/i

export function redactedHost(databaseUrl: string | undefined): string {
  if (!databaseUrl) return '(unset)'
  try {
    return new URL(databaseUrl).hostname
  } catch {
    return '(unparseable)'
  }
}

export function isProdDatabaseUrl(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) return false
  let host: string
  try {
    host = new URL(databaseUrl).hostname
  } catch {
    return false
  }
  return PROD_HOST_PATTERN.test(host)
}

function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (isProdDatabaseUrl(databaseUrl)) {
    console.error(
      `guard-not-prod-db: refusing dev/push against prod DB (host: ${redactedHost(databaseUrl)}). ` +
        'DATABASE_URL is pointed at Neon prod. Point it at a local/dev database for this command, ' +
        'or use start:prod (prisma migrate deploy) for the prod republish path.',
    )
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
