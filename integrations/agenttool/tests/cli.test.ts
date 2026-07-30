import { describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";

import type {
  AgentBrowser,
  BrowserProcessConfig,
} from "@agenttool/browser";

import {
  parseWordResolverProcessConfig,
  runWordAgenttoolCli,
  WORD_AGENTTOOL_ENV,
  WORD_AGENTTOOL_CLI_HELP,
  type WordAgenttoolCliDependencies,
} from "../src/cli.js";
import { WORD_PUBLIC_DEMO_RESOLVER } from "../src/remote-resolver.js";
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

  test("doctor reports local-only source acquisition by default and closes Browser once", async () => {
    const browser = new FakeBrowser();
    const stdout = capture();
    const deps = dependencies(browser, { stdout });

    const code = await runWordAgenttoolCli(["doctor"], deps);
    const report = JSON.parse(captured(stdout));

    expect(code).toBe(0);
    expect(report).toMatchObject({
      ok: true,
      version: "agenttool-word-doctor/0.2",
      word: {
        source_model: "caller_supplied_local_state",
        remote_resolver: {
          enabled: false,
          configured_by: "none",
          request: "unavailable",
        },
        automatic_selection: false,
        automatic_navigation: false,
      },
      checks: {
        browser_launch: "ok",
        automatic_download: false,
        control_transport: "local_process_only",
        remote_source_egress: "disabled",
      },
    });
    expect(browser.closeCalls).toBe(1);
  });

  test("parses one generic process-fixed resolver without consuming Browser flags", () => {
    expect(parseWordResolverProcessConfig([], {})).toEqual({
      configuredBy: "none",
      browserArgs: [],
    });
    expect(
      parseWordResolverProcessConfig([
        "--word-resolver",
        "https://community.example/words",
        "--authority",
        "local",
      ], {}),
    ).toEqual({
      baseUrl: "https://community.example/words/",
      configuredBy: "flag",
      browserArgs: ["--authority", "local"],
    });
    expect(
      parseWordResolverProcessConfig([], {
        [WORD_AGENTTOOL_ENV.resolverUrl]:
          "https://environment.example/community/",
      }),
    ).toEqual({
      baseUrl: "https://environment.example/community/",
      configuredBy: "environment",
      browserArgs: [],
    });
    expect(
      parseWordResolverProcessConfig(["--public-resolver"], {}),
    ).toEqual({
      baseUrl: WORD_PUBLIC_DEMO_RESOLVER,
      configuredBy: "public_demo",
      browserArgs: [],
    });
  });

  test("rejects unsafe or ambiguous resolver startup configuration before Browser launch", async () => {
    for (const args of [
      ["doctor", "--word-resolver", "http://resolver.example"],
      [
        "doctor",
        "--word-resolver",
        "https://resolver.example/?redirect=other",
      ],
      [
        "doctor",
        "--word-resolver",
        "https://resolver.example",
        "--public-resolver",
      ],
    ]) {
      let launches = 0;
      const stderr = capture();
      const code = await runWordAgenttoolCli(args, {
        env: {},
        cwd: "/tmp",
        stdout: capture(),
        stderr,
        launch: async () => {
          launches += 1;
          return new FakeBrowser() as unknown as AgentBrowser;
        },
      });
      expect(code).toBe(1);
      expect(launches).toBe(0);
      expect(captured(stderr)).toContain("remote_resolver_invalid_config");
    }
  });

  test("doctor reports the caller-chosen resolver and its bounded untrusted egress without fetching it", async () => {
    const browser = new FakeBrowser();
    const stdout = capture();
    let resolverFetches = 0;
    const deps = dependencies(browser, {
      stdout,
      createRemoteResolver(config) {
        expect(config.baseUrl).toBe(
          "https://community.example/meaning/",
        );
        return {
          baseUrl: config.baseUrl!,
          timeoutMs: 7_500,
          maxResponseBytes: 500_000,
          async resolve() {
            resolverFetches += 1;
            throw new Error("doctor must not fetch");
          },
        };
      },
    });

    const code = await runWordAgenttoolCli([
      "doctor",
      "--word-resolver",
      "https://community.example/meaning",
    ], deps);
    const report = JSON.parse(captured(stdout));

    expect(code).toBe(0);
    expect(resolverFetches).toBe(0);
    expect(report.word.remote_resolver).toEqual({
      enabled: true,
      base_url: "https://community.example/meaning/",
      configured_by: "flag",
      fixed_at: "process_start",
      request: "explicit_word_resolve_remote_only",
      query_disclosed: true,
      credentials: "omitted",
      redirects: "blocked",
      retries: "none",
      timeout_ms: 7_500,
      max_response_bytes: 500_000,
      maximum_in_flight: 4,
      response_validation: "strict_local_word-reference/0.1_reproduction",
      trust: "untrusted",
    });
    expect(report.checks.remote_source_egress).toBe(
      "process_fixed_https_on_explicit_resolve",
    );
    expect(browser.closeCalls).toBe(1);
  });

  test("passes the fixed resolver to the one shared transport session", async () => {
    const browser = new FakeBrowser();
    let observedBase: string | undefined;
    const deps = dependencies(browser, {
      createSession(_ownedBrowser, remoteResolver) {
        observedBase = remoteResolver?.baseUrl;
        return {
          sessionId: "remote-session",
          close() {},
        } as unknown as WordWireSession;
      },
      runJsonl: async () => {},
    });

    const code = await runWordAgenttoolCli([
      "jsonl",
      "--public-resolver",
    ], deps);

    expect(code).toBe(0);
    expect(observedBase).toBe(WORD_PUBLIC_DEMO_RESOLVER);
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
