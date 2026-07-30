import type { Readable, Writable } from "node:stream";

import {
  AgentBrowser,
  BROWSER_ENV,
  BROWSER_PACKAGE_VERSION,
  BrowserNetworkPolicy,
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
  publicWordError,
  type WordWireSession,
} from "./protocol.js";
import {
  normalizeWordResolverBaseUrl,
  RemoteWordResolver,
  RemoteWordResolverError,
  WORD_PUBLIC_DEMO_RESOLVER,
  WORD_REMOTE_RESOLVER_LIMITS,
  type RemoteWordResolverPort,
} from "./remote-resolver.js";
import { AgenttoolWordSession } from "./session.js";
import { WORD_AGENTTOOL_VERSION } from "./version.js";

export const WORD_AGENTTOOL_ENV = Object.freeze({
  resolverUrl: "AGENTOOL_WORD_RESOLVER_URL",
});

export interface WordResolverProcessConfig {
  readonly baseUrl?: string;
  readonly configuredBy: "none" | "environment" | "flag" | "public_demo";
  readonly browserArgs: readonly string[];
}

export interface WordAgenttoolCliDependencies {
  env?: Record<string, string | undefined>;
  cwd?: string;
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  launch?: (config: BrowserProcessConfig) => Promise<AgentBrowser>;
  createRemoteResolver?: (
    config: WordResolverProcessConfig,
    browserConfig: BrowserProcessConfig,
  ) => RemoteWordResolverPort | undefined;
  createSession?: (
    browser: AgentBrowser,
    remoteResolver?: RemoteWordResolverPort,
  ) => WordWireSession;
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
  --word-resolver HTTPS_BASE_URL
  --public-resolver                    shorthand for ${WORD_PUBLIC_DEMO_RESOLVER}
  --headless | --headed
  --authority public|local|sovereign
  --public-web | --no-public-web
  --local-network | --no-local-network
  --ephemeral | --profile DIR
  --channel NAME | --executable PATH
  --output-dir DIR

Environment:
  ${WORD_AGENTTOOL_ENV.resolverUrl}=HTTPS_BASE_URL
  ${BROWSER_ENV.headless}=1|0
  ${BROWSER_ENV.authority}=public|local|sovereign
  ${BROWSER_ENV.publicWeb}=1|0
  ${BROWSER_ENV.localNetwork}=1|0
  ${BROWSER_ENV.profile}=ephemeral|persistent
  ${BROWSER_ENV.profileDir}=DIR
  ${BROWSER_ENV.channel}=NAME
  ${BROWSER_ENV.executable}=PATH
  ${BROWSER_ENV.outputDir}=DIR

Local word meanings are bounded caller-supplied state. An optional remote
resolver must be chosen at process start; no tool call accepts or replaces its
HTTPS base URL. Calling word_resolve_remote discloses the exact word in one
bounded credential-free no-redirect read. All resolver, Browser, and page data
is untrusted. Nothing is ranked, selected, planned, opened, retried, or
downloaded automatically. Browser authority remains fixed at process start.
`;

function requiredResolverValue(
  args: readonly string[],
  index: number,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new RemoteWordResolverError("remote_resolver_invalid_config");
  }
  return value;
}

/**
 * Remove only the Word Layer process-start flags before delegating every
 * Browser option to Browser's own strict parser.
 */
export function parseWordResolverProcessConfig(
  args: readonly string[],
  env: Record<string, string | undefined> = process.env,
): WordResolverProcessConfig {
  let rawBase = env[WORD_AGENTTOOL_ENV.resolverUrl]?.trim() || undefined;
  let configuredBy: WordResolverProcessConfig["configuredBy"] =
    rawBase ? "environment" : "none";
  let resolverFlagSeen = false;
  const browserArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--word-resolver") {
      if (resolverFlagSeen) {
        throw new RemoteWordResolverError("remote_resolver_invalid_config");
      }
      rawBase = requiredResolverValue(args, index);
      configuredBy = "flag";
      resolverFlagSeen = true;
      index += 1;
      continue;
    }
    if (argument === "--public-resolver") {
      if (resolverFlagSeen) {
        throw new RemoteWordResolverError("remote_resolver_invalid_config");
      }
      rawBase = WORD_PUBLIC_DEMO_RESOLVER;
      configuredBy = "public_demo";
      resolverFlagSeen = true;
      continue;
    }
    browserArgs.push(argument);
  }

  if (!rawBase) {
    return {
      configuredBy: "none",
      browserArgs,
    };
  }
  return {
    baseUrl: normalizeWordResolverBaseUrl(rawBase),
    configuredBy,
    browserArgs,
  };
}

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
  remoteResolver: RemoteWordResolverPort | undefined,
  dependencies: WordAgenttoolCliDependencies,
): WordWireSession {
  if (dependencies.createSession) {
    return dependencies.createSession(browser, remoteResolver);
  }
  return new AgenttoolWordSession(
    new WordBrowserSession({ browser }),
    remoteResolver,
  );
}

function createRemoteResolver(
  wordConfig: WordResolverProcessConfig,
  browserConfig: BrowserProcessConfig,
  dependencies: WordAgenttoolCliDependencies,
): RemoteWordResolverPort | undefined {
  if (dependencies.createRemoteResolver) {
    return dependencies.createRemoteResolver(wordConfig, browserConfig);
  }
  if (!wordConfig.baseUrl) return undefined;
  const networkPolicy = new BrowserNetworkPolicy(
    browserConfig.authority
      ? { authority: browserConfig.authority }
      : {
          allowPublicWeb: browserConfig.allowPublicWeb,
          allowLocalNetwork: browserConfig.allowLocalNetwork,
        },
  );
  return new RemoteWordResolver({
    baseUrl: wordConfig.baseUrl,
    networkPolicy,
  });
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
    const wordConfig = parseWordResolverProcessConfig(
      args,
      dependencies.env ?? process.env,
    );
    const config = parseBrowserProcessConfig(wordConfig.browserArgs, {
      ...(dependencies.env ? { env: dependencies.env } : {}),
      ...(dependencies.cwd ? { cwd: dependencies.cwd } : {}),
    });
    const remoteResolver = createRemoteResolver(
      wordConfig,
      config,
      dependencies,
    );
    const browser = await launchFrom(config, dependencies);

    if (command === "doctor") {
      try {
        stdout.write(
          `${JSON.stringify({
            ok: true,
            version: "agenttool-word-doctor/0.2",
            integration_version: WORD_AGENTTOOL_VERSION,
            browser_version: BROWSER_PACKAGE_VERSION,
            config: formatProcessConfig(config),
            capabilities: browser.capabilities(),
            word: {
              source_protocol: WORD_REFERENCE_PROTOCOL,
              handoff_protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
              jsonl_protocol: WORD_JSONL_PROTOCOL_VERSION,
              source_model: "caller_supplied_local_state",
              remote_resolver: remoteResolver
                ? {
                    enabled: true,
                    base_url: remoteResolver.baseUrl,
                    configured_by: wordConfig.configuredBy,
                    fixed_at: "process_start",
                    request: "explicit_word_resolve_remote_only",
                    query_disclosed: true,
                    credentials: "omitted",
                    redirects: "blocked",
                    retries: "none",
                    timeout_ms: remoteResolver.timeoutMs,
                    max_response_bytes: remoteResolver.maxResponseBytes,
                    maximum_in_flight:
                      WORD_REMOTE_RESOLVER_LIMITS.maximumInFlight,
                    response_validation:
                      "strict_local_word-reference/0.1_reproduction",
                    trust: "untrusted",
                  }
                : {
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
              remote_source_egress: remoteResolver
                ? "process_fixed_https_on_explicit_resolve"
                : "disabled",
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
      session = createSession(browser, remoteResolver, dependencies);
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
    const detail = error instanceof RemoteWordResolverError
      ? publicWordError(error)
      : publicBrowserError(error);
    stderr.write(`error: ${detail.code}: ${detail.message}\n`);
    return 1;
  }
}
