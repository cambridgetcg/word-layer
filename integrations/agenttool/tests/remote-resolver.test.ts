import { describe, expect, test } from "bun:test";

import {
  resolveWordReference,
  WORD_REFERENCE_PROTOCOL,
  type ExactNameResolutionInput,
  type WordReferenceResolution,
} from "word-layer";

import {
  normalizeWordResolverBaseUrl,
  RemoteWordResolver,
  WORD_PUBLIC_DEMO_RESOLVER,
  WORD_REMOTE_RESOLVER_LIMITS,
  type WordResolverNetworkPolicy,
} from "../src/remote-resolver.js";

function localInput(word = " LOVE "): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word,
    sources: [{
      protocol: WORD_REFERENCE_PROTOCOL,
      source_id: "community.one",
      records: [{
        record_id: "care",
        word: "love",
        language: "en",
        definition: "Care that remains.",
        references: [{
          reference_id: "site",
          kind: "site",
          href: "https://meaning.example/love?token=private#fragment",
          asserted_by: "did:example:community",
          proof: "publisher assertion only",
        }],
      }],
    }],
  };
}

function canonical(word = " LOVE "): WordReferenceResolution {
  return resolveWordReference(localInput(word));
}

function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

class RecordingPolicy implements WordResolverNetworkPolicy {
  readonly checked: string[] = [];
  error?: unknown;

  async assertAllowed(input: string | URL): Promise<URL> {
    const url = new URL(input);
    this.checked.push(url.href);
    if (this.error) throw this.error;
    return url;
  }
}

function fakeFetch(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return implementation as typeof globalThis.fetch;
}

async function rejectionCodeWithin(
  promise: Promise<unknown>,
  timeoutMs = 250,
): Promise<string> {
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    promise.then(
      () => "unexpected_success",
      (error: unknown) =>
        typeof error === "object" && error !== null
          ? String(Reflect.get(error, "code"))
          : "missing_error_code",
    ),
    new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  expect(outcome).not.toBe(timeout);
  return outcome as string;
}

describe("process-fixed remote word resolver", () => {
  test("requires a canonical HTTPS base without credentials, query, or fragment", () => {
    expect(normalizeWordResolverBaseUrl("https://resolver.example/community"))
      .toBe("https://resolver.example/community/");
    expect(normalizeWordResolverBaseUrl(WORD_PUBLIC_DEMO_RESOLVER))
      .toBe(WORD_PUBLIC_DEMO_RESOLVER);

    for (const invalid of [
      "",
      " https://resolver.example",
      "http://resolver.example",
      "https://user:secret@resolver.example",
      "https://resolver.example/?choice=other",
      "https://resolver.example/#other",
      "https://resolver.example/path\nsilently-stripped",
      "https://resolver.example/\u0000control",
      "https://resolver.example/\ud800",
      `https://resolver.example/${"a".repeat(8_192)}`,
      `https://resolver.example/${"é".repeat(4_000)}`,
    ]) {
      expect(() => normalizeWordResolverBaseUrl(invalid)).toThrow();
    }
  });

  test("sends one bounded credential-free no-redirect request after authority preflight", async () => {
    const policy = new RecordingPolicy();
    const calls: Array<{
      url: string;
      init: RequestInit | undefined;
    }> = [];
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example/community",
      networkPolicy: policy,
      fetch: fakeFetch(async (input, init) => {
        calls.push({ url: input.toString(), init });
        return jsonResponse(canonical());
      }),
    });

    const reconstructed = await resolver.resolve(" LOVE ");

    const expectedUrl =
      "https://resolver.example/community/v1/resolve/%20LOVE%20";
    expect(policy.checked).toEqual([expectedUrl]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(expectedUrl);
    expect(calls[0]!.init).toMatchObject({
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(resolveWordReference(reconstructed)).toEqual(canonical());
  });

  test("authority refusal prevents the HTTP request", async () => {
    const policy = new RecordingPolicy();
    policy.error = Object.assign(new Error("private answer"), {
      code: "network_blocked",
    });
    let fetchCalls = 0;
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: policy,
      fetch: fakeFetch(async () => {
        fetchCalls += 1;
        return jsonResponse(canonical());
      }),
    });

    await expect(resolver.resolve("love")).rejects.toMatchObject({
      code: "remote_resolver_network_blocked",
    });
    expect(fetchCalls).toBe(0);
  });

  test("enforces one deadline even when an injected transport ignores AbortSignal", async () => {
    const policy = new RecordingPolicy();
    let fetchCalls = 0;
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: policy,
      timeoutMs: 5,
      fetch: fakeFetch(() => {
        fetchCalls += 1;
        return new Promise<Response>(() => {});
      }),
    });

    await expect(resolver.resolve("love")).rejects.toMatchObject({
      code: "remote_resolver_timeout",
    });
    expect(fetchCalls).toBe(1);
  });

  test("discards a response that arrives after its deadline without awaiting cleanup", async () => {
    let deliver!: (response: Response) => void;
    const pendingFetch = new Promise<Response>((resolve) => {
      deliver = resolve;
    });
    let cancelCalls = 0;
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: new RecordingPolicy(),
      timeoutMs: 5,
      fetch: fakeFetch(() => pendingFetch),
    });

    expect(await rejectionCodeWithin(resolver.resolve("love")))
      .toBe("remote_resolver_timeout");

    deliver(new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => {});
      },
    }), {
      headers: { "content-type": "application/json" },
    }));
    await Bun.sleep(0);
    expect(cancelCalls).toBe(1);
  });

  test("honors caller/session cancellation before any fetch", async () => {
    const policy = new RecordingPolicy();
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: policy,
      fetch: fakeFetch(async () => {
        fetchCalls += 1;
        return jsonResponse(canonical());
      }),
    });

    await expect(
      resolver.resolve("love", { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "remote_resolver_aborted",
    });
    expect(policy.checked).toEqual([]);
    expect(fetchCalls).toBe(0);
  });

  test("bounds aggregate in-flight work and releases admission slots", async () => {
    const releases: Array<() => void> = [];
    let fetchCalls = 0;
    let releaseStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve;
    });
    let hold = true;
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: new RecordingPolicy(),
      fetch: fakeFetch(() => {
        fetchCalls += 1;
        if (!hold) return Promise.resolve(jsonResponse(canonical("love")));
        return new Promise<Response>((resolve) => {
          releases.push(() => resolve(jsonResponse(canonical("love"))));
          if (
            releases.length
            === WORD_REMOTE_RESOLVER_LIMITS.maximumInFlight
          ) {
            releaseStarted();
          }
        });
      }),
    });

    const admitted = Array.from(
      { length: WORD_REMOTE_RESOLVER_LIMITS.maximumInFlight },
      () => resolver.resolve("love"),
    );
    await allStarted;
    await expect(resolver.resolve("love")).rejects.toMatchObject({
      code: "remote_resolver_busy",
    });
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await expect(
      resolver.resolve("love", { signal: alreadyCancelled.signal }),
    ).rejects.toMatchObject({
      code: "remote_resolver_aborted",
    });
    expect(fetchCalls).toBe(WORD_REMOTE_RESOLVER_LIMITS.maximumInFlight);

    hold = false;
    for (const release of releases) release();
    await Promise.all(admitted);
    await expect(resolver.resolve("love")).resolves.toBeDefined();
    expect(fetchCalls).toBe(
      WORD_REMOTE_RESOLVER_LIMITS.maximumInFlight + 1,
    );
  });

  test("rejects redirects, unsuccessful status, encoding, media type, and invalid length without retry", async () => {
    const cases: Array<{
      response: () => Response;
      code: string;
    }> = [
      {
        response: () =>
          new Response("", {
            status: 302,
            headers: { location: "https://other.example/" },
          }),
        code: "remote_resolver_redirect",
      },
      {
        response: () => jsonResponse({ error: "down" }, { status: 503 }),
        code: "remote_resolver_http_error",
      },
      {
        response: () =>
          jsonResponse(canonical(), {
            headers: {
              "content-type": "application/json",
              "content-encoding": "gzip",
            },
          }),
        code: "remote_resolver_encoding_invalid",
      },
      {
        response: () =>
          new Response("text", {
            headers: { "content-type": "text/plain" },
          }),
        code: "remote_resolver_media_type_invalid",
      },
      {
        response: () =>
          jsonResponse(canonical(), {
            headers: {
              "content-type": "application/json",
              "content-length": "not-a-number",
            },
          }),
        code: "remote_resolver_length_invalid",
      },
    ];

    for (const item of cases) {
      let calls = 0;
      const resolver = new RemoteWordResolver({
        baseUrl: "https://resolver.example",
        networkPolicy: new RecordingPolicy(),
        fetch: fakeFetch(async () => {
          calls += 1;
          return item.response();
        }),
      });
      await expect(resolver.resolve("love")).rejects.toMatchObject({
        code: item.code,
      });
      expect(calls).toBe(1);
    }
  });

  test("never-settling early response cancellation cannot hide status or header errors", async () => {
    const cases = [
      {
        init: {
          status: 503,
          headers: { "content-type": "application/json" },
        },
        code: "remote_resolver_http_error",
      },
      {
        init: {
          headers: { "content-type": "text/plain" },
        },
        code: "remote_resolver_media_type_invalid",
      },
    ] satisfies Array<{ init: ResponseInit; code: string }>;

    for (const item of cases) {
      let cancelCalls = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1;
          return new Promise<void>(() => {});
        },
      });
      const resolver = new RemoteWordResolver({
        baseUrl: "https://resolver.example",
        networkPolicy: new RecordingPolicy(),
        fetch: fakeFetch(async () => new Response(body, item.init)),
      });

      expect(await rejectionCodeWithin(resolver.resolve("love")))
        .toBe(item.code);
      expect(cancelCalls).toBe(1);
    }
  });

  test("bounds streamed bytes and rejects malformed UTF-8 or JSON", async () => {
    const cases: Array<{
      response: () => Response;
      options?: { maxResponseBytes: number };
      code: string;
    }> = [
      {
        response: () =>
          new Response("x".repeat(64), {
            headers: { "content-type": "application/json" },
          }),
        options: { maxResponseBytes: 16 },
        code: "remote_resolver_response_too_large",
      },
      {
        response: () =>
          new Response(new Uint8Array([0xc3, 0x28]), {
            headers: { "content-type": "application/json" },
          }),
        code: "remote_resolver_json_invalid",
      },
      {
        response: () =>
          new Response("{not-json", {
            headers: { "content-type": "application/json" },
          }),
        code: "remote_resolver_json_invalid",
      },
    ];

    for (const item of cases) {
      const resolver = new RemoteWordResolver({
        baseUrl: "https://resolver.example",
        networkPolicy: new RecordingPolicy(),
        fetch: fakeFetch(async () => item.response()),
        ...item.options,
      });
      await expect(resolver.resolve("love")).rejects.toMatchObject({
        code: item.code,
      });
    }
  });

  test("best-effort stream cancellation cannot replace timeout or size errors", async () => {
    const neverFinishes = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        return Promise.reject(new Error("cancel failed"));
      },
    });
    const timeoutResolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: new RecordingPolicy(),
      timeoutMs: 5,
      fetch: fakeFetch(async () =>
        new Response(neverFinishes, {
          headers: { "content-type": "application/json" },
        })),
    });
    await expect(timeoutResolver.resolve("love")).rejects.toMatchObject({
      code: "remote_resolver_timeout",
    });

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const sizeResolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: new RecordingPolicy(),
      maxResponseBytes: 16,
      fetch: fakeFetch(async () =>
        new Response(oversized, {
          headers: { "content-type": "application/json" },
        })),
    });
    expect(await rejectionCodeWithin(sizeResolver.resolve("love")))
      .toBe("remote_resolver_response_too_large");
  });

  test("requires exact local reproduction of every remote protocol invariant", async () => {
    const mutations: Array<(value: any) => void> = [
      (value) => {
        value.query.normalized = "joy";
      },
      (value) => {
        value.meanings[0].meaning_id = "community.one:other";
      },
      (value) => {
        value.meanings[0].provenance.definition_sha256 = "0".repeat(64);
      },
      (value) => {
        value.meanings[0].trust = "trusted";
      },
      (value) => {
        value.ambiguity.automatic_selection = true;
      },
      (value) => {
        value.selection = { reference_id: "site" };
      },
      (value) => {
        value.extra = "not in the protocol";
      },
    ];

    for (const mutate of mutations) {
      const changed = structuredClone(canonical()) as any;
      mutate(changed);
      const resolver = new RemoteWordResolver({
        baseUrl: "https://resolver.example",
        networkPolicy: new RecordingPolicy(),
        fetch: fakeFetch(async () => jsonResponse(changed)),
      });

      await expect(resolver.resolve(" LOVE ")).rejects.toMatchObject({
        code: "remote_resolver_response_invalid",
      });
    }
  });

  test("accepts the canonical empty unknown-word response without inventing a claim", async () => {
    const empty = resolveWordReference({
      mode: "exact_name",
      word: "unknown-word",
      sources: [],
    });
    const resolver = new RemoteWordResolver({
      baseUrl: "https://resolver.example",
      networkPolicy: new RecordingPolicy(),
      fetch: fakeFetch(async () => jsonResponse(empty)),
    });

    const reconstructed = await resolver.resolve("unknown-word");
    expect(resolveWordReference(reconstructed)).toEqual(empty);
    expect(empty).toMatchObject({
      found: false,
      meanings: [],
      ambiguity: {
        meanings: 0,
        references: 0,
        automatic_selection: false,
      },
      selection: null,
    });
  });
});
