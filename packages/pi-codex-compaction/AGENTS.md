# pi-codex-compaction Guidelines

Root `AGENTS.md` applies.

## Invariants

- Default automatic `context_management` on for eligible requests; preserve explicit off settings and Pi's standard recovery compactor.
- `/server-compaction now` immediately requests standalone compaction through Pi's public compaction lifecycle, without an injected conversation turn or standard summarizer fallback. Use only the official public endpoint with the current Pi-resolved API key or OAuth credential; never switch credentials, billing modes, or retry automatically. Bound transport and preserve history on failure/cancellation. Preserve and replay the entire returned window, not just its latest encrypted item, and record standalone usage once.
- `/server-compaction next` queues one eligible ordinary request at the minimum threshold without changing the regular configuration. Keep existing branch-local pending/consumed entries compatible; consume only after compatibility/auth checks. Restore normal settings for tool continuations and after failures/cancellations; explicit `on`/`off` or immediate `now` cancels a pending one-shot.
- Enable it only on the official public `openai`/`openai-responses` route for GPT-5/GPT-6 candidates. Do not change providers, credentials, or billing mode.
- Do not restore legacy backend transport, beta headers, compat serializers, or direct-compaction event-bus adapters.
- Stop cache warming only when the actual cached request used automatic compaction. Leave unrelated providers and skipped requests unchanged.
- Adopt only completed, bounded, ordered output. Use `output_item.done`, not `output_item.added`; the terminal output array can be empty.
- Replay the latest checkpoint and its exact output suffix without duplicating the normalized assistant message or dropping later tool results.
- Use one automatic tool adapter: a stable namespace base plus Pi's chronological `additional_tools` updates. Never rewrite system-message history or expose a strategy selector.
- Rebuild the tool base from Pi's effective wire declarations at each compaction boundary. Do not carry an old base through checkpoints; inline-only additions can lose tool availability during the next compacted response.
- Preserve hidden tools and exact function/grammar schemas. Fail closed on ambiguous or unsupported declarations; keep Pi's standard recovery available.
- When automatic adaptation is unavailable or off, replay saved checkpoints with current inline declarations after the checkpoint so existing sessions can recover.
- Keep ordinary response usage on the assistant entry, never duplicate it on the checkpoint.
- Verify retained output through the public provider payload boundary with transport disabled. Do not resolve physical Pi AI files or import its serializer subpaths; packed-load tests must not install or link host peers.
- Bound captured and persisted output, honor cancellation, and never log prompts, credentials, headers, or encrypted content.
- Preserve Pi's standard compactor as a safety net. Do not claim lower cost or latency without measured evidence.

## Validation

```bash
npm run -w packages/pi-codex-compaction check
npm test -w packages/pi-codex-compaction
npm run -w packages/pi-codex-compaction pack:dry-run
```
