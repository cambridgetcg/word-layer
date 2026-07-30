import {
  WordBrowserHandoffError,
  type ExactNameResolutionInput,
  type WordBrowserOffer,
  type WordBrowserSelectionReceipt,
} from "word-layer";

import {
  RemoteWordResolverError,
  type RemoteWordResolveOptions,
  type RemoteWordResolverPort,
} from "./remote-resolver.js";
import {
  type WordResolveRemoteInput,
  type WordWireSession,
} from "./protocol.js";

export type LocalWordWireSession = Omit<WordWireSession, "resolveRemote">;

interface LinkedSignals {
  signal: AbortSignal;
  dispose: () => void;
}

function linkSignals(
  lifetime: AbortSignal,
  request: AbortSignal | undefined,
): LinkedSignals {
  if (!request || request === lifetime) {
    return { signal: lifetime, dispose: () => {} };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of [lifetime, request]) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      lifetime.removeEventListener("abort", abort);
      request.removeEventListener("abort", abort);
    },
  };
}

/**
 * Join one local capability-handoff session to an optional process-configured
 * remote source reader. The reader can acquire only source data; all handles,
 * selection, Browser planning, and Browser opening remain owned by the same
 * local handoff session.
 */
export class AgenttoolWordSession implements WordWireSession {
  readonly sessionId: string;

  readonly #handoff: LocalWordWireSession;
  readonly #remoteResolver: RemoteWordResolverPort | undefined;
  readonly #lifetime = new AbortController();
  #closed = false;

  constructor(
    handoff: LocalWordWireSession,
    remoteResolver?: RemoteWordResolverPort,
  ) {
    this.#handoff = handoff;
    this.#remoteResolver = remoteResolver;
    this.sessionId = handoff.sessionId;
  }

  resolve(input: ExactNameResolutionInput): WordBrowserOffer {
    return this.#handoff.resolve(input);
  }

  async resolveRemote(
    input: WordResolveRemoteInput,
    options: RemoteWordResolveOptions = {},
  ): Promise<WordBrowserOffer> {
    if (this.#closed) {
      throw new WordBrowserHandoffError(
        "session_closed",
        "the word handoff session is closed",
      );
    }
    if (
      !input
      || typeof input !== "object"
      || Array.isArray(input)
      || input.mode !== "exact_name"
      || typeof input.word !== "string"
      || Object.keys(input).some(
        (field) => field !== "mode" && field !== "word",
      )
    ) {
      throw new RemoteWordResolverError("invalid_request");
    }
    if (!this.#remoteResolver) {
      throw new RemoteWordResolverError("remote_resolver_disabled");
    }
    const linked = linkSignals(this.#lifetime.signal, options.signal);
    try {
      if (linked.signal.aborted) {
        throw new RemoteWordResolverError("remote_resolver_aborted");
      }
      const sourceInput = await this.#remoteResolver.resolve(input.word, {
        signal: linked.signal,
      });
      if (linked.signal.aborted) {
        throw new RemoteWordResolverError("remote_resolver_aborted");
      }
      return this.#handoff.resolve(sourceInput);
    } finally {
      linked.dispose();
    }
  }

  select(input: {
    choice_handle: string;
  }): WordBrowserSelectionReceipt {
    return this.#handoff.select(input);
  }

  plan(input: {
    selection_handle: string;
  }): unknown {
    return this.#handoff.plan(input);
  }

  open(input: {
    open_handle: string;
  }): Promise<unknown> {
    return this.#handoff.open(input);
  }

  discardResolution(resolutionId: string): boolean {
    return this.#handoff.discardResolution(resolutionId);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lifetime.abort();
    this.#handoff.close();
  }
}
