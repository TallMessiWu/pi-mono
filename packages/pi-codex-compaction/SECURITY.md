# Security Policy

Reasoning-effort configuration updates from Pi are accepted only in their
exact bounded shape (`type`, `reasoning: {effort}` with a bounded lowercase
token). On requests that carry `context_management` they are removed and the
latest effort is sent as `reasoning.effort`; elsewhere they stay chronological
across replay. Neither path weakens assistant-output hash verification. Unknown
configuration fields remain fail-closed. If the API rejects compaction together
with such an update (HTTP 400), the extension asks Pi for one more request for
the same turn, without `context_management`; no other failure is retried.

## Supported versions

Security fixes are provided for the latest released version of `pi-codex-compaction`.

## Reporting a vulnerability

Please do not open a public issue for suspected security vulnerabilities.
Report privately through
[GitHub Security Advisories](https://github.com/jvm/pi-mono/security/advisories/new)
or contact the maintainer through GitHub. Include the affected version,
description, reproduction steps, and any suggested mitigation.

## Security model

Pi extensions execute with the permissions of the local user. Install only
trusted packages. This extension enables automatic compaction by default only
for eligible `openai` GPT-5/GPT-6 models on `openai-responses` at the exact
official endpoint `https://api.openai.com/v1`.

Automatic mode and `/server-compaction next` transform ordinary Pi requests;
Pi owns their TLS, transport limits, cancellation, retries, authentication and
credential refresh. Explicit `/server-compaction now` makes one standalone HTTP
request to the exact official `https://api.openai.com/v1/responses/compact` URL.
It uses the current Pi-resolved credential and headers in either auth mode,
rejects base-URL overrides, follows no redirects, and never falls back between
OAuth and API-key billing, providers, or endpoints. Standalone endpoint access
is account-dependent and is not implied by ordinary inference access; neither
auth path has been live-verified for this endpoint. No provider is registered
and no legacy ChatGPT backend endpoint is used.

The standalone operation serializes the stored, context-edited session projection
through the configured provider's public payload boundary with transport blocked.
It does not invoke ordinary request-only extension hooks: request-only redactions
or service-tier transformations are not applied. Treat `now` as an explicit send
of that projected session to OpenAI, not as a replay of another extension's last
transformed HTTP payload. It injects no conversation turn. It uses Pi's public
compaction lifecycle, preserving ordinary `/compact` behavior.

Standalone transport has a 120-second deadline, 4 MiB request/response limits,
1,024-item limits, and no automatic retry. Its response is read incrementally
with an enforced byte bound. Response bodies and arbitrary transport/auth errors
are never displayed or logged; only locally authored safe errors, including HTTP
status numbers, may be shown. Failure/cancellation explicitly cancels Pi's
compaction hook, rather than throwing and silently running its standard summarizer.
Context, branch, model and credential identity are rechecked before adoption.
Standalone usage is attached once to the compaction entry, not a synthetic reply.

## Checkpoints and local data

Raw `response.output_item.done` items are copied, bounded to 1,024 items and
4 MiB total, and adopted only after matching successful stream completion.
Added/partial items are never treated as checkpoints. Unknown output forms,
missing indices, failed streams, and cancellation leave history intact.
Encrypted checkpoint strings are additionally limited to 2 million characters.
The complete persisted details are bounded to 4 MiB.

Standalone output is the complete canonical next context window, not a streamed
checkpoint suffix. It is saved/replayed in order without pruning retained items.
It must contain a valid encrypted compaction item and only supported conversation
items. Retained tool/configuration declarations are rejected: replaying stale
declarations could undo a later tool removal or visibility restriction. Replay
still verifies the retained assistant hash and provider serialization before
substituting the window; current tool declarations are restored afterward.

The checkpoint and its exact post-checkpoint output suffix are sensitive session
data. Provider encryption does not make the surrounding transcript or suffix
public. Neither is logged or sent through install telemetry.

A domain-separated HMAC-SHA-256 binds replay to the current credential, auth
mode, model, endpoint and headers. The provider-issued, high-entropy bearer
credential and potentially secret headers form the HMAC key material and are
never stored in checkpoint details. Only non-secret routing/auth-mode metadata
is used as the HMAC message. This is
credential binding, not storage or verification of user-chosen passwords.
Rotation invalidates replay, including OAuth token refresh. The fallback is
a bounded transcript excerpt, not a complete summary. The original history and
fallback remain subject to the user's Pi session-file permissions and retention.

Replay checks the canonical retained assistant and serialized output
fingerprints. Before adoption, serialization uses the configured provider's
public payload hook and aborts before transport. It uses a non-credential
placeholder, a fetch function that always throws, and zero retries; it does not
resolve real authentication or send an additional inference request. Missing
hooks, serialization errors, or an attempted fetch prevent adoption. No host
filesystem lookup or private serializer imports are required. Omitted, edited,
or transformed messages fall back rather than restoring stale raw content. As with Pi text summaries, edits to already-compacted
source history cannot alter an opaque checkpoint. Legacy checkpoint details are
not migrated or replayed across provider/authentication boundaries.

## Extension composition and recovery

Load this extension after request transformers. Its compatibility check cannot
constrain a later trusted extension that changes the payload. It skips observed
reasoning configuration updates, stateful continuation, truncation, multi-agent
requests, and preexisting compaction policies.

For Pi's inline declarations, the adapter derives a namespace base exclusively
from the provider-serialized, currently visible function/custom tools. It does
not execute tools, broaden Pi's active loadout, read tool definitions from project
files, or invent function/grammar schemas. Only the redundant leading inline
declaration is removed after promotion. Later inline updates and system messages
retain their positions. A changed, removed or hidden base tool starts a new base,
as does Pi's tool-state checkpoint after compaction. Missing, ambiguous, oversized
or unsupported inline state is not opted into automatic compaction.

Checkpoint replay preserves native declaration positions when the namespace
adapter is active. When automatic mode is off or adaptation is unavailable,
current leading inline declarations are moved after the saved checkpoint as a
recovery workaround. That does not repair tool loss inside an already running
response and does not enable an additional inference request.

Cache warming is stopped only for a cached request that actually enabled
automatic compaction, because replay could produce an uncommitted checkpoint.
Other providers and skipped requests retain Pi's normal warming behavior.
Turning automatic mode off still blocks warming the old automatic request until
a new ordinary request replaces it.

The extension does not execute tools, duplicate response usage, or issue an
automatic paid retry after a failed attempt. Pi's standard compaction remains
available. Local success diagnostics contain only a version, elapsed
milliseconds, byte count and output-item count.

No project settings are read. Install telemetry is best-effort, once per
version, with a five-second timeout. It sends only package/version/runtime
metadata and respects CI, `PI_OFFLINE`, `PI_TELEMETRY`, and
`enableInstallTelemetry: false`.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for validation and live-test precautions.
