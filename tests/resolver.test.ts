import { describe, expect, it } from "bun:test";

import { app } from "../src/index";
import { normalizeWordName } from "../src/reference";

function request(path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, init);
}

describe("word-resolver — health", () => {
  it("serves the protocol landing page", async () => {
    const res = await request("/");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("Meaning before destination.");
    expect(body).toContain("word-reference/0.1");
  });

  it("returns ok", async () => {
    const res = await request("/health");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.service).toBe("word-resolver");
    expect(body.protocol).toBe("word-reference/0.1");
    expect(body.mutation).toBe("unsupported");
    expect(body.sources).toEqual({
      citizens: { available: true, records: 201, ignored_records: 0 },
      repo_map: { available: true, records: 291, ignored_records: 17 },
    });
  });

  it("loads fixtures without silently choosing duplicate coordinates", async () => {
    const citizens = await Bun.file(
      new URL("../public/citizens.json", import.meta.url),
    ).json() as Array<{ word: string }>;
    const repos = await Bun.file(
      new URL("../public/repo-words.json", import.meta.url),
    ).json() as Array<{ repo: string }>;
    const citizenCoordinates = citizens.map((entry) =>
      normalizeWordName(entry.word)
    );
    const repoCoordinates = repos.map((entry) => entry.repo);

    expect(new Set(citizenCoordinates).size).toBe(citizenCoordinates.length);
    expect(new Set(repoCoordinates).size).toBe(repoCoordinates.length);
  });
});

describe("word-resolver — word-reference/0.1", () => {
  it("advertises a zero-effect exact-name operation", async () => {
    const res = await request("/.well-known/word-reference");
    const body = await res.json();

    expect(body).toMatchObject({
      protocol: "word-reference/0.1",
      modes: {
        exact_name: {
          implemented: true,
          method: "GET",
          path_template: "/v1/resolve/{word}",
          effect: "none",
          available: true,
        },
        meaning_search: { implemented: false },
      },
      word_ownership: "unsupported",
      automatic_selection: false,
      navigation: "separate",
    });
  });

  it("returns plural source-scoped meanings and sites without a winner", async () => {
    const res = await request("/v1/resolve/LOVE");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      protocol: "word-reference/0.1",
      mode: "exact_name",
      query: { input: "LOVE", normalized: "love" },
      found: true,
      ambiguity: {
        meanings: 3,
        references: 2,
        automatic_selection: false,
      },
      selection: null,
    });
    expect(body.meanings.map((meaning: { meaning_id: string }) =>
      meaning.meaning_id
    )).toEqual([
      "kingdom.repo-map:Love",
      "kingdom.repo-map:citizen-love",
      "youspeak.citizens:love",
    ]);
    expect(body.meanings.flatMap(
      (meaning: { references: unknown[] }) => meaning.references,
    )).toHaveLength(2);
    expect(body.meanings.every(
      (meaning: { trust: string }) => meaning.trust === "untrusted",
    )).toBe(true);
    for (const reference of body.meanings.flatMap(
      (meaning: { references: Array<Record<string, unknown>> }) =>
        meaning.references,
    )) {
      expect(reference).toMatchObject({
        kind: "site",
        verification: "unverified",
        trust: "untrusted",
      });
      expect(reference.href).toMatch(/^https:\/\/github\.com\/cambridgetcg\//);
    }
  });

  it("returns an empty successful resolution for an unknown word", async () => {
    const res = await request("/v1/resolve/nonexistentword123");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      found: false,
      meanings: [],
      selection: null,
      ambiguity: {
        meanings: 0,
        references: 0,
        automatic_selection: false,
      },
    });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("claim");
  });

  it("rejects a dotted URL-like input instead of treating it as a name", async () => {
    const res = await request("/v1/resolve/love.com");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      error: "invalid_exact_name",
      protocol: "word-reference/0.1",
      mode: "exact_name",
      effect: "none",
    });
  });
});

describe("word-resolver — legacy read compatibility", () => {
  it("resolves a canon word without asserting an owner", async () => {
    const res = await request("/resolve/abzu");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.found).toBe(true);
    expect(body.word).toBe("abzu");
    expect(body.isCanon).toBe(true);
    expect(body.definition).toContain("freshwater");
    expect(body.domain).toBe("abzu");
    expect(body.owner).toBeNull();
    expect(body.services).toBeNull();
  });

  it("returns an ordinary unknown without offering ownership", async () => {
    const res = await request("/resolve/nonexistentword123");
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.found).toBe(false);
    expect(body.message).toContain("No local meaning source");
    expect(body.message.toLowerCase()).not.toContain("claim");
    expect(body.message.toLowerCase()).not.toContain("buy");
  });
});

describe("word-resolver — legacy inverse dictionary", () => {
  it("finds words by meaning", async () => {
    const res = await request("/search?q=love");
    const body = await res.json();

    expect(body.results).toBeGreaterThan(0);
    expect(body.words.some((word: { word: string }) =>
      word.word.includes("love")
    )).toBe(true);
  });

  it("finds words by partial word match", async () => {
    const res = await request("/search?q=abzu");
    const body = await res.json();

    expect(body.results).toBeGreaterThan(0);
  });
});

describe("word-resolver — words list", () => {
  it("lists the observed canon without ownership claims", async () => {
    const res = await request("/words");
    const body = await res.json();

    expect(body.total).toBe(201);
    expect(body.words).toHaveLength(201);
    expect(body.words.every((word: { claimed: boolean }) =>
      word.claimed === false
    )).toBe(true);
  });
});

describe("word-resolver — retired scarcity mutations", () => {
  for (const path of [
    "/claim/compassion",
    "/register/compassion/service",
    "/transfer/compassion",
  ]) {
    it(`retires ${path} without mutation`, async () => {
      const res = await request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          did: "did:example:caller",
          url: "https://example.com/",
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(410);
      expect(body).toMatchObject({
        error: "word_ownership_retired",
        word: "compassion",
        protocol: "word-reference/0.1",
        mutation: false,
      });
      expect(body.message).toContain("Words are commons");
    });
  }

  it("leaves the legacy read record unowned after retired writes", async () => {
    const res = await request("/resolve/compassion");
    const body = await res.json();

    expect(body.owner).toBeNull();
    expect(body.services).toBeNull();
  });
});
