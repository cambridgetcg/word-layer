# Word Layer for AgentTool Browser

This release sidecar composes the Browser-neutral `word-layer` core with one
local `@agenttool/browser` 0.5 process. It exposes Browser's existing nine
operations and six explicit Word operations over MCP and JSONL:

```text
word_resolve --------\
word_resolve_remote --> word_select -> word_plan -> word_open
                                           \
                                            word_close invalidates Word handles only
```

`word_resolve` accepts caller-supplied, bounded local source documents.
`word_resolve_remote` is a separate opt-in network read from one
caller-chosen HTTPS resolver fixed at process start. No remote resolver is
configured by default, and no tool call accepts or replaces its base URL.
Neither path implies a central catalog or complete inventory of meaning.
Source text, publisher and proof assertions, displayed URLs, resolver
responses, and Browser results are untrusted observations, never instructions.

## Commands

After installing dependencies and building the root package:

```sh
bun run build:core
bun run build
agenttool-word mcp
agenttool-word jsonl
agenttool-word doctor

# A community resolver, fixed for this process:
agenttool-word mcp --word-resolver https://resolver.example/community/

# Explicit shorthand for the current public demo:
agenttool-word mcp --public-resolver
```

The sidecar consumes the exact core artifact in
`vendor/word-layer-0.3.1.tgz`, rather than mounting the repository as a
dependency. When the core version changes, rebuild, test, and deliberately
refresh that artifact and its lock entry together.

Browser launch flags and environment settings are the same process-start
authority controls as `agenttool-browser`. No tool call can widen them, and
this package never downloads a browser.

The generic resolver may also be configured with
`AGENTOOL_WORD_RESOLVER_URL`. It must be an HTTPS base URL without credentials,
query, fragment, controls, or unpaired surrogates; its raw and serialized forms
are each bounded to 8,192 Unicode code points and UTF-8 bytes. The client
appends `/v1/resolve/{word}`, checks that target with a separate
`BrowserNetworkPolicy` instance built from the same process-start authority
configuration, sends no credentials or referrer, requests identity encoding,
follows no redirects, retries nothing, and bounds the request to ten seconds
and the decoded response to one MiB. One resolver client admits at most four
aggregate in-flight reads; an additional call fails immediately with the
stable `remote_resolver_busy` error. MCP request cancellation and Word-session
closure are both propagated into an admitted read.
The exact word is disclosed to the configured resolver. As with Browser's
documented policy, `public` and `local` authority use DNS preflight
classification, but the result does not pin the eventual address connected by
the separate fetch. `sovereign` authority may skip address classification.
The time-of-check/time-of-use and DNS-rebinding gap therefore remains. This is
a bounded policy layer, not an SSRF sandbox.

A remote document is accepted only when rebuilding bounded source documents
from it and running the pure local resolver reproduces the entire
`word-reference/0.1` response exactly. This rechecks its query, identifiers,
definition hashes, URL rules, ordering, ambiguity counts,
`automatic_selection: false`, `selection: null`, and untrusted state. It does
not establish the resolver's identity, completeness, truth, or safety.

The current JSONL version is exactly `agenttool-word-jsonl/0.2`; the released
`agenttool-word-jsonl/0.1` schema remains packaged as immutable history. Each
request is one strict JSON object with `version`, `id`, `method`, and optional
`params`.
Requests are sequential and neither requests nor responses may exceed one
MiB. Results are never truncated.

## Selection boundary

`word_resolve` returns plural meaning records and opaque choice handles without
calling Browser or the network. `word_resolve_remote` performs only the
explicit fixed-resolver read and then returns the same local handoff offer; it
does not call Browser. `word_select` consumes one choice handle. `word_plan`
consumes the resulting selection only after Browser produces a zero-effect
`new_tab` plan. `word_open` consumes its one-shot handle before attempting one
Browser open. After resolution, none of these stages accepts a URL.

`word_close` invalidates Word handles but leaves raw Browser operations
available. `browser_close`, process shutdown, input EOF, and MCP transport
closure invalidate Word handles and close the shared Browser.

The composed MCP server intentionally retains AgentTool Browser's
`agenttool-browser@0.5.0` identity because Browser owns the base server
builder. Tool enumeration is the capability truth: nine `browser_*` tools and
six `word_*` tools.

This is a local transport integration. It is not OS DNS, an address-bar
handler, a ranking system, federation, persistence, or a hosted Browser
service. A caller may choose the public Word Layer demo, a community resolver,
or no remote resolver. The Browser process and its authority remain local to
the caller.
