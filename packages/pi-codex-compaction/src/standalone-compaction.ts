import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENDPOINT = "https://api.openai.com/v1";
const MAX_BYTES = 4 * 1024 * 1024;
type Item = Record<string, unknown>;
const record = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);

/** Only errors with static, locally authored messages may reach notifications. */
export class CompactionError extends Error {}

/** Unlike streamed checkpoints, the standalone result is a complete window.
 * Never prune it to the last compaction item. Tool/configuration declarations
 * are deliberately unsupported in saved windows: replaying stale declarations
 * could undo a later tool removal or visibility change. */
export function validCompactedWindow(value: unknown): value is Item[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1024 ||
      Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) return false;
  const content = (part: unknown, assistant = false): boolean => record(part) && (
    (part.type === (assistant ? "output_text" : "input_text") && typeof part.text === "string") ||
    (!assistant && part.type === "input_image" && (typeof part.image_url === "string" || typeof part.file_id === "string")) ||
    (!assistant && part.type === "input_file" && (typeof part.file_data === "string" || typeof part.file_id === "string" || typeof part.file_url === "string"))
  );
  let checkpoints = 0;
  for (const item of value) {
    if (!record(item)) return false;
    if (item.type === "compaction") {
      if (typeof item.id !== "string" || typeof item.encrypted_content !== "string" ||
          item.encrypted_content.length === 0 || item.encrypted_content.length > 2_000_000) return false;
      checkpoints++;
    } else if (item.type === "message" || item.type === undefined) {
      if (!["user", "assistant", "developer", "system"].includes(String(item.role)) ||
          !(typeof item.content === "string" || (Array.isArray(item.content) &&
            item.content.every(part => content(part, item.role === "assistant"))))) return false;
    } else if (item.type === "reasoning") {
      if (typeof item.id !== "string" || !Array.isArray(item.summary) ||
          !item.summary.every(part => record(part) && part.type === "summary_text" && typeof part.text === "string") ||
          (item.encrypted_content !== undefined && typeof item.encrypted_content !== "string")) return false;
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string" ||
          typeof item[item.type === "function_call" ? "arguments" : "input"] !== "string") return false;
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || !(typeof item.output === "string" ||
          (Array.isArray(item.output) && item.output.every(part => content(part))))) return false;
    } else return false;
  }
  return checkpoints > 0;
}

function parseUsage(value: unknown, model: Model<any>): Usage | undefined {
  if (!record(value)) return;
  const read = record(value.input_tokens_details) ? value.input_tokens_details.cached_tokens ?? 0 : 0;
  const write = record(value.input_tokens_details) ? value.input_tokens_details.cache_write_tokens ?? 0 : 0;
  const { input_tokens: input, output_tokens: output, total_tokens: total } = value;
  if (![input, output, total, read, write].every(v => Number.isSafeInteger(v) && Number(v) >= 0) ||
      Number(read) + Number(write) > Number(input) || Number(total) !== Number(input) + Number(output)) return;
  const usage: Usage = { input: Number(input) - Number(read) - Number(write), output: Number(output),
    cacheRead: Number(read), cacheWrite: Number(write), totalTokens: Number(total),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  calculateCost(model, usage);
  return usage;
}

/** One explicit request, with the current Pi-resolved credential in either auth
 * mode. No backend endpoints, redirects, account switching, or paid retries. */
export async function requestStandaloneCompaction(ctx: ExtensionContext, input: unknown[], signal: AbortSignal): Promise<{
  output: Item[]; usage: Usage;
}> {
  signal.throwIfAborted();
  const model = ctx.model;
  if (!model || model.provider !== "openai" || model.api !== "openai-responses" || model.baseUrl !== ENDPOINT) {
    throw new CompactionError("Unsupported compaction route");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  signal.throwIfAborted();
  if (!auth.ok || !auth.apiKey || (auth.baseUrl !== undefined && auth.baseUrl !== ENDPOINT)) {
    throw new CompactionError("Current OpenAI credentials are unavailable");
  }
  const headers = new Headers({ Authorization: `Bearer ${auth.apiKey}` });
  for (const source of [model.headers, auth.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
  }
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const body = JSON.stringify({ model: model.id, input });
  if (input.length > 1024 || Buffer.byteLength(body) > MAX_BYTES) throw new CompactionError("Compaction input exceeds the safety limit");
  signal.throwIfAborted();
  const response = await fetch(`${ENDPOINT}/responses/compact`, { method: "POST", headers, body, signal, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    // Never surface response bodies: they can echo transcript or credentials.
    throw new CompactionError(`Compaction endpoint returned HTTP ${response.status}`);
  }
  if (!response.body) throw new CompactionError("Compaction response has no body");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new CompactionError("Compaction response exceeds the safety limit");
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(data) || data.object !== "response.compaction" || typeof data.id !== "string" ||
      !validCompactedWindow(data.output)) throw new CompactionError("Invalid compaction window");
  const usage = parseUsage(data.usage, model);
  if (!usage) throw new CompactionError("Invalid compaction usage");
  return { output: data.output, usage };
}
