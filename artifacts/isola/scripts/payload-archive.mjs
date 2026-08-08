/**
 * payload-archive.mjs — pack and unpack Isola's runtime payload as ONE file.
 *
 * ── Why an archive ─────────────────────────────────────────────────────────
 *
 * Isola's runtime payload is Next.js standalone output, which contains
 * directories literally named `node_modules` and `.next`. `.replitignore`
 * excludes both names, and Replit applies those exclusions to nested paths
 * inside the shipped payload, not just at the repository root. Three publishes
 * demonstrated the same asymmetry: api-server — a single esbuild bundle whose
 * path contains no excluded segment — started and opened its port every time,
 * while isola died before its banner and never opened 23359.
 *
 * `!.deploy` re-inclusion was the last attempt to keep the payload as a
 * directory tree (build b202729). It did not work. `.replitignore` has no
 * official Replit documentation — not in docs.replit.com, not in Context7's
 * Replit corpus, not on the public web — so which ignore dialect it implements,
 * and whether `!` means anything to it, cannot be established from authority.
 *
 * This removes the question instead of answering it. A single file named
 * `.deploy/isola-runtime.bin` contains no path segment any exclusion can match,
 * under ANY ignore dialect. Nothing about its survival depends on undocumented
 * nested-ignore semantics.
 * `decision-require-replit-runtime-image-simulator-2026-08-07`.
 *
 * ── Why a hand-rolled format ───────────────────────────────────────────────
 *
 * `tar` would be one line, and is probably present in the runtime container.
 * "Probably" is what this incident has cost fourteen hours to. This uses only
 * `node:zlib` and `node:fs`, which are guaranteed present because the runtime
 * is node, so the archive cannot fail for a reason we did not verify.
 *
 * Format — gzip over a sequence of records, each:
 *
 *   [4 bytes | uint32be header length][header JSON][payload bytes]
 *
 * header = { p: path, t: 'f'|'d'|'l', m?: mode, s?: size, k?: symlink target }
 *
 * Symlinks are preserved as links rather than materialised: pnpm's standalone
 * output uses 24 RELATIVE links into its own `.pnpm` store, so they resolve
 * inside the extracted tree and duplicating their targets would inflate the
 * payload for nothing.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readlink, symlink, writeFile } from 'node:fs/promises'
import { createGunzip, createGzip } from 'node:zlib'
import { dirname, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { open } from 'node:fs/promises'

/** Depth-first list of every entry under `root`, directories before contents. */
async function walk(root, dir = root, out = []) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)
    const rel = relative(root, full).split('\\').join('/')
    if (entry.isSymbolicLink()) out.push({ p: rel, t: 'l', k: (await readlink(full)).split('\\').join('/') })
    else if (entry.isDirectory()) {
      out.push({ p: rel, t: 'd' })
      await walk(root, full, out)
    } else if (entry.isFile()) {
      const st = await lstat(full)
      out.push({ p: rel, t: 'f', m: st.mode, s: st.size, _full: full })
    }
  }
  return out
}

/** Pack `srcDir` into the single file `archivePath`. */
export async function pack(srcDir, archivePath) {
  const entries = await walk(srcDir)
  const gzip = createGzip({ level: 6 })
  const out = createWriteStream(archivePath)
  const done = pipeline(gzip, out)

  for (const entry of entries) {
    const { _full, ...header } = entry
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8')
    const lenBuf = Buffer.allocUnsafe(4)
    lenBuf.writeUInt32BE(headerBuf.length, 0)
    if (!gzip.write(lenBuf)) await new Promise((r) => gzip.once('drain', r))
    if (!gzip.write(headerBuf)) await new Promise((r) => gzip.once('drain', r))
    if (entry.t === 'f' && entry.s > 0) {
      // Streamed in chunks: the payload is ~2500 files and must not be held in
      // memory all at once.
      const fh = await open(_full, 'r')
      try {
        const buf = Buffer.allocUnsafe(1 << 20)
        let read
        while ((read = (await fh.read(buf, 0, buf.length)).bytesRead) > 0) {
          if (!gzip.write(buf.subarray(0, read))) await new Promise((r) => gzip.once('drain', r))
        }
      } finally {
        await fh.close()
      }
    }
  }
  gzip.end()
  await done
  return entries.length
}

/** Unpack `archivePath` into `destDir`, which is created if absent. */
export async function unpack(archivePath, destDir) {
  await mkdir(destDir, { recursive: true })
  const gunzip = createGunzip()
  createReadStream(archivePath).pipe(gunzip)

  let buffered = Buffer.alloc(0)
  let pending = null // entry awaiting its payload bytes
  let remaining = 0
  let count = 0

  const flushTo = async (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    for (;;) {
      if (pending) {
        if (buffered.length === 0) return
        const take = Math.min(remaining, buffered.length)
        await pending.write(buffered.subarray(0, take))
        buffered = buffered.subarray(take)
        remaining -= take
        if (remaining === 0) {
          await pending.close()
          pending = null
        } else return
        continue
      }
      if (buffered.length < 4) return
      const headerLen = buffered.readUInt32BE(0)
      if (buffered.length < 4 + headerLen) return
      const header = JSON.parse(buffered.subarray(4, 4 + headerLen).toString('utf8'))
      buffered = buffered.subarray(4 + headerLen)
      const target = join(destDir, header.p)
      count += 1
      if (header.t === 'd') {
        await mkdir(target, { recursive: true })
      } else if (header.t === 'l') {
        await mkdir(dirname(target), { recursive: true })
        await symlink(header.k, target).catch((e) => {
          if (e.code !== 'EEXIST') throw e
        })
      } else {
        await mkdir(dirname(target), { recursive: true })
        if (header.s === 0) {
          await writeFile(target, '', { mode: header.m })
          continue
        }
        pending = await open(target, 'w', header.m)
        remaining = header.s
      }
    }
  }

  for await (const chunk of gunzip) await flushTo(chunk)
  if (pending) {
    await pending.close()
    throw new Error('payload-archive: archive ended mid-file — it is truncated')
  }
  if (buffered.length !== 0) throw new Error('payload-archive: trailing bytes — archive is malformed')
  return count
}

export const ARCHIVE_NAME = 'isola-runtime.bin'

/** Where the archive lives, and where it is extracted to, from the repo root. */
export function paths(repoRoot) {
  return {
    archive: resolve(repoRoot, '.deploy', ARCHIVE_NAME),
    runtime: resolve(repoRoot, '.deploy', 'isola-runtime'),
  }
}
