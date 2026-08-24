import path from "node:path";
import fs from "node:fs";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { readConfigFile } from "../config-file.js";
import { resolveDefaultLogsDir, resolveHomeAwarePath } from "../home-paths.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import {
  isSecretBearingRequest,
  safeSecretRouteLogProps,
  safeSecretRouteError,
  classifyError,
  SAFE_SECRET_ROUTE_MESSAGE,
} from "./secret-route-log-policy.js";
function resolveServerLogDir() {
    const envOverride = process.env.PAPERCLIP_LOG_DIR?.trim();
    if (envOverride)
        return resolveHomeAwarePath(envOverride);
    const fileLogDir = readConfigFile()?.logging.logDir?.trim();
    if (fileLogDir)
        return resolveHomeAwarePath(fileLogDir);
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
        req(req) {
            if (isSecretBearingRequest(req)) {
                return { id: req.id, method: req.method, url: req.route?.path ?? "[secrets route]" };
            }
            return pinoHttp.stdSerializers.req(req);
        },
    },
    customLogLevel(_req, res, err) {
        if (err && isSecretBearingRequest(_req)) {
            try {
                err.message = SAFE_SECRET_ROUTE_MESSAGE;
                err.stack = `${err.name ?? "Error"}: ${SAFE_SECRET_ROUTE_MESSAGE}`;
                for (const k of Object.keys(err)) {
                    if (k !== "name")
                        delete err[k];
                }
                try {
                    delete err.cause;
                }
                catch { }
                if ("cause" in err) {
                    try {
                        Object.defineProperty(err, "cause", { value: undefined, enumerable: false, configurable: true });
                    }
                    catch { }
                }
            }
            catch { }
        }
        if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
            return "silent";
        }
        if (err || res.statusCode >= 500)
            return "error";
        if (res.statusCode >= 400)
            return "warn";
        return "info";
    },
    customSuccessMessage(req, res) {
        if (isSecretBearingRequest(req)) {
            return `${req.method} ${req.route?.path ?? "[secrets route]"} ${res.statusCode}`;
        }
        return `${req.method} ${req.url} ${res.statusCode}`;
    },
    customErrorMessage(req, res, err) {
        if (isSecretBearingRequest(req)) {
            return `${req.method} ${req.route?.path ?? "[secrets route]"} ${res.statusCode} — ${SAFE_SECRET_ROUTE_MESSAGE}`;
        }
        const ctx = res.__errorContext;
        const errMsg = ctx?.error?.message || err?.message || res.err?.message || "unknown error";
        return `${req.method} ${req.url} ${res.statusCode} — ${errMsg}`;
    },
    customProps(req, res) {
        if (isSecretBearingRequest(req)) {
            if (res.statusCode >= 400 && res.err) {
                res.err = safeSecretRouteError(res.statusCode, res.err);
            }
            if (res.statusCode < 400)
                return { secretsRoute: true };
            return safeSecretRouteLogProps({
                routePath: req.route?.path,
                method: req.method,
                companyId: req.params?.companyId,
                secretId: req.params?.id,
                statusCode: res.statusCode,
                requestId: req.id,
                errorCode: classifyError(res.__errorContext?.error ?? res.err, res.statusCode),
            });
        }
        if (res.statusCode >= 400) {
            const ctx = res.__errorContext;
            if (ctx) {
                return {
                    errorContext: ctx.error,
                    reqBody: ctx.reqBody,
                    reqParams: ctx.reqParams,
                    reqQuery: ctx.reqQuery,
                };
            }
            const props = {};
            const { body, params, query } = req;
            if (body && typeof body === "object" && Object.keys(body).length > 0) {
                props.reqBody = body;
            }
            if (params && typeof params === "object" && Object.keys(params).length > 0) {
                props.reqParams = params;
            }
            if (query && typeof query === "object" && Object.keys(query).length > 0) {
                props.reqQuery = query;
            }
            if (req.route?.path) {
                props.routePath = req.route.path;
            }
            return props;
        }
        return {};
    },
});
//# sourceMappingURL=logger.js.map