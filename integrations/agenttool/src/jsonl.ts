import { once } from "node:events";
import type { Writable } from "node:stream";

import {
  executeBrowserOperation,
  publicBrowserError,
  type AgentBrowser,
} from "@agenttool/browser";
import { type z } from "zod";

import {
  WORD_BROWSER_OPERATIONS,
  WORD_INPUT_SCHEMAS,
  WORD_JSONL_PROTOCOL_VERSION,
  WORD_OPERATIONS,
  WORD_TRANSPORT_LIMITS,
  closeWordSession,
  publicWordError,
  unicodeScalarLength,
  type WordBrowserOperation,
  type WordOperation,
  type WordWireSession,
} from "./protocol.js";

type RequestId = string | number;
type InputChunk = string | Uint8Array;

type ProtocolErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "unsupported_version"
  | "method_not_found"
  | "invalid_params";

type FramingErrorCode = "line_too_large" | "invalid_utf8";
type EncodingFailure = "serialization_failed" | "result_too_large";

interface JsonRecord {
  [key: string]: unknown;
}

interface ParsedRequest {
  version: typeof WORD_JSONL_PROTOCOL_VERSION;
  id: RequestId;
  method: WordBrowserOperation;
  params: JsonRecord;
}

interface BoundedLine {
  text?: string;
  error?: FramingErrorCode;
}

interface EncodedLine {
  line: string;
  failure?: EncodingFailure;
}

interface ErrorDetail {
  code: string;
  message: string;
}

interface SuccessEnvelope {
  version: typeof WORD_JSONL_PROTOCOL_VERSION;
  id: RequestId;
  ok: true;
  result: unknown;
}

interface ErrorEnvelope {
  version: typeof WORD_JSONL_PROTOCOL_VERSION;
  id: RequestId | null;
  ok: false;
  error: ErrorDetail;
}

type ResponseEnvelope = SuccessEnvelope | ErrorEnvelope;

export interface WordBrowserJsonlSessionOptions {
  input: AsyncIterable<InputChunk>;
  output: Writable;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

class JsonlProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly requestId?: RequestId;

  constructor(
    code: ProtocolErrorCode,
    message: string,
    requestId?: RequestId,
  ) {
    super(message);
    this.name = "JsonlProtocolError";
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

const OPERATIONS: ReadonlySet<string> = new Set(WORD_BROWSER_OPERATIONS);
const WORD_OPERATION_SET: ReadonlySet<string> = new Set(WORD_OPERATIONS);

function isWordOperation(
  method: WordBrowserOperation,
): method is WordOperation {
  return WORD_OPERATION_SET.has(method);
}

function protocolError(
  code: ProtocolErrorCode,
  message: string,
  requestId?: RequestId,
): JsonlProtocolError {
  return new JsonlProtocolError(code, message, requestId);
}

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("invalid_request", "request must be a JSON object");
  }
  return value as JsonRecord;
}

function validRequestId(value: unknown): value is RequestId {
  const scalarLength =
    typeof value === "string" ? unicodeScalarLength(value) : undefined;
  return (
    (typeof value === "string"
      && scalarLength !== undefined
      && scalarLength > 0
      && scalarLength <= 200)
    || (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function parseRequest(text: string): ParsedRequest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw protocolError("invalid_json", "line is not valid JSON");
  }

  const value = asRecord(decoded);
  const id = value.id;
  if (!validRequestId(id)) {
    throw protocolError(
      "invalid_request",
      "id must be a non-empty string or safe integer",
    );
  }

  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => !["version", "id", "method", "params"].includes(key),
    )
  ) {
    throw protocolError(
      "invalid_request",
      "request contains an unknown top-level field",
      id,
    );
  }

  if (value.version !== WORD_JSONL_PROTOCOL_VERSION) {
    throw protocolError(
      "unsupported_version",
      `version must be ${WORD_JSONL_PROTOCOL_VERSION}`,
      id,
    );
  }

  if (
    typeof value.method !== "string"
    || !OPERATIONS.has(value.method)
  ) {
    throw protocolError("method_not_found", "unknown word/browser method", id);
  }

  let params: JsonRecord;
  try {
    params = value.params === undefined ? {} : asRecord(value.params);
  } catch {
    throw protocolError(
      "invalid_request",
      "params must be a JSON object",
      id,
    );
  }

  return {
    version: WORD_JSONL_PROTOCOL_VERSION,
    id,
    method: value.method as WordBrowserOperation,
    params,
  };
}

function parsedWordParams<Method extends WordOperation>(
  method: Method,
  params: JsonRecord,
): z.output<(typeof WORD_INPUT_SCHEMAS)[Method]> {
  const parsed = WORD_INPUT_SCHEMAS[method].safeParse(params);
  if (!parsed.success) {
    throw protocolError(
      "invalid_params",
      parsed.error.issues
        .slice(0, 4)
        .map(
          (issue) =>
            `${issue.path.join(".") || "params"}: ${issue.message}`,
        )
        .join("; ")
        .slice(0, 2_000),
    );
  }
  return parsed.data as z.output<(typeof WORD_INPUT_SCHEMAS)[Method]>;
}

/**
 * Execute one operation from the shared Word/Browser registry. No operation
 * is retried here or in the framing loop.
 */
export async function executeWordBrowserOperation(
  browser: AgentBrowser,
  session: WordWireSession,
  method: WordBrowserOperation,
  rawParams: Record<string, unknown>,
): Promise<unknown> {
  if (!isWordOperation(method)) {
    if (method === "browser_close") {
      const closingBrowser = {
        async close(): Promise<void> {
          session.close();
          await browser.close();
        },
      } as unknown as AgentBrowser;
      return await executeBrowserOperation(
        closingBrowser,
        method,
        rawParams,
      );
    }
    return await executeBrowserOperation(browser, method, rawParams);
  }

  switch (method) {
    case "word_resolve": {
      const params = parsedWordParams(method, rawParams);
      return session.resolve(
        params as unknown as Parameters<WordWireSession["resolve"]>[0],
      );
    }
    case "word_select":
      return session.select(parsedWordParams(method, rawParams));
    case "word_plan":
      return session.plan(parsedWordParams(method, rawParams));
    case "word_open":
      return await session.open(parsedWordParams(method, rawParams));
    case "word_close":
      parsedWordParams(method, rawParams);
      return closeWordSession(session);
  }
}

async function* boundedLines(
  input: AsyncIterable<InputChunk>,
  maxBytes: number,
): AsyncGenerator<BoundedLine> {
  let parts: Buffer[] = [];
  let bytes = 0;
  let discarding = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const finish = (): BoundedLine => {
    if (discarding) {
      parts = [];
      bytes = 0;
      discarding = false;
      return { error: "line_too_large" };
    }

    const value = Buffer.concat(parts, bytes);
    parts = [];
    bytes = 0;
    const content =
      value.length > 0 && value[value.length - 1] === 13
        ? value.subarray(0, value.length - 1)
        : value;
    try {
      return { text: decoder.decode(content) };
    } catch {
      return { error: "invalid_utf8" };
    }
  };

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk)
      ? rawChunk
      : Buffer.from(rawChunk);
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue;

      const segment = chunk.subarray(start, index);
      if (!discarding) {
        if (bytes + segment.length > maxBytes) {
          discarding = true;
          parts = [];
          bytes = 0;
        } else if (segment.length > 0) {
          parts.push(segment);
          bytes += segment.length;
        }
      }
      yield finish();
      start = index + 1;
    }

    const remainder = chunk.subarray(start);
    if (!discarding) {
      if (bytes + remainder.length > maxBytes) {
        discarding = true;
        parts = [];
        bytes = 0;
      } else if (remainder.length > 0) {
        parts.push(remainder);
        bytes += remainder.length;
      }
    }
  }

  if (discarding || bytes > 0) yield finish();
}

function jsonString(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") throw new TypeError("not serializable");
  return encoded;
}

function encodedLine(
  envelope: ResponseEnvelope,
  maxBytes: number,
  id: RequestId | null,
): EncodedLine {
  let line: string;
  let failure: EncodingFailure | undefined;
  try {
    line = jsonString(envelope);
  } catch {
    failure = "serialization_failed";
    line = jsonString({
      version: WORD_JSONL_PROTOCOL_VERSION,
      id,
      ok: false,
      error: {
        code: "serialization_failed",
        message: "result is not JSON serializable",
      },
    });
  }

  if (Buffer.byteLength(line, "utf8") + 1 <= maxBytes) {
    return {
      line: `${line}\n`,
      ...(failure ? { failure } : {}),
    };
  }

  failure = "result_too_large";
  const withId = jsonString({
    version: WORD_JSONL_PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
      code: "result_too_large",
      message: `result exceeds ${maxBytes} bytes`,
    },
  });
  if (Buffer.byteLength(withId, "utf8") + 1 <= maxBytes) {
    return { line: `${withId}\n`, failure };
  }

  const withoutId = jsonString({
    version: WORD_JSONL_PROTOCOL_VERSION,
    id: null,
    ok: false,
    error: {
      code: "result_too_large",
      message: "result exceeds response bound",
    },
  });
  return { line: `${withoutId}\n`, failure };
}

async function writeLine(output: Writable, line: string): Promise<void> {
  if (output.write(line)) return;
  await once(output, "drain");
}

function operationError(
  error: unknown,
  method: WordBrowserOperation,
): ErrorDetail {
  if (error instanceof JsonlProtocolError) {
    return { code: error.code, message: error.message };
  }
  return isWordOperation(method)
    ? publicWordError(error)
    : publicBrowserError(error);
}

function parsingError(error: unknown): {
  id: RequestId | null;
  detail: ErrorDetail;
} {
  if (error instanceof JsonlProtocolError) {
    return {
      id: validRequestId(error.requestId) ? error.requestId : null,
      detail: { code: error.code, message: error.message },
    };
  }
  return {
    id: null,
    detail: {
      code: "internal_error",
      message: "word/browser protocol operation failed",
    },
  };
}

function resolutionIdFrom(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  try {
    const resolutionId = Reflect.get(result, "resolution_id");
    return typeof resolutionId === "string" ? resolutionId : undefined;
  } catch {
    return undefined;
  }
}

function discardUndeliverableResolution(
  session: WordWireSession,
  resolutionId: string,
): void {
  try {
    session.discardResolution(resolutionId);
  } catch {
    // Delivery failure remains the public result; cleanup is best-effort if a
    // non-conforming structural session throws from its invalidation hook.
  }
}

export async function runWordBrowserJsonlSession(
  browser: AgentBrowser,
  session: WordWireSession,
  options: WordBrowserJsonlSessionOptions,
): Promise<void> {
  const maxRequestBytes =
    options.maxRequestBytes
    ?? WORD_TRANSPORT_LIMITS.maximumRequestBytes;
  const maxResponseBytes =
    options.maxResponseBytes
    ?? WORD_TRANSPORT_LIMITS.maximumResponseBytes;

  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new Error("maxRequestBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 256) {
    throw new Error(
      "maxResponseBytes must be a safe integer of at least 256",
    );
  }

  for await (const line of boundedLines(options.input, maxRequestBytes)) {
    if (line.text !== undefined && line.text.trim() === "") continue;

    let id: RequestId | null = null;
    let envelope: ResponseEnvelope;
    let successfulWordResolution: string | undefined;

    if (line.error) {
      envelope = {
        version: WORD_JSONL_PROTOCOL_VERSION,
        id,
        ok: false,
        error: {
          code: line.error,
          message:
            line.error === "line_too_large"
              ? `request line exceeds ${maxRequestBytes} bytes`
              : "request line is not valid UTF-8",
        },
      };
    } else {
      let request: ParsedRequest;
      try {
        request = parseRequest(line.text ?? "");
        id = request.id;
      } catch (error) {
        const parsed = parsingError(error);
        id = parsed.id;
        envelope = {
          version: WORD_JSONL_PROTOCOL_VERSION,
          id,
          ok: false,
          error: parsed.detail,
        };
        const encoded = encodedLine(envelope, maxResponseBytes, id);
        await writeLine(options.output, encoded.line);
        continue;
      }

      try {
        const result = await executeWordBrowserOperation(
          browser,
          session,
          request.method,
          request.params,
        );
        envelope = {
          version: WORD_JSONL_PROTOCOL_VERSION,
          id,
          ok: true,
          result,
        };
        if (isWordOperation(request.method)) {
          successfulWordResolution = resolutionIdFrom(result);
        }
      } catch (error) {
        envelope = {
          version: WORD_JSONL_PROTOCOL_VERSION,
          id,
          ok: false,
          error: operationError(error, request.method),
        };
      }
    }

    const encoded = encodedLine(envelope, maxResponseBytes, id);
    if (encoded.failure && successfulWordResolution !== undefined) {
      discardUndeliverableResolution(session, successfulWordResolution);
    }
    await writeLine(options.output, encoded.line);
  }
}
