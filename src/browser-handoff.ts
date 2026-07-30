import { randomBytes as secureRandomBytes } from "node:crypto";

import {
  WORD_REFERENCE_PROTOCOL,
  resolveWordReference,
  type ExactNameResolutionInput,
  type ResolvedWordMeaning,
  type ResolvedWordReference,
  type WordReferenceResolution,
} from "./reference.js";

export const WORD_BROWSER_HANDOFF_PROTOCOL =
  "word-browser-handoff/0.1" as const;

export const WORD_BROWSER_HANDOFF_LIMITS = Object.freeze({
  defaultTtlMs: 5 * 60 * 1_000,
  maximumTtlMs: 60 * 60 * 1_000,
  defaultActiveHandles: 4_096,
  maximumActiveHandles: 4_096,
  defaultActiveResolutions: 16,
  maximumActiveResolutions: 1_024,
  defaultOfferBytes: 256 * 1_024,
  maximumOfferBytes: 1_024 * 1_024,
  entropyBytes: 32,
});

export type WordBrowserHandoffErrorCode =
  | "invalid_request"
  | "invalid_options"
  | "invalid_handle"
  | "handle_expired"
  | "session_closed"
  | "state_full"
  | "result_too_large"
  | "browser_plan_failed"
  | "browser_open_failed"
  | "internal_error";

export class WordBrowserHandoffError extends Error {
  readonly code: WordBrowserHandoffErrorCode;

  constructor(code: WordBrowserHandoffErrorCode, message: string) {
    super(message);
    this.name = "WordBrowserHandoffError";
    this.code = code;
  }
}

/**
 * The smallest structural slice of AgentTool Browser needed by this adapter.
 * AgentBrowser satisfies this interface without making word-layer depend on
 * Browser internals.
 */
export interface WordBrowserPlan {
  readonly execution: false;
}

export interface WordBrowserPort<
  PlanResult extends WordBrowserPlan,
  OpenResult,
> {
  /**
   * Both results must be plain, finite, acyclic JSON data. Plan results must
   * not contain an `href` property at any depth.
   */
  plan(action: Readonly<{ kind: "new_tab"; url: string }>): PlanResult;
  open(url: string): Promise<OpenResult>;
}

export interface WordBrowserSessionOptions<
  PlanResult extends WordBrowserPlan,
  OpenResult,
> {
  browser: WordBrowserPort<PlanResult, OpenResult>;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  ttlMs?: number;
  maxActiveHandles?: number;
  maxActiveResolutions?: number;
  maxOfferBytes?: number;
}

export interface WordBrowserMeaningProvenance {
  source_id: string;
  record_id: string;
  definition_sha256: string;
}

export interface WordBrowserOfferedReference {
  reference_id: string;
  kind: string;
  source_id: string;
  asserted_by: string | null;
  proof: string | null;
  verification: "unverified";
  trust: "untrusted";
  display_url: string;
  target_redacted: boolean;
  selectable: boolean;
  choice_handle: string | null;
}

export interface WordBrowserOfferedMeaning {
  meaning_id: string;
  word: string;
  language: string;
  definition: string;
  provenance: WordBrowserMeaningProvenance;
  trust: "untrusted";
  references: WordBrowserOfferedReference[];
}

export interface WordBrowserOffer {
  protocol: typeof WORD_BROWSER_HANDOFF_PROTOCOL;
  source_protocol: typeof WORD_REFERENCE_PROTOCOL;
  session_id: string;
  resolution_id: string;
  observed_at: string;
  expires_at: string;
  query: WordReferenceResolution["query"];
  found: boolean;
  meanings: WordBrowserOfferedMeaning[];
  ambiguity: {
    meanings: number;
    references: number;
    browser_choices: number;
    automatic_selection: false;
  };
  selection: null;
  authority: "none";
  automatic_action: "never";
}

export interface WordBrowserSelectedReference {
  query: {
    normalized: string;
  };
  meaning_id: string;
  word: string;
  language: string;
  provenance: WordBrowserMeaningProvenance;
  reference_id: string;
  kind: "site";
  source_id: string;
  asserted_by: string | null;
  proof: string | null;
  verification: "unverified";
  trust: "untrusted";
  display_url: string;
  target_redacted: boolean;
}

export interface WordBrowserSelectionReceipt {
  protocol: typeof WORD_BROWSER_HANDOFF_PROTOCOL;
  session_id: string;
  resolution_id: string;
  selection_handle: string;
  selected_at: string;
  expires_at: string;
  selected: WordBrowserSelectedReference;
  next: "plan";
  authority: "none";
  automatic_action: "never";
}

export interface WordBrowserPlanReceipt<PlanResult extends WordBrowserPlan> {
  protocol: typeof WORD_BROWSER_HANDOFF_PROTOCOL;
  session_id: string;
  resolution_id: string;
  open_handle: string;
  planned_at: string;
  expires_at: string;
  selected: WordBrowserSelectedReference;
  browser_action: {
    kind: "new_tab";
  };
  browser_plan: PlanResult;
  next: "open";
  authority: "none";
  automatic_action: "never";
}

export interface WordBrowserOpenReceipt<OpenResult> {
  protocol: typeof WORD_BROWSER_HANDOFF_PROTOCOL;
  session_id: string;
  resolution_id: string;
  attempted_at: string;
  attempted_once: true;
  selected: WordBrowserSelectedReference;
  browser_result: OpenResult;
}

interface StoredTarget {
  readonly href: string;
  readonly queryNormalized: string;
  readonly meaning_id: string;
  readonly word: string;
  readonly language: string;
  readonly provenanceSourceId: string;
  readonly recordId: string;
  readonly definitionSha256: string;
  readonly reference_id: string;
  readonly kind: "site";
  readonly source_id: string;
  readonly asserted_by: string | null;
  readonly proof: string | null;
  readonly verification: "unverified";
  readonly trust: "untrusted";
  readonly display_url: string;
  readonly target_redacted: boolean;
}

interface HandleRecord {
  readonly resolutionId: string;
  readonly expiresAt: number;
  readonly target: StoredTarget;
}

interface ResolutionState {
  readonly expiresAt: number;
  readonly choiceHandles: Set<string>;
  readonly selectionHandles: Set<string>;
  readonly openHandles: Set<string>;
}

const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const HANDLE_INPUT_LIMIT = 512;
let nextProcessSessionOrdinal = 0;

function allocateProcessSessionOrdinal(): string {
  if (nextProcessSessionOrdinal >= Number.MAX_SAFE_INTEGER) {
    throw new WordBrowserHandoffError(
      "internal_error",
      "process-local handoff session space is exhausted",
    );
  }
  nextProcessSessionOrdinal += 1;
  return nextProcessSessionOrdinal.toString(36);
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainWireJson(
  value: unknown,
  forbidHref: boolean,
  ancestors = new Set<object>(),
): boolean {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value)
    && prototype !== Object.prototype
    && prototype !== null
  ) {
    return false;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownNames = Object.getOwnPropertyNames(value);
      if (
        ownNames.some((name) =>
          name !== "length"
          && !/^(?:0|[1-9][0-9]*)$/.test(name)
        )
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          index.toString(),
        );
        if (
          !descriptor
          || !("value" in descriptor)
          || !descriptor.enumerable
          || !isPlainWireJson(descriptor.value, forbidHref, ancestors)
        ) {
          return false;
        }
      }
      return true;
    }

    for (const name of Object.getOwnPropertyNames(value)) {
      if (forbidHref && name === "href") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (
        !descriptor
        || !("value" in descriptor)
        || !descriptor.enumerable
        || !isPlainWireJson(descriptor.value, forbidHref, ancestors)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function requireExactObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<PropertyKey, unknown> {
  if (!isObject(value)) {
    throw new WordBrowserHandoffError(
      "invalid_request",
      `${label} must be an object`,
    );
  }
  const fields = Reflect.ownKeys(value);
  for (const field of fields) {
    if (typeof field !== "string" || !allowed.includes(field)) {
      throw new WordBrowserHandoffError(
        "invalid_request",
        `${label} contains an unknown field`,
      );
    }
  }
  for (const field of allowed) {
    if (!fields.includes(field)) {
      throw new WordBrowserHandoffError(
        "invalid_request",
        `${label}.${field} is required`,
      );
    }
  }
  return value;
}

function requireHandle(
  value: Record<PropertyKey, unknown>,
  field: string,
): string {
  const handle = value[field];
  if (
    typeof handle !== "string"
    || handle.length === 0
    || handle.length > HANDLE_INPUT_LIMIT
  ) {
    throw new WordBrowserHandoffError(
      "invalid_request",
      `${field} must be a bounded string`,
    );
  }
  return handle;
}

function requireBoundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate)
    || (candidate as number) < 1
    || (candidate as number) > maximum
  ) {
    throw new WordBrowserHandoffError(
      "invalid_options",
      `${field} must be an integer from 1 through ${maximum}`,
    );
  }
  return candidate as number;
}

function displayTarget(href: string): {
  displayUrl: string;
  targetRedacted: boolean;
} {
  const parsed = new URL(href);
  parsed.search = "";
  parsed.hash = "";
  const displayUrl = parsed.href;
  return {
    displayUrl,
    targetRedacted: displayUrl !== href,
  };
}

function formatTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function selectedView(target: StoredTarget): WordBrowserSelectedReference {
  return {
    query: {
      normalized: target.queryNormalized,
    },
    meaning_id: target.meaning_id,
    word: target.word,
    language: target.language,
    provenance: {
      source_id: target.provenanceSourceId,
      record_id: target.recordId,
      definition_sha256: target.definitionSha256,
    },
    reference_id: target.reference_id,
    kind: target.kind,
    source_id: target.source_id,
    asserted_by: target.asserted_by,
    proof: target.proof,
    verification: target.verification,
    trust: target.trust,
    display_url: target.display_url,
    target_redacted: target.target_redacted,
  };
}

function storedTarget(
  meaning: ResolvedWordMeaning,
  reference: ResolvedWordReference,
  queryNormalized: string,
): StoredTarget {
  const { displayUrl, targetRedacted } = displayTarget(reference.href);
  return Object.freeze({
    href: reference.href,
    queryNormalized,
    meaning_id: meaning.meaning_id,
    word: meaning.word,
    language: meaning.language,
    provenanceSourceId: meaning.provenance.source_id,
    recordId: meaning.provenance.record_id,
    definitionSha256: meaning.provenance.definition_sha256,
    reference_id: reference.reference_id,
    kind: "site",
    source_id: reference.source_id,
    asserted_by: reference.asserted_by,
    proof: reference.proof,
    verification: reference.verification,
    trust: reference.trust,
    display_url: displayUrl,
    target_redacted: targetRedacted,
  });
}

function offeredReference(
  reference: ResolvedWordReference,
  choiceHandle: string | null,
): WordBrowserOfferedReference {
  const { displayUrl, targetRedacted } = displayTarget(reference.href);
  return {
    reference_id: reference.reference_id,
    kind: reference.kind,
    source_id: reference.source_id,
    asserted_by: reference.asserted_by,
    proof: reference.proof,
    verification: reference.verification,
    trust: reference.trust,
    display_url: displayUrl,
    target_redacted: targetRedacted,
    selectable: choiceHandle !== null,
    choice_handle: choiceHandle,
  };
}

function wrapResolutionError(cause: unknown): never {
  if (cause instanceof WordBrowserHandoffError) throw cause;
  throw new WordBrowserHandoffError(
    "invalid_request",
    cause instanceof Error
      ? `word resolution rejected the request: ${cause.message}`
      : "word resolution rejected the request",
  );
}

/**
 * A process-local capability session joining pure word resolution to an
 * existing AgentTool Browser instance.
 *
 * Every stage accepts only the opaque handle produced by the previous stage.
 * The exact href is never accepted back from the caller; it is retained here
 * for continuity, while Browser planning may return its own redacted target
 * summary. The final open ticket is consumed before Browser I/O begins.
 */
export class WordBrowserSession<
  PlanResult extends WordBrowserPlan,
  OpenResult,
> {
  readonly sessionId: string;

  readonly #browser: WordBrowserPort<PlanResult, OpenResult>;
  readonly #now: () => number;
  readonly #randomBytes: (length: number) => Uint8Array;
  readonly #ttlMs: number;
  readonly #maxActiveHandles: number;
  readonly #maxActiveResolutions: number;
  readonly #maxOfferBytes: number;
  readonly #sessionOrdinal: string;

  readonly #choices = new Map<string, HandleRecord>();
  readonly #selections = new Map<string, HandleRecord>();
  readonly #opens = new Map<string, HandleRecord>();
  readonly #resolutions = new Map<string, ResolutionState>();
  readonly #transitioning = new Set<string>();

  #lastNow: number | undefined;
  #idCounter = 0;
  #closed = false;
  #resolving = false;

  constructor(
    options: WordBrowserSessionOptions<PlanResult, OpenResult>,
  ) {
    if (!isObject(options)) {
      throw new WordBrowserHandoffError(
        "invalid_options",
        "options must be an object",
      );
    }
    const browser = options.browser;
    if (
      !isObject(browser)
      || typeof browser.plan !== "function"
      || typeof browser.open !== "function"
    ) {
      throw new WordBrowserHandoffError(
        "invalid_options",
        "browser must provide plan and open methods",
      );
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new WordBrowserHandoffError(
        "invalid_options",
        "now must be a function",
      );
    }
    if (
      options.randomBytes !== undefined
      && typeof options.randomBytes !== "function"
    ) {
      throw new WordBrowserHandoffError(
        "invalid_options",
        "randomBytes must be a function",
      );
    }

    this.#browser = browser as WordBrowserPort<PlanResult, OpenResult>;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
    this.#ttlMs = requireBoundedInteger(
      options.ttlMs,
      WORD_BROWSER_HANDOFF_LIMITS.defaultTtlMs,
      WORD_BROWSER_HANDOFF_LIMITS.maximumTtlMs,
      "ttlMs",
    );
    this.#maxActiveHandles = requireBoundedInteger(
      options.maxActiveHandles,
      WORD_BROWSER_HANDOFF_LIMITS.defaultActiveHandles,
      WORD_BROWSER_HANDOFF_LIMITS.maximumActiveHandles,
      "maxActiveHandles",
    );
    this.#maxActiveResolutions = requireBoundedInteger(
      options.maxActiveResolutions,
      WORD_BROWSER_HANDOFF_LIMITS.defaultActiveResolutions,
      WORD_BROWSER_HANDOFF_LIMITS.maximumActiveResolutions,
      "maxActiveResolutions",
    );
    this.#maxOfferBytes = requireBoundedInteger(
      options.maxOfferBytes,
      WORD_BROWSER_HANDOFF_LIMITS.defaultOfferBytes,
      WORD_BROWSER_HANDOFF_LIMITS.maximumOfferBytes,
      "maxOfferBytes",
    );
    this.#sessionOrdinal = allocateProcessSessionOrdinal();
    this.sessionId = this.#allocateId("session", "invalid_options");
  }

  resolve(input: ExactNameResolutionInput): WordBrowserOffer {
    this.#assertOpen();
    if (this.#resolving) {
      throw new WordBrowserHandoffError(
        "internal_error",
        "reentrant resolution is not allowed",
      );
    }
    this.#resolving = true;
    try {
      return this.#resolve(input);
    } finally {
      this.#resolving = false;
    }
  }

  #resolve(input: ExactNameResolutionInput): WordBrowserOffer {
    requireExactObject(input, ["mode", "word", "sources"], "resolution input");

    let resolution: WordReferenceResolution;
    try {
      resolution = resolveWordReference(input);
    } catch (cause) {
      wrapResolutionError(cause);
    }

    const now = this.#readNow();
    this.#pruneExpired(now);
    const siteCount = resolution.meanings.reduce(
      (count, meaning) =>
        count
        + meaning.references.filter((reference) => reference.kind === "site")
          .length,
      0,
    );
    if (
      this.#activeHandleCount() + siteCount > this.#maxActiveHandles
      || (
        siteCount > 0
        && this.#resolutions.size + 1 > this.#maxActiveResolutions
      )
    ) {
      throw new WordBrowserHandoffError(
        "state_full",
        "browser handoff state is full",
      );
    }

    const expiresAt = now + this.#ttlMs;
    if (
      !Number.isSafeInteger(expiresAt)
      || expiresAt > MAX_DATE_MILLISECONDS
    ) {
      throw new WordBrowserHandoffError(
        "internal_error",
        "clock cannot produce a representable expiry",
      );
    }

    /*
     * Allocation is prepared off-map. If entropy fails, no capability or
     * resolution becomes reachable.
     */
    const resolutionId = this.#allocateId("resolution");
    const preparedChoices = new Map<
      ResolvedWordReference,
      { handle: string; record: HandleRecord }
    >();
    for (const meaning of resolution.meanings) {
      for (const reference of meaning.references) {
        if (reference.kind !== "site") continue;
        const handle = this.#allocateId("choice");
        preparedChoices.set(reference, {
          handle,
          record: Object.freeze({
            resolutionId,
            expiresAt,
            target: storedTarget(
              meaning,
              reference,
              resolution.query.normalized,
            ),
          }),
        });
      }
    }

    const meanings: WordBrowserOfferedMeaning[] = resolution.meanings.map(
      (meaning) => ({
        meaning_id: meaning.meaning_id,
        word: meaning.word,
        language: meaning.language,
        definition: meaning.definition,
        provenance: {
          source_id: meaning.provenance.source_id,
          record_id: meaning.provenance.record_id,
          definition_sha256: meaning.provenance.definition_sha256,
        },
        trust: meaning.trust,
        references: meaning.references.map((reference) =>
          offeredReference(
            reference,
            preparedChoices.get(reference)?.handle ?? null,
          )),
      }),
    );

    const offer: WordBrowserOffer = {
      protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
      source_protocol: WORD_REFERENCE_PROTOCOL,
      session_id: this.sessionId,
      resolution_id: resolutionId,
      observed_at: formatTime(now),
      expires_at: formatTime(expiresAt),
      query: {
        input: resolution.query.input,
        normalized: resolution.query.normalized,
      },
      found: resolution.found,
      meanings,
      ambiguity: {
        meanings: resolution.ambiguity.meanings,
        references: resolution.ambiguity.references,
        browser_choices: preparedChoices.size,
        automatic_selection: false,
      },
      selection: null,
      authority: "none",
      automatic_action: "never",
    };
    let offerBytes: number;
    try {
      offerBytes = Buffer.byteLength(JSON.stringify(offer), "utf8");
    } catch {
      throw new WordBrowserHandoffError(
        "internal_error",
        "the handoff offer could not be serialized",
      );
    }
    if (offerBytes > this.#maxOfferBytes) {
      throw new WordBrowserHandoffError(
        "result_too_large",
        "the handoff offer exceeds the configured byte limit",
      );
    }

    const readyAt = this.#readNow();
    if (readyAt >= expiresAt) {
      throw new WordBrowserHandoffError(
        "handle_expired",
        "the handoff offer expired while it was being prepared",
      );
    }
    this.#assertOpen();
    if (preparedChoices.size > 0) {
      const state: ResolutionState = {
        expiresAt,
        choiceHandles: new Set(),
        selectionHandles: new Set(),
        openHandles: new Set(),
      };
      for (const { handle, record } of preparedChoices.values()) {
        this.#choices.set(handle, record);
        state.choiceHandles.add(handle);
      }
      this.#resolutions.set(resolutionId, state);
    }

    return offer;
  }

  select(input: { choice_handle: string }): WordBrowserSelectionReceipt {
    this.#assertOpen();
    const request = requireExactObject(
      input,
      ["choice_handle"],
      "selection input",
    );
    const choiceHandle = requireHandle(request, "choice_handle");
    const now = this.#readNow();
    const record = this.#requireActive(
      this.#choices,
      choiceHandle,
      now,
    );
    this.#beginTransition(choiceHandle);
    try {
      const selectionHandle = this.#allocateId("selection");
      const selectedAt = this.#readNow();
      if (selectedAt >= record.expiresAt) {
        this.#dropResolution(record.resolutionId);
        throw new WordBrowserHandoffError(
          "handle_expired",
          "the handoff handle has expired",
        );
      }
      this.#assertTransitionSource(
        this.#choices,
        choiceHandle,
        record,
      );
      const state = this.#resolutions.get(record.resolutionId);
      if (!state) {
        throw new WordBrowserHandoffError(
          "internal_error",
          "resolution state is unavailable",
        );
      }
      this.#choices.delete(choiceHandle);
      state.choiceHandles.delete(choiceHandle);
      this.#selections.set(selectionHandle, record);
      state.selectionHandles.add(selectionHandle);

      return {
        protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
        session_id: this.sessionId,
        resolution_id: record.resolutionId,
        selection_handle: selectionHandle,
        selected_at: formatTime(selectedAt),
        expires_at: formatTime(record.expiresAt),
        selected: selectedView(record.target),
        next: "plan",
        authority: "none",
        automatic_action: "never",
      };
    } finally {
      this.#transitioning.delete(choiceHandle);
    }
  }

  plan(input: { selection_handle: string }): WordBrowserPlanReceipt<PlanResult> {
    this.#assertOpen();
    const request = requireExactObject(
      input,
      ["selection_handle"],
      "planning input",
    );
    const selectionHandle = requireHandle(request, "selection_handle");
    const startedAt = this.#readNow();
    const record = this.#requireActive(
      this.#selections,
      selectionHandle,
      startedAt,
    );
    this.#beginTransition(selectionHandle);
    try {
      let browserPlan: PlanResult;
      try {
        browserPlan = this.#browser.plan(Object.freeze({
          kind: "new_tab",
          url: record.target.href,
        }));
        if (
          !isObject(browserPlan)
          || browserPlan.execution !== false
          || !isPlainWireJson(browserPlan, true)
        ) {
          throw new TypeError(
            "Browser returned an effectful, unsafe, or invalid plan",
          );
        }
      } catch {
        throw new WordBrowserHandoffError(
          "browser_plan_failed",
          "Browser could not produce a zero-effect plan",
        );
      }

      const plannedAt = this.#readNow();
      if (plannedAt >= record.expiresAt) {
        this.#dropResolution(record.resolutionId);
        throw new WordBrowserHandoffError(
          "handle_expired",
          "the handoff handle has expired",
        );
      }
      const openHandle = this.#allocateId("open");
      this.#assertTransitionSource(
        this.#selections,
        selectionHandle,
        record,
      );
      const state = this.#resolutions.get(record.resolutionId);
      if (!state) {
        throw new WordBrowserHandoffError(
          "internal_error",
          "resolution state is unavailable",
        );
      }
      this.#selections.delete(selectionHandle);
      state.selectionHandles.delete(selectionHandle);
      this.#opens.set(openHandle, record);
      state.openHandles.add(openHandle);

      return {
        protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
        session_id: this.sessionId,
        resolution_id: record.resolutionId,
        open_handle: openHandle,
        planned_at: formatTime(plannedAt),
        expires_at: formatTime(record.expiresAt),
        selected: selectedView(record.target),
        browser_action: {
          kind: "new_tab",
        },
        browser_plan: browserPlan,
        next: "open",
        authority: "none",
        automatic_action: "never",
      };
    } finally {
      this.#transitioning.delete(selectionHandle);
    }
  }

  async open(
    input: { open_handle: string },
  ): Promise<WordBrowserOpenReceipt<OpenResult>> {
    this.#assertOpen();
    const request = requireExactObject(input, ["open_handle"], "open input");
    const openHandle = requireHandle(request, "open_handle");
    const attemptedAt = this.#readNow();
    const record = this.#requireActive(this.#opens, openHandle, attemptedAt);

    /*
     * Consume before invoking Browser. A synchronous re-entry or a concurrent
     * second call therefore cannot dispatch the same target twice, including
     * when Browser later throws or returns an uncertain failure.
     */
    this.#opens.delete(openHandle);
    const state = this.#resolutions.get(record.resolutionId);
    state?.openHandles.delete(openHandle);
    this.#removeEmptyResolution(record.resolutionId);

    let browserResult: OpenResult;
    try {
      browserResult = await this.#browser.open(record.target.href);
      if (!isPlainWireJson(browserResult, false)) {
        throw new TypeError("Browser returned a non-JSON result");
      }
    } catch {
      throw new WordBrowserHandoffError(
        "browser_open_failed",
        "Browser open failed; the one-shot handle remains spent",
      );
    }

    return {
      protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
      session_id: this.sessionId,
      resolution_id: record.resolutionId,
      attempted_at: formatTime(attemptedAt),
      attempted_once: true,
      selected: selectedView(record.target),
      browser_result: browserResult,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#choices.clear();
    this.#selections.clear();
    this.#opens.clear();
    this.#resolutions.clear();
    this.#transitioning.clear();
  }

  /**
   * Invalidates every capability produced by one resolution. Transport
   * adapters use this when a result cannot be delivered without truncation,
   * so an invisible live handle cannot consume bounded session state.
   */
  discardResolution(resolutionId: string): boolean {
    if (
      typeof resolutionId !== "string"
      || resolutionId.length === 0
      || resolutionId.length > HANDLE_INPUT_LIMIT
    ) {
      return false;
    }
    const existed = this.#resolutions.has(resolutionId);
    this.#dropResolution(resolutionId);
    return existed;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new WordBrowserHandoffError(
        "session_closed",
        "browser handoff session is closed",
      );
    }
  }

  #readNow(): number {
    let current: number;
    try {
      current = this.#now();
    } catch {
      throw new WordBrowserHandoffError(
        "internal_error",
        "clock failed",
      );
    }
    if (
      !Number.isSafeInteger(current)
      || current < 0
      || current > MAX_DATE_MILLISECONDS
      || (this.#lastNow !== undefined && current < this.#lastNow)
    ) {
      throw new WordBrowserHandoffError(
        "internal_error",
        "clock must return nondecreasing epoch milliseconds",
      );
    }
    this.#lastNow = current;
    return current;
  }

  #allocateId(
    prefix: "session" | "resolution" | "choice" | "selection" | "open",
    failureCode: WordBrowserHandoffErrorCode = "internal_error",
  ): string {
    if (this.#idCounter >= Number.MAX_SAFE_INTEGER) {
      throw new WordBrowserHandoffError(
        "internal_error",
        "handoff identifier space is exhausted",
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = this.#randomBytes(WORD_BROWSER_HANDOFF_LIMITS.entropyBytes);
    } catch {
      throw new WordBrowserHandoffError(
        failureCode,
        "secure handoff entropy is unavailable",
      );
    }
    if (
      !(bytes instanceof Uint8Array)
      || bytes.byteLength !== WORD_BROWSER_HANDOFF_LIMITS.entropyBytes
    ) {
      throw new WordBrowserHandoffError(
        failureCode,
        "secure handoff entropy returned an invalid value",
      );
    }
    this.#idCounter += 1;
    const nonce = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("base64url");
    return `${prefix}_${this.#sessionOrdinal}_${this.#idCounter.toString(36)}_${nonce}`;
  }

  #activeHandleCount(): number {
    return this.#choices.size + this.#selections.size + this.#opens.size;
  }

  #beginTransition(handle: string): void {
    if (this.#transitioning.has(handle)) {
      throw new WordBrowserHandoffError(
        "invalid_handle",
        "the handoff handle is invalid or already used",
      );
    }
    this.#transitioning.add(handle);
  }

  #assertTransitionSource(
    map: Map<string, HandleRecord>,
    handle: string,
    record: HandleRecord,
  ): void {
    this.#assertOpen();
    if (map.get(handle) !== record) {
      throw new WordBrowserHandoffError(
        "invalid_handle",
        "the handoff handle is invalid or already used",
      );
    }
  }

  #requireActive(
    map: Map<string, HandleRecord>,
    handle: string,
    now: number,
  ): HandleRecord {
    const record = map.get(handle);
    if (!record) {
      this.#pruneExpired(now);
      throw new WordBrowserHandoffError(
        "invalid_handle",
        "the handoff handle is invalid or already used",
      );
    }
    if (now >= record.expiresAt) {
      this.#dropResolution(record.resolutionId);
      this.#pruneExpired(now);
      throw new WordBrowserHandoffError(
        "handle_expired",
        "the handoff handle has expired",
      );
    }
    this.#pruneExpired(now, record.resolutionId);
    return record;
  }

  #pruneExpired(now: number, exceptResolutionId?: string): void {
    for (const [resolutionId, state] of this.#resolutions) {
      if (
        resolutionId !== exceptResolutionId
        && now >= state.expiresAt
      ) {
        this.#dropResolution(resolutionId);
      }
    }
  }

  #dropResolution(resolutionId: string): void {
    const state = this.#resolutions.get(resolutionId);
    if (!state) return;
    for (const handle of state.choiceHandles) this.#choices.delete(handle);
    for (const handle of state.selectionHandles) {
      this.#selections.delete(handle);
    }
    for (const handle of state.openHandles) this.#opens.delete(handle);
    this.#resolutions.delete(resolutionId);
  }

  #removeEmptyResolution(resolutionId: string): void {
    const state = this.#resolutions.get(resolutionId);
    if (
      state
      && state.choiceHandles.size === 0
      && state.selectionHandles.size === 0
      && state.openHandles.size === 0
    ) {
      this.#resolutions.delete(resolutionId);
    }
  }
}
