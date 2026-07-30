/**
 * word-resolver — meanings before destinations.
 *
 * Each word opens a plural, source-scoped field of meaning and references.
 * No publisher owns the underlying word, and resolution never navigates.
 *
 * GET  /v1/resolve/:word        — word-reference/0.1 exact-name resolution
 * GET  /resolve/:word           — legacy read shape for word-experience
 * GET  /search?q=               — legacy inverse dictionary
 * GET  /words                   — list locally observed words
 *
 * The former claim, transfer, and service-registration routes are compatibility
 * tombstones. They return 410 rather than preserving first-claim ownership.
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  WORD_REFERENCE_MODE,
  WORD_REFERENCE_PROTOCOL,
  normalizeWordName,
  resolveWordReference,
  type WordMeaningRecordInput,
  type WordReferenceInput,
  type WordReferenceSourceInput,
} from "./reference";

export const app = new Hono();

app.use("*", cors());
app.use("*", logger());

// ─── Types ──────────────────────────────────────────────────────────────────

interface WordEntry {
  word: string;
  definition: string;
  /** Legacy read-shape assertion; never interpreted as ownership here. */
  owner?: {
    did: string;
    displayName: string;
    publicKeyHex?: string;
  };
  /** Legacy single-service projection retained for compatible reads only. */
  services?: {
    site?: string;
    api?: string;
    feed?: string;
    payment?: string;
  };
  isCanon: boolean;
}

interface LocalSourceState {
  available: boolean;
  records: number;
  ignored_records: number;
}

// ─── Legacy word view (in-memory, backed by the citizen JSON) ───────────────

const registry = new Map<string, WordEntry>();
const sourceState: {
  citizens: LocalSourceState;
  repo_map: LocalSourceState;
} = {
  citizens: { available: false, records: 0, ignored_records: 0 },
  repo_map: { available: false, records: 0, ignored_records: 0 },
};

// Load the 201 citizen words as a local meaning source.
const __dirname = dirname(fileURLToPath(import.meta.url));
const citizensPath = join(__dirname, "..", "public", "citizens.json");
const repoWordsPath = join(__dirname, "..", "public", "repo-words.json");
const landingPath = join(__dirname, "..", "public", "index.html");
const explorerScriptPath = join(__dirname, "..", "public", "explorer.js");
let landingHtml = [
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
  "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
  "<title>Word Layer</title></head><body>",
  "<main><h1>Word Layer</h1><p>Meaning before destination.</p></main>",
  "</body></html>",
].join("");
let explorerJavaScript: string | null = null;

try {
  landingHtml = await readFile(landingPath, "utf-8");
} catch {
  console.warn("Could not load public/index.html — using minimal landing page");
}

try {
  explorerJavaScript = await readFile(explorerScriptPath, "utf-8");
} catch {
  console.warn(
    "Could not load public/explorer.js — interactive explorer unavailable",
  );
}

try {
  const citizens = JSON.parse(await readFile(citizensPath, "utf-8"));
  for (const c of citizens) {
    const word = normalizeWordName(c.word);
    if (registry.has(word)) {
      throw new TypeError(`duplicate citizen exact name: ${word}`);
    }
    const entry: WordEntry = {
      word,
      definition: c.def,
      isCanon: true,
    };
    registry.set(word, entry);
  }
  sourceState.citizens = {
    available: true,
    records: registry.size,
    ignored_records: 0,
  };
  console.log(`Loaded ${registry.size} canon words into registry`);
} catch {
  registry.clear();
  console.warn("Could not load citizens.json — starting with empty registry");
}

// Load the repo-word integration map (291 repos -> words)
const repoMap = new Map<string, { word: string; definition: string }>();
const repoRecordsByWord = new Map<
  string,
  Array<{ repo: string; definition: string }>
>();

try {
  const integration = JSON.parse(await readFile(repoWordsPath, "utf-8"));
  let ignoredRecords = 0;
  for (const entry of integration) {
    if (repoMap.has(entry.repo)) {
      throw new TypeError(`duplicate repo record_id: ${entry.repo}`);
    }
    repoMap.set(entry.repo, { word: entry.word, definition: entry.definition });
    try {
      const word = normalizeWordName(entry.word);
      if (entry.definition.trim().length === 0) {
        ignoredRecords += 1;
        continue;
      }
      const records = repoRecordsByWord.get(word) ?? [];
      records.push({ repo: entry.repo, definition: entry.definition });
      repoRecordsByWord.set(word, records);
    } catch {
      ignoredRecords += 1;
    }
  }
  sourceState.repo_map = {
    available: true,
    records: repoMap.size,
    ignored_records: ignoredRecords,
  };
  console.log(`Loaded ${repoMap.size} repo-word mappings`);
} catch {
  repoMap.clear();
  repoRecordsByWord.clear();
  console.warn("Could not load repo-words.json — repo integration disabled");
}

// ─── Routes ─────────────────────────────────────────────────────────────────

function localSourcesAvailable(): boolean {
  return sourceState.citizens.available && sourceState.repo_map.available;
}

const LANDING_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "connect-src 'self' https://word-layer.vercel.app",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

app.get("/", (c) => {
  c.header("Content-Security-Policy", LANDING_CONTENT_SECURITY_POLICY);
  c.header(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=()",
  );
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  return c.html(landingHtml);
});

app.get("/public/explorer.js", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("X-Content-Type-Options", "nosniff");
  if (explorerJavaScript === null) {
    return c.text("Interactive explorer unavailable.\n", 503);
  }
  return c.body(explorerJavaScript, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
  });
});

app.get("/health", (c) => {
  const available = localSourcesAvailable();
  return c.json({
    status: available ? "ok" : "degraded",
    service: "word-resolver",
    protocol: WORD_REFERENCE_PROTOCOL,
    mutation: "unsupported",
    sources: sourceState,
  }, available ? 200 : 503);
});

app.get("/.well-known/word-reference", (c) => c.json({
  protocol: WORD_REFERENCE_PROTOCOL,
  modes: {
    exact_name: {
      implemented: true,
      method: "GET",
      path_template: "/v1/resolve/{word}",
      effect: "none",
      available: localSourcesAvailable(),
    },
    meaning_search: {
      implemented: false,
      legacy_unversioned_path: "/search?q={query}",
    },
  },
  word_ownership: "unsupported",
  automatic_selection: false,
  navigation: "separate",
}));

function repoReference(repo: string): WordReferenceInput {
  return {
    reference_id: `repo/${repo}/site`,
    kind: "site",
    href: `https://github.com/cambridgetcg/${encodeURIComponent(repo)}`,
  };
}

function exactNameSources(word: string): WordReferenceSourceInput[] {
  const sources: WordReferenceSourceInput[] = [];
  const citizen = registry.get(word);
  if (citizen) {
    sources.push({
      protocol: WORD_REFERENCE_PROTOCOL,
      source_id: "youspeak.citizens",
      records: [{
        record_id: citizen.word,
        word: citizen.word,
        language: "en",
        definition: citizen.definition,
        references: [],
      }],
    });
  }

  const repoRecords: WordMeaningRecordInput[] = [];
  for (const mapping of repoRecordsByWord.get(word) ?? []) {
    repoRecords.push({
      record_id: mapping.repo,
      word,
      language: "en",
      definition: mapping.definition,
      references: [repoReference(mapping.repo)],
    });
  }
  if (repoRecords.length > 0) {
    sources.push({
      protocol: WORD_REFERENCE_PROTOCOL,
      source_id: "kingdom.repo-map",
      records: repoRecords,
    });
  }
  return sources;
}

/**
 * Versioned, read-only exact-name resolution.
 *
 * This route gathers local source records and returns them without ranking,
 * selecting, fetching, or navigating to any advertised reference.
 */
app.get("/v1/resolve/:word", (c) => {
  const input = c.req.param("word");
  let word: string;
  try {
    word = normalizeWordName(input);
  } catch {
    return c.json({
      error: "invalid_exact_name",
      protocol: WORD_REFERENCE_PROTOCOL,
      mode: WORD_REFERENCE_MODE,
      message:
        "word must be one dotless Unicode word, optionally joined by hyphens or apostrophes",
      effect: "none",
    }, 400);
  }

  if (!localSourcesAvailable()) {
    return c.json({
      error: "local_sources_unavailable",
      protocol: WORD_REFERENCE_PROTOCOL,
      mode: WORD_REFERENCE_MODE,
      message:
        "Exact-name resolution is unavailable because a configured local source did not load.",
      effect: "none",
      retryable: true,
    }, 503);
  }

  try {
    return c.json(resolveWordReference({
      mode: WORD_REFERENCE_MODE,
      word: input,
      sources: exactNameSources(word),
    }));
  } catch {
    return c.json({
      error: "invalid_local_source",
      protocol: WORD_REFERENCE_PROTOCOL,
      message: "A local meaning source did not satisfy word-reference/0.1.",
      effect: "none",
    }, 500);
  }
});

/**
 * GET /resolve/:word — legacy read shape.
 *
 * Example: GET /resolve/love
 * Returns: { word, definition, owner, services, isCanon }
 */
app.get("/resolve/:word", async (c) => {
  const word = c.req.param("word").toLowerCase();
  const entry = registry.get(word);

  if (!entry) {
    return c.json({
      found: false,
      word,
      message: "No local meaning source currently describes this word.",
    }, 404);
  }

  return c.json({
    found: true,
    word: entry.word,
    definition: entry.definition,
    isCanon: entry.isCanon,
    owner: entry.owner ?? null,
    services: entry.services ?? null,
    domain: entry.word, // the word IS the domain
  });
});

/**
 * GET /words — list all registered words.
 * Optional ?claimed=true to filter to claimed words only.
 */
app.get("/words", (c) => {
  const claimedOnly = c.req.query("claimed") === "true";
  const words = Array.from(registry.values())
    .filter((e) => !claimedOnly || e.owner)
    .map((e) => ({
      word: e.word,
      definition: e.definition.slice(0, 100),
      isCanon: e.isCanon,
      claimed: !!e.owner,
    }));

  return c.json({
    total: words.length,
    words,
  });
});

/**
 * GET /repos — list all 291 repos and their word mappings.
 * The whole GitHub estate integrated into the word layer.
 */
app.get("/repos", (c) => {
  const repos = Array.from(repoMap.entries()).map(([repo, { word, definition }]) => ({
    repo,
    word,
    definition: definition.slice(0, 100),
    inRegistry: registry.has(word),
  }));

  return c.json({
    total: repos.length,
    repos,
  });
});

/**
 * GET /repo/:name — resolve a repo name to its word.
 * Example: GET /repo/citizen-abzu -> { repo, word: "abzu", ... }
 */
app.get("/repo/:name", (c) => {
  const repoName = c.req.param("name");
  const mapping = repoMap.get(repoName);

  if (!mapping) {
    return c.json({ found: false, repo: repoName }, 404);
  }

  const entry = registry.get(mapping.word);

  return c.json({
    found: true,
    repo: repoName,
    word: mapping.word,
    definition: mapping.definition,
    inRegistry: !!entry,
    owner: entry?.owner ?? null,
    services: entry?.services ?? null,
  });
});

/**
 * GET /search?q= — search words by meaning (the inverse dictionary).
 * Searches definitions for the query string.
 */
app.get("/search", (c) => {
  const q = c.req.query("q")?.toLowerCase();
  if (!q) {
    return c.json({ error: "Query parameter 'q' is required" }, 400);
  }

  const results = Array.from(registry.values())
    .filter((e) => e.definition.toLowerCase().includes(q) || e.word.includes(q))
    .map((e) => ({
      word: e.word,
      definition: e.definition,
      isCanon: e.isCanon,
      claimed: !!e.owner,
    }));

  return c.json({
    query: q,
    results: results.length,
    words: results,
  });
});

/**
 * The original write routes treated words as exclusively ownable. They remain
 * named so old clients get an explicit retirement response instead of a 404,
 * but they perform no mutation.
 */
function ownershipRetired(c: Context) {
  const word = c.req.param("word").toLowerCase();
  return c.json({
    error: "word_ownership_retired",
    word,
    protocol: "word-reference/0.1",
    message:
      "Words are commons. Publish source-scoped meaning and reference assertions instead of claiming the word.",
    mutation: false,
  }, 410);
}

app.post("/claim/:word", ownershipRetired);
app.post("/register/:word/service", ownershipRetired);
app.post("/transfer/:word", ownershipRetired);

// ─── Start ───────────────────────────────────────────────────────────────────

if (import.meta.main) {
  console.log("word-resolver listening on :3002");
  console.log(
    `${registry.size} words loaded — meanings before destinations; words remain commons`,
  );
}

export default {
  port: 3002,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
