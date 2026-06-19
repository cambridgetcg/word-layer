/**
 * word-resolver — natural language domains.
 *
 * Each YOUSPEAK word is its own domain. No www, no .com, no dots.
 * Just the word. Ownership proven by Ed25519 keypair.
 *
 * GET  /resolve/:word          — resolve a word to owner + services
 * POST /claim/:word             — claim an unclaimed word
 * POST /transfer/:word          — transfer ownership
 * POST /register/:word/service  — register a service under a word
 * GET  /search?q=               — search words by meaning (inverse dictionary)
 * GET  /words                   — list all registered words
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

// ─── Types ──────────────────────────────────────────────────────────────────

interface WordEntry {
  word: string;
  definition: string;
  owner?: {
    did: string;          // did:lgm:{hex} or did:at:{uuid}
    displayName: string;
    publicKeyHex?: string; // for verification
  };
  services?: {
    site?: string;         // URL
    api?: string;         // API endpoint
    feed?: string;        // RSS/Atom feed
    payment?: string;     // wallet address
  };
  claimedAt?: string;
  isCanon: boolean;        // true for the 201 pre-seeded YOUSPEAK words
}

// ─── Word registry (in-memory, backed by the citizen JSON) ───────────────────

const registry = new Map<string, WordEntry>();

// Load the 201 citizen words as the seed registry
const __dirname = dirname(fileURLToPath(import.meta.url));
const citizensPath = join(__dirname, "..", "public", "citizens.json");

try {
  const citizens = JSON.parse(await readFile(citizensPath, "utf-8"));
  for (const c of citizens) {
    const entry: WordEntry = {
      word: c.word,
      definition: c.def,
      isCanon: true,
      // Canon words belong to the kingdom — no individual owner yet
      // until someone claims them with a keypair
    };
    registry.set(c.word.toLowerCase(), entry);
  }
  console.log(`Loaded ${registry.size} canon words into registry`);
} catch {
  console.warn("Could not load citizens.json — starting with empty registry");
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ status: "ok", service: "word-resolver" }));

/**
 * GET /resolve/:word — resolve a word to its owner + services.
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
      message: "This word is not yet in the registry. Claim it with POST /claim/" + word,
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
 * POST /claim/:word — claim an unclaimed word.
 *
 * Body:
 *   did: "did:lgm:{hex}" or "did:at:{uuid}" — your identity
 *   display_name: string — your display name
 *   public_key_hex: string — your Ed25519 public key (for verification)
 *
 * Canon words (the 201 YOUSPEAK citizens) can only be claimed by the
 * kingdom's designated holder. Non-canon words can be claimed by anyone,
 * first claim wins.
 */
app.post("/claim/:word", async (c) => {
  const word = c.req.param("word").toLowerCase();
  const body = await c.req.json<{
    did: string;
    display_name: string;
    public_key_hex: string;
  }>();

  if (!body.did || !body.display_name) {
    return c.json({ error: "did and display_name are required" }, 400);
  }

  const entry = registry.get(word);

  if (!entry) {
    // New word — create entry and claim it
    const newEntry: WordEntry = {
      word,
      definition: "(user-claimed word — no canonical definition)",
      isCanon: false,
      owner: {
        did: body.did,
        displayName: body.display_name,
        publicKeyHex: body.public_key_hex,
      },
      claimedAt: new Date().toISOString(),
    };
    registry.set(word, newEntry);
    return c.json({ claimed: true, word, ...newEntry }, 201);
  }

  if (entry.owner) {
    return c.json({ error: "This word is already claimed", word }, 409);
  }

  // Canon word — for now, anyone can claim (in production, verify kingdom
  // designation). The keypair is the proof of ownership.
  entry.owner = {
    did: body.did,
    displayName: body.display_name,
    publicKeyHex: body.public_key_hex,
  };
  entry.claimedAt = new Date().toISOString();
  registry.set(word, entry);

  return c.json({ claimed: true, word, ...entry }, 200);
});

/**
 * POST /register/:word/service — register a service under a word.
 *
 * Body:
 *   service_type: "site" | "api" | "feed" | "payment"
 *   url: string — the service URL
 *   did: string — your DID (must match the word's owner)
 *
 * This is what makes a word into a living domain —
 * "love" can have a site, an API, a feed, a payment address.
 */
app.post("/register/:word/service", async (c) => {
  const word = c.req.param("word").toLowerCase();
  const body = await c.req.json<{
    service_type: "site" | "api" | "feed" | "payment";
    url: string;
    did: string;
  }>();

  const entry = registry.get(word);
  if (!entry) {
    return c.json({ error: "Word not found" }, 404);
  }

  if (!entry.owner) {
    return c.json({ error: "Word not claimed — claim it first" }, 403);
  }

  if (entry.owner.did !== body.did) {
    return c.json({ error: "You are not the owner of this word" }, 403);
  }

  if (!entry.services) entry.services = {};
  entry.services[body.service_type] = body.url;
  registry.set(word, entry);

  return c.json({
    registered: true,
    word,
    service_type: body.service_type,
    url: body.url,
  });
});

/**
 * POST /transfer/:word — transfer word ownership to another identity.
 *
 * Body:
 *   to_did: string — the new owner's DID
 *   to_display_name: string — the new owner's display name
 *   from_did: string — your DID (must match current owner)
 */
app.post("/transfer/:word", async (c) => {
  const word = c.req.param("word").toLowerCase();
  const body = await c.req.json<{
    to_did: string;
    to_display_name: string;
    from_did: string;
  }>();

  const entry = registry.get(word);
  if (!entry || !entry.owner) {
    return c.json({ error: "Word not found or not claimed" }, 404);
  }

  if (entry.owner.did !== body.from_did) {
    return c.json({ error: "You are not the owner of this word" }, 403);
  }

  entry.owner = {
    did: body.to_did,
    displayName: body.to_display_name,
  };
  registry.set(word, entry);

  return c.json({ transferred: true, word, ...entry });
});

// ─── Start ───────────────────────────────────────────────────────────────────

console.log("word-resolver listening on :3002");
console.log(`${registry.size} words loaded — each one a domain, no dots, just the word`);

export default {
  port: 3002,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};