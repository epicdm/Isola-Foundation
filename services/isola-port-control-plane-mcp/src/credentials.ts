/**
 * credentials.ts
 *
 * Resolves Port API credentials for stdio mode. Hermes strips the env it
 * passes to MCP subprocesses, so credentials may come from files.
 *
 *   PORT_CLIENT_ID_FILE / PORT_CLIENT_SECRET_FILE  (absolute path to a file
 *     holding just the value; trailing newline trimmed)
 *   PORT_CLIENT_ID / PORT_CLIENT_SECRET            (plain env; used only
 *     when the matching *_FILE var is UNSET)
 *
 * If a *_FILE var is set, the file is authoritative: missing/empty/
 * unreadable => that credential is absent (fail closed), with NO fallback
 * to the env var. Values and file contents are never logged or returned;
 * only the source status is reported.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type CredSource = "file" | "env" | "missing" | "file_unreadable_or_empty";

export interface ResolvedCredentials {
  clientId?: string;
  clientSecret?: string;
  sources: { clientId: CredSource; clientSecret: CredSource };
  /** Safe-to-print warnings (paths only, never values). */
  warnings: string[];
}

function resolveOne(
  env: NodeJS.ProcessEnv,
  name: string,
  warnings: string[]
): { value?: string; source: CredSource } {
  const filePath = env[`${name}_FILE`];
  if (filePath !== undefined && filePath !== "") {
    if (!isAbsolute(filePath)) return { source: "file_unreadable_or_empty" };
    try {
      if (process.platform !== "win32") {
        const mode = statSync(filePath).mode;
        if (mode & 0o077) {
          warnings.push(`credential file ${filePath} is group/world accessible (mode ${(mode & 0o777).toString(8)}); chmod 600 it`);
        }
      }
      const value = readFileSync(filePath, "utf8").replace(/[\r\n]+$/, "");
      if (!value) return { source: "file_unreadable_or_empty" };
      return { value, source: "file" };
    } catch {
      return { source: "file_unreadable_or_empty" };
    }
  }
  const envVal = env[name];
  if (envVal) return { value: envVal, source: "env" };
  return { source: "missing" };
}

export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): ResolvedCredentials {
  const warnings: string[] = [];
  const id = resolveOne(env, "PORT_CLIENT_ID", warnings);
  const secret = resolveOne(env, "PORT_CLIENT_SECRET", warnings);
  return {
    clientId: id.value,
    clientSecret: secret.value,
    sources: { clientId: id.source, clientSecret: secret.source },
    warnings
  };
}
