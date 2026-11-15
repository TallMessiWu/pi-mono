import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";

function fixture(modelChanges = {}, flagOverride, thresholdOverride) {
  const handlers = new Map();
  const flags = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  let authCalls = 0;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerFlag: (name, definition) => flags.set(name, definition),
    getFlag: (name) => name === "server-compaction-threshold" && thresholdOverride !== undefined ? thresholdOverride
      : name === "server-compaction" && flagOverride !== undefined ? flagOverride : flags.get(name)?.default,
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    getSettings: () => ({ compaction: { enabled: true, reserveTokens: 8192 } }),
  };
  const ctx = {
    model: { provider: "openai", api: "openai-responses", id: "gpt-6-astra",
      baseUrl: "https://api.openai.com/v1", contextWindow: 100_000, ...modelChanges },
    modelRegistry: {
      async getApiKeyAndHeaders() { authCalls++; return { ok: true, apiKey: "synthetic-test-credential" }; },
      isUsingOAuth: () => true,
    },
    sessionManager: {
      getSessionId: () => "fixture",
      getLeafId: () => "user",
      getBranch: () => entries,
      buildSessionProjection: () => ({ entries: [], messages: [] }),
    },
    hasUI: true,
    ui: { notify: (message) => notices.push(message) },
    waitForIdle: async () => {},
  };
  extension(pi);
  const dispatch = (name, event = {}) => handlers.get(name)?.(event, ctx);
  dispatch("session_start");
  dispatch("turn_start");
  return {
    flags, commands, handlers, entries, dispatch, ctx, notices, authCalls: () => authCalls,
    payload: () => ({ model: ctx.model.id, input: [] }),
    request: (payload) => dispatch("before_provider_request", { payload }),
    warm: () => dispatch("cache_warming_decision", { action: "warm" }),
    toggle: (args) => commands.get("server-compaction").handler(args, ctx),
    context: (names) => dispatch("context_with_system", { messages: [
      { role: "system", content: "Synthetic", timestamp: 0, toolsAdded: names.map(name => ({
        name, description: "Synthetic tool", parameters: { type: "object", properties: {} },
      })) },
    ] }),
  };
}

test("default-on registration uses only the public request pipeline", async () => {
  const h = fixture();
  assert.equal(h.flags.get("server-compaction").default, true);
  assert.deepEqual([...h.flags.keys()].sort(), ["server-compaction", "server-compaction-threshold"]);
  assert.equal(h.handlers.has("before_provider_headers"), false, "no legacy beta header hook");
  const payload = h.payload();
  const result = await h.request(payload);
  assert.deepEqual(result.context_management, [{ type: "compaction", compact_threshold: 55084 }]);
  assert.equal(payload.context_management, undefined);
  assert.equal(result.store, false);
  assert.equal(result.stream, true);
});

  test("automatic adaptation promotes the initial base and preserves later updates without a strategy flag", async () => {
    const h = fixture();
    await h.context(["base", "late", "hidden"]);
    const tool = name => ({ type: "function", name, parameters: { type: "object", properties: {} } });
    const payload = { ...h.payload(), prompt_cache_key: "synthetic-affinity", input: [
      { type: "additional_tools", role: "developer", tools: [tool("base")] },
      { role: "developer", content: "An anchored prompt update" },
      { type: "additional_tools", role: "developer", tools: [tool("late")] },
    ] };
    const before = JSON.stringify(payload);
    const result = await h.request(payload);
    assert.ok(result.context_management);
    assert.deepEqual(result.input, payload.input.slice(1));
    assert.equal(JSON.stringify(payload), before);
    assert.equal(result.prompt_cache_key, payload.prompt_cache_key);
    assert.deepEqual(result.tools[0].tools.map(t => t.name), ["base"]);
    assert.deepEqual(h.warm(), { action: "stop" });
  });
  for (const variant of ["off", "invalid-threshold", "foreign-policy", "foreign-tools"]) {
    test(`automatic inline adaptation leaves ${variant} requests untouched without auth resolution`, async () => {
      const h = fixture({}, variant === "off" ? false : undefined, variant === "invalid-threshold" ? "0" : undefined);
      await h.context(["base"]);
      const payload = { ...h.payload(), input: [{ type: "additional_tools", role: "developer", tools: [
        { type: "function", name: "base", parameters: { type: "object", properties: {} } },
      ] }], ...(variant === "foreign-policy" ? { context_management: [{ type: "compaction", compact_threshold: 9999 }] } : {}),
        ...(variant === "foreign-tools" ? { tools: [{ type: "web_search" }] } : {}) };
      const before = JSON.stringify(payload);
      assert.equal(await h.request(payload), undefined);
      assert.equal(JSON.stringify(payload), before);
      assert.equal(h.authCalls(), 0);
      assert.equal(h.warm(), undefined);
    });
  }

for (const modelChanges of [
  { provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
  { provider: "anthropic", api: "anthropic-messages" },
  { baseUrl: "https://example.com/v1" },
  { api: "openai-completions" },
  { id: "unverified-model" },
]) {
  test(`default-on leaves unrelated route and warming untouched: ${JSON.stringify(modelChanges)}`, async () => {
    const h = fixture(modelChanges);
    assert.equal(await h.request(h.payload()), undefined);
    assert.equal(h.authCalls(), 0);
    assert.equal(h.warm(), undefined);
    await h.toggle("status");
    assert.match(h.notices.at(-1), /unavailable for the current provider\/model/);
  });
}

test("warming follows the actual request, not the default toggle", async () => {
  const h = fixture();
  assert.equal(h.warm(), undefined, "no automatic request was sent");
  await h.request({ ...h.payload(), input: [{ type: "configuration_update", reasoning: { effort: "high" }, unsupported: true }] });
  assert.equal(h.warm(), undefined, "incompatible requests keep their existing warming policy");
  await h.request(h.payload());
  assert.deepEqual(h.warm(), { action: "stop" });
  await h.toggle("off");
  assert.deepEqual(h.warm(), { action: "stop" }, "cached automatic request is still unsafe to warm");
  await h.request(h.payload());
  assert.equal(h.warm(), undefined, "new ordinary request replaces the cached automatic request");
});

test("an explicit false startup flag disables automatic requests and warming interception", async () => {
  const h = fixture({}, false);
  assert.equal(await h.request(h.payload()), undefined);
  assert.equal(h.warm(), undefined);
  assert.equal(h.authCalls(), 0);
});

test("unmapped inline tools skip auth resolution and preserve ordinary cache warming", async () => {
  const h = fixture();
  const payload = { ...h.payload(), input: [{ type: "additional_tools", role: "developer", tools: [] }] };
  assert.equal(await h.request(payload), undefined);
  assert.equal(h.authCalls(), 0);
  assert.equal(h.warm(), undefined);
  await h.request(h.payload());
  assert.deepEqual(h.warm(), { action: "stop" });
  assert.equal(await h.request(payload), undefined);
  assert.equal(h.warm(), undefined, "a new inline-tools request replaces the cached automatic request");
});

for (const position of [0, 1, 2]) {
  test(`inline declaration at input position ${position} preserves history, grammar, Fast and reasoning`, async () => {
    const h = fixture();
    await h.context(["ping"]);
    const input = [{ role: "developer", content: "Synthetic system state" },
      { role: "user", content: "Synthetic user input" }];
    input.splice(position, 0, { type: "additional_tools", role: "developer", tools: [{
      type: "namespace", name: "fixtures", description: "Synthetic tools", tools: [{
        type: "custom", name: "ping", format: { type: "grammar", syntax: "lark", definition: 'start: "PING"' },
      }],
    }] });
    const payload = { ...h.payload(), input, store: true, stream: true, service_tier: "priority",
      reasoning: { effort: "high" } };
    const expected = structuredClone(payload);
    const result = await h.request(payload);
    if (position === 2) {
      assert.ok(result.context_management);
      assert.equal(result.input, payload.input, "Do not remove declarations introduced after user input");
      assert.deepEqual(payload, expected);
      assert.equal(h.authCalls(), 1);
      return;
    }
    assert.ok(result.context_management);
    assert.deepEqual(result.input, input.filter((_, i) => i !== position));
    assert.equal(result.service_tier, "priority");
    assert.deepEqual(result.reasoning, payload.reasoning);
    assert.deepEqual(result.tools, input[position].tools);
    assert.deepEqual(payload, expected);
    assert.equal(h.authCalls(), 1);
    assert.deepEqual(h.warm(), { action: "stop" });
  });
}

test("model switches do not carry an automatic warming veto to another provider", async () => {
  const h = fixture();
  await h.request(h.payload());
  h.ctx.model = { ...h.ctx.model, provider: "anthropic", api: "anthropic-messages" };
  assert.equal(h.warm(), undefined);
  assert.equal(await h.request(h.payload()), undefined);
});

test("now is queued without inference, and status does not consume it", async () => {
  const h = fixture();
  await h.toggle("now");
  assert.equal(h.authCalls(), 0);
  assert.match(h.notices.at(-1), /queued.*next eligible message request/);
  await h.toggle("status");
  assert.match(h.notices.at(-1), /one-shot pending/);
  assert.deepEqual(h.entries.map(e => e.data), [{ pending: true }]);
  await h.request(h.payload());
  await h.toggle("status");
  assert.doesNotMatch(h.notices.at(-1), /one-shot pending/);
});

for (const [flag, startupThreshold] of [[true, "25000"], [false, "25000"], [true, undefined]]) {
  test(`now leaves startup settings unchanged (enabled=${flag}, threshold=${startupThreshold})`, async () => {
    const h = fixture({}, flag, startupThreshold);
    await h.toggle("now");
    const original = h.payload();
    const result = await h.request(original);
    assert.deepEqual(result.context_management, [{ type: "compaction", compact_threshold: 1000 }]);
    assert.equal(original.context_management, undefined, "do not mutate the incoming payload");
    const normal = await h.request(h.payload());
    assert.deepEqual(normal?.context_management, flag ? [{ type: "compaction", compact_threshold:
      startupThreshold === undefined ? 55084 : Number(startupThreshold) }] : undefined);
    assert.equal(h.entries.some(e => e.customType.endsWith(":config")), false);
  });
}

test("now adapts inline tools even when automatic compaction is off", async () => {
  const h = fixture({}, false);
  await h.toggle("now");
  await h.context(["base", "hidden"]);
  const payload = { ...h.payload(), input: [{ type: "additional_tools", role: "developer", tools: [
    { type: "function", name: "base", parameters: { type: "object", properties: {} } },
  ] }] };
  const result = await h.request(payload);
  assert.equal(result.context_management[0].compact_threshold, 1000);
  assert.deepEqual(result.tools[0].tools.map(t => t.name), ["base"]);
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.deepEqual(h.warm(), { action: "stop" });
});

test("now stays pending across missing credentials, warming and standard compaction", async () => {
  const h = fixture({}, false);
  await h.toggle("now");
  const resolve = h.ctx.modelRegistry.getApiKeyAndHeaders;
  h.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false });
  assert.equal(await h.request(h.payload()), undefined);
  assert.deepEqual(h.entries.at(-1).data, { pending: true });
  h.ctx.modelRegistry.getApiKeyAndHeaders = resolve;
  await h.dispatch("agent_end");
  await h.request(h.payload()); // A cache-warming/nested call outside an ordinary turn.
  assert.equal(h.warm(), undefined);
  await h.dispatch("turn_start");
  await h.dispatch("session_before_compact");
  await h.request(h.payload());
  assert.deepEqual(h.entries.at(-1).data, { pending: true });
  await h.dispatch("session_compact");
  const result = await h.request(h.payload());
  assert.equal(result.context_management[0].compact_threshold, 1000);
  assert.deepEqual(h.entries.at(-1).data, { pending: false });
});

for (const args of ["now 1000", "now extra more", "now -1"]) {
  test(`invalid now arguments do not change configuration: ${args}`, async () => {
    const h = fixture({}, false);
    await h.toggle(args);
    assert.match(h.notices.at(-1), /Use \/server-compaction/);
    assert.equal(h.entries.length, 0);
    assert.equal(await h.request(h.payload()), undefined);
  });
}

test("now refuses unsupported routes without arming a request", async () => {
  const h = fixture({ baseUrl: "https://example.com/v1" });
  await h.toggle("now");
  assert.match(h.notices.at(-1), /unavailable for the current provider\/model/);
  assert.equal(h.entries.length, 0);
  assert.equal(h.authCalls(), 0);
});

test("package exports no legacy transport or compat serializer helpers", async () => {
  const exports = await import("../src/index.ts");
  assert.deepEqual(Object.keys(exports).sort(), ["PACKAGE_NAME", "registerAutomaticCompaction"]);
});
