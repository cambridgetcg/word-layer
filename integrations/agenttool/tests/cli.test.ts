import { describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";

import type {
  AgentBrowser,
  BrowserProcessConfig,
} from "@agenttool/browser";

import {
  runWordAgenttoolCli,
  WORD_AGENTTOOL_CLI_HELP,
  type WordAgenttoolCliDependencies,
} from "../src/cli.js";
import type { WordWireSession } from "../src/protocol.js";

class FakeBrowser {
  closeCalls = 0;
  readonly plans: unknown[] = [];
  readonly opens: string[] = [];

  capabilities() {
    return {
      schema: "agenttool-browser-capabilities/0.1",
      authority: { profile: "public" },
    };
  }

  plan(action: unknown) {
    this.plans.push(action);
    return { execution: false };
  }

  async open(url: string) {
    this.opens.push(url);
    return { tabId: "tab-1", untrusted: true };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

function capture(): PassThrough {
  return new PassThrough();
}

function captured(stream: PassThrough): string {
  return stream.read()?.toString("utf8") ?? "";
}

function dependencies(
  browser: FakeBrowser,
  overrides: Partial<WordAgenttoolCliDependencies> = {},
): WordAgenttoolCliDependencies {
  return {
    env: {},
    cwd: "/tmp",
    stdin: Readable.from([]),
    stdout: capture(),
    stderr: capture(),
    launch: async (_config: BrowserProcessConfig) =>
      browser as unknown as AgentBrowser,
    ...overrides,
  };
}

describe("agenttool-word CLI", () => {
  test("help is effect-free", async () => {
    const browser = new FakeBrowser();
    const stdout = capture();
    let launched = false;

    const code = await runWordAgenttoolCli(["help"], {
      stdout,
      stderr: capture(),
      launch: async () => {
        launched = true;
        return browser as unknown as AgentBrowser;
      },
    });

    expect(code).toBe(0);
    expect(launched).toBe(false);
    expect(captured(stdout)).toBe(WORD_AGENTTOOL_CLI_HELP);
  });

  test("doctor reports the bounded source model and closes Browser once", async () => {
    const browser = new FakeBrowser();
    const stdout = capture();
    const deps = dependencies(browser, { stdout });

    const code = await runWordAgenttoolCli(["doctor"], deps);
    const report = JSON.parse(captured(stdout));

    expect(code).toBe(0);
    expect(report).toMatchObject({
      ok: true,
      version: "agenttool-word-doctor/0.1",
      word: {
        source_model: "caller_supplied_local_state",
        automatic_selection: false,
        automatic_navigation: false,
      },
      checks: {
        browser_launch: "ok",
        automatic_download: false,
        transport: "local_process_only",
      },
    });
    expect(browser.closeCalls).toBe(1);
  });

  test("JSONL EOF closes one Word session and Browser exactly once", async () => {
    const browser = new FakeBrowser();
    let sessionCloseCalls = 0;
    let observedBrowser: AgentBrowser | undefined;
    const session = {
      sessionId: "session-test",
      close() {
        sessionCloseCalls += 1;
      },
    } as unknown as WordWireSession;
    const deps = dependencies(browser, {
      createSession: () => session,
      runJsonl: async (ownedBrowser) => {
        observedBrowser = ownedBrowser;
        await ownedBrowser.close();
      },
    });

    const code = await runWordAgenttoolCli(["jsonl"], deps);

    expect(code).toBe(0);
    expect(observedBrowser).toBeDefined();
    expect(sessionCloseCalls).toBe(1);
    expect(browser.closeCalls).toBe(1);
  });

  test("MCP ownership uses one shared session and always closes it", async () => {
    const browser = new FakeBrowser();
    let sessionCloseCalls = 0;
    const session = {
      sessionId: "session-shared",
      close() {
        sessionCloseCalls += 1;
      },
    } as unknown as WordWireSession;
    let seenSession: WordWireSession | undefined;
    let seenBrowser: AgentBrowser | undefined;
    const deps = dependencies(browser, {
      createSession: () => session,
      runMcp: async (ownedBrowser, ownedSession) => {
        seenBrowser = ownedBrowser;
        seenSession = ownedSession;
      },
    });

    const code = await runWordAgenttoolCli(["mcp"], deps);

    expect(code).toBe(0);
    expect(seenSession).toBe(session);
    expect(seenBrowser).toBeDefined();
    expect(sessionCloseCalls).toBe(1);
    expect(browser.closeCalls).toBe(1);
  });

  test("session construction failure still closes the launched Browser", async () => {
    const browser = new FakeBrowser();
    const stderr = capture();
    const deps = dependencies(browser, {
      stderr,
      createSession: () => {
        throw new Error("session entropy unavailable");
      },
    });

    const code = await runWordAgenttoolCli(["jsonl"], deps);

    expect(code).toBe(1);
    expect(browser.closeCalls).toBe(1);
    expect(captured(stderr)).toContain("session entropy unavailable");
  });

  test("JSONL SIGINT closes both owners once and ends the input", async () => {
    const browser = new FakeBrowser();
    const input = new PassThrough();
    let sessionCloseCalls = 0;
    const session = {
      sessionId: "session-signal",
      close() {
        sessionCloseCalls += 1;
      },
    } as unknown as WordWireSession;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deps = dependencies(browser, {
      stdin: input,
      createSession: () => session,
      runJsonl: async (_ownedBrowser, _ownedSession, options) => {
        started();
        for await (const _chunk of options.input) {
          // Wait for the CLI signal handler to destroy the stream.
        }
      },
    });

    const result = runWordAgenttoolCli(["jsonl"], deps);
    await running;
    process.emit("SIGINT", "SIGINT");
    const code = await result;

    expect(code).toBe(0);
    expect(input.destroyed).toBe(true);
    expect(sessionCloseCalls).toBe(1);
    expect(browser.closeCalls).toBe(1);
  });

  test("startup failures emit no protocol success document", async () => {
    const stdout = capture();
    const stderr = capture();

    const code = await runWordAgenttoolCli(["jsonl"], {
      env: {},
      cwd: "/tmp",
      stdin: Readable.from([]),
      stdout,
      stderr,
      launch: async () => {
        throw Object.assign(new Error("browser unavailable"), {
          code: "browser_launch_failed",
        });
      },
    });

    expect(code).toBe(1);
    expect(captured(stdout)).toBe("");
    expect(captured(stderr)).toContain(
      "error: browser_launch_failed: browser unavailable",
    );
  });
});
