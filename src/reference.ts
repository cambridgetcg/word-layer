import { createHash } from "node:crypto";

export const WORD_REFERENCE_PROTOCOL = "word-reference/0.1" as const;
export const WORD_REFERENCE_MODE = "exact_name" as const;

export const WORD_REFERENCE_LIMITS = Object.freeze({
  sources: 16,
  recordsPerSource: 512,
  referencesPerRecord: 64,
  recordsTotal: 8_192,
  referencesTotal: 4_096,
  sourceTextCodePointsTotal: 1_000_000,
  wordInput: 256,
  word: 128,
  identifier: 256,
  language: 64,
  definition: 8_192,
  referenceKind: 64,
  importAssertion: 64,
  href: 8_192,
  assertedBy: 2_048,
  proof: 8_192,
});

export type WordReferenceVerification = "unverified";
export type WordReferenceTrust = "untrusted";

export interface WordReferenceInput {
  reference_id: string;
  kind: string;
  href: string;
  asserted_by?: string | null;
  proof?: string | null;
  /**
   * Assertions supplied by a source are deliberately ignored. This resolver
   * does not verify publishers or proofs.
   */
  verification?: string;
  trust?: string;
}

export interface WordMeaningRecordInput {
  record_id: string;
  word: string;
  language: string;
  definition: string;
  references?: readonly WordReferenceInput[];
}

export interface WordReferenceSourceInput {
  protocol: typeof WORD_REFERENCE_PROTOCOL;
  source_id: string;
  records: readonly WordMeaningRecordInput[];
}

export interface ExactNameResolutionInput {
  mode: typeof WORD_REFERENCE_MODE;
  word: string;
  sources: readonly WordReferenceSourceInput[];
}

export interface ResolvedWordReference {
  reference_id: string;
  kind: string;
  href: string;
  source_id: string;
  asserted_by: string | null;
  proof: string | null;
  verification: WordReferenceVerification;
  trust: WordReferenceTrust;
}

export interface ResolvedWordMeaning {
  meaning_id: string;
  word: string;
  language: string;
  definition: string;
  provenance: {
    source_id: string;
    record_id: string;
    definition_sha256: string;
  };
  trust: WordReferenceTrust;
  references: ResolvedWordReference[];
}

export interface WordReferenceResolution {
  protocol: typeof WORD_REFERENCE_PROTOCOL;
  mode: typeof WORD_REFERENCE_MODE;
  query: {
    input: string;
    normalized: string;
  };
  found: boolean;
  meanings: ResolvedWordMeaning[];
  ambiguity: {
    meanings: number;
    references: number;
    automatic_selection: false;
  };
  selection: null;
}

interface NormalizedRecord {
  source_id: string;
  record_id: string;
  word: string;
  language: string;
  definition: string;
  definition_sha256: string;
  references: ResolvedWordReference[];
  fingerprint: string;
}

interface ResolutionBudget {
  records: number;
  references: number;
  sourceTextCodePoints: number;
}

const WORD_SEGMENT = String.raw`[\p{L}\p{N}][\p{L}\p{N}\p{M}]*`;
const WORD_PATTERN = new RegExp(
  String.raw`^${WORD_SEGMENT}(?:[-'’]${WORD_SEGMENT})*$`,
  "u",
);
const KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;
const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9])?$/;
const LANGUAGE_PATTERN = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DEFINITION_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string`);
  }
  if (hasUnpairedSurrogate(value)) {
    throw new TypeError(`${field} must contain only Unicode scalar values`);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${field} contains unknown field: ${unknown[0]}`);
  }
}

function consumeSourceText(
  budget: ResolutionBudget,
  value: unknown,
): void {
  if (typeof value !== "string") return;
  budget.sourceTextCodePoints += codePointLength(value);
  if (
    budget.sourceTextCodePoints
    > WORD_REFERENCE_LIMITS.sourceTextCodePointsTotal
  ) {
    throw new RangeError(
      `source text must contain at most ${WORD_REFERENCE_LIMITS.sourceTextCodePointsTotal} aggregate Unicode code points`,
    );
  }
}

function consumeSourceExpansion(
  budget: ResolutionBudget,
  rawLength: number,
  normalizedLength: number,
): void {
  const expansion = normalizedLength - rawLength;
  if (expansion <= 0) return;
  budget.sourceTextCodePoints += expansion;
  if (
    budget.sourceTextCodePoints
    > WORD_REFERENCE_LIMITS.sourceTextCodePointsTotal
  ) {
    throw new RangeError(
      `source text must contain at most ${WORD_REFERENCE_LIMITS.sourceTextCodePointsTotal} aggregate Unicode code points after normalization`,
    );
  }
}

function boundedIdentifier(value: unknown, field: string): string {
  const input = requireString(value, field);
  const length = codePointLength(input);
  if (length === 0 || length > WORD_REFERENCE_LIMITS.identifier) {
    throw new RangeError(
      `${field} must contain 1-${WORD_REFERENCE_LIMITS.identifier} ASCII characters`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(input)) {
    throw new TypeError(
      `${field} must be an ASCII source-scoped identifier`,
    );
  }
  return input;
}

function boundedOptionalText(
  value: unknown,
  field: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  const input = requireString(value, field);
  const length = codePointLength(input);
  if (length === 0 || length > maximum) {
    throw new RangeError(`${field} must contain 1-${maximum} Unicode code points`);
  }
  if (DEFINITION_CONTROL_PATTERN.test(input)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
  return input;
}

function validateOptionalImportAssertion(
  value: unknown,
  field: string,
): void {
  if (value === undefined) return;
  const input = requireString(value, field);
  const length = codePointLength(input);
  if (length === 0 || length > WORD_REFERENCE_LIMITS.importAssertion) {
    throw new RangeError(
      `${field} must contain 1-${WORD_REFERENCE_LIMITS.importAssertion} Unicode code points`,
    );
  }
  if (CONTROL_PATTERN.test(input)) {
    throw new TypeError(`${field} must not contain control characters`);
  }
}

function normalizeDefinition(
  value: unknown,
  budget: ResolutionBudget,
): string {
  const raw = requireString(value, "definition");
  const rawLength = codePointLength(raw);
  if (
    rawLength === 0
    || rawLength > WORD_REFERENCE_LIMITS.definition
  ) {
    throw new RangeError(
      `definition must contain 1-${WORD_REFERENCE_LIMITS.definition} Unicode code points`,
    );
  }
  if (DEFINITION_CONTROL_PATTERN.test(raw)) {
    throw new TypeError("definition must not contain control characters");
  }
  const normalized = raw
    .replace(/\r\n?/g, "\n")
    .trim()
    .normalize("NFC");
  const length = codePointLength(normalized);
  if (length === 0 || length > WORD_REFERENCE_LIMITS.definition) {
    throw new RangeError(
      `definition must contain 1-${WORD_REFERENCE_LIMITS.definition} Unicode code points`,
    );
  }
  consumeSourceExpansion(budget, rawLength, length);
  return normalized;
}

function normalizeLanguage(value: unknown): string {
  const input = requireString(value, "language");
  const length = codePointLength(input);
  if (length === 0 || length > WORD_REFERENCE_LIMITS.language) {
    throw new RangeError(
      `language must contain 1-${WORD_REFERENCE_LIMITS.language} Unicode code points`,
    );
  }
  if (!LANGUAGE_PATTERN.test(input)) {
    throw new TypeError("language must be a lowercase BCP 47-shaped tag");
  }
  return input;
}

function normalizeReferenceKind(value: unknown): string {
  const input = requireString(value, "reference.kind");
  const length = codePointLength(input);
  if (
    length === 0
    || length > WORD_REFERENCE_LIMITS.referenceKind
    || !KIND_PATTERN.test(input)
  ) {
    throw new TypeError(
      "reference.kind must be a bounded lowercase identifier",
    );
  }
  return input;
}

function normalizeHref(
  value: unknown,
  budget: ResolutionBudget,
): string {
  const raw = requireString(value, "reference.href");
  const length = codePointLength(raw);
  if (length === 0 || length > WORD_REFERENCE_LIMITS.href) {
    throw new RangeError(
      `reference.href must contain 1-${WORD_REFERENCE_LIMITS.href} Unicode code points`,
    );
  }
  if (CONTROL_PATTERN.test(raw)) {
    throw new TypeError("reference.href must not contain control characters");
  }
  const input = raw.trim();
  if (input !== raw) {
    throw new TypeError(
      "reference.href must not contain surrounding whitespace",
    );
  }
  if (/^https?:/i.test(input) && !/^https?:\/\//i.test(input)) {
    throw new TypeError(
      "reference.href must begin with an http or https authority",
    );
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new TypeError("reference.href must be an absolute URL", {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("reference.href must use http or https");
  }
  const authorityStart = input.indexOf("://");
  const authority = authorityStart < 0
    ? ""
    : input
      .slice(authorityStart + 3)
      .split(/[/?#]/, 1)[0] ?? "";
  if (authority.includes("@")) {
    throw new TypeError("reference.href must not contain userinfo");
  }
  if (!url.hostname) {
    throw new TypeError("reference.href must contain a hostname");
  }
  if (url.username || url.password) {
    throw new TypeError("reference.href must not contain userinfo");
  }
  const serialized = url.href;
  const serializedLength = codePointLength(serialized);
  if (serializedLength > WORD_REFERENCE_LIMITS.href) {
    throw new RangeError(
      `serialized reference.href must contain at most ${WORD_REFERENCE_LIMITS.href} Unicode code points`,
    );
  }
  consumeSourceExpansion(budget, length, serializedLength);
  return serialized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function referenceFingerprint(reference: ResolvedWordReference): string {
  return JSON.stringify([
    reference.reference_id,
    reference.kind,
    reference.href,
    reference.source_id,
    reference.asserted_by,
    reference.proof,
  ]);
}

function normalizeReferences(
  value: unknown,
  sourceId: string,
  budget: ResolutionBudget,
): ResolvedWordReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("references must be an array");
  }
  if (value.length > WORD_REFERENCE_LIMITS.referencesPerRecord) {
    throw new RangeError(
      `references must contain at most ${WORD_REFERENCE_LIMITS.referencesPerRecord} entries`,
    );
  }
  budget.references += value.length;
  if (budget.references > WORD_REFERENCE_LIMITS.referencesTotal) {
    throw new RangeError(
      `resolution sources must contain at most ${WORD_REFERENCE_LIMITS.referencesTotal} aggregate references`,
    );
  }

  const candidates = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new TypeError(`references[${index}] must be an object`);
    }
    const reference = raw as WordReferenceInput;
    rejectUnknownFields(
      reference as unknown as Record<string, unknown>,
      [
        "reference_id",
        "kind",
        "href",
        "asserted_by",
        "proof",
        "verification",
        "trust",
      ],
      `references[${index}]`,
    );
    for (const field of [
      reference.reference_id,
      reference.kind,
      reference.href,
      reference.asserted_by,
      reference.proof,
      reference.verification,
      reference.trust,
    ]) {
      consumeSourceText(budget, field);
    }
    validateOptionalImportAssertion(
      reference.verification,
      `references[${index}].verification`,
    );
    validateOptionalImportAssertion(
      reference.trust,
      `references[${index}].trust`,
    );
    const normalized: ResolvedWordReference = {
      reference_id: boundedIdentifier(
        reference.reference_id,
        `references[${index}].reference_id`,
      ),
      kind: normalizeReferenceKind(reference.kind),
      href: normalizeHref(reference.href, budget),
      source_id: sourceId,
      asserted_by: boundedOptionalText(
        reference.asserted_by,
        `references[${index}].asserted_by`,
        WORD_REFERENCE_LIMITS.assertedBy,
      ),
      proof: boundedOptionalText(
        reference.proof,
        `references[${index}].proof`,
        WORD_REFERENCE_LIMITS.proof,
      ),
      verification: "unverified",
      trust: "untrusted",
    };
    return {
      normalized,
      fingerprint: referenceFingerprint(normalized),
    };
  });

  candidates.sort(
    (left, right) =>
      compareText(left.normalized.reference_id, right.normalized.reference_id)
      || compareText(left.fingerprint, right.fingerprint),
  );

  const deduplicated: ResolvedWordReference[] = [];
  let previous:
    | { reference_id: string; fingerprint: string }
    | undefined;
  for (const candidate of candidates) {
    if (candidate.normalized.reference_id === previous?.reference_id) {
      if (candidate.fingerprint !== previous.fingerprint) {
        throw new TypeError(
          `conflicting duplicate reference_id: ${candidate.normalized.reference_id}`,
        );
      }
      continue;
    }
    deduplicated.push(candidate.normalized);
    previous = {
      reference_id: candidate.normalized.reference_id,
      fingerprint: candidate.fingerprint,
    };
  }
  return deduplicated;
}

function normalizeRecord(
  raw: WordMeaningRecordInput,
  sourceId: string,
  index: number,
  budget: ResolutionBudget,
): NormalizedRecord {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(`records[${index}] must be an object`);
  }
  rejectUnknownFields(
    raw as unknown as Record<string, unknown>,
    ["record_id", "word", "language", "definition", "references"],
    `records[${index}]`,
  );
  for (const field of [
    raw.record_id,
    raw.word,
    raw.language,
    raw.definition,
  ]) {
    consumeSourceText(budget, field);
  }

  const recordId = boundedIdentifier(raw.record_id, `records[${index}].record_id`);
  const sourceWord = requireString(raw.word, `records[${index}].word`);
  const word = normalizeWordName(sourceWord);
  if (sourceWord !== word) {
    throw new TypeError(
      `records[${index}].word must be in canonical exact-name form`,
    );
  }
  const language = normalizeLanguage(raw.language);
  const definition = normalizeDefinition(raw.definition, budget);
  const definitionSha256 = sha256(definition);
  const references = normalizeReferences(raw.references, sourceId, budget);
  const fingerprint = JSON.stringify([
    word,
    language,
    definition,
    definitionSha256,
    references.map(referenceFingerprint),
  ]);

  return {
    source_id: sourceId,
    record_id: recordId,
    word,
    language,
    definition,
    definition_sha256: definitionSha256,
    references,
    fingerprint,
  };
}

/**
 * Normalize one exact, dotless Unicode word.
 *
 * This is deliberately not a meaning-search query normalizer: prose,
 * whitespace-separated phrases, URL-like names, paths, and schemes are
 * rejected.
 */
export function normalizeWordName(input: string): string {
  const raw = requireString(input, "word");
  if (codePointLength(raw) > WORD_REFERENCE_LIMITS.wordInput) {
    throw new RangeError(
      `word input must contain at most ${WORD_REFERENCE_LIMITS.wordInput} Unicode code points`,
    );
  }
  if (CONTROL_PATTERN.test(raw)) {
    throw new TypeError("word must not contain control characters");
  }
  const normalized = raw
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase("und");
  const length = codePointLength(normalized);
  if (length === 0 || length > WORD_REFERENCE_LIMITS.word) {
    throw new RangeError(
      `word must contain 1-${WORD_REFERENCE_LIMITS.word} Unicode code points`,
    );
  }
  if (!WORD_PATTERN.test(normalized)) {
    throw new TypeError(
      "word must be one dotless Unicode word, optionally joined by hyphens or apostrophes",
    );
  }
  return normalized;
}

/**
 * Pure exact-name resolution. It performs no I/O, verification, ranking,
 * selection, or navigation.
 */
export function resolveWordReference(
  input: ExactNameResolutionInput,
): WordReferenceResolution {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("resolution input must be an object");
  }
  if (input.mode !== WORD_REFERENCE_MODE) {
    throw new TypeError(`mode must be ${WORD_REFERENCE_MODE}`);
  }

  const queryInput = requireString(input.word, "word");
  const normalizedQuery = normalizeWordName(queryInput);
  const budget: ResolutionBudget = {
    records: 0,
    references: 0,
    sourceTextCodePoints: 0,
  };
  if (!Array.isArray(input.sources)) {
    throw new TypeError("sources must be an array");
  }
  if (input.sources.length > WORD_REFERENCE_LIMITS.sources) {
    throw new RangeError(
      `sources must contain at most ${WORD_REFERENCE_LIMITS.sources} entries`,
    );
  }

  const records: NormalizedRecord[] = [];
  input.sources.forEach((source, sourceIndex) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw new TypeError(`sources[${sourceIndex}] must be an object`);
    }
    rejectUnknownFields(
      source as unknown as Record<string, unknown>,
      ["protocol", "source_id", "records"],
      `sources[${sourceIndex}]`,
    );
    if (source.protocol !== WORD_REFERENCE_PROTOCOL) {
      throw new TypeError(
        `sources[${sourceIndex}].protocol must be ${WORD_REFERENCE_PROTOCOL}`,
      );
    }
    const sourceId = boundedIdentifier(
      source.source_id,
      `sources[${sourceIndex}].source_id`,
    );
    consumeSourceText(budget, source.source_id);
    if (!Array.isArray(source.records)) {
      throw new TypeError(`sources[${sourceIndex}].records must be an array`);
    }
    if (source.records.length > WORD_REFERENCE_LIMITS.recordsPerSource) {
      throw new RangeError(
        `sources[${sourceIndex}].records must contain at most ${WORD_REFERENCE_LIMITS.recordsPerSource} entries`,
      );
    }
    budget.records += source.records.length;
    if (budget.records > WORD_REFERENCE_LIMITS.recordsTotal) {
      throw new RangeError(
        `resolution sources must contain at most ${WORD_REFERENCE_LIMITS.recordsTotal} aggregate records`,
      );
    }
    source.records.forEach((record: unknown, recordIndex: number) => {
      const normalized = normalizeRecord(
        record as WordMeaningRecordInput,
        sourceId,
        recordIndex,
        budget,
      );
      records.push(normalized);
    });
  });

  records.sort(
    (left, right) =>
      compareText(left.source_id, right.source_id)
      || compareText(left.record_id, right.record_id)
      || compareText(left.fingerprint, right.fingerprint),
  );

  const uniqueRecords: NormalizedRecord[] = [];
  let previous:
    | { coordinate: string; fingerprint: string }
    | undefined;
  for (const candidate of records) {
    const coordinate = JSON.stringify([
      candidate.source_id,
      candidate.record_id,
    ]);
    if (coordinate === previous?.coordinate) {
      if (candidate.fingerprint !== previous.fingerprint) {
        throw new TypeError(
          `conflicting duplicate record: ${candidate.source_id}:${candidate.record_id}`,
        );
      }
      continue;
    }
    uniqueRecords.push(candidate);
    previous = {
      coordinate,
      fingerprint: candidate.fingerprint,
    };
  }

  const meanings: ResolvedWordMeaning[] = uniqueRecords
    .filter((record) => record.word === normalizedQuery)
    .map((record) => ({
      meaning_id: `${record.source_id}:${record.record_id}`,
      word: record.word,
      language: record.language,
      definition: record.definition,
      provenance: {
        source_id: record.source_id,
        record_id: record.record_id,
        definition_sha256: record.definition_sha256,
      },
      trust: "untrusted",
      references: record.references,
    }));
  const referenceCount = meanings.reduce(
    (total, meaning) => total + meaning.references.length,
    0,
  );

  return {
    protocol: WORD_REFERENCE_PROTOCOL,
    mode: WORD_REFERENCE_MODE,
    query: {
      input: queryInput,
      normalized: normalizedQuery,
    },
    found: meanings.length > 0,
    meanings,
    ambiguity: {
      meanings: meanings.length,
      references: referenceCount,
      automatic_selection: false,
    },
    selection: null,
  };
}
