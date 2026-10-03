import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import {
  ValidationError,
  assert,
  enumValue,
  text,
  validateSchema,
} from "./validate.mjs";

const MAX_BODY = 1024 * 1024;
const TIMEOUT_MS = 90000;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function headers(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== "string" || origin === "null") return false;
  try {
    const expected = new URL(
      `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`,
    ).origin;
    return (
      new URL(origin).origin === expected &&
      new URL(origin).pathname === "/" &&
      !new URL(origin).search &&
      !new URL(origin).hash
    );
  } catch {
    return false;
  }
}

async function readBody(req, signal) {
  const length = req.headers["content-length"];
  if (length && Number(length) > MAX_BODY) {
    req.resume();
    throw new HttpError(413, "请求内容过大，请限制在 1 MB 以内。");
  }
  if (
    !/^application\/json(?:\s*;|\s*$)/i.test(req.headers["content-type"] || "")
  ) {
    req.resume();
    throw new HttpError(400, "请发送 JSON 格式的请求。");
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY)
        return fail(new HttpError(413, "请求内容过大，请限制在 1 MB 以内。"));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, "请求必须是有效的 JSON 对象。"));
      }
    };
    const onError = () => fail(new HttpError(400, "请求未完整接收，请重试。"));
    const onAbort = () => fail(signal.reason);
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function liveEndpoint(env) {
  try {
    const url = new URL(
      (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "") +
        "/responses",
    );
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href;
  } catch {
    throw new HttpError(400, "模型服务地址配置无效，请检查 OPENAI_BASE_URL。");
  }
}

function collectOutput(result) {
  if (
    !result ||
    typeof result !== "object" ||
    result.error ||
    (result.status && result.status !== "completed")
  ) {
    throw new HttpError(502, "模型未完成输出，请缩短输入后重试。");
  }
  const pieces = [];
  const annotations = [];
  let offset = 0;
  for (const item of result.output || []) {
    if (item.type === "refusal")
      throw new HttpError(502, "模型未能处理这次请求，请调整输入后重试。");
    if (item.type !== "message") continue;
    if (item.status && item.status !== "completed")
      throw new HttpError(502, "模型输出不完整，请重试。");
    for (const part of item.content || []) {
      if (part.type === "refusal")
        throw new HttpError(502, "模型未能处理这次请求，请调整输入后重试。");
      if (part.type !== "output_text" || typeof part.text !== "string")
        continue;
      if (pieces.length) offset += 1;
      for (const annotation of part.annotations || []) {
        if (annotation.type !== "url_citation") continue;
        try {
          const url = new URL(annotation.url);
          if (!["http:", "https:"].includes(url.protocol)) continue;
          annotations.push({
            type: "url_citation",
            url: url.href,
            title:
              typeof annotation.title === "string"
                ? annotation.title
                : url.hostname,
            ...(Number.isInteger(annotation.start_index)
              ? { start_index: annotation.start_index + offset }
              : {}),
            ...(Number.isInteger(annotation.end_index)
              ? { end_index: annotation.end_index + offset }
              : {}),
          });
        } catch {
          /* Discard malformed links supplied by the model. */
        }
      }
      pieces.push(part.text);
      offset += part.text.length;
    }
  }
  const output = pieces.join("\n");
  if (!output.trim())
    throw new HttpError(502, "模型没有返回可用内容，请重试。");
  return { text: output, annotations };
}

function safeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0)
      result[key] = usage[key];
  }
  return Object.keys(result).length ? result : null;
}

function generator({ mode, model, signal, env, fetchImpl }) {
  return async ({ instructions, input, schema, webSearch = false, demo }) => {
    signal.throwIfAborted();
    if (mode === "demo") {
      const value = typeof demo === "function" ? await demo() : demo;
      const normalized =
        typeof value === "string"
          ? { text: value }
          : value && typeof value.text === "string"
            ? {
                text: value.text,
                ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
              }
            : { text: JSON.stringify(value ?? null), data: value ?? null };
      if (schema) {
        if (!Object.hasOwn(normalized, "data"))
          normalized.data = JSON.parse(normalized.text);
        validateSchema(normalized.data, schema);
      }
      return { ...normalized, annotations: [], usage: null };
    }
    const body = {
      model,
      instructions,
      input,
      store: false,
      max_output_tokens: 4000,
    };
    if (schema)
      body.text = {
        format: { type: "json_schema", name: "result", strict: true, schema },
      };
    if (webSearch) body.tools = [{ type: "web_search" }];
    let response;
    try {
      response = await fetchImpl(liveEndpoint(env), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY.trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "无法连接模型服务，请检查网络和模型服务配置。");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const message =
        response.status === 401 || response.status === 403
          ? "模型服务验证失败，请检查服务端 API 密钥与模型权限。"
          : response.status === 429
            ? "模型服务暂时繁忙或额度不足，请稍后重试。"
            : "模型服务返回错误，请稍后重试。";
      throw new HttpError(502, message);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new HttpError(502, "模型服务返回了无法读取的内容，请重试。");
    }
    let output;
    try {
      output = collectOutput(result);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "模型服务返回的内容格式不正确，请重试。");
    }
    if (schema) {
      try {
        output.data = validateSchema(JSON.parse(output.text), schema);
      } catch {
        throw new HttpError(502, "模型结果不符合预期结构，请重试。");
      }
    }
    return { ...output, usage: safeUsage(result.usage) };
  };
}

async function staticFile(req, res, root) {
  let pathname;
  try {
    pathname = decodeURIComponent(req.url.split("?")[0]);
  } catch {
    throw new HttpError(400, "路径无效。");
  }
  if (
    !pathname.startsWith("/") ||
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.split("/").some((part) => part.startsWith("."))
  )
    throw new HttpError(404, "未找到页面。");
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const type = MIME[path.extname(relative).toLowerCase()];
  if (!type) throw new HttpError(404, "未找到页面。");
  const publicRoot = path.resolve(root, "public");
  const target = path.resolve(publicRoot, relative);
  if (!target.startsWith(publicRoot + path.sep))
    throw new HttpError(404, "未找到页面。");
  try {
    const [actualRoot, actualTarget] = await Promise.all([
      fs.realpath(publicRoot),
      fs.realpath(target),
    ]);
    if (
      !actualTarget.startsWith(actualRoot + path.sep) ||
      !(await fs.stat(actualTarget)).isFile()
    )
      throw new Error();
    const data = await fs.readFile(actualTarget);
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    throw new HttpError(404, "未找到页面。");
  }
}

/** Creates a local application; the entry point chooses the listen address. */
export function createApp({
  project,
  run,
  env = process.env,
  fetchImpl = globalThis.fetch,
}) {
  if (!project?.id || !project?.title || typeof run !== "function")
    throw new TypeError("project and run are required");
  const root = project.root || process.cwd();
  const defaultModel =
    (typeof env.OPENAI_MODEL === "string" && env.OPENAI_MODEL.trim()) ||
    "gpt-6-astra";
  const canLive =
    typeof env.OPENAI_API_KEY === "string" &&
    Boolean(env.OPENAI_API_KEY.trim());
  let active = 0;
  const server = http.createServer(async (req, res) => {
    headers(res);
    try {
      const pathname = req.url.split("?")[0];
      if (req.method === "GET" && pathname === "/api/health")
        return json(res, 200, { ok: true });
      if (req.method === "GET" && pathname === "/api/config")
        return json(res, 200, {
          id: project.id,
          title: project.title,
          canLive,
          model: defaultModel,
        });
      if (pathname === "/api/run" && req.method === "POST") {
        if (!originAllowed(req)) {
          req.resume();
          throw new HttpError(403, "仅允许从本应用页面发起请求。");
        }
        if (active >= 4) {
          req.resume();
          throw new HttpError(429, "同时运行的请求过多，请等待当前任务完成。");
        }
        active += 1;
        const started = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(
          () =>
            controller.abort(
              new HttpError(504, "请求超过 90 秒，请缩短输入后重试。"),
            ),
          TIMEOUT_MS,
        );
        timer.unref();
        const disconnected = () => {
          if (!res.writableEnded)
            controller.abort(new HttpError(499, "请求已取消。"));
        };
        req.once("aborted", disconnected);
        res.once("close", disconnected);
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await Promise.race([
            aborted,
            (async () => {
              const payload = await readBody(req, controller.signal);
              const mode = enumValue(
                payload.mode,
                ["demo", "live"],
                "运行模式",
              );
              const model =
                payload.model === undefined
                  ? defaultModel
                  : text(payload.model, "模型名称", 120);
              assert(!/[\r\n\0]/.test(model), "模型名称无效。");
              if (mode === "live" && !canLive)
                throw new HttpError(
                  400,
                  "请先在服务端 .env 中配置 OPENAI_API_KEY，再使用真实模式。",
                );
              const context = {
                mode,
                model,
                signal: controller.signal,
                generate: generator({
                  mode,
                  model,
                  signal: controller.signal,
                  env,
                  fetchImpl,
                }),
              };
              let result;
              try {
                result = await run(payload, context);
              } catch (error) {
                if (error?.status === 400 && !(error instanceof HttpError))
                  throw new ValidationError(error.message);
                throw error;
              }
              controller.signal.throwIfAborted();
              json(res, 200, {
                data: result,
                meta: {
                  mode,
                  model,
                  durationMs: Math.round(performance.now() - started),
                },
              });
            })(),
          ]);
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", onAbort);
          req.off("aborted", disconnected);
          res.off("close", disconnected);
          active -= 1;
        }
        return;
      }
      if (pathname.startsWith("/api/"))
        throw new HttpError(
          req.method === "GET" ? 404 : 405,
          "接口不存在或请求方式不支持。",
        );
      if (!["GET", "HEAD"].includes(req.method)) {
        req.resume();
        throw new HttpError(405, "请求方式不支持。");
      }
      await staticFile(req, res, root);
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof ValidationError
            ? 400
            : 500;
      json(res, status, {
        error:
          status === 500 ? "服务处理失败，请检查输入后重试。" : error.message,
      });
    }
  });
  server.requestTimeout = TIMEOUT_MS;
  server.headersTimeout = 15000;
  return server;
}
