import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(artifactDir, "..", "..");
const deployDir = path.join(repoRoot, ".deploy", "api-server");
const entrypoint = path.join(deployDir, "index.mjs");

/**
 * Stage dist/ into the repo-root .deploy/api-server/ directory the production
 * run command actually points at (.replit-artifact/artifact.toml).
 *
 * Why: esbuild's own log confirmed dist/index.mjs was created during the
 * build phase of real Replit Autoscale builds, yet the runtime container
 * failed with `Error: Cannot find module '.../artifacts/api-server/dist/index.mjs'`
 * (builds 5867f18a, 464d486f/c8331dd1, after the unrelated pnpm-recursion and
 * snapshot_dirty defects were both independently fixed). The mechanism was
 * never confirmed (Replit's own log collector does not expose it), so this
 * does not modify .gitignore or assume that is the cause — it removes the
 * dependency on whichever mechanism is at fault by staging an explicit copy
 * and pointing the run command at that copy instead of dist/ directly.
 * `inc-isola-replit-postbuild-pnpm-store-prune-2026-08-07`.
 */
async function stageDeploy(distDir) {
  await rm(deployDir, { recursive: true, force: true });
  await mkdir(deployDir, { recursive: true });
  await cp(distDir, deployDir, { recursive: true });

  if (!existsSync(entrypoint)) {
    console.error(
      `build.mjs: staged entrypoint is missing after copy: ${entrypoint}\n` +
        `This means the deploy stage itself did not survive being written — ` +
        `stop here rather than shipping a build the runtime cannot start.`,
    );
    process.exit(1);
  }

  console.log(`DEPLOY_STAGING=OK entrypoint=${entrypoint}`);
}

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      // @google-cloud/* deliberately NOT externalized (removed 2026-08-07): it
      // is genuinely imported (src/lib/objectStorage.ts, objectAcl.ts via
      // @google-cloud/storage), has no native bindings, and real Replit
      // Autoscale builds lost externalized runtime dependencies between the
      // build phase completing and the runtime container starting at least
      // once (build 5867f18a). Bundling it removes that dependency on
      // whichever mechanism was responsible.
      // `@google/*`/`googleapis` stay external below — unused today, kept for
      // the same "may be imported later" reason as the rest of this list.
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });

  await stageDeploy(distDir);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
