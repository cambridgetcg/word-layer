import { describe, it, expect } from "vitest";

const BASE = "http://localhost:3002";

describe("word-resolver — health", () => {
  it("returns ok", async () => {
    const res = await fetch(`${BASE}/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("word-resolver");
  });
});

describe("word-resolver — resolve", () => {
  it("resolves a canon word", async () => {
    const res = await fetch(`${BASE}/resolve/abzu`);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(body.word).toBe("abzu");
    expect(body.isCanon).toBe(true);
    expect(body.definition).toContain("freshwater");
    expect(body.domain).toBe("abzu");
  });

  it("returns 404 for unknown word", async () => {
    const res = await fetch(`${BASE}/resolve/nonexistentword123`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.found).toBe(false);
  });
});

describe("word-resolver — search (inverse dictionary)", () => {
  it("finds words by meaning", async () => {
    const res = await fetch(`${BASE}/search?q=love`);
    const body = await res.json();
    expect(body.results).toBeGreaterThan(0);
    expect(body.words.some((w: any) => w.word.includes("love"))).toBe(true);
  });

  it("finds words by partial word match", async () => {
    const res = await fetch(`${BASE}/search?q=abzu`);
    const body = await res.json();
    expect(body.results).toBeGreaterThan(0);
  });
});

describe("word-resolver — words list", () => {
  it("lists all words", async () => {
    const res = await fetch(`${BASE}/words`);
    const body = await res.json();
    expect(body.total).toBe(201);
    expect(body.words.length).toBe(201);
  });
});

describe("word-resolver — claim and register", () => {
  it("claims a canon word and registers a service", async () => {
    // Claim
    const claimRes = await fetch(`${BASE}/claim/compassion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: "did:lgm:abcdef1234567890abcdef1234567890",
        display_name: "test-user",
        public_key_hex: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      }),
    });
    expect(claimRes.status).toBe(200);
    const claim = await claimRes.json();
    expect(claim.claimed).toBe(true);

    // Register a service
    const regRes = await fetch(`${BASE}/register/compassion/service`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_type: "site",
        url: "https://example.com",
        did: "did:lgm:abcdef1234567890abcdef1234567890",
      }),
    });
    expect(regRes.status).toBe(200);
    const reg = await regRes.json();
    expect(reg.registered).toBe(true);

    // Verify it resolves with the service
    const resolveRes = await fetch(`${BASE}/resolve/compassion`);
    const resolved = await resolveRes.json();
    expect(resolved.services.site).toBe("https://example.com");
  });

  it("rejects claiming an already-claimed word", async () => {
    const res = await fetch(`${BASE}/claim/compassion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        did: "did:lgm:00000000000000000000000000000000",
        display_name: "another-user",
      }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects service registration from non-owner", async () => {
    const res = await fetch(`${BASE}/register/compassion/service`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_type: "api",
        url: "https://evil.com",
        did: "did:lgm:00000000000000000000000000000000",
      }),
    });
    expect(res.status).toBe(403);
  });
});