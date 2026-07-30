import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";

import {
  BROWSER_OPERATIONS,
  BrowserError,
  type AgentBrowser,
  type BrowserOperation,
} from "@agenttool/browser";
import {
  WORD_REFERENCE_PROTOCOL,
  WordBrowserHandoffError,
  WordBrowserSession,
  type ExactNameResolutionInput,
  type WordBrowserPlan,
} from "word-layer";

import {
  executeWordBrowserOperation,
  runWordBrowserJsonlSession,
} from "../src/jsonl.js";
import {
  WORD_BROWSER_OPERATIONS,
  WORD_JSONL_PROTOCOL_VERSION,
  WORD_OPERATIONS,
  type WordWireSession,
} from "../src/protocol.js";
import type { RemoteWordResolverPort } from "../src/remote-resolver.js";
import { AgenttoolWordSession } from "../src/session.js";

const RETAINED_URL =
  "https://meaning.example/love/path?token=private-value#quiet-fragment";

interface FakePlan extends WordBrowserPlan {
  summary: string;
}

class FakeBrowser {
  readonly calls: string[] = [];
  readonly plans: Array<Record<string, unknown>> = [];
  readonly opens: string[] = [];
  readonly order?: string[];
  closeCount = 0;
  activeOpens = 0;
  maximumActiveOpens = 0;

  capabilitiesImplementation:
    | (() => unknown)
    | undefined;
  openImplementation:
    | ((url: string) => Promise<unknown>)
    | undefined;

  constructor(order?: string[]) {
    this.order = order;
  }

  capabilities(): unknown {
    this.calls.push("browser_capabilities");
    return this.capabilitiesImplementation?.() ?? {
      operation: "browser_capabilities",
    };
  }

  plan(action: Record<string, unknown>): FakePlan {
    this.calls.push("browser_plan");
    this.plans.push(action);
    return {
      execution: false,
      summary: "Would open one new tab.",
    };
  }

  async open(url: string): Promise<unknown> {
    this.calls.push("browser_open");
    this.opens.push(url);
    this.activeOpens += 1;
    this.maximumActiveOpens = Math.max(
      this.maximumActiveOpens,
      this.activeOpens,
    );
    try {
      if (this.openImplementation) {
        return await this.openImplementation(url);
      }
      return { operation: "browser_open", url };
    } finally {
      this.activeOpens -= 1;
    }
  }

  async observe(options: Record<string, unknown>): Promise<unknown> {
    this.calls.push("browser_observe");
    return { operation: "browser_observe", options };
  }

  async actAndObserve(action: Record<string, unknown>): Promise<unknown> {
    this.calls.push("browser_act");
    return { operation: "browser_act", action };
  }

  async extract(input: Record<string, unknown>): Promise<unknown> {
    this.calls.push("browser_extract");
    return { operation: "browser_extract", input };
  }

  async screenshot(input: Record<string, unknown>): Promise<unknown> {
    this.calls.push("browser_screenshot");
    return { operation: "browser_screenshot", input };
  }

  async tabs(): Promise<unknown[]> {
    this.calls.push("browser_tabs");
    return [{ tabId: "tab-1", url: "https://example.test/" }];
  }

  async close(): Promise<void> {
    this.calls.push("browser_close");
    this.order?.push("browser");
    this.closeCount += 1;
  }
}

class RecordingWritable extends Writable {
  readonly chunks: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

class SlowWritable extends Writable {
  readonly chunks: string[] = [];
  completedWrites = 0;

  constructor() {
    super({ highWaterMark: 1 });
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    setTimeout(() => {
      this.chunks.push(Buffer.from(chunk).toString("utf8"));
      this.completedWrites += 1;
      callback();
    }, 2);
  }
}

function asAgentBrowser(browser: FakeBrowser): AgentBrowser {
  return browser as unknown as AgentBrowser;
}

function deterministicEntropy(seed = 1): (length: number) => Uint8Array {
  let call = seed;
  return (length) => {
    const bytes = new Uint8Array(length);
    bytes.fill(call % 256);
    call += 1;
    return bytes;
  };
}

function resolutionInput(
  href = RETAINED_URL,
): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word: "LOVE",
    sources: [
      {
        protocol: WORD_REFERENCE_PROTOCOL,
        source_id: "source.local",
        records: [
          {
            record_id: "care",
            word: "love",
            language: "en",
            definition: "Care freely given.",
            references: [
              {
                reference_id: "site",
                kind: "site",
                href,
                asserted_by: "did:example:local",
                proof: "local-assertion",
              },
            ],
          },
        ],
      },
    ],
  };
}

function createSession(
  browser: FakeBrowser,
): WordBrowserSession<FakePlan, unknown> {
  return new WordBrowserSession({
    browser,
    now: () => 1_800_000_000_000,
    randomBytes: deterministicEntropy(),
  });
}

function request(
  id: string | number,
  method: string,
  params?: Record<string, unknown>,
): string {
  return JSON.stringify({
    version: WORD_JSONL_PROTOCOL_VERSION,
    id,
    method,
    ...(params === undefined ? {} : { params }),
  });
}

async function* chunks(
  ...values: Array<string | Uint8Array>
): AsyncGenerator<string | Uint8Array> {
  for (const value of values) yield value;
}

function parseOutput(text: string): Array<Record<string, unknown>> {
  const lines = text.split("\n");
  expect(lines.pop()).toBe("");
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function run(
  browser: FakeBrowser,
  session: WordWireSession,
  input: AsyncIterable<string | Uint8Array>,
  options: {
    maxRequestBytes?: number;
    maxResponseBytes?: number;
    output?: RecordingWritable | SlowWritable;
  } = {},
): Promise<{
  output: RecordingWritable | SlowWritable;
  envelopes: Array<Record<string, unknown>>;
}> {
  const output = options.output ?? new RecordingWritable();
  await runWordBrowserJsonlSession(asAgentBrowser(browser), session, {
    input,
    output,
    ...(options.maxRequestBytes === undefined
      ? {}
      : { maxRequestBytes: options.maxRequestBytes }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
  });
  const text =
    output instanceof RecordingWritable
      ? output.text()
      : output.chunks.join("");
  return { output, envelopes: parseOutput(text) };
}

function expectCode(
  envelope: Record<string, unknown>,
  code: string,
): void {
  expect(envelope.ok).toBe(false);
  expect(
    (envelope.error as Record<string, unknown>).code,
  ).toBe(code);
}

function browserParams(
  operation: BrowserOperation,
): Record<string, unknown> {
  switch (operation) {
    case "browser_capabilities":
    case "browser_observe":
    case "browser_screenshot":
    case "browser_tabs":
    case "browser_close":
      return {};
    case "browser_plan":
      return {
        action: { kind: "new_tab", url: "https://browser.example/plan" },
      };
    case "browser_open":
      return { url: "https://browser.example/open" };
    case "browser_act":
      return { action: { kind: "wait", ms: 0 } };
    case "browser_extract":
      return { format: "text" };
  }
}

function inertSession(
  overrides: Partial<WordWireSession> = {},
): WordWireSession {
  const unavailable = (): never => {
    throw new Error("unexpected Word operation");
  };
  return {
    sessionId: "word-session-test",
    resolve: unavailable,
    resolveRemote: unavailable,
    select: unavailable,
    plan: unavailable,
    open: unavailable,
    close() {},
    discardResolution() {
      return false;
    },
    ...overrides,
  } as WordWireSession;
}

describe("agenttool-word-jsonl/0.2", () => {
  test("uses the exact version, shared 15-operation registry, and dispatches every operation", async () => {
    expect(WORD_JSONL_PROTOCOL_VERSION).toBe(
      "agenttool-word-jsonl/0.2",
    );
    expect(WORD_BROWSER_OPERATIONS).toEqual([
      ...BROWSER_OPERATIONS,
      ...WORD_OPERATIONS,
    ]);
    expect(WORD_BROWSER_OPERATIONS).toHaveLength(15);

    const browser = new FakeBrowser();
    const remoteResolver: RemoteWordResolverPort = {
      baseUrl: "https://resolver.example/",
      timeoutMs: 10_000,
      maxResponseBytes: 1_048_576,
      async resolve() {
        return resolutionInput();
      },
    };
    const session = new AgenttoolWordSession(
      createSession(browser),
      remoteResolver,
    );
    const seen: string[] = [];

    for (const operation of BROWSER_OPERATIONS) {
      if (operation === "browser_close") continue;
      await executeWordBrowserOperation(
        asAgentBrowser(browser),
        session,
        operation,
        browserParams(operation),
      );
      seen.push(operation);
    }

    const offer = await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_resolve",
      resolutionInput() as unknown as Record<string, unknown>,
    ) as ReturnType<WordWireSession["resolve"]>;
    seen.push("word_resolve");
    await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_resolve_remote",
      { mode: "exact_name", word: "LOVE" },
    );
    seen.push("word_resolve_remote");
    const choice = offer.meanings[0]!.references[0]!.choice_handle!;
    const selection = await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_select",
      { choice_handle: choice },
    ) as ReturnType<WordWireSession["select"]>;
    seen.push("word_select");
    const plan = await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_plan",
      { selection_handle: selection.selection_handle },
    ) as ReturnType<WordWireSession["plan"]>;
    seen.push("word_plan");
    await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_open",
      { open_handle: plan.open_handle },
    );
    seen.push("word_open");
    await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_close",
      {},
    );
    seen.push("word_close");
    await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "browser_close",
      {},
    );
    seen.push("browser_close");

    expect(new Set(seen)).toEqual(new Set(WORD_BROWSER_OPERATIONS));
  });

  test("accepts CRLF, blank lines, omitted params, and a final unterminated line while enforcing strict framing", async () => {
    const browser = new FakeBrowser();
    const session = inertSession();
    const good = request(7, "browser_capabilities");
    const extra = JSON.stringify({
      version: WORD_JSONL_PROTOCOL_VERSION,
      id: "extra",
      method: "browser_capabilities",
      params: {},
      surprise: true,
    });
    const wrongVersion = JSON.stringify({
      version: "agenttool-browser-jsonl/0.1",
      id: "version",
      method: "browser_capabilities",
    });
    const badParams = JSON.stringify({
      version: WORD_JSONL_PROTOCOL_VERSION,
      id: "params",
      method: "browser_capabilities",
      params: [],
    });
    const malformed = "{not json";
    const unknown = request("unknown", "word_teleport");

    const { envelopes } = await run(
      browser,
      session,
      chunks(
        ` \r\n${good}\r\n`,
        `${extra}\n${wrongVersion}\n${badParams}\n`,
        `${malformed}\n${unknown}`,
      ),
    );

    expect(envelopes[0]).toEqual({
      version: WORD_JSONL_PROTOCOL_VERSION,
      id: 7,
      ok: true,
      result: { operation: "browser_capabilities" },
    });
    expectCode(envelopes[1]!, "invalid_request");
    expect(envelopes[1]!.id).toBe("extra");
    expectCode(envelopes[2]!, "unsupported_version");
    expectCode(envelopes[3]!, "invalid_request");
    expectCode(envelopes[4]!, "invalid_json");
    expect(envelopes[4]!.id).toBeNull();
    expectCode(envelopes[5]!, "method_not_found");
  });

  test("validates IDs as safe integers or 1-200 Unicode scalar values", async () => {
    const browser = new FakeBrowser();
    const supplementaryId = "😀".repeat(200);
    const lines = [
      JSON.stringify({
        version: WORD_JSONL_PROTOCOL_VERSION,
        id: "",
        method: "browser_capabilities",
      }),
      JSON.stringify({
        version: WORD_JSONL_PROTOCOL_VERSION,
        id: Number.MAX_SAFE_INTEGER + 1,
        method: "browser_capabilities",
      }),
      request(supplementaryId, "browser_capabilities"),
      request("😀".repeat(201), "browser_capabilities"),
      request("\ud800", "browser_capabilities"),
      request(Number.MAX_SAFE_INTEGER, "browser_capabilities"),
    ].join("\n");
    const { envelopes } = await run(
      browser,
      inertSession(),
      chunks(`${lines}\n`),
    );

    expectCode(envelopes[0]!, "invalid_request");
    expect(envelopes[0]!.id).toBeNull();
    expectCode(envelopes[1]!, "invalid_request");
    expect(envelopes[2]!.ok).toBe(true);
    expect(envelopes[2]!.id).toBe(supplementaryId);
    expectCode(envelopes[3]!, "invalid_request");
    expect(envelopes[3]!.id).toBeNull();
    expectCode(envelopes[4]!, "invalid_request");
    expect(envelopes[4]!.id).toBeNull();
    expect(envelopes[5]!.ok).toBe(true);
    expect(envelopes[5]!.id).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("resolve and select are Browser-zero-effect; plan and open retain the exact stored URL", async () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);

    const offer = await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_resolve",
      resolutionInput() as unknown as Record<string, unknown>,
    ) as ReturnType<WordWireSession["resolve"]>;
    const choice = offer.meanings[0]!.references[0]!.choice_handle!;
    expect(browser.calls).toEqual([]);
    expect(
      offer.meanings[0]!.references[0]!.display_url,
    ).toBe("https://meaning.example/love/path");

    const selection = await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_select",
      { choice_handle: choice },
    ) as ReturnType<WordWireSession["select"]>;
    expect(browser.calls).toEqual([]);

    const plan = await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_plan",
      { selection_handle: selection.selection_handle },
    ) as ReturnType<WordWireSession["plan"]>;
    expect(browser.calls).toEqual(["browser_plan"]);
    expect(browser.plans[0]).toEqual({
      kind: "new_tab",
      url: RETAINED_URL,
    });
    expect(plan.browser_action).toEqual({ kind: "new_tab" });

    await executeWordBrowserOperation(
      asAgentBrowser(browser),
      session,
      "word_open",
      { open_handle: plan.open_handle },
    );
    expect(browser.opens).toEqual([RETAINED_URL]);
  });

  test("strict Word schemas reject caller URL injection before any session or Browser call", async () => {
    const browser = new FakeBrowser();
    const calls: string[] = [];
    const session = inertSession({
      resolve() {
        calls.push("resolve");
        throw new Error("must not run");
      },
      async resolveRemote() {
        calls.push("resolve_remote");
        throw new Error("must not run");
      },
      select() {
        calls.push("select");
        throw new Error("must not run");
      },
      plan() {
        calls.push("plan");
        throw new Error("must not run");
      },
      async open() {
        calls.push("open");
        throw new Error("must not run");
      },
      close() {
        calls.push("close");
      },
    });
    const injected = "https://attacker.example/injected";
    const input = [
      request("resolve", "word_resolve", {
        ...resolutionInput(),
        url: injected,
      }),
      request("resolve-remote", "word_resolve_remote", {
        mode: "exact_name",
        word: "love",
        resolver_url: injected,
      }),
      request("select", "word_select", {
        choice_handle: "choice",
        url: injected,
      }),
      request("plan", "word_plan", {
        selection_handle: "selection",
        url: injected,
      }),
      request("open", "word_open", {
        open_handle: "open",
        url: injected,
      }),
      request("close", "word_close", { url: injected }),
    ].join("\n");

    const { envelopes } = await run(
      browser,
      session,
      chunks(`${input}\n`),
    );

    expect(envelopes).toHaveLength(6);
    for (const envelope of envelopes) {
      expectCode(envelope, "invalid_params");
    }
    expect(calls).toEqual([]);
    expect(browser.calls).toEqual([]);
  });

  test("executes requests sequentially and rejects replay of a spent open handle", async () => {
    const browser = new FakeBrowser();
    browser.openImplementation = async (url) => {
      await new Promise((resolve) => setTimeout(resolve, 3));
      return { url };
    };
    const session = createSession(browser);
    const offer = session.resolve(resolutionInput());
    const selection = session.select({
      choice_handle:
        offer.meanings[0]!.references[0]!.choice_handle!,
    });
    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });

    const input = [
      request("first", "word_open", {
        open_handle: plan.open_handle,
      }),
      request("replay", "word_open", {
        open_handle: plan.open_handle,
      }),
    ].join("\n");
    const { envelopes } = await run(
      browser,
      session,
      chunks(`${input}\n`),
    );

    expect(envelopes[0]!.ok).toBe(true);
    expectCode(envelopes[1]!, "invalid_handle");
    expect(browser.opens).toEqual([RETAINED_URL]);
    expect(browser.maximumActiveOpens).toBe(1);

    browser.opens.length = 0;
    const rawInput = [
      request("raw-1", "browser_open", {
        url: "https://browser.example/one",
      }),
      request("raw-2", "browser_open", {
        url: "https://browser.example/two",
      }),
    ].join("\n");
    const raw = await run(
      browser,
      session,
      chunks(`${rawInput}\n`),
    );
    expect(raw.envelopes.map((envelope) => envelope.id)).toEqual([
      "raw-1",
      "raw-2",
    ]);
    expect(browser.maximumActiveOpens).toBe(1);
  });

  test("word_close only invalidates Word, while valid browser_close invalidates Word before Browser", async () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);
    const offer = session.resolve(resolutionInput());
    const choice =
      offer.meanings[0]!.references[0]!.choice_handle!;
    const wordInput = [
      request("word-close", "word_close", {}),
      request("spent", "word_select", { choice_handle: choice }),
      request("browser-still-live", "browser_capabilities", {}),
    ].join("\n");
    const word = await run(
      browser,
      session,
      chunks(`${wordInput}\n`),
    );

    expect(word.envelopes[0]).toMatchObject({
      id: "word-close",
      ok: true,
      result: { closed: true },
    });
    expectCode(word.envelopes[1]!, "session_closed");
    expect(word.envelopes[2]!.ok).toBe(true);
    expect(browser.closeCount).toBe(0);

    const order: string[] = [];
    const closingBrowser = new FakeBrowser(order);
    const closingSession = inertSession({
      close() {
        order.push("word");
      },
    });
    const closed = await run(
      closingBrowser,
      closingSession,
      chunks(`${request("close-all", "browser_close", {})}\n`),
    );
    expect(closed.envelopes[0]).toMatchObject({
      id: "close-all",
      ok: true,
      result: { closed: true },
    });
    expect(order).toEqual(["word", "browser"]);
  });

  test("invalid browser_close params preserve both Word handles and Browser", async () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);
    const offer = session.resolve(resolutionInput());
    const choice =
      offer.meanings[0]!.references[0]!.choice_handle!;

    const invalid = await run(
      browser,
      session,
      chunks(
        `${request("bad-close", "browser_close", {
          unexpected: true,
        })}\n`,
      ),
    );
    expectCode(invalid.envelopes[0]!, "invalid_params");
    expect(browser.closeCount).toBe(0);

    const selected = session.select({ choice_handle: choice });
    expect(selected.selection_handle).toBeString();
  });

  test("uses typed public errors and redacts unknown Word failures", async () => {
    const browser = new FakeBrowser();
    const typedSession = inertSession({
      resolve(): never {
        throw new WordBrowserHandoffError(
          "state_full",
          "bounded Word state is full",
        );
      },
    });
    const typed = await run(
      browser,
      typedSession,
      chunks(
        `${request(
          "typed-word",
          "word_resolve",
          resolutionInput() as unknown as Record<string, unknown>,
        )}\n`,
      ),
    );
    expect(typed.envelopes[0]!.error).toEqual({
      code: "state_full",
      message: "bounded Word state is full",
    });

    const secret = "SECRET-INTERNAL-WORD-DETAIL";
    const unknownSession = inertSession({
      resolve(): never {
        throw new Error(secret);
      },
    });
    const unknown = await run(
      browser,
      unknownSession,
      chunks(
        `${request(
          "unknown-word",
          "word_resolve",
          resolutionInput() as unknown as Record<string, unknown>,
        )}\n`,
      ),
    );
    expect(unknown.envelopes[0]!.error).toEqual({
      code: "internal_error",
      message: "word handoff operation failed",
    });
    expect(JSON.stringify(unknown.envelopes)).not.toContain(secret);

    const typedBrowser = new FakeBrowser();
    typedBrowser.capabilitiesImplementation = () => {
      throw new BrowserError(
        "browser_closed",
        "Browser is already closed",
      );
    };
    const browserError = await run(
      typedBrowser,
      inertSession(),
      chunks(`${request("typed-browser", "browser_capabilities")}\n`),
    );
    expect(browserError.envelopes[0]!.error).toEqual({
      code: "browser_closed",
      message: "Browser is already closed",
    });
  });

  test("bounds request bytes, rejects malformed UTF-8, and continues on the next line", async () => {
    const browser = new FakeBrowser();
    const oversized = Buffer.from(`${"x".repeat(181)}\n`);
    const invalidUtf8 = Buffer.from([0xc3, 0x28, 0x0a]);
    const valid = request("after-errors", "browser_capabilities");
    const { envelopes } = await run(
      browser,
      inertSession(),
      chunks(
        oversized,
        invalidUtf8,
        Buffer.from(valid.slice(0, 23)),
        Buffer.from(valid.slice(23)),
      ),
      { maxRequestBytes: 180 },
    );

    expectCode(envelopes[0]!, "line_too_large");
    expect(envelopes[0]!.id).toBeNull();
    expectCode(envelopes[1]!, "invalid_utf8");
    expect(envelopes[1]!.id).toBeNull();
    expect(envelopes[2]!.ok).toBe(true);
    expect(envelopes[2]!.id).toBe("after-errors");
  });

  test("honors writable backpressure before advancing", async () => {
    const output = new SlowWritable();
    const input = [
      request("one", "browser_capabilities"),
      request("two", "browser_capabilities"),
    ].join("\n");
    const result = await run(
      new FakeBrowser(),
      inertSession(),
      chunks(`${input}\n`),
      { output },
    );

    expect(output.completedWrites).toBe(2);
    expect(result.envelopes.map((envelope) => envelope.id)).toEqual([
      "one",
      "two",
    ]);
  });

  test("discards an oversized successful Word resolution before emitting a complete error line", async () => {
    const browser = new FakeBrowser();
    const actual = createSession(browser);
    let capturedChoice = "";
    let capturedResolution = "";
    const discarded: string[] = [];
    const wrapped: WordWireSession = {
      sessionId: actual.sessionId,
      resolve(input) {
        const offer = actual.resolve(input);
        capturedResolution = offer.resolution_id;
        capturedChoice =
          offer.meanings[0]!.references[0]!.choice_handle!;
        return offer;
      },
      select(input) {
        return actual.select(input);
      },
      plan(input) {
        return actual.plan(input);
      },
      open(input) {
        return actual.open(input);
      },
      close() {
        actual.close();
      },
      discardResolution(resolutionId) {
        discarded.push(resolutionId);
        return actual.discardResolution(resolutionId);
      },
    };

    const output = new RecordingWritable();
    const result = await run(
      browser,
      wrapped,
      chunks(
        `${request(
          "bounded",
          "word_resolve",
          resolutionInput() as unknown as Record<string, unknown>,
        )}\n`,
      ),
      { maxResponseBytes: 256, output },
    );

    expectCode(result.envelopes[0]!, "result_too_large");
    expect(discarded).toEqual([capturedResolution]);
    expect(() =>
      actual.select({ choice_handle: capturedChoice }),
    ).toThrow(expect.objectContaining({ code: "invalid_handle" }));
    expect(output.text().endsWith("\n")).toBe(true);
    expect(() => JSON.parse(output.text().trimEnd())).not.toThrow();
    expect(output.text()).not.toContain("\"meanings\"");
  });

  test("discards a successful Word resolution when result serialization fails", async () => {
    const discarded: string[] = [];
    const circular: Record<string, unknown> = {
      resolution_id: "resolution-circular",
    };
    circular.self = circular;
    const session = inertSession({
      resolve() {
        return circular as never;
      },
      discardResolution(resolutionId) {
        discarded.push(resolutionId);
        return true;
      },
    });
    const result = await run(
      new FakeBrowser(),
      session,
      chunks(
        `${request(
          "circular",
          "word_resolve",
          resolutionInput() as unknown as Record<string, unknown>,
        )}\n`,
      ),
    );

    expectCode(result.envelopes[0]!, "serialization_failed");
    expect(discarded).toEqual(["resolution-circular"]);
  });

  test("delegates ordinary Browser operations without touching Word state", async () => {
    const browser = new FakeBrowser();
    let wordCalls = 0;
    const session = inertSession({
      resolve(): never {
        wordCalls += 1;
        throw new Error("unexpected");
      },
      select(): never {
        wordCalls += 1;
        throw new Error("unexpected");
      },
    });
    const result = await run(
      browser,
      session,
      chunks(
        `${request("raw-open", "browser_open", {
          url: "https://browser.example/direct",
        })}\n`,
      ),
    );

    expect(result.envelopes[0]).toMatchObject({
      id: "raw-open",
      ok: true,
      result: {
        operation: "browser_open",
        url: "https://browser.example/direct",
      },
    });
    expect(browser.opens).toEqual(["https://browser.example/direct"]);
    expect(wordCalls).toBe(0);
  });
});
