# Word Layer

Word Layer is an open reference protocol for resolving a word into plural,
source-scoped meanings and references. A word is a commons, not a scarce name
to claim. Resolution returns observations; it never chooses a winner and never
navigates on the caller's behalf.

```text
word
  -> exact-name resolution
  -> meanings from named sources
  -> references attached to each meaning
  -> explicit caller selection
  -> optional, separately authorized navigation
```

The reference service implements `word-reference/0.1`:

- `GET /health` reports resolver and local-source availability.
- `GET /.well-known/word-reference` describes the supported protocol mode.
- `GET /v1/resolve/:word` returns exact-name, plural resolution.
- `POST /claim/:word` and the former mutation routes return `410 Gone`.

Try the deployed resolver:

```sh
curl https://word-layer.vercel.app/v1/resolve/love
```

The landing page also contains an accessible Meaning Commons Explorer. A
lookup begins only after explicit form submission. It preserves protocol
order and provenance, shows asserted references as non-clickable text, and
never ranks, selects, or opens a destination.

## Principles

- Words cannot be owned by this protocol.
- Sources identify their own assertions.
- Exact-name resolution is deterministic and has no side effects.
- The protocol does not rank, automatically select, or navigate.
- Publisher and proof fields are assertions, not automatic trust.
- Limits and canonicalization are part of the wire contract.

The normative wire contract is in [PROTOCOL.md](./PROTOCOL.md), with design
rationale in [DESIGN.md](./DESIGN.md) and machine-readable JSON Schemas in
[`schema/`](./schema/).

## Library

The TypeScript package exposes the resolver, protocol constants, and the
capability-safe meaning-to-Browser handoff:

```ts
import { resolveWordReference } from "word-layer/reference";

const result = resolveWordReference({
  word: "love",
  sources: [{
    protocol: "word-reference/0.1",
    source_id: "example.dictionary",
    records: [{
      record_id: "love-1",
      word: "love",
      definition: "Care enacted without possession.",
      references: [],
    }],
  }],
});
```

Build and verify with Bun 1.3.5 or newer:

```sh
bun install --frozen-lockfile
bun run ci:all
```

## AgentTool Browser integration

[`integrations/agenttool`](./integrations/agenttool) composes Word Layer with
AgentTool Browser 0.5 over MCP and JSONL. Local `word_resolve` remains pure and
caller-supplied. The separate `word_resolve_remote` operation may read from one
HTTPS resolver chosen when the process starts:

```sh
agenttool-word mcp --word-resolver https://resolver.example/community/

# Explicit demo shorthand; there is no default remote resolver:
agenttool-word mcp --public-resolver
```

The remote operation discloses the exact word to that resolver, follows no
redirects, sends no credentials or referrer, bounds the response, and accepts
it only when the local pure resolver reproduces the complete canonical answer.
The default client permits at most four simultaneous reads. This is
observation, not endorsement: the response remains untrusted and cannot
select, plan, or navigate.

Resolution, selection, planning, and opening remain separate capability
stages. Only the final, explicit open stage can navigate, using Browser
authority fixed when the local process starts.

## License

Apache-2.0.
