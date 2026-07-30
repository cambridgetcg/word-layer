import type { Readable, Writable } from "node:stream";

import {
  AgentBrowser,
  BROWSER_ENV,
  BROWSER_PACKAGE_VERSION,
  formatProcessConfig,
  parseBrowserProcessConfig,
  publicBrowserError,
  type BrowserProcessConfig,
} from "@agenttool/browser";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  WORD_BROWSER_HANDOFF_PROTOCOL,
  WORD_REFERENCE_PROTOCOL,
  WordBrowserSession,
} from "word-layer";

import {
  runWordBrowserJsonlSession,
  type WordBrowserJsonlSessionOptions,
} from "./jsonl.js";
import {
  serveWordBrowserMcpStdio,
} from "./mcp.js";
import {
  WORD_JSONL_PROTOCOL_VERSION,
  type WordWireSession,
} from "./protocol.js";
import { WORD_AGENTTOOL_VERSION } from "./version.js";

export interface WordAgenttoolCliDependencies {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  launch?: (config: BrowserProcessConfig) => Promise<AgentBrowser>;
  createSession?: (browser: AgentBrowser) => WordWireSession;
  runMcp?: (
    browser: AgentBrowser,
    session: WordWireSession,
    stderr: Writable,
  ) => Promise<void>;
  runJsonl?: (
    browser: AgentBrowser,
    session: WordWireSession,
    options: WordBrowserJsonlSessionOptions,
  ) => Promise<void>;
}

export const WORD_AGENTTOOL_CLI_HELP = `agenttool-word ${WORD_AGENTTOOL_VERSION}

Usage:
  agenttool-word mcp [startup options]       composed Browser + Word MCP server
  agenttool-word jsonl [startup options]     ${WORD_JSONL_PROTOCOL_VERSION} on stdin/stdout
  agenttool-word doctor [startup options]    launch-and-close configuration check
  agenttool-word help

Startup options:
  --headless | --headed
  --authority public|local|sovereign
  --public-web | --no-public-web
  --local-network | --no-local-network
  --ephemeral | --profile DIR
  --channel NAME | --executable PATH
  --output-dir DIR

Environment:
  ${BROWSER_ENV.headless}=1|0
  ${BROWSER_ENV.authority}=public|local|sovereign
  ${BROWSER_ENV.publicWeb}=1|0
  ${BROWSER_ENV.localNetwork}=1|0
  ${BROWSER_ENV.profile}=ephemeral|persistent
  ${BROWSER_ENV.profileDir}=DIR
  ${BROWSER_ENV.channel}=NAME
  ${BROWSER_ENV.executable}=PATH
  ${BROWSER_ENV.outputDir}=DIR

Word meanings and references are bounded caller-supplied local state. Nothing
is ranked or selected automatically. Browser authority is fixed at process
start; Browser and page data are untrusted. Browser binaries are never
downloaded automatically.
`;

function idempotentBrowser(browser: AgentBrowser): AgentBrowser {
  let closePromise: Promise<void> | undefined;
  return new Proxy(browser, {
    get(target, property, receiver) {
      if (property === "close") {
        return (): Promise<void> => {
          closePromise ??= target.close();
          return closePromise;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function launchFrom(
  config: BrowserProcessConfig,
  dependencies: WordAgenttoolCliDependencies,
): Promise<AgentBrowser> {
  const launched = dependencies.launch
    ? await dependencies.launch(config)
    : await AgentBrowser.launch(
      config.authority
        ? {
            headless: config.headless,
            authority: config.authority,
            profile: config.profile,
            ...(config.channel ? { channel: config.channel } : {}),
            ...(config.executablePath
              ? { executablePath: config.executablePath }
              : {}),
            outputDir: config.outputDir,
          }
        : {
            headless: config.headless,
            allowPublicWeb: config.allowPublicWeb,
            allowLocalNetwork: config.allowLocalNetwork,
            profile: config.profile,
            ...(config.channel ? { channel: config.channel } : {}),
            ...(config.executablePath
              ? { executablePath: config.executablePath }
              : {}),
            outputDir: config.outputDir,
          },
    );
  return idempotentBrowser(launched);
}

function createSession(
  browser: AgentBrowser,
  dependencies: WordAgenttoolCliDependencies,
): WordWireSession {
  if (dependencies.createSession) {
    return dependencies.createSession(browser);
  }
  return new WordBrowserSession({ browser });
}

async function closeComposite(
  session: WordWireSession,
  browser: AgentBrowser,
): Promise<void> {
  try {
    session.close();
  } finally {
    await browser.close();
  }
}

function compositeCloser(
  session: WordWireSession,
  browser: AgentBrowser,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= closeComposite(session, browser);
    return closePromise;
  };
}

async function defaultMcpRunner(
  browser: AgentBrowser,
  session: WordWireSession,
  input: Readable,
  output: Writable,
  stderr: Writable,
): Promise<void> {
  const handle = serveWordBrowserMcpStdio(browser, session, {
    transport: new StdioServerTransport(input, output),
    onerror() {
      stderr.write(
        "error: internal_error: MCP transport or protocol failure\n",
      );
    },
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= handle.close();
    return shutdownPromise;
  };
  const onSignal = () => {
    void shutdown();
  };
  const onInputEnd = () => {
    void shutdown();
  };
  const onInputClose = () => {
    void shutdown();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  input.once("end", onInputEnd);
  input.once("close", onInputClose);
  stderr.write(
    "· agenttool-word MCP ready (local stdio; Browser and source data are untrusted)\n",
  );
  if (input.readableEnded || input.destroyed) {
    void shutdown();
  }
  try {
    await handle.closed;
    await shutdown();
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    input.removeListener("end", onInputEnd);
    input.removeListener("close", onInputClose);
  }
}

export async function runWordAgenttoolCli(
  argv: readonly string[],
  dependencies: WordAgenttoolCliDependencies = {},
): Promise<number> {
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const [command, ...args] = argv;

  if (
    command === undefined
    || command === "help"
    || command === "--help"
    || command === "-h"
  ) {
    stdout.write(WORD_AGENTTOOL_CLI_HELP);
    return 0;
  }
  if (!["mcp", "jsonl", "doctor"].includes(command)) {
    stderr.write(
      `error: unknown command ${JSON.stringify(command)}\n\n`
      + WORD_AGENTTOOL_CLI_HELP,
    );
    return 2;
  }

  try {
    const config = parseBrowserProcessConfig(args, {
      ...(dependencies.env ? { env: dependencies.env } : {}),
      ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    });
    const browser = await launchFrom(config, dependencies);

    if (command === "doctor") {
      try {
        stdout.write(
          `${JSON.stringify({
            ok: true,
            version: "agenttool-word-doctor/0.1",
            integration_version: WORD_AGENTTOOL_VERSION,
            browser_version: BROWSER_PACKAGE_VERSION,
            config: formatProcessConfig(config),
            capabilities: browser.capabilities(),
            word: {
              source_protocol: WORD_REFERENCE_PROTOCOL,
              handoff_protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
              jsonl_protocol: WORD_JSONL_PROTOCOL_VERSION,
              source_model: "caller_supplied_local_state",
              automatic_selection: false,
              automatic_navigation: false,
            },
            checks: {
              browser_launch: "ok",
              automatic_download: false,
              transport: "local_process_only",
            },
          })}\n`,
        );
      } finally {
        await browser.close();
      }
      return 0;
    }

    let session: WordWireSession;
    try {
      session = createSession(browser, dependencies);
    } catch (error) {
      await browser.close();
      throw error;
    }
    const closeOwned = compositeCloser(session, browser);
    try {
      if (command === "jsonl") {
        const runner =
          dependencies.runJsonl ?? runWordBrowserJsonlSession;
        let signalRequested = false;
        const onSignal = () => {
          signalRequested = true;
          stdin.destroy();
          void closeOwned();
        };
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        try {
          try {
            await runner(browser, session, {
              input: stdin,
              output: stdout,
            });
          } catch (error) {
            if (!signalRequested) throw error;
          }
        } finally {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }
      } else {
        const runner = dependencies.runMcp
          ?? (async (
            ownedBrowser: AgentBrowser,
            ownedSession: WordWireSession,
            ownedStderr: Writable,
          ) =>
            defaultMcpRunner(
              ownedBrowser,
              ownedSession,
              stdin,
              stdout,
              ownedStderr,
            ));
        await runner(browser, session, stderr);
      }
    } finally {
      await closeOwned();
    }
    return 0;
  } catch (error) {
    const detail = publicBrowserError(error);
    stderr.write(`error: ${detail.code}: ${detail.message}\n`);
    return 1;
  }
}
