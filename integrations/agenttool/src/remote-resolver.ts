import { isDeepStrictEqual } from "node:util";

import {
  normalizeWordName,
  resolveWordReference,
  WORD_REFERENCE_MODE,
  WORD_REFERENCE_PROTOCOL,
  type ExactNameResolutionInput,
  type WordMeaningRecordInput,
  type WordReferenceInput,
  type WordReferenceSourceInput,
} from "word-layer";

export const WORD_PUBLIC_DEMO_RESOLVER =
  "https://word-layer.vercel.app/" as const;

export const WORD_REMOTE_RESOLVER_LIMITS = Object.freeze({
  maximumBaseUrlCodePoints: 8_192,
  maximumBaseUrlBytes: 8_192,
  maximumInFlight: 4,
  defaultTimeoutMs: 10_000,
  maximumTimeoutMs: 60_000,
  defaultResponseBytes: 1_048_576,
  maximumResponseBytes: 1_048_576,
});

export type RemoteWordResolverErrorCode =
  | "invalid_request"
  | "remote_resolver_disabled"
  | "remote_resolver_invalid_config"
  | "remote_resolver_aborted"
  | "remote_resolver_timeout"
  | "remote_resolver_busy"
  | "remote_resolver_network_blocked"
  | "remote_resolver_network_error"
  | "remote_resolver_redirect"
  | "remote_resolver_http_error"
  | "remote_resolver_encoding_invalid"
  | "remote_resolver_length_invalid"
  | "remote_resolver_media_type_invalid"
  | "remote_resolver_response_too_large"
  | "remote_resolver_body_invalid"
  | "remote_resolver_json_invalid"
  | "remote_resolver_response_invalid";

const ERROR_MESSAGES: Readonly<Record<RemoteWordResolverErrorCode, string>> =
  Object.freeze({
    invalid_request: "the exact-name request is invalid",
    remote_resolver_disabled:
      "no remote word resolver was configured at process start",
    remote_resolver_invalid_config:
      "the remote word resolver must be an HTTPS base URL without credentials, query, or fragment",
    remote_resolver_aborted: "the remote word resolver request was cancelled",
    remote_resolver_timeout:
      "the remote word resolver request reached its deadline",
    remote_resolver_busy:
      "the remote word resolver has reached its in-flight request limit",
    remote_resolver_network_blocked:
      "the process-fixed Browser network authority blocks the remote word resolver",
    remote_resolver_network_error:
      "the remote word resolver request failed",
    remote_resolver_redirect:
      "the process-fixed remote word resolver attempted to redirect",
    remote_resolver_http_error:
      "the remote word resolver returned an unsuccessful HTTP status",
    remote_resolver_encoding_invalid:
      "the remote word resolver did not honor the identity content-encoding boundary",
    remote_resolver_length_invalid:
      "the remote word resolver returned an invalid Content-Length header",
    remote_resolver_media_type_invalid:
      "the remote word resolver response was not JSON",
    remote_resolver_response_too_large:
      "the remote word resolver response exceeded the configured byte limit",
    remote_resolver_body_invalid:
      "the remote word resolver response body could not be read",
    remote_resolver_json_invalid:
      "the remote word resolver response contained invalid JSON",
    remote_resolver_response_invalid:
      "the remote word resolver response was not a canonical word-reference/0.1 resolution",
  });

/**
 * Stable public error: it never includes a remote body, configured URL,
 * exception string, DNS answer, or response header value.
 */
export class RemoteWordResolverError extends Error {
  readonly code: RemoteWordResolverErrorCode;

  constructor(code: RemoteWordResolverErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "RemoteWordResolverError";
    this.code = code;
  }
}

export interface WordResolverNetworkPolicy {
  assertAllowed(input: string | URL): Promise<URL>;
}

export interface RemoteWordResolverOptions {
  baseUrl: string;
  networkPolicy: WordResolverNetworkPolicy;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RemoteWordResolveOptions {
  signal?: AbortSignal;
}

export interface RemoteWordResolverPort {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  resolve(
    word: string,
    options?: RemoteWordResolveOptions,
  ): Promise<ExactNameResolutionInput>;
}

interface LinkedDeadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

function scalarLength(value: string): number | undefined {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return undefined;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return undefined;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return undefined;
    }
    length += 1;
  }
  return length;
}

function boundedResolverUrlText(value: string): void {
  const codePoints = scalarLength(value);
  if (
    codePoints === undefined
    || codePoints < 1
    || codePoints > WORD_REMOTE_RESOLVER_LIMITS.maximumBaseUrlCodePoints
    || Buffer.byteLength(value, "utf8")
      > WORD_REMOTE_RESOLVER_LIMITS.maximumBaseUrlBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RemoteWordResolverError("remote_resolver_invalid_config");
  }
}

/**
 * Normalize one caller-chosen process-start resolver base. A path prefix is
 * allowed so independent/community resolvers need not control an origin root.
 * The exact request path is appended later and no tool call can replace it.
 */
export function normalizeWordResolverBaseUrl(input: string): string {
  if (typeof input !== "string" || input.trim() !== input || input.length === 0) {
    throw new RemoteWordResolverError("remote_resolver_invalid_config");
  }
  boundedResolverUrlText(input);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new RemoteWordResolverError("remote_resolver_invalid_config");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname === ""
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw new RemoteWordResolverError("remote_resolver_invalid_config");
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
  boundedResolverUrlText(parsed.href);
  return parsed.href;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved < 1
    || resolved > maximum
  ) {
    throw new RemoteWordResolverError("remote_resolver_invalid_config");
  }
  return resolved;
}

function requestUrl(baseUrl: string, word: string): URL {
  return new URL(
    `v1/resolve/${encodeURIComponent(word)}`,
    baseUrl,
  );
}

function linkedDeadline(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): LinkedDeadline {
  const controller = new AbortController();
  let timeoutReached = false;
  const onParentAbort = () => controller.abort();
  if (parent?.aborted) {
    controller.abort();
  } else {
    parent?.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

function abortError(deadline: LinkedDeadline): RemoteWordResolverError {
  return new RemoteWordResolverError(
    deadline.timedOut()
      ? "remote_resolver_timeout"
      : "remote_resolver_aborted",
  );
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function awaitWithAbort<T>(
  operation: Promise<T>,
  deadline: LinkedDeadline,
  discardLateValue?: (value: T) => void,
): Promise<T> {
  if (deadline.signal.aborted) {
    operation.then(
      (value) => {
        try {
          discardLateValue?.(value);
        } catch {
          // Late cleanup is best effort.
        }
      },
      () => {
        // Observe a late rejection after cancellation.
      },
    );
    return Promise.reject(abortError(deadline));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError(deadline));
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    if (deadline.signal.aborted) onAbort();
    operation.then(
      (value) => {
        if (settled) {
          try {
            discardLateValue?.(value);
          } catch {
            // Late cleanup is best effort.
          }
          return;
        }
        settled = true;
        deadline.signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        deadline.signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {
      // Cleanup is best effort and never replaces the stable primary error.
    });
  } catch {
    // A non-conforming body may throw synchronously.
  }
}

function parseContentLength(input: string | null): number | null {
  if (input === null) return null;
  const normalized = input.trim();
  if (!/^(0|[1-9]\d*)$/u.test(normalized)) {
    throw new RemoteWordResolverError("remote_resolver_length_invalid");
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new RemoteWordResolverError("remote_resolver_length_invalid");
  }
  return value;
}

function isJsonMediaType(input: string | null): boolean {
  if (input === null) return false;
  const mediaType = input.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType === "application/json"
    || /^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(mediaType)
  );
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: LinkedDeadline,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (deadline.signal.aborted) {
    cancelReader(reader);
    return Promise.reject(abortError(deadline));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cancelReader(reader);
      reject(abortError(deadline));
    };
    deadline.signal.addEventListener("abort", onAbort, { once: true });
    if (deadline.signal.aborted) onAbort();
    if (settled) return;
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        deadline.signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        deadline.signal.removeEventListener("abort", onAbort);
        reject(
          deadline.signal.aborted
            ? abortError(deadline)
            : new RemoteWordResolverError("remote_resolver_body_invalid"),
        );
      },
    );
  });
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    void reader.cancel().catch(() => {
      // Cancellation is best effort and never replaces the primary error.
    });
  } catch {
    // A non-conforming reader may throw synchronously.
  }
}

function releaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    // Releasing a non-conforming or still-pending reader is best effort.
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  deadline: LinkedDeadline,
): Promise<Uint8Array> {
  if (response.body === null) {
    throw new RemoteWordResolverError("remote_resolver_body_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await readWithAbort(reader, deadline);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new RemoteWordResolverError("remote_resolver_body_invalid");
      }
      total += part.value.byteLength;
      if (total > maximum) {
        cancelReader(reader);
        throw new RemoteWordResolverError(
          "remote_resolver_response_too_large",
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof RemoteWordResolverError) throw error;
    throw new RemoteWordResolverError(
      deadline.signal.aborted
        ? (deadline.timedOut()
          ? "remote_resolver_timeout"
          : "remote_resolver_aborted")
        : "remote_resolver_body_invalid",
    );
  } finally {
    releaseReader(reader);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteWordResolverError("remote_resolver_response_invalid");
  }
  return value as Record<string, unknown>;
}

function sourceInputFromResolution(
  value: unknown,
  requestedWord: string,
): ExactNameResolutionInput {
  const resolution = record(value);
  if (!Array.isArray(resolution.meanings)) {
    throw new RemoteWordResolverError("remote_resolver_response_invalid");
  }

  const recordsBySource = new Map<string, WordMeaningRecordInput[]>();
  for (const rawMeaning of resolution.meanings) {
    const meaning = record(rawMeaning);
    const provenance = record(meaning.provenance);
    const sourceId = provenance.source_id;
    if (typeof sourceId !== "string" || !Array.isArray(meaning.references)) {
      throw new RemoteWordResolverError("remote_resolver_response_invalid");
    }
    const references: WordReferenceInput[] = meaning.references.map(
      (rawReference) => {
        const reference = record(rawReference);
        return {
          reference_id: reference.reference_id as string,
          kind: reference.kind as string,
          href: reference.href as string,
          asserted_by: reference.asserted_by as string | null,
          proof: reference.proof as string | null,
        };
      },
    );
    const meaningRecord: WordMeaningRecordInput = {
      record_id: provenance.record_id as string,
      word: meaning.word as string,
      language: meaning.language as string,
      definition: meaning.definition as string,
      references,
    };
    const sourceRecords = recordsBySource.get(sourceId) ?? [];
    sourceRecords.push(meaningRecord);
    recordsBySource.set(sourceId, sourceRecords);
  }

  const sources: WordReferenceSourceInput[] = [...recordsBySource]
    .map(([sourceId, records]) => ({
      protocol: WORD_REFERENCE_PROTOCOL,
      source_id: sourceId,
      records,
    }));
  const input: ExactNameResolutionInput = {
    mode: WORD_REFERENCE_MODE,
    word: requestedWord,
    sources,
  };

  let canonical: unknown;
  try {
    canonical = resolveWordReference(input);
  } catch {
    throw new RemoteWordResolverError("remote_resolver_response_invalid");
  }
  if (!isDeepStrictEqual(value, canonical)) {
    throw new RemoteWordResolverError("remote_resolver_response_invalid");
  }
  return input;
}

/**
 * Read one exact-name result from one caller-chosen process-fixed HTTPS base.
 *
 * This is a source-acquisition network read, not Browser navigation. It sends
 * no credentials, follows no redirects, performs no retries, and returns only
 * source input that reproduced the entire remote response under the local pure
 * resolver. Selection and navigation remain later handle-only stages.
 */
export class RemoteWordResolver implements RemoteWordResolverPort {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #networkPolicy: WordResolverNetworkPolicy;
  readonly #fetch: typeof globalThis.fetch;
  #inFlight = 0;

  constructor(options: RemoteWordResolverOptions) {
    if (
      !options
      || typeof options !== "object"
      || !options.networkPolicy
      || typeof options.networkPolicy.assertAllowed !== "function"
    ) {
      throw new RemoteWordResolverError("remote_resolver_invalid_config");
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new RemoteWordResolverError("remote_resolver_invalid_config");
    }
    this.#baseUrl = normalizeWordResolverBaseUrl(options.baseUrl);
    this.#timeoutMs = boundedInteger(
      options.timeoutMs,
      WORD_REMOTE_RESOLVER_LIMITS.defaultTimeoutMs,
      WORD_REMOTE_RESOLVER_LIMITS.maximumTimeoutMs,
    );
    this.#maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      WORD_REMOTE_RESOLVER_LIMITS.defaultResponseBytes,
      WORD_REMOTE_RESOLVER_LIMITS.maximumResponseBytes,
    );
    this.#networkPolicy = options.networkPolicy;
    this.#fetch = fetchImpl;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  get maxResponseBytes(): number {
    return this.#maxResponseBytes;
  }

  async resolve(
    word: string,
    options: RemoteWordResolveOptions = {},
  ): Promise<ExactNameResolutionInput> {
    try {
      normalizeWordName(word);
    } catch {
      throw new RemoteWordResolverError("invalid_request");
    }
    if (options.signal?.aborted) {
      throw new RemoteWordResolverError("remote_resolver_aborted");
    }
    if (
      this.#inFlight
      >= WORD_REMOTE_RESOLVER_LIMITS.maximumInFlight
    ) {
      throw new RemoteWordResolverError("remote_resolver_busy");
    }
    this.#inFlight += 1;
    try {
      const url = requestUrl(this.#baseUrl, word);
      const deadline = linkedDeadline(options.signal, this.#timeoutMs);
      try {
        try {
          if (deadline.signal.aborted) throw abortError(deadline);
          await awaitWithAbort(
            this.#networkPolicy.assertAllowed(url),
            deadline,
          );
        } catch (error) {
          if (error instanceof RemoteWordResolverError) throw error;
          throw new RemoteWordResolverError(
            errorCode(error) === "network_blocked"
              ? "remote_resolver_network_blocked"
              : "remote_resolver_network_error",
          );
        }

        let response: Response;
        try {
          if (deadline.signal.aborted) throw abortError(deadline);
          response = await awaitWithAbort(
            this.#fetch(url, {
              method: "GET",
              headers: {
                Accept: "application/json",
                "Accept-Encoding": "identity",
              },
              credentials: "omit",
              redirect: "manual",
              cache: "no-store",
              referrerPolicy: "no-referrer",
              signal: deadline.signal,
            }),
            deadline,
            cancelBody,
          );
        } catch {
          throw deadline.signal.aborted
            ? abortError(deadline)
            : new RemoteWordResolverError("remote_resolver_network_error");
        }

        if (deadline.signal.aborted) {
          cancelBody(response);
          throw abortError(deadline);
        }
        if (
          response.redirected
          || (response.status >= 300 && response.status < 400)
        ) {
          cancelBody(response);
          throw new RemoteWordResolverError("remote_resolver_redirect");
        }
        if (!response.ok) {
          cancelBody(response);
          throw new RemoteWordResolverError("remote_resolver_http_error");
        }
        if (response.url !== "" && response.url !== url.href) {
          cancelBody(response);
          throw new RemoteWordResolverError("remote_resolver_redirect");
        }

        const contentEncoding = response.headers.get("content-encoding");
        if (
          contentEncoding !== null
          && contentEncoding.trim().toLowerCase() !== "identity"
        ) {
          cancelBody(response);
          throw new RemoteWordResolverError(
            "remote_resolver_encoding_invalid",
          );
        }
        if (!isJsonMediaType(response.headers.get("content-type"))) {
          cancelBody(response);
          throw new RemoteWordResolverError(
            "remote_resolver_media_type_invalid",
          );
        }
        let declaredLength: number | null;
        try {
          declaredLength = parseContentLength(
            response.headers.get("content-length"),
          );
        } catch (error) {
          cancelBody(response);
          throw error;
        }
        if (
          declaredLength !== null
          && declaredLength > this.#maxResponseBytes
        ) {
          cancelBody(response);
          throw new RemoteWordResolverError(
            "remote_resolver_response_too_large",
          );
        }

        const bytes = await readBoundedBody(
          response,
          this.#maxResponseBytes,
          deadline,
        );
        let decoded: unknown;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          decoded = JSON.parse(text) as unknown;
        } catch {
          throw new RemoteWordResolverError("remote_resolver_json_invalid");
        }
        return sourceInputFromResolution(decoded, word);
      } finally {
        deadline.dispose();
      }
    } finally {
      this.#inFlight -= 1;
    }
  }
}
