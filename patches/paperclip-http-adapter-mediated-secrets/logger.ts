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
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
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
