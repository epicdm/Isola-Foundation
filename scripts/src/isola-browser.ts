/**
 * Minimal Chrome DevTools Protocol driver for acceptance evidence.
 *
 * Deliberately dependency-free. Playwright is not installed in this monorepo,
 * and adding it would mean a lockfile change plus a native-binary install step
 * that has repeatedly failed on Windows in this repo. Chromium itself IS
 * already present (Playwright's browser cache), so the smallest honest
 * implementation is to drive that binary over CDP with node built-ins.
 *
 * What this is for: proving what a real browser RENDERS. Every read here goes
 * through `document.body.innerText` or a live DOM query on the deployed page,
 * so a check built on it cannot pass from an API response or from source.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where Playwright caches browsers, per platform. Env var wins. */
export function chromiumSearchRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.ISOLA_CHROMIUM_PATH) return [];
  const roots: string[] = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH) roots.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    roots.push(path.join(env.LOCALAPPDATA, "ms-playwright"));
  } else if (process.platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Caches", "ms-playwright"));
  } else {
    roots.push(path.join(os.homedir(), ".cache", "ms-playwright"));
  }
  return roots;
}

const EXECUTABLES = [
  path.join("chrome-win64", "chrome.exe"),
  path.join("chrome-win", "chrome.exe"),
  path.join("chrome-linux", "chrome"),
  path.join("Chromium.app", "Contents", "MacOS", "Chromium"),
];

/**
 * Resolve a Chromium binary, newest build first. Returns null when none is
 * installed — the caller must then report NOT RUN, never a pass.
 */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.ISOLA_CHROMIUM_PATH) {
    return fs.existsSync(env.ISOLA_CHROMIUM_PATH) ? env.ISOLA_CHROMIUM_PATH : null;
  }
  for (const root of chromiumSearchRoots(env)) {
    if (!fs.existsSync(root)) continue;
    const builds = fs
      .readdirSync(root)
      .filter((d) => d.startsWith("chromium-"))
      // Highest build number wins; "chromium-1223" must beat "chromium-1200".
      .sort((a, b) => Number(b.split("-")[1] ?? 0) - Number(a.split("-")[1] ?? 0));
    for (const build of builds) {
      for (const exe of EXECUTABLES) {
        const candidate = path.join(root, build, exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

export interface BrowserSession {
  goto(url: string, opts?: { waitMs?: number }): Promise<void>;
  /** Evaluate in the page and return the JSON value. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Rendered, human-visible text of the current page. */
  innerText(): Promise<string>;
  currentUrl(): Promise<string>;
  screenshot(file: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Launch Chromium and attach to a page target.
 *
 * The profile is a throwaway directory outside the repository, so no cookie
 * jar, storage state or authenticated trace can ever be committed.
 */
export async function launchBrowser(opts: { chromiumPath: string; headless?: boolean }): Promise<BrowserSession> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "isola-browser-"));
  const args = [
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--window-size=1440,1000",
    "about:blank",
  ];
  if (opts.headless !== false) args.unshift("--headless=new");

  const proc: ChildProcess = spawn(opts.chromiumPath, args, { stdio: ["ignore", "ignore", "pipe"] });

  // Chromium prints the DevTools endpoint to stderr once the port is bound.
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("Chromium did not report a DevTools endpoint within 30s")), 30000);
    proc.stderr?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /ws:\/\/[^\s]+/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited before reporting a DevTools endpoint (code ${code})`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as CdpMessage;
    if (msg.id === undefined) return;
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result ?? {});
  });

  function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 60000);
    });
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function evaluate<T>(expression: string): Promise<T> {
    const res = await send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`page evaluate threw: ${res.exceptionDetails.text ?? "unknown"}`);
    }
    return res.result?.value as T;
  }

  return {
    async goto(url, { waitMs = 2500 } = {}) {
      await send("Page.navigate", { url }, sessionId);
      // A single-page app resolves its route after load, so settle on the DOM
      // being non-empty rather than on the navigation event alone.
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        await sleep(400);
        const ready = await evaluate<boolean>(
          "document.readyState === 'complete' && document.body !== null && document.body.innerText.trim().length > 0",
        ).catch(() => false);
        if (ready) break;
      }
      await sleep(waitMs);
    },
    evaluate,
    innerText: () => evaluate<string>("document.body ? document.body.innerText : ''"),
    currentUrl: () => evaluate<string>("location.href"),
    async screenshot(file) {
      const res = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(res.data as string, "base64"));
    },
    async close() {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      proc.kill();
      // Best effort: the profile holds cookies, so remove it rather than
      // leaving an authenticated browser profile on disk.
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Windows sometimes holds a lock briefly; the dir is in the OS temp */
      }
    },
  };
}
