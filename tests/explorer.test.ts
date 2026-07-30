import { describe, expect, it } from "bun:test";

import {
  apiOriginFor,
  assertResolution,
  initializeExplorer,
  resolutionSummary,
  resolutionUrl,
  validateWordInput,
} from "../public/explorer.js";
import { app } from "../src/index";

class TestNode {
  tagName: string;
  children: TestNode[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: any) => unknown>();
  className = "";
  dir = "";
  lang = "";
  href = "";
  hidden = false;
  disabled = false;
  value = "";
  focused = false;
  private ownText = "";

  constructor(tagName: string, text = "") {
    this.tagName = tagName.toLowerCase();
    this.ownText = text;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = String(value);
    this.children = [];
  }

  append(...nodes: TestNode[]) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: TestNode[]) {
    this.ownText = "";
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener(name: string, listener: (event: any) => unknown) {
    this.listeners.set(name, listener);
  }

  focus() {
    this.focused = true;
  }

  descendants(tagName: string): TestNode[] {
    const normalized = tagName.toLowerCase();
    return [
      ...(this.tagName === normalized ? [this] : []),
      ...this.children.flatMap((child) => child.descendants(normalized)),
    ];
  }
}

class TestDocument {
  nodes = new Map<string, TestNode>();
  created: TestNode[] = [];

  constructor() {
    for (const id of [
      "word-form",
      "word-input",
      "word-submit",
      "word-error",
      "explorer-status",
      "explorer-error",
      "explorer-results",
      "results-title",
      "results-summary",
      "meaning-list",
      "origin",
      "resolve",
      "discovery",
      "health",
    ]) {
      const tagName = id === "word-form"
        ? "form"
        : id === "word-input"
        ? "input"
        : id === "word-submit"
        ? "button"
        : id === "meaning-list"
        ? "ul"
        : id === "results-title"
        ? "h2"
        : id === "explorer-results"
        ? "section"
        : id === "resolve" || id === "discovery" || id === "health"
        ? "a"
        : "p";
      this.nodes.set(id, new TestNode(tagName));
    }
    this.nodes.get("word-error")!.hidden = true;
    this.nodes.get("explorer-error")!.hidden = true;
    this.nodes.get("explorer-results")!.hidden = true;
  }

  getElementById(id: string) {
    return this.nodes.get(id) ?? null;
  }

  createElement(name: string) {
    const node = new TestNode(name);
    this.created.push(node);
    return node;
  }

  createTextNode(text: string) {
    const node = new TestNode("#text", text);
    this.created.push(node);
    return node;
  }
}

describe("meaning commons explorer — exact-name input", () => {
  it("matches protocol normalization for dotless Unicode words", () => {
    expect(validateWordInput(" Love ")).toEqual({
      ok: true,
      input: " Love ",
      normalized: "love",
    });
    expect(validateWordInput("愛")).toEqual({
      ok: true,
      input: "愛",
      normalized: "愛",
    });
    expect(validateWordInput("O’NEILL")).toEqual({
      ok: true,
      input: "O’NEILL",
      normalized: "o’neill",
    });
    expect(validateWordInput("𐐀")).toEqual({
      ok: true,
      input: "𐐀",
      normalized: "𐐨",
    });
  });

  for (const input of [
    "",
    "love.com",
    "two words",
    "https://example.com",
    "love/path",
    "love\njoy",
    "love_joy",
  ]) {
    it(`rejects ${JSON.stringify(input)} without a request`, () => {
      expect(validateWordInput(input).ok).toBe(false);
    });
  }

  it("counts protocol limits in Unicode code points", () => {
    expect(validateWordInput("𐐀".repeat(128)).ok).toBe(true);
    expect(validateWordInput("𐐀".repeat(129)).ok).toBe(false);
    expect(validateWordInput(` ${"𐐀".repeat(128)} `).ok).toBe(true);
    expect(validateWordInput("𐐀".repeat(257)).ok).toBe(false);
  });
});

describe("meaning commons explorer — deployment routing", () => {
  it("uses the public resolver from GitHub Pages", () => {
    expect(apiOriginFor({
      hostname: "cambridgetcg.github.io",
      origin: "https://cambridgetcg.github.io",
    })).toBe("https://word-layer.vercel.app");
    expect(apiOriginFor({
      hostname: "a-fork.github.io",
      origin: "https://a-fork.github.io",
    })).toBe("https://word-layer.vercel.app");
  });

  it("keeps Vercel and local previews on their own HTTP(S) origin", () => {
    expect(apiOriginFor({
      hostname: "word-layer.vercel.app",
      origin: "https://word-layer.vercel.app",
    })).toBe("https://word-layer.vercel.app");
    expect(apiOriginFor({
      hostname: "localhost",
      origin: "http://localhost:3002",
    })).toBe("http://localhost:3002");
  });

  it("encodes input only inside a fixed exact-resolution path", () => {
    expect(
      resolutionUrl("https://word-layer.vercel.app", " Love "),
    ).toBe("https://word-layer.vercel.app/v1/resolve/%20Love%20");
    expect(() => resolutionUrl("javascript:alert(1)", "love")).toThrow();
  });
});

describe("meaning commons explorer — fail-closed resolution", () => {
  it("accepts the deployed response shape without collapsing provenance", async () => {
    const response = await app.request("/v1/resolve/LOVE");
    const body = await response.json();
    const resolution = await assertResolution(body, {
      input: "LOVE",
      normalized: "love",
    });

    expect(resolution.meanings).toHaveLength(3);
    expect(resolution.meanings.map(
      (meaning: { meaning_id: string }) => meaning.meaning_id,
    )).toEqual([
      "kingdom.repo-map:Love",
      "kingdom.repo-map:citizen-love",
      "youspeak.citizens:love",
    ]);
    expect(resolutionSummary(resolution)).toBe(
      "3 meanings · 2 asserted references. No winner was selected; protocol order is deterministic, not ranking.",
    );
  });

  it("rejects authority, count, target, and unknown-field drift", async () => {
    const response = await app.request("/v1/resolve/love");
    const canonical = await response.json();

    const selected = structuredClone(canonical);
    selected.selection = { meaning_id: selected.meanings[0].meaning_id };
    await expect(assertResolution(selected, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const automatic = structuredClone(canonical);
    automatic.ambiguity.automatic_selection = true;
    await expect(assertResolution(automatic, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const inconsistent = structuredClone(canonical);
    inconsistent.ambiguity.meanings += 1;
    await expect(assertResolution(inconsistent, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const unsafeTarget = structuredClone(canonical);
    unsafeTarget.meanings[0].references[0].href = "javascript:alert(1)";
    await expect(assertResolution(unsafeTarget, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const expanded = structuredClone(canonical);
    expanded.suggested_winner = expanded.meanings[0].meaning_id;
    await expect(assertResolution(expanded, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const reordered = structuredClone(canonical);
    reordered.meanings.reverse();
    await expect(assertResolution(reordered, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const duplicateCoordinate = structuredClone(canonical);
    duplicateCoordinate.meanings.splice(
      1,
      0,
      structuredClone(duplicateCoordinate.meanings[0]),
    );
    duplicateCoordinate.ambiguity.meanings += 1;
    duplicateCoordinate.ambiguity.references +=
      duplicateCoordinate.meanings[0].references.length;
    await expect(assertResolution(duplicateCoordinate, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();

    const incorrectDigest = structuredClone(canonical);
    incorrectDigest.meanings[0].provenance.definition_sha256 = "0".repeat(64);
    await expect(assertResolution(incorrectDigest, {
      input: "love",
      normalized: "love",
    })).rejects.toThrow();
  });
});

describe("meaning commons explorer — explicit interaction", () => {
  it("does not fetch before submit and renders asserted URLs as text", async () => {
    const apiResponse = await app.request("/v1/resolve/love");
    const canonical = await apiResponse.json();
    const documentObject = new TestDocument();
    const input = documentObject.getElementById("word-input")!;
    const form = documentObject.getElementById("word-form")!;
    const results = documentObject.getElementById("explorer-results")!;
    const meaningList = documentObject.getElementById("meaning-list")!;
    input.value = "love";
    let requests = 0;

    initializeExplorer(
      documentObject as any,
      {
        hostname: "word-layer.vercel.app",
        origin: "https://word-layer.vercel.app",
      },
      async (_url, init) => {
        requests += 1;
        expect(init).toMatchObject({
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        });
        return new Response(JSON.stringify(canonical), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    expect(requests).toBe(0);
    await form.listeners.get("submit")!({ preventDefault() {} });

    expect(requests).toBe(1);
    expect(results.hidden).toBe(false);
    expect(results.focused).toBe(true);
    expect(meaningList.children).toHaveLength(3);
    expect(documentObject.created.filter((node) => node.tagName === "a"))
      .toHaveLength(0);
    expect(
      documentObject.created
        .filter((node) => node.tagName === "code")
        .map((node) => node.textContent),
    ).toContain("https://github.com/cambridgetcg/Love");
  });

  it("rejects invalid input locally without fetching", async () => {
    const documentObject = new TestDocument();
    const input = documentObject.getElementById("word-input")!;
    const form = documentObject.getElementById("word-form")!;
    const error = documentObject.getElementById("word-error")!;
    input.value = "love.com";
    let requests = 0;

    initializeExplorer(
      documentObject as any,
      {
        hostname: "word-layer.vercel.app",
        origin: "https://word-layer.vercel.app",
      },
      async () => {
        requests += 1;
        return new Response();
      },
    );
    await form.listeners.get("submit")!({ preventDefault() {} });

    expect(requests).toBe(0);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("dotless word");
    expect(input.attributes.get("aria-invalid")).toBe("true");
    expect(input.focused).toBe(true);
  });

  it("restores controls when an overlapping replacement submit is invalid", async () => {
    const documentObject = new TestDocument();
    const input = documentObject.getElementById("word-input")!;
    const submit = documentObject.getElementById("word-submit")!;
    const form = documentObject.getElementById("word-form")!;
    input.value = "love";
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      fetchStarted = resolve;
    });

    initializeExplorer(
      documentObject as any,
      {
        hostname: "word-layer.vercel.app",
        origin: "https://word-layer.vercel.app",
      },
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          fetchStarted();
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        }),
    );

    const first = form.listeners.get("submit")!({ preventDefault() {} });
    await started;
    expect(submit.disabled).toBe(true);

    input.value = "love.com";
    await form.listeners.get("submit")!({ preventDefault() {} });
    await first;

    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Explore meanings");
    expect(form.attributes.has("aria-busy")).toBe(false);
  });

  it("fails closed on a non-JSON response", async () => {
    const documentObject = new TestDocument();
    const input = documentObject.getElementById("word-input")!;
    const form = documentObject.getElementById("word-form")!;
    const error = documentObject.getElementById("explorer-error")!;
    input.value = "love";

    initializeExplorer(
      documentObject as any,
      {
        hostname: "word-layer.vercel.app",
        origin: "https://word-layer.vercel.app",
      },
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    await form.listeners.get("submit")!({ preventDefault() {} });

    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("could not be safely displayed");
  });
});

describe("meaning commons explorer — static delivery and safety", () => {
  it("keeps the Vercel and GitHub Pages documents byte-identical", async () => {
    const root = await Bun.file(
      new URL("../index.html", import.meta.url),
    ).text();
    const publicPage = await Bun.file(
      new URL("../public/index.html", import.meta.url),
    ).text();

    expect(publicPage).toBe(root);
    expect(root).toContain('id="word-form"');
    expect(root).toContain('for="word-input"');
    expect(root).toContain('role="status"');
    expect(root).toContain('aria-live="polite"');
    expect(root).toContain('src="./public/explorer.js"');
    expect(root).toContain('type="submit" disabled');
    expect(root).toContain("The word is not about to");
  });

  it("serves the browser module through Hono for local and Vercel routing", async () => {
    const response = await app.request("/public/explorer.js");
    const delivered = await response.text();
    const source = await Bun.file(
      new URL("../public/explorer.js", import.meta.url),
    ).text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain(
      "text/javascript",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(delivered).toBe(source);
  });

  it("never turns asserted response content into markup or navigation", async () => {
    const source = await Bun.file(
      new URL("../public/explorer.js", import.meta.url),
    ).text();

    expect(source).not.toContain(".innerHTML");
    expect(source).not.toContain("insertAdjacentHTML");
    expect(source).not.toContain("document.write");
    expect(source).not.toContain("window.open");
    expect(source).not.toContain("location.assign");
    expect(source).not.toContain("location.replace");
    expect(source).not.toContain("href = reference.href");
    expect(source).toContain("address.textContent = reference.href");
    expect(source).toContain('form.addEventListener("submit"');
  });
});
