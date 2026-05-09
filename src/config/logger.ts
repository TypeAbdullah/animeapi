import { env } from "./env.js";
import { pino, type LoggerOptions } from "pino";

const configuredLogLevel = String(process.env.LOG_LEVEL || "").trim().toLowerCase();
const defaultLogLevel = env.isProduction ? "warn" : env.isDev ? "debug" : "info";
const effectiveLogLevel = configuredLogLevel || defaultLogLevel;
const shouldPrettyPrintLogs =
    env.isDev || /^(1|true|yes|on)$/i.test(String(process.env.TATAKAI_LOG_PRETTY || "").trim());

const loggerOptions: LoggerOptions = {
    redact: env.isProduction ? ["hostname", "pid"] : [],
    level: effectiveLogLevel,
    base: env.isProduction ? { service: "tatakai-api" } : undefined,
    transport: shouldPrettyPrintLogs
        ? {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "SYS:hh:MM:ss TT",
                  singleLine: true,
                  levelFirst: true,
                  ignore: "pid,hostname,service",
              },
          }
        : undefined,
    serializers: {
        err(value) {
            if (!value) return value;
            const err = value as Error & { status?: number };
            return {
                name: err.name,
                message: err.message,
                status: err.status,
                stack: env.isProduction ? undefined : err.stack,
            };
        },
    },
    formatters: {
        level(label) {
            return {
                level: label.toUpperCase(),
            };
        },
    },
};

export const log = pino(loggerOptions);

const rateLimitState = new Map<string, number>();

export const logRateLimited = (
    key: string,
    fn: () => void,
    intervalMs = 30000
) => {
    const now = Date.now();
    const last = rateLimitState.get(key) || 0;
    if (now - last < intervalMs) return;
    rateLimitState.set(key, now);
    fn();
};

export const isVerboseLoggingEnabled = !env.isProduction;
