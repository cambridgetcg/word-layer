import { describe, expect, test } from "bun:test";

import {
  WORD_REFERENCE_PROTOCOL,
  WordBrowserSession,
  type ExactNameResolutionInput,
  type WordBrowserPlan,
} from "word-layer";

import {
  RemoteWordResolverError,
  type RemoteWordResolverPort,
} from "../src/remote-resolver.js";
import { AgenttoolWordSession } from "../src/session.js";

const PRIVATE_TARGET =
  "https://meaning.example/love/path?token=private#quiet";

interface FakePlan extends WordBrowserPlan {
  summary: string;
}

class FakeBrowser {
  readonly calls: Array<{ operation: string; input: unknown }> = [];

  plan(input: { kind: "new_tab"; url: string }): FakePlan {
    this.calls.push({ operation: "plan", input });
    return { execution: false, summary: "Would open one tab." };
  }

  async open(url: string): Promise<unknown> {
    this.calls.push({ operation: "open", input: url });
    return { tabId: "tab-1", untrusted: true };
  }
}

function sourceInput(): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word: "LOVE",
    sources: [{
      protocol: WORD_REFERENCE_PROTOCOL,
      source_id: "community.remote",
      records: [{
        record_id: "care",
        word: "love",
        language: "en",
        definition: "Care offered without ownership.",
        references: [{
          reference_id: "site",
          kind: "site",
          href: PRIVATE_TARGET,
        }],
      }],
    }],
  };
}

function deterministicEntropy(): (length: number) => Uint8Array {
  let value = 1;
  return (length) => {
    const bytes = new Uint8Array(length);
    bytes.fill(value);
    value += 1;
    return bytes;
  };
}

function remote(
  resolve: RemoteWordResolverPort["resolve"],
): RemoteWordResolverPort {
  return {
    baseUrl: "https://resolver.example/",
    timeoutMs: 10_000,
    maxResponseBytes: 1_048_576,
    resolve,
  };
}

describe("AgentTool remote source session", () => {
  test("remote acquisition creates choices but never selects, plans, or opens", async () => {
    const browser = new FakeBrowser();
    const seenWords: string[] = [];
    const handoff = new WordBrowserSession({
      browser,
      now: () => 1_800_000_000_000,
      randomBytes: deterministicEntropy(),
    });
    const session = new AgenttoolWordSession(
      handoff,
      remote(async (word) => {
        seenWords.push(word);
        return sourceInput();
      }),
    );

    const offer = await session.resolveRemote({
      mode: "exact_name",
      word: "LOVE",
    });

    expect(seenWords).toEqual(["LOVE"]);
    expect(browser.calls).toEqual([]);
    expect(offer).toMatchObject({
      found: true,
      selection: null,
      authority: "none",
      automatic_action: "never",
      ambiguity: {
        browser_choices: 1,
        automatic_selection: false,
      },
    });
    const offered = offer.meanings[0]!.references[0]!;
    expect(offered.display_url).toBe("https://meaning.example/love/path");
    expect(JSON.stringify(offer)).not.toContain("private");
    expect(JSON.stringify(offer)).not.toContain("#quiet");

    const selected = session.select({
      choice_handle: offered.choice_handle!,
    });
    expect(browser.calls).toEqual([]);
    expect(selected).toMatchObject({
      next: "plan",
      authority: "none",
      automatic_action: "never",
    });

    const planned = session.plan({
      selection_handle: selected.selection_handle,
    }) as { open_handle: string };
    expect(browser.calls).toEqual([{
      operation: "plan",
      input: { kind: "new_tab", url: PRIVATE_TARGET },
    }]);
    expect(browser.calls.some((call) => call.operation === "open")).toBe(false);

    await session.open({ open_handle: planned.open_handle });
    expect(browser.calls.at(-1)).toEqual({
      operation: "open",
      input: PRIVATE_TARGET,
    });
  });

  test("direct callers cannot replace the exact mode or inject a resolver URL", async () => {
    let remoteCalls = 0;
    const session = new AgenttoolWordSession(
      new WordBrowserSession({
        browser: new FakeBrowser(),
        randomBytes: deterministicEntropy(),
      }),
      remote(async () => {
        remoteCalls += 1;
        return sourceInput();
      }),
    );

    await expect(
      session.resolveRemote({
        mode: "meaning_search",
        word: "love",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      session.resolveRemote({
        mode: "exact_name",
        word: "love",
        resolver_url: "https://attacker.example/",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(remoteCalls).toBe(0);
  });

  test("remote resolution is unavailable unless configured at process start", async () => {
    const session = new AgenttoolWordSession(
      new WordBrowserSession({
        browser: new FakeBrowser(),
        randomBytes: deterministicEntropy(),
      }),
    );

    await expect(
      session.resolveRemote({
        mode: "meaning_search",
        word: "love",
      } as never),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      session.resolveRemote({ mode: "exact_name", word: "love" }),
    ).rejects.toMatchObject({
      code: "remote_resolver_disabled",
    });
  });

  test("request cancellation reaches the resolver without closing the session", async () => {
    let observedSignal: AbortSignal | undefined;
    let calls = 0;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const requestAwareRemote = remote((_word, options = {}) => {
      calls += 1;
      observedSignal = options.signal;
      if (calls > 1) return Promise.resolve(sourceInput());
      started();
      return new Promise<ExactNameResolutionInput>((_resolve, reject) => {
        const abort = () => {
          reject(new RemoteWordResolverError("remote_resolver_aborted"));
        };
        if (options.signal?.aborted) {
          abort();
        } else {
          options.signal?.addEventListener("abort", abort, { once: true });
        }
      });
    });
    const session = new AgenttoolWordSession(
      new WordBrowserSession({
        browser: new FakeBrowser(),
        randomBytes: deterministicEntropy(),
      }),
      requestAwareRemote,
    );
    const request = new AbortController();

    const resolving = session.resolveRemote(
      { mode: "exact_name", word: "love" },
      { signal: request.signal },
    );
    await began;
    expect(observedSignal).not.toBe(request.signal);
    request.abort();

    await expect(resolving).rejects.toMatchObject({
      code: "remote_resolver_aborted",
    });
    expect(observedSignal?.aborted).toBe(true);
    await expect(
      session.resolveRemote({ mode: "exact_name", word: "love" }),
    ).resolves.toMatchObject({ found: true });
    expect(calls).toBe(2);
  });

  test("closing the Word session aborts an outstanding remote read", async () => {
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingRemote = remote((_word, options = {}) => {
      observedSignal = options.signal;
      started();
      return new Promise<ExactNameResolutionInput>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new RemoteWordResolverError("remote_resolver_aborted"));
        }, { once: true });
      });
    });
    const session = new AgenttoolWordSession(
      new WordBrowserSession({
        browser: new FakeBrowser(),
        randomBytes: deterministicEntropy(),
      }),
      pendingRemote,
    );

    const resolving = session.resolveRemote({
      mode: "exact_name",
      word: "love",
    });
    await began;
    session.close();

    await expect(resolving).rejects.toMatchObject({
      code: "remote_resolver_aborted",
    });
    expect(observedSignal?.aborted).toBe(true);
    await expect(
      session.resolveRemote({ mode: "exact_name", word: "love" }),
    ).rejects.toMatchObject({ code: "session_closed" });
  });
});
