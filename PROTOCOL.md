# Word Reference Protocol 0.1

> `word-reference/0.1` is an abundance-oriented semantic reference overlay.
> It restores meaning and provenance to a name before ordinary web navigation.
> It does not replace DNS, assign ownership of words, rank publishers, select a
> destination, or navigate.

Status: first-slice reference and local Browser handoff contracts. The schemas
are
[`schema/word-reference-source-v0.1.schema.json`](schema/word-reference-source-v0.1.schema.json)
and
[`schema/word-reference-resolution-v0.1.schema.json`](schema/word-reference-resolution-v0.1.schema.json);
the four handoff envelopes share
[`schema/word-browser-handoff-v0.1.schema.json`](schema/word-browser-handoff-v0.1.schema.json).
This document does not claim that a public resolver, an OS resolver, or
browser-address-bar integration is deployed.

## 1. Purpose

DNS resolves hostnames for network transport. `word-reference/0.1` resolves an
exact natural-language name into a plural, source-scoped field of:

- meanings;
- provenance;
- zero or more asserted HTTP(S) references; and
- explicit uncertainty.

Nobody owns the underlying word. Publishing a definition or URL under `love`
does not make a publisher the owner of `love`, exclude another meaning, or make
one URL canonical. Unknown words are not unclaimed inventory.

The protocol is read-only and zero-effect:

```text
word
  -> source-scoped meanings and references
  -> no automatic selection
  -> no navigation
```

## 2. Normative terms

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** describe protocol
requirements.

- **source** — a caller-supplied namespace containing records. `source_id` is
  an assertion, not authenticated identity.
- **record** — one source-scoped account of one word.
- **meaning** — the bounded definition projected from one matching record.
- **reference** — a source-scoped assertion that an absolute HTTP(S) URL is
  relevant to a meaning.
- **publisher assertion** — the optional `asserted_by` value on a reference.
  It is data supplied by a source, not verified authorship.
- **proof assertion** — the optional `proof` value on a reference. Its
  presence does not mean a signature, key, chain, or statement was checked.
- **resolution** — a deterministic, zero-effect projection of matching local
  source records.
- **selection** — a later caller decision outside resolution.

Source labels, publisher assertions, proof assertions, definitions, and
references are untrusted until a separately identified verifier actually
checks the relevant claim. The first slice performs no such verification.

## 3. Operations

Two operations are named and deliberately separate:

| Mode | Meaning | Version 0.1 |
|---|---|---|
| `exact_name` | Match a normalized word exactly against normalized source record words | Implemented contract |
| `meaning_search` | Find words by concepts, definitions, similarity, or another semantic search method | Reserved; not implemented |

An implementation MUST NOT silently turn `exact_name` into substring,
full-text, embedding, synonym, spell-correction, prefix, or fuzzy search.
An implementation receiving `meaning_search` in the first slice MUST return an
unsupported-mode error rather than pretending the result is exact resolution.
The legacy `/search` behavior is not a `word-reference/0.1` meaning-search
implementation.

The anticipated direct module call is:

```ts
resolveWordReference({
  mode: "exact_name",
  word: " Love ",
  sources: [sourceDocument],
});
```

The module returns the resolution shape in section 7. Calling it MUST NOT read
the network, check DNS, verify a proof, mutate a registry, choose a reference,
start a browser, or open a page.

## 4. Bounds

Bounds are part of the wire contract, not implementation suggestions.
Implementations MAY impose lower aggregate resource limits if they report that
fact and do not silently truncate a valid record.

| Field or collection | Bound |
|---|---:|
| raw query input | 1–256 Unicode code points |
| normalized query or record word | 1–128 Unicode code points |
| `source_id`, `record_id`, `reference_id` | 1–256 ASCII characters |
| language tag | 1–64 ASCII characters |
| reference kind | 1–64 ASCII characters |
| imported `verification` or `trust` assertion | 1–64 Unicode code points when present |
| definition | 1–8,192 Unicode code points |
| HTTP(S) URL | 1–8,192 Unicode code points |
| publisher assertion | 1–2,048 Unicode code points, or `null` |
| proof assertion | 1–8,192 Unicode code points, or `null` |
| sources per resolution | 0–16 |
| records per source | 0–512 |
| records per resolution | 0–8,192 |
| references per record/meaning | 0–64 |
| meanings per resolution | 0–8,192 |
| references per resolution | 0–4,096 |
| all source string fields per resolution, including normalization/URL expansion | 0–1,000,000 aggregate Unicode code points |

Identifiers use the conservative ASCII grammar
`[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9])?`. In particular, they
cannot contain `:`, so the derived `meaning_id` has an unambiguous separator.
They remain source-provided coordinates, not identities or security
principals.

All accepted strings MUST contain only Unicode scalar values; unpaired UTF-16
surrogates are invalid.

The aggregate limits are checked before result construction and again for text
growth caused by normalization or WHATWG URL serialization. They prevent the
per-field maxima from multiplying into an unbounded in-memory result. The JSON
schemas express per-document and response structure; the cross-source aggregate
text budget is an algorithmic conformance requirement. Input records,
references, and strings count before deduplication so repeated data cannot be
used to evade the resource budget.

## 5. Name normalization

Exact-name normalization is mechanical, not semantic:

1. require a 1–256-code-point string without C0 controls or DEL;
2. remove leading and trailing ECMAScript whitespace;
3. apply Unicode NFKC normalization;
4. apply locale-independent lowercase mapping; and
5. reject an empty or over-bound result.

The function is applied to the query. Every source record `word` MUST already
equal the function's result: source documents use canonical exact-name form
rather than carrying a second raw spelling. The resolver applies the function
again to validate that invariant. `query.input` preserves the caller's accepted
input. `query.normalized` carries the normalized value used for comparison. A
canonical value is one dotless Unicode word: each segment starts with a Unicode
letter or number, may continue with letters, numbers, or combining marks, and
may be joined only by ASCII hyphen, straight apostrophe, or curly apostrophe.

Normalization MUST NOT:

- remove, insert, or collapse internal whitespace;
- remove punctuation or hyphens;
- strip diacritics;
- transliterate scripts;
- split compounds;
- infer a language;
- expand synonyms; or
- treat a visually similar character as the same character.

Consequently, dotted names, paths, schemes, whitespace-separated prose, and
most punctuation are rejected rather than reinterpreted. Confusable and
homographic names can remain distinct. NFKC and lowercasing are not an
anti-phishing system.

## 6. Source documents

A source document has this public shape:

```json
{
  "protocol": "word-reference/0.1",
  "source_id": "community.love",
  "records": [
    {
      "record_id": "love-care-that-remains",
      "word": "love",
      "language": "en",
      "definition": "Care that remains oriented toward another being.",
      "references": [
        {
          "reference_id": "public-site",
          "kind": "site",
          "href": "https://example.org/love",
          "asserted_by": "did:example:community",
          "proof": "ed25519:asserted-but-not-checked"
        }
      ]
    }
  ]
}
```

`references` may be omitted; omission normalizes to an empty list.
`asserted_by` and `proof` may likewise be omitted; omission normalizes to
`null`. Present publisher and proof assertions are bounded and preserved
exactly; the resolver does not trim, Unicode-normalize, decode, or otherwise
rewrite opaque proof material. A reference kind MUST already match
`[a-z][a-z0-9_-]*`. `site` is the ordinary browser destination kind, but 0.1
preserves other bounded kinds without assigning them semantics.

Identifiers MUST arrive in their canonical ASCII grammar without surrounding
whitespace. Language tags MUST arrive lowercase and match
`[a-z]{2,8}(?:-[a-z0-9]{1,8})*`. Definitions are bounded before and after
normalization, convert CRLF or CR line endings to LF, trim surrounding
whitespace, and apply NFC before their digest is computed.

Every `href` MUST:

- parse as an absolute URL;
- contain no surrounding whitespace;
- use `http:` or `https:`;
- contain a hostname;
- contain no username or password; and
- contain no C0 control or DEL character; and
- fit the URL bound both before parsing and after WHATWG serialization.

A source `href` may use Unicode accepted by the WHATWG URL parser, so the
source schema annotates it as an IRI. The emitted `href` is the parser's
serialized absolute URI form.

Parsing a URL establishes only syntactic eligibility. It does not establish
publisher identity, relevance, safety, availability, TLS validity, public
reachability, or permission to navigate.

Optional source-input `verification` and `trust` strings are import assertions
only. When present they must satisfy their bound and contain no C0 control or
DEL character. A 0.1 resolver MUST NOT inherit them. Every emitted reference
is reset to:

```json
{
  "verification": "unverified",
  "trust": "untrusted"
}
```

Likewise, a `source_id`, `asserted_by`, or `proof` value is not elevated by
being well-formed.

## 7. Resolution response

A resolution is strict JSON with these top-level fields:

```json
{
  "protocol": "word-reference/0.1",
  "mode": "exact_name",
  "query": {
    "input": " Love ",
    "normalized": "love"
  },
  "found": true,
  "meanings": [
    {
      "meaning_id": "community.love:love-care-that-remains",
      "word": "love",
      "language": "en",
      "definition": "Care that remains oriented toward another being.",
      "provenance": {
        "source_id": "community.love",
        "record_id": "love-care-that-remains",
        "definition_sha256": "a686e7454c1b11329ebddaa751d347925c5306766cb6c04d804032e6fe756107"
      },
      "trust": "untrusted",
      "references": [
        {
          "reference_id": "public-site",
          "kind": "site",
          "href": "https://example.org/love",
          "source_id": "community.love",
          "asserted_by": "did:example:community",
          "proof": "ed25519:asserted-but-not-checked",
          "verification": "unverified",
          "trust": "untrusted"
        }
      ]
    }
  ],
  "ambiguity": {
    "meanings": 1,
    "references": 1,
    "automatic_selection": false
  },
  "selection": null
}
```

Field invariants:

- `protocol` is exactly `word-reference/0.1`.
- `mode` is exactly `exact_name`.
- `found` is `true` exactly when `meanings` is non-empty.
- Every meaning's `word` equals `query.normalized`.
- `meaning_id` is `source_id + ":" + record_id`.
- `definition_sha256` is lowercase SHA-256 over the UTF-8 bytes of the emitted
  `definition`, without treating the digest as authenticity proof.
- Every meaning has `trust: "untrusted"`.
- Every emitted reference repeats its containing meaning's `source_id`.
- Every emitted reference has `verification: "unverified"` and
  `trust: "untrusted"`.
- `ambiguity.meanings` equals `meanings.length`.
- `ambiguity.references` equals the sum of nested reference counts.
- `ambiguity.automatic_selection` is always `false`.
- `selection` is always `null`.

An empty result is ordinary:

```json
{
  "protocol": "word-reference/0.1",
  "mode": "exact_name",
  "query": {
    "input": "unknown-word",
    "normalized": "unknown-word"
  },
  "found": false,
  "meanings": [],
  "ambiguity": {
    "meanings": 0,
    "references": 0,
    "automatic_selection": false
  },
  "selection": null
}
```

It MUST NOT suggest a purchase, claim, registration, or default destination.

## 8. Deterministic ordering and deduplication

Determinism uses ascending ECMAScript string comparison and stable canonical
fingerprints, never locale collation, source priority, trust score, popularity,
payment, or arrival time.

1. Record candidates are ordered by `source_id`, then `record_id`, then their
   canonical content fingerprint.
2. Meanings are ordered by `source_id`, then `record_id`.
3. Reference candidates within a meaning are ordered by `reference_id`, then
   their canonical content fingerprint.
4. URLs are parsed with the runtime's WHATWG URL implementation and emitted as
   its absolute `href` serialization before comparison.

Deduplication removes repeated input, not plurality:

- repeated records at the same `(source_id, record_id)` coordinate collapse;
- the same definition from different `source_id` or `record_id` values remains
  separate because its provenance is different;
- repeated references at the same
  `(source_id, record_id, reference_id)` coordinate collapse; and
- the same URL asserted by different sources or records remains separate.

When repeated coordinates carry different normalized content, resolution MUST
reject the input as a conflicting duplicate. It MUST NOT pick a winner.
Canonical fingerprints make duplicate checks independent of source arrival
order; they are not truth, trust, ownership, or ranking decisions.

## 9. Safe AgentTool Browser handoff

Resolution and navigation remain separate operations and trust/policy
boundaries. The safe composition is:

```text
adapter receives exact-name input and resolves internally
  -> plural site offers with opaque choice handles
  -> select exactly one choice handle
  -> a new selection handle
  -> browser_plan for the privately retained absolute HTTP(S) URL
  -> a new one-shot open handle
  -> separate explicit browser_open
  -> consumed before Browser I/O
```

`src/browser-handoff.ts` implements this composition as a process-local
`WordBrowserSession` around an injected AgentTool Browser-compatible object.
It calls the pure resolver directly; resolution and selection do not call
Browser or fetch the network.

The adapter deliberately uses three different bearer-handle stages:

```text
choice --select--> selection --plan--> open --dispatch--> consumed
   \________ expiry or session close invalidates every stage ________/
```

Each successful transition consumes its input handle. All derived handles keep
the original resolution deadline; selecting or planning does not refresh it.
If Browser planning fails, the selection handle remains available for another
explicit attempt because planning has no Browser effect. A successful plan
consumes it. Selecting one reference does not invalidate sibling choices from
the same plural resolution.

The final open handle is consumed synchronously before `AgentBrowser.open()`
begins, so concurrent replay and retry after an uncertain Browser failure
cannot dispatch the same retained intention twice.

An opaque adapter handle:

- is not `reference_id`;
- is unpredictable, process-local, expiring, and bound to one exact
  resolution/meaning/reference tuple;
- MUST NOT let a caller substitute a new URL; and
- is a selection-safety mechanism, not verification, semantic legitimacy,
  destination or account authorization, secrecy, consent, or proof that the
  destination is benign.

While live, these handles are ephemeral bearer capabilities for the next
in-process transition. They SHOULD NOT be logged or disclosed outside the
intended caller/session boundary. The envelope's `authority: "none"` means they
grant no legitimacy to a meaning or publisher, no account authority, and no
expansion of Browser's launch-time authority; it does not mean possession of a
valid handle has no operational effect. `session_id` and `resolution_id` are
coordinates, not authentication.

Only references whose exact kind is `site` receive choice handles. Other typed
references remain visible for future adapters but are not Browser-selectable.
Two sources asserting the same URL still receive different handles: provenance
is not deduplicated merely because the destination matches.

The handoff offer is a separate `word-browser-handoff/0.1` envelope, not a
modified `word-reference/0.1` response. It preserves plural meanings,
provenance, trust state, `selection: null`, and
`automatic_selection: false`. Exact targets are retained in private session
state rather than accepted back from the caller. Displayed URLs omit query and
fragment components, but this is output
minimization rather than a secrecy guarantee: origins and paths are visible,
and Browser's own plan surfaces its redacted target summary. The plan is
returned intact; AgentTool Browser currently preserves the path and fragment
and redacts query values rather than the whole URL.

The ordinary `/v1/resolve/:word` operation still returns full asserted `href`
values as part of `word-reference/0.1`. Choosing the handoff API avoids placing
those values in its initial offer; it cannot retroactively conceal a target
already delivered through the resolver API or already known by the caller.

`browser_plan` is still a zero-effect consequence forecast, not approval.
Planning uses `{ kind: "new_tab", url: retainedHref }`, matching
`AgentBrowser.open()`'s creation of a new tab. The adapter rejects any
caller-supplied target, accepts only the stage handle, and later passes the
exact retained URL serialization to `AgentBrowser.open()` once. AgentTool
Browser retains its existing requirements and boundaries:

- the destination passed to Browser is an absolute HTTP(S) URL;
- Browser authority is fixed at process start;
- URL credentials remain subject to Browser policy;
- public/local/sovereign destination policy remains Browser-owned;
- Browser DNS and request policy still run at execution; and
- Browser remains responsible for surfacing navigation uncertainty.

The Word Layer MUST NOT weaken, bypass, or claim to replace those checks. This
repository now contains the direct TypeScript handoff session and its
acceptance tests plus a private local sidecar in `integrations/agenttool`. The
sidecar composes one handoff session with the exact same AgentTool Browser
instance and exposes Browser's operations plus:

| Operation | Accepted input | Effect |
|---|---|---|
| `word_resolve` | exact-name word and bounded caller-supplied sources | local resolution and capability allocation; no Browser call |
| `word_select` | one opaque choice handle | local one-stage transition |
| `word_plan` | one opaque selection handle | one zero-effect Browser plan |
| `word_open` | one opaque open handle | at most one Browser open attempt |
| `word_close` | empty object | invalidate Word handles only |

After `word_resolve`, no Word operation accepts a URL, `session_id`, or
`resolution_id`. MCP and `agenttool-word-jsonl/0.1` validate these strict
inputs against one operation registry. The JSONL facade also delegates the
current Browser registry, processes requests sequentially, and places no
diagnostics on protocol stdout. `browser_close`, transport closure, input EOF,
or process shutdown closes both layers; `word_close` deliberately leaves raw
Browser operations available.

The composed MCP surface retains AgentTool Browser 0.5's server identity
because Browser owns the base server builder. Its enumerated operation set,
rather than a renamed server, is the capability declaration.

The source model remains caller-supplied local state. The sidecar does not
discover, endorse, rank, or imply completeness of sources. Its MCP guide and
prompt are static instructions only and cannot dispatch an operation.

Handoff offers default to a 256 KiB serialized bound and cannot exceed one
MiB. The bound is checked before capabilities become reachable. A transport
that cannot serialize or deliver an already committed result invalidates the
corresponding resolution rather than leaving invisible handles alive or
silently truncating plurality.

`word-browser-handoff/0.1` is an experimental local wire contract represented
by a strict JSON Schema. Its zero-effect planning guarantee depends on
injecting the real AgentTool Browser implementation: an arbitrary object could
lie while returning
`execution: false`. To keep runtime receipts aligned with that schema, plan
and open outputs MUST be finite, acyclic, plain JSON data; plan data MUST NOT
contain an `href` property at any depth. Invalid plan output preserves the
selection handle. Invalid open output is reported as a failed Browser open
after the one-shot handle has already been spent.

Custom clocks and entropy providers are trusted host/test seams; production
unpredictability depends on the default CSPRNG or an equivalent. `close()`
invalidates outstanding handles but cannot cancel a Browser open already
dispatched. Any returned Browser observation remains untrusted remote content
and may disclose destination details.

Neither the sidecar nor the schema modifies an address bar, installs an OS DNS
handler, persists handles across restarts, federates sources, establishes
trust, or deploys a service.

## 10. Legacy compatibility

The legacy resolver represented a word as one entry with `definition`,
`owner`, and keyed `services`. A compatibility projection MAY keep the legacy
read endpoint while the versioned protocol is adopted, subject to these rules:

- `definition` becomes one source-scoped meaning;
- `owner` is at most an unverified publisher assertion and grants no ownership
  of the word;
- an absolute HTTP(S) `services.site` value may become one `site` reference;
- other legacy service fields remain legacy data until a later version defines
  their projection;
- unknown words remain empty observations, not claim opportunities; and
- legacy output MUST NOT be described as `word-reference/0.1` unless it
  satisfies the resolution schema exactly.

The legacy inverse-dictionary `/search` operation is not `meaning_search`.
Legacy claim, transfer, or service-registration behavior does not define the
abundance model. A future write protocol may carry signed source-scoped
assertions, but it cannot grant exclusive ownership of the word itself.

## 11. Threat and trust boundaries

`word-reference/0.1` deliberately does not solve:

- **source impersonation** — `source_id` is asserted, not authenticated;
- **publisher impersonation** — `asserted_by` is data until verified;
- **false or irrelevant proofs** — `proof` is opaque and unchecked;
- **prompt injection** — all source-supplied strings, including
  `asserted_by`, `proof`, URLs, definitions, and identifiers, plus remote page
  content, are untrusted data, never host or tool instructions;
- **homographs and confusables** — normalization does not establish identity;
- **phishing or malicious sites** — an HTTP(S) URL is not a safety verdict;
- **DNS rebinding, proxy behavior, redirects, or connected-peer identity** —
  these remain within the eventual Browser/network boundary;
- **Sybil publication** — plurality can include many assertions from one actor;
- **ranking capture** — this version has no ranking or default result;
- **freshness, revocation, federation, or durable availability** — the first
  slice uses caller-supplied local source state;
- **authorization or consent** — a reference does not authorize account,
  payment, credential, relationship, or off-platform action; or
- **semantic completeness** — a definition points toward meaning; it does not
  exhaust or monopolize it.

Bounds reduce resource abuse but do not make data trustworthy. Deterministic
ordering makes the same accepted input reproducible; it does not make the
first item preferred.

## 12. Conformance

A conforming first-slice resolver:

1. accepts only `exact_name`;
2. applies the normalization in section 5;
3. validates bounded source records and absolute credential-free HTTP(S)
   references;
4. preserves source-scoped plurality;
5. applies deterministic conflict, ordering, and deduplication rules;
6. emits the strict resolution schema;
7. resets assertion trust and verification state;
8. always emits `automatic_selection: false` and `selection: null`; and
9. performs no verification, network request, mutation, planning, selection,
   or navigation as part of resolution.

A schema-valid response is structural evidence only. It is not evidence that
the inputs were true, the implementation followed this algorithm, or any
reference was safely opened.

Likewise, source-schema validation is structural. JSON Schema patterns do not
express NFKC-plus-lowercase canonical equality, conflict rules, or the
cross-source budget. A source document still requires the semantic validation
in this protocol before it is accepted.
