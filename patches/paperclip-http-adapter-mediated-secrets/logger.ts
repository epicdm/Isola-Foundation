import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import {
  isSecretBearingPath,
  safeSecretRouteLogProps,
  safeSecretRouteError,
  classifyError,
  SAFE_SECRET_ROUTE_MESSAGE,
} from "./secret-route-log-policy.js";

function resolveServerLogDir(): string {
  const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
  if (envOverride) return resolveHomeAwarePath(envOverride);

  const fileLogDir = readConfigFile()?.logging.logDir?.trim();
  if (fileLogDir) return resolveHomeAwarePath(fileLogDir);

  return resolveDefaultLogsDir();
}

const logDir = resolveServerLogDir();
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

export const logger = pino({
  level: "debug",
  redact: [
      // Defence in depth ONLY. Native path redaction cannot reach err.message,
      // err.stack, a cause chain or the top-level msg, so it is not what
      // protects the secrets routes — see secret-route-log-policy.ts. These
      // are fixed paths, never built from user input.
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.value",
      "req.body.secret",
      "req.body.password",
      "req.body.token",
      "req.body.apiKey",
      "req.query.token",
      "req.query.value",
      "reqBody.value",
      "reqBody.secret",
      "reqBody.password",
      "reqBody.token",
    ],
}, pino.transport({
  targets: [
    {
      target: "pino-pretty",
      options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
      level: "info",
    },
    {
      target: "pino-pretty",
      options: { ...sharedOpts, colorize: false, destination: logFile, mkdir: true },
      level: "debug",
    },
  ],
}));

export const httpLogger = pinoHttp({
  logger,
  serializers: {
    // PINO'S DEFAULT `req` SERIALIZER EMITS req.params AND req.query.
    // That is a path into the log record that customProps cannot influence at
    // all, and it is how a canary planted in params reached the emitted bytes
    // even on a 201. On a secrets route the request is described by its ROUTE
    // TEMPLATE and nothing else.
    req(req: any) {
      if (isSecretBearingPath(req.originalUrl ?? req.url)) {
        return { id: req.id, method: req.method, url: req.route?.path ?? "[secrets route]" };
      }
      return (pinoHttp as any).stdSerializers.req(req);
    },
  },
  customLogLevel(_req, res, err) {
    // THE `err` ARGUMENT CANNOT BE REPLACED, ONLY EMPTIED.
    // pino-http selects `err || res.err` AFTER customProps runs, so swapping
    // `res.err` there does not cover an error delivered via `res.on("error")`.
    // This hook does receive that object and runs before serialisation, so on
    // a secrets route its message, stack and own properties are overwritten in
    // place. Mutating it is safe: it is about to be logged and discarded, and
    // it is neither the request nor the response.
    if (err && isSecretBearingPath((_req as any).originalUrl ?? _req.url)) {
      try {
        (err as any).message = SAFE_SECRET_ROUTE_MESSAGE;
        (err as any).stack = `${(err as any).name ?? "Error"}: ${SAFE_SECRET_ROUTE_MESSAGE}`;
        for (const k of Object.keys(err as any)) {
          if (k !== "name") delete (err as any)[k];
        }
        // `cause` from `new Error(msg, { cause })` is NON-ENUMERABLE, so the
        // loop above never sees it — while pino's err serialiser FOLLOWS it.
        // A canary planted in `cause.message` reached the emitted bytes until
        // this was added. Clear it explicitly, with defineProperty as the
        // fallback when the property is not configurable.
        try {
          delete (err as any).cause;
        } catch {
          /* fall through to defineProperty below */
        }
        if ("cause" in (err as any)) {
          try {
            Object.defineProperty(err, "cause", {
              value: undefined,
              enumerable: false,
              configurable: true,
            });
          } catch {
            /* the res.err swap in customProps still applies */
          }
        }
      } catch {
        // A frozen error cannot be emptied; the res.err swap in customProps and
        // the route-aware req serializer still apply.
      }
    }
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    // `req.url` CARRIES THE QUERY STRING. On a secrets route that alone puts
    // `?value=<secret>` into the top-level `msg`, which no redact path
    // protects. pino-http uses this success path for any response WITHOUT an
    // error object — including a 400 or 409 — so this is not only the 2xx
    // case. Found by review of dc614d2.
    if (isSecretBearingPath((req as any).originalUrl ?? req.url)) {
      return `${req.method} ${(req as any).route?.path ?? "[secrets route]"} ${res.statusCode}`;
    }
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    // The raw error message is NEVER used as the log message on a secrets
    // route: it is the one field most likely to quote the submitted value
    // back ("duplicate secret <value>").
    if (isSecretBearingPath((req as any).originalUrl ?? req.url)) {
      return `${req.method} ${(req as any).route?.path ?? "[secrets route]"} ${res.statusCode} — ${SAFE_SECRET_ROUTE_MESSAGE}`;
    }
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    // SECRETS ROUTES: construct the record from a fixed allowlist and return.
    // Nothing from the body, query, params or error is enumerated, so no
    // nesting, proxy, getter, toJSON or cause chain can smuggle a value out.
    if (isSecretBearingPath((req as any).originalUrl ?? req.url)) {
      const anyReq = req as any;
      const anyRes = res as any;
      if (res.statusCode >= 400 && anyRes.err) {
        // Replace the error pino would serialise (message + stack + cause).
        anyRes.err = safeSecretRouteError(res.statusCode, anyRes.err);
      }
      if (res.statusCode < 400) return { secretsRoute: true };
      return safeSecretRouteLogProps({
        routePath: anyReq.route?.path,
        method: req.method,
        companyId: anyReq.params?.companyId,
        secretId: anyReq.params?.id,
        statusCode: res.statusCode,
        requestId: anyReq.id,
        errorCode: classifyError(anyRes.__errorContext?.error ?? anyRes.err, res.statusCode),
      });
    }
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: ctx.reqBody,
          reqParams: ctx.reqParams,
          reqQuery: ctx.reqQuery,
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = body;
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = params;
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = query;
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
