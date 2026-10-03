import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createApp } from "../lib/server.mjs";
import {
  text,
  enumValue,
  objectSchema,
  stringSchema,
  arraySchema,
  validateSchema,
} from "../lib/validate.mjs";

const SECRET = "test-only-not-a-real-api-key";
const schema = objectSchema({
  title: stringSchema(),
  tasks: arraySchema(
    objectSchema({ name: stringSchema(), done: { type: "boolean" } }),
  ),
});
const structured = {
  title: "Plan",
  tasks: [{ name: "First step", done: false }],
};
const complete = (text, annotations = []) => ({
  status: "completed",
  output: [
    { type: "message", content: [{ type: "output_text", text, annotations }] },
  ],
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
});

// OS-assigned ephemeral ports can hit a Fetch-forbidden port on Windows.
// Use a safe high range, retaining collision retries for parallel test runs.
let nextTestPort = 30000 + (process.pid % 10000);
async function listen(server) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = nextTestPort;
    nextTestPort = port === 39999 ? 30000 : port + 1;
    try {
      const listening = once(server, "listening");
      server.listen(port, "127.0.0.1");
      await listening;
      return `http://127.0.0.1:${port}`;
    } catch (error) {
      if (!["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
    }
  }
  throw new Error("No available test port in the safe range 30000–39999.");
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(
  t,
  { run = async () => ({ ok: true }), env = {}, fetchImpl, upstream } = {},
) {
  const tempBase = path.join(os.tmpdir(), "chatgpt-core-test-");
  const root = await fs.mkdtemp(tempBase);
  await fs.mkdir(path.join(root, "public"));
  await fs.writeFile(
    path.join(root, "public", "index.html"),
    "<!doctype html><title>Test</title>",
  );
  await fs.writeFile(
    path.join(root, "public", "app.js"),
    "export const ok=true;",
  );
  await fs.writeFile(path.join(root, "public", ".hidden.json"), SECRET);
  await fs.writeFile(path.join(root, ".env"), SECRET);
  await fs.writeFile(
    path.join(root, "private.json"),
    JSON.stringify({ secret: SECRET }),
  );
  let api;
  if (upstream) {
    api = http.createServer(upstream);
    const base = await listen(api);
    env = {
      OPENAI_API_KEY: SECRET,
      OPENAI_MODEL: "test-model",
      OPENAI_BASE_URL: base + "/v1",
      ...env,
    };
  }
  const server = createApp({
    project: { id: "test-app", title: "Test Tool", root },
    run,
    env,
    fetchImpl,
  });
  const url = await listen(server);
  t.after(async () => {
    await close(server);
    if (api) await close(api);
    assert.ok(root.startsWith(tempBase));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    server,
    url,
    get: (route) => fetch(url + route),
    post: (payload = { mode: "demo" }, options = {}) =>
      fetch(url + "/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify(payload),
        ...options,
      }),
    raw: ({
      route = "/api/run",
      method = "POST",
      body = "",
      headers = {},
    } = {}) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          url,
          { method, path: route, headers },
          (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                text: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end(body);
      }),
  };
}

function reply(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

test("config and health expose only public fields; assets carry safe headers", async (t) => {
  const app = await fixture(t, { env: { OPENAI_API_KEY: SECRET } });
  const config = await app.get("/api/config");
  assert.deepEqual(await config.json(), {
    id: "test-app",
    title: "Test Tool",
    canLive: true,
    model: "gpt-6-astra",
  });
  assert.deepEqual(await (await app.get("/api/health")).json(), { ok: true });
  const page = await app.get("/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /script-src 'self';/,
  );
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.match(await page.text(), /Test/);
  const asset = await app.get("/app.js");
  assert.match(asset.headers.get("content-type"), /javascript/);
  const head = await app.raw({ route: "/app.js", method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
});

test("demo text envelope stays usable without any API call or key", async (t) => {
  const app = await fixture(t, {
    fetchImpl: () => {
      throw new Error("Demo must never fetch");
    },
    run: (payload, context) => {
      assert.equal(context.mode, "demo");
      assert.ok(context.signal instanceof AbortSignal);
      return context.generate({
        demo: () => ({
          text: `Echo ${payload.message}`,
          annotations: [],
          usage: null,
        }),
      });
    },
  });
  const response = await app.post({ mode: "demo", message: "hello" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data, {
    text: "Echo hello",
    annotations: [],
    usage: null,
  });
  assert.equal(result.meta.mode, "demo");
  assert.equal(result.meta.model, "gpt-6-astra");
  assert.ok(result.meta.durationMs >= 0);
});

test("demo structured objects are validated and returned in data", async (t) => {
  const app = await fixture(t, {
    run: (_, { generate }) => generate({ schema, demo: structured }),
  });
  const result = await (await app.post()).json();
  assert.deepEqual(result.data.data, structured);
  assert.deepEqual(JSON.parse(result.data.text), structured);
  assert.deepEqual(result.data.annotations, []);
});

test("real HTTP upstream receives Responses API fields, schema, search, and server key", async (t) => {
  let observed;
  const app = await fixture(t, {
    upstream: async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      observed = {
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization,
        body: JSON.parse(raw),
      };
      reply(res, complete(JSON.stringify(structured)));
    },
    run: (_, { generate }) =>
      generate({
        instructions: "Make a plan",
        input: [{ role: "user", content: "Plan this" }],
        schema,
        webSearch: true,
      }),
  });
  const response = await app.post({ mode: "live", model: "chosen-model" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.data.data, structured);
  assert.deepEqual(result.data.usage, {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
  });
  assert.equal(result.meta.model, "chosen-model");
  assert.equal(observed.url, "/v1/responses");
  assert.equal(observed.method, "POST");
  assert.equal(observed.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(observed.body, {
    model: "chosen-model",
    instructions: "Make a plan",
    input: [{ role: "user", content: "Plan this" }],
    store: false,
    max_output_tokens: 4000,
    text: {
      format: { type: "json_schema", name: "result", strict: true, schema },
    },
    tools: [{ type: "web_search" }],
  });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("collects every output message and safe URL citation, ignoring top-level output_text", async (t) => {
  const app = await fixture(t, {
    upstream: (_, res) =>
      reply(res, {
        status: "completed",
        output_text: "Wrong shortcut",
        output: [
          { type: "reasoning", summary: [] },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "One",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/a",
                    title: "Source A",
                    start_index: 0,
                    end_index: 3,
                  },
                ],
              },
            ],
          },
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "Two",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/b",
                    title: "Source B",
                    start_index: 0,
                    end_index: 3,
                  },
                  { type: "url_citation", url: "javascript:alert(1)" },
                ],
              },
            ],
          },
        ],
      }),
    run: (_, { generate }) =>
      generate({ instructions: "Read", input: "Hello" }),
  });
  const result = await (await app.post({ mode: "live" })).json();
  assert.equal(result.data.text, "One\nTwo");
  assert.equal(result.data.annotations.length, 2);
  assert.equal(result.data.annotations[1].start_index, 4);
  assert.equal(result.data.annotations[1].end_index, 7);
});

test("upstream error status and body never leak a key or raw internal message", async (t) => {
  let status = 401;
  const app = await fixture(t, {
    upstream: (_, res) =>
      reply(
        res,
        { error: { message: `${SECRET} sensitive-debug-message` } },
        status,
      ),
    run: (_, { generate }) =>
      generate({ instructions: "Read", input: "Hello" }),
  });
  for (status of [401, 403, 429, 500]) {
    const response = await app.post({ mode: "live" });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.ok(!body.includes(SECRET));
    assert.ok(!body.includes("sensitive-debug-message"));
    assert.ok(JSON.parse(body).error.length > 0);
  }
});

test("refusal, incomplete, empty, malformed JSON and invalid output all fail clearly", async (t) => {
  let result;
  const app = await fixture(t, {
    upstream: (_, res) => reply(res, result),
    run: (_, { generate }) =>
      generate({ instructions: "Read", input: "Hello" }),
  });
  for (result of [
    {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "refusal", refusal: SECRET }] },
      ],
    },
    {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    },
    { status: "completed", output: [] },
    { status: "completed", output: {} },
    "this is not JSON",
  ]) {
    const response = await app.post({ mode: "live" });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.ok(!body.includes(SECRET));
    assert.ok(JSON.parse(body).error);
  }
});

test("structured responses reject malformed, missing, nested wrong-type, and extra fields", async (t) => {
  let output;
  const app = await fixture(t, {
    upstream: (_, res) => reply(res, complete(output)),
    run: (_, { generate }) =>
      generate({ instructions: "Plan", input: "Hello", schema }),
  });
  for (output of [
    "not JSON",
    JSON.stringify({ title: "Missing tasks" }),
    JSON.stringify({ title: "Bad task", tasks: [{ name: "x", done: "yes" }] }),
    JSON.stringify({ ...structured, extra: "unexpected" }),
  ]) {
    const response = await app.post({ mode: "live" });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /结构/);
  }
});

test("missing key fails only live mode; invalid service URL does not leak configuration", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.post()).status, 200);
  const missing = await app.post({ mode: "live" });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /OPENAI_API_KEY/);
  const invalid = await fixture(t, {
    env: {
      OPENAI_API_KEY: SECRET,
      OPENAI_BASE_URL: `https://user:${SECRET}@example.com/v1`,
    },
    run: (_, { generate }) =>
      generate({ instructions: "Read", input: "Hello" }),
  });
  const response = await invalid.post({ mode: "live" });
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes(SECRET));
});

test("network errors and unexpected handler exceptions are sanitized", async (t) => {
  const app = await fixture(t, {
    env: { OPENAI_API_KEY: SECRET },
    fetchImpl: () => {
      throw new Error(SECRET);
    },
    run: (_, { generate }) =>
      generate({ instructions: "Read", input: "Hello" }),
  });
  const network = await app.post({ mode: "live" });
  assert.equal(network.status, 502);
  assert.ok(!(await network.text()).includes(SECRET));
  const faulty = await fixture(t, {
    run: () => {
      throw new Error(SECRET);
    },
  });
  const response = await faulty.post();
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(SECRET));
});

test("same origin and scripts are allowed, cross-origin and null origins are rejected", async (t) => {
  const app = await fixture(t);
  for (const origin of [undefined, app.url]) {
    const response = await app.raw({
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ mode: "demo" }),
    });
    assert.equal(response.status, 200);
  }
  for (const origin of [
    "https://evil.example",
    "null",
    `${app.url}.evil.example`,
    `${app.url}/evil`,
  ]) {
    const response = await app.raw({
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ mode: "demo" }),
    });
    assert.equal(response.status, 403);
  }
});

test("unsafe paths, hidden files and files outside public never expose contents", async (t) => {
  const app = await fixture(t);
  for (const route of [
    "/.env",
    "/../.env",
    "/%2e%2e/private.json",
    "/%2e%2e%2fprivate.json",
    "/..%5cprivate.json",
    "/.hidden.json",
    "/lib/server.mjs",
    "/private.json",
    "/%00.json",
  ]) {
    const response = await app.raw({ route, method: "GET" });
    assert.equal(response.status, 404, route);
    assert.ok(!response.text.includes(SECRET));
  }
  const malformed = await app.raw({ route: "/%XY", method: "GET" });
  assert.equal(malformed.status, 400);
});

test("rejects bad JSON, wrong content type, invalid modes and oversized request bodies", async (t) => {
  const app = await fixture(t);
  for (const body of ["", "{", "[]", "null", "42"]) {
    const response = await app.raw({
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal((await app.raw({ body: "{}" })).status, 400);
  for (const payload of [
    {},
    { mode: "other" },
    { mode: "demo", model: "" },
    { mode: "demo", model: "x\ny" },
  ])
    assert.equal((await app.post(payload)).status, 400);
  const body = JSON.stringify({
    mode: "demo",
    content: "x".repeat(1024 * 1024),
  });
  const declared = await app.raw({
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    body,
  });
  assert.equal(declared.status, 413);
  const chunked = await app.raw({
    headers: {
      "Content-Type": "application/json",
      "Transfer-Encoding": "chunked",
    },
    body,
  });
  assert.equal(chunked.status, 413);
});

test("handler input validation has a useful 400 response", async (t) => {
  const app = await fixture(t, {
    run: (payload) => ({ message: text(payload.message, "消息", 5) }),
  });
  assert.equal((await app.post()).status, 400);
  assert.equal(
    (await app.post({ mode: "demo", message: "too long" })).status,
    400,
  );
  const compatible = await fixture(t, {
    run: () => {
      throw Object.assign(new Error("业务校验失败。"), { status: 400 });
    },
  });
  const response = await compatible.post();
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "业务校验失败。");
});

test(
  "four active jobs are allowed; the fifth gets 429; slots are reused",
  { timeout: 5000 },
  async (t) => {
    let release;
    let count = 0;
    let ready;
    const allStarted = new Promise((resolve) => {
      ready = resolve;
    });
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const app = await fixture(t, {
      run: async () => {
        count++;
        if (count === 4) ready();
        await barrier;
        return "done";
      },
    });
    const pending = Array.from({ length: 4 }, () => app.post());
    try {
      await allStarted;
      const response = await app.post();
      assert.equal(response.status, 429);
      assert.match((await response.json()).error, /请求过多/);
    } finally {
      release();
    }
    const responses = await Promise.all(pending);
    responses.forEach((response) => assert.equal(response.status, 200));
    assert.equal((await app.post()).status, 200);
  },
);

test(
  "client cancellation aborts the downstream fetch signal",
  { timeout: 5000 },
  async (t) => {
    let started;
    let downstreamAborted;
    const called = new Promise((resolve) => {
      started = resolve;
    });
    const cancelled = new Promise((resolve) => {
      downstreamAborted = resolve;
    });
    const app = await fixture(t, {
      env: { OPENAI_API_KEY: SECRET },
      fetchImpl: async (_, { signal }) => {
        started();
        return new Promise((resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              downstreamAborted();
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
      run: (_, { generate }) =>
        generate({ instructions: "Read", input: "Hello" }),
    });
    const controller = new AbortController();
    const pending = app
      .post({ mode: "live" }, { signal: controller.signal })
      .catch((error) => error);
    await called;
    controller.abort();
    await cancelled;
    assert.equal((await pending).name, "AbortError");
    assert.equal((await app.get("/api/health")).status, 200);
  },
);

test("validation helpers enforce nested schemas, enums, lengths and ranges", () => {
  assert.equal(text(" ok ", "文本"), "ok");
  assert.throws(() => text(null));
  assert.throws(() => enumValue("x", ["a"], "选择"));
  assert.deepEqual(validateSchema(structured, schema), structured);
  assert.throws(() =>
    validateSchema({ ...structured, tasks: [{ name: "x" }] }, schema),
  );
  assert.throws(() =>
    validateSchema([1], {
      type: "array",
      items: { type: "integer" },
      minItems: 2,
    }),
  );
  assert.throws(() => validateSchema(0, { type: "number", minimum: 1 }));
  assert.throws(() => validateSchema("long", stringSchema({ maxLength: 2 })));
  assert.equal(validateSchema(null, { type: ["string", "null"] }), null);
});
