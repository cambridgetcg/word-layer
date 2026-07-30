# Word Layer for AgentTool Browser

This release sidecar composes the Browser-neutral `word-layer` core with one
local `@agenttool/browser` 0.5 process. It exposes Browser's existing nine
operations and five explicit meaning-to-navigation stages over MCP and JSONL:

```text
word_resolve -> word_select -> word_plan -> word_open
                                  \
                                   word_close invalidates Word handles only
```

The resolver accepts caller-supplied, bounded local source documents. It does
not imply a central catalog or complete inventory of meaning. Source text,
publisher and proof assertions, displayed URLs, and Browser results are
untrusted observations, never instructions.

## Commands

After installing dependencies and building the root package:

```sh
bun run build:core
bun run build
agenttool-word mcp
agenttool-word jsonl
agenttool-word doctor
```

The sidecar consumes the exact core artifact in
`vendor/word-layer-0.3.0.tgz`, rather than mounting the repository as a
dependency. When the core version changes, rebuild, test, and deliberately
refresh that artifact and its lock entry together.

Browser launch flags and environment settings are the same process-start
authority controls as `agenttool-browser`. No tool call can widen them, and
this package never downloads a browser.

The JSONL version is exactly `agenttool-word-jsonl/0.1`. Each request is one
strict JSON object with `version`, `id`, `method`, and optional `params`.
Requests are sequential and neither requests nor responses may exceed one
MiB. Results are never truncated.

## Selection boundary

`word_resolve` returns plural meaning records and opaque choice handles without
calling Browser. `word_select` consumes one choice handle. `word_plan` consumes
the resulting selection only after Browser produces a zero-effect
`new_tab` plan. `word_open` consumes its one-shot handle before attempting one
Browser open. After resolution, none of these stages accepts a URL.

`word_close` invalidates Word handles but leaves raw Browser operations
available. `browser_close`, process shutdown, input EOF, and MCP transport
closure invalidate Word handles and close the shared Browser.

The composed MCP server intentionally retains AgentTool Browser's
`agenttool-browser@0.5.0` identity because Browser owns the base server
builder. Tool enumeration is the capability truth: nine `browser_*` tools and
five `word_*` tools.

This is a local transport integration. It is not OS DNS, an address-bar
handler, a ranking system, federation, persistence, or a hosted Browser
service. The public Word Layer resolver supplies source-scoped meanings; the
Browser process and its authority remain local to the caller.
