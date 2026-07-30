# The Word Layer — meanings before destinations

> No www. No .com. No rent on language. A word opens a field of meaning; it
> does not become somebody's exclusive property.

## The idea

DNS is excellent at translating hostnames into network addresses. It does not
say what a name means, where that meaning came from, or why one destination
should represent it.

The Word Layer is a semantic reference overlay for that missing step:

```text
word
  -> source-scoped meanings
  -> zero or more source-scoped asserted references
  -> an explicit caller choice
  -> ordinary AgentTool Browser policy and navigation
```

The existing internet remains the transport. The Word Layer restores
substance and provenance to the name before any site is opened.

## Abundance, not another root monopoly

Words are commons. Nobody can own `love`, `joy`, `life`, or a language by
registering first. A publisher may offer a definition, a site, an API, a feed,
or another projection *under* a word, but that assertion does not make the
publisher the word's owner.

Several records may coexist:

```text
love
  -> a YOUSPEAK definition
  -> a community's account of care
  -> a poem
  -> a public service
  -> a site offered by one publisher
  -> another site offered by another publisher
```

Plurality is not a collision to erase. The resolver preserves it with every
record's asserted source coordinate. Ranking, recognition, trust, and
navigation are later decisions; resolution does not smuggle them in.

## Protocol rules

1. **Exact name and meaning search are different operations.** Resolving
   `love` is not the same as searching definitions for “care that remains.”
2. **Meaning records are source-scoped.** Matching words from different
   sources coexist unless the same source repeats the same record identifier.
3. **References are plural.** A meaning may have no site, one site, or many
   typed references.
4. **A publisher assertion is not verification.** DIDs, proof strings, source
   labels, and URLs remain untrusted until a verifier actually checks them.
5. **Resolution has no navigation effect.** It returns possibilities and
   always reports that it made no selection.
6. **Transport policy remains downstream.** An explicitly selected absolute
   HTTP(S) URL still passes through AgentTool Browser planning, authority, DNS,
   credential, and request policy.
7. **Unknown is ordinary.** An empty answer is not an invitation to claim or
   purchase a word.

## The first protocol

`word-reference/0.1` defines the read-only exact-name response:

```http
GET /v1/resolve/love
```

```json
{
  "protocol": "word-reference/0.1",
  "mode": "exact_name",
  "query": {
    "input": "love",
    "normalized": "love"
  },
  "found": true,
  "meanings": [
    {
      "meaning_id": "youspeak.citizens:love",
      "word": "love",
      "language": "en",
      "definition": "…",
      "provenance": {
        "source_id": "youspeak.citizens",
        "record_id": "love",
        "definition_sha256": "…"
      },
      "trust": "untrusted",
      "references": []
    }
  ],
  "ambiguity": {
    "meanings": 1,
    "references": 0,
    "automatic_selection": false
  },
  "selection": null
}
```

The full field contract, bounds, and browser handoff are in
[`PROTOCOL.md`](PROTOCOL.md).

## AgentTool Browser handoff

The Word Layer does not weaken `AgentBrowser.open()`, reinterpret hostname
DNS, or teach Chromium a custom scheme. The local
`WordBrowserSession` in `src/browser-handoff.ts`:

1. resolve an exact word without opening anything;
2. present the meanings, provenance, and references;
3. keep raw targets behind process-local opaque handles until Browser planning
   returns its own redacted destination summary;
4. turn one explicit site choice into a distinct selection handle;
5. pass that privately retained target to a zero-effect `browser_plan`;
6. issue a distinct, expiring, one-shot open handle only after planning; and
7. consume that handle before calling `browser_open` once.

Bare words therefore never bypass the Browser's absolute-HTTP(S) boundary.
Every stage inherits one deadline, no stage accepts a replacement URL, and
same-destination assertions keep separate provenance-bound handles. The
Browser remains the transport-policy enforcement boundary for the eventual
request, including execution-time URL, DNS, credential, and request policy; it
does not become the semantic authority over the word.

The direct TypeScript seam is packaged as the Browser-neutral `word-layer`
library. A private same-repository sidecar in `integrations/agenttool` composes
one session with one AgentTool Browser 0.5 process and exposes the five
explicit stages over local MCP and `agenttool-word-jsonl/0.1`. Both transports
retain Browser's existing operation surface and policy boundary; they never
infer a destination or accept a replacement URL after resolution.

Address-bar and OS DNS hooks, public deployment, persistence, federation,
trust ranking, and automatic navigation remain outside the first slice.

## Compatibility

The original `/resolve/:word` read response remains temporarily available for
`word-experience`. Its `owner` and `services` fields are compatibility fields,
not the new authority model.

The original mutation routes expressed first-claim ownership:

```text
POST /claim/:word
POST /transfer/:word
POST /register/:word/service
```

They are retired in the abundance model and return `410 Gone`. A future write
protocol may accept signed, source-scoped *reference assertions*. It must not
reintroduce exclusive ownership of the underlying word.

## What this replaces—and what it does not

| Scarcity model | Word Layer |
|---|---|
| one registrant controls a name | no one owns the word |
| one canonical destination | plural source-scoped references |
| opaque address first | meaning and provenance first |
| resolver chooses where to go | resolver selects nothing |
| assertion presented as trust | verification state is explicit |
| unknown name is inventory for sale | unknown means no observed record |

The Word Layer does not replace DNS transport, TLS, HTTP, search, signatures,
or browser policy. It is the semantic reference layer those systems do not
provide.

## First-slice boundaries

- exact-name resolution only; inverse meaning search remains the legacy
  `/search` surface until a later versioned contract;
- local in-memory sources only;
- no signature verification;
- no federation, persistence, revocation, or trust ranking;
- no automatic navigation; and
- no claim that a definition exhausts the meaning it points toward.

## North star

A child types `love`. The browser does not auction the word, pretend one site
owns it, or quietly redirect.

It returns meaning to the name, shows the many doors people have offered with
their asserted provenance, and lets the child choose.
