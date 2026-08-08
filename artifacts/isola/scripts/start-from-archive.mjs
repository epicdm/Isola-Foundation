/**
 * start-from-archive.mjs — unpack the shipped runtime payload, then run it.
 *
 * The deployment ships Isola's runtime as ONE file, `.deploy/isola-runtime.bin`,
 * because a directory tree containing `node_modules` and `.next` does not
 * survive Replit's `.replitignore` filtering into the runtime container — see
 * `payload-archive.mjs` for the evidence. This is the other half: extract that
 * file and start the extracted server.
 *
 * Extraction is idempotent and happens once per container. It is deliberately
 * NOT skipped when the target already exists — a half-extracted tree from a
 * killed start would otherwise be reused and fail confusingly. Extraction of
 * ~2500 files costs a few seconds, which is inside the platform's startup
 * window; correctness is worth more here than shaving that.
 *
 * `execFileSync` is not used: the server must become THIS process's child and
 * inherit its stdio so the platform's log collector sees the app's output, and
 * signals must reach it. `spawn` with `stdio: 'inherit'` gives both.
 */

import { existsSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { paths, unpack } from './payload-archive.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..', '..')
const { archive, runtime } = paths(repoRoot)

const server = join(runtime, 'artifacts', 'isola', 'server.js')

async function main() {
  if (!existsSync(archive)) {
    console.error(
      `start-from-archive: the runtime payload is missing: ${archive}\n` +
        `The build stages it (generate-deploy-staging.mjs) and asserts it exists, so if it is\n` +
        `absent here it did not survive the build-to-runtime boundary. Do not fall back to a\n` +
        `workspace tree: there is no node_modules in this container to fall back to.`,
    )
    process.exit(1)
  }

  // Remove any partial extraction from an interrupted previous start.
  rmSync(runtime, { recursive: true, force: true })

  const started = Date.now()
  const entries = await unpack(archive, runtime)
  console.log(`PAYLOAD_UNPACKED=OK entries=${entries} ms=${Date.now() - started} dir=${runtime}`)

  if (!existsSync(server)) {
    console.error(`start-from-archive: extracted payload has no server at ${server}`)
    process.exit(1)
  }

  const child = spawn(process.execPath, [server], { stdio: 'inherit', env: process.env })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => child.kill(signal))
  }
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}

await main()
