const PRODUCTION_API_ORIGIN = "https://word-layer.vercel.app";
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RENDER_MEANINGS = 512;
const MAX_RENDER_REFERENCES = 2_048;
const REQUEST_TIMEOUT_MS = 12_000;

const WORD_PATTERN =
  /^[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-'’][\p{L}\p{N}][\p{L}\p{N}\p{M}]*)*$/u;
const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,254}[A-Za-z0-9])?$/;
const LANGUAGE_PATTERN = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;
const REFERENCE_KIND_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RAW_CONTROL_PATTERN =
  /[\u0000-\u001F\u007F\uD800-\uDFFF]/u;
const TEXT_CONTROL_PATTERN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u;

function codePointLength(value) {
  return Array.from(value).length;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function isBoundedString(value, minimum, maximum, controlPattern) {
  return typeof value === "string" &&
    codePointLength(value) >= minimum &&
    codePointLength(value) <= maximum &&
    !controlPattern.test(value);
}

function isIdentifier(value) {
  return typeof value === "string" &&
    codePointLength(value) <= 256 &&
    IDENTIFIER_PATTERN.test(value);
}

function isCanonicalWord(value) {
  return typeof value === "string" &&
    codePointLength(value) <= 128 &&
    WORD_PATTERN.test(value);
}

function isReferenceUrl(value) {
  if (!isBoundedString(value, 1, 8192, RAW_CONTROL_PATTERN) ||
    value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.href === value;
  } catch {
    return false;
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareMeaningCoordinates(left, right) {
  return compareStrings(
    left.provenance.source_id,
    right.provenance.source_id,
  ) || compareStrings(
    left.provenance.record_id,
    right.provenance.record_id,
  );
}

async function definitionSha256(definition) {
  if (!globalThis.crypto?.subtle) {
    throw new TypeError("SHA-256 validation is unavailable");
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(definition),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function apiOriginFor(locationLike) {
  const hostname = String(locationLike?.hostname ?? "").toLowerCase();
  if (
    hostname === "github.io" ||
    hostname.endsWith(".github.io")
  ) {
    return PRODUCTION_API_ORIGIN;
  }

  try {
    const candidate = new URL(String(locationLike?.origin ?? ""));
    if (candidate.protocol === "http:" || candidate.protocol === "https:") {
      return candidate.origin;
    }
  } catch {
    // A file preview has no network origin; use the public read-only resolver.
  }
  return PRODUCTION_API_ORIGIN;
}

export function validateWordInput(input) {
  if (typeof input !== "string" || input.length === 0) {
    return {
      ok: false,
      code: "empty",
      message: "Enter one dotless word.",
    };
  }
  if (codePointLength(input) > 256) {
    return {
      ok: false,
      code: "input_too_long",
      message: "Keep the entered word to 256 Unicode characters or fewer.",
    };
  }
  if (RAW_CONTROL_PATTERN.test(input)) {
    return {
      ok: false,
      code: "control_character",
      message: "The word cannot contain control characters.",
    };
  }

  let normalized;
  try {
    normalized = input.trim().normalize("NFKC").toLowerCase();
  } catch {
    return {
      ok: false,
      code: "invalid_unicode",
      message: "Enter a valid Unicode word.",
    };
  }

  if (
    codePointLength(normalized) < 1 ||
    codePointLength(normalized) > 128 ||
    !WORD_PATTERN.test(normalized)
  ) {
    return {
      ok: false,
      code: "invalid_exact_name",
      message:
        "Use one dotless word. Hyphens and apostrophes are welcome; dots, spaces, paths, and URLs are not.",
    };
  }

  return { ok: true, input, normalized };
}

export function resolutionUrl(apiOrigin, input) {
  const origin = new URL(apiOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new TypeError("resolver origin must use HTTP(S)");
  }
  return new URL(
    `/v1/resolve/${encodeURIComponent(input)}`,
    origin.origin,
  ).href;
}

function assertReference(value, sourceId) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "reference_id",
      "kind",
      "href",
      "source_id",
      "asserted_by",
      "proof",
      "verification",
      "trust",
    ]) ||
    !isIdentifier(value.reference_id) ||
    typeof value.kind !== "string" ||
    codePointLength(value.kind) > 64 ||
    !REFERENCE_KIND_PATTERN.test(value.kind) ||
    !isReferenceUrl(value.href) ||
    value.source_id !== sourceId ||
    !isIdentifier(value.source_id) ||
    !(
      value.asserted_by === null ||
      isBoundedString(value.asserted_by, 1, 2048, TEXT_CONTROL_PATTERN)
    ) ||
    !(
      value.proof === null ||
      isBoundedString(value.proof, 1, 8192, TEXT_CONTROL_PATTERN)
    ) ||
    value.verification !== "unverified" ||
    value.trust !== "untrusted"
  ) {
    throw new TypeError("malformed reference");
  }
}

function assertMeaning(value, normalizedWord) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "meaning_id",
      "word",
      "language",
      "definition",
      "provenance",
      "trust",
      "references",
    ]) ||
    value.word !== normalizedWord ||
    !isCanonicalWord(value.word) ||
    typeof value.language !== "string" ||
    codePointLength(value.language) > 64 ||
    !LANGUAGE_PATTERN.test(value.language) ||
    !isBoundedString(value.definition, 1, 8192, TEXT_CONTROL_PATTERN) ||
    value.trust !== "untrusted" ||
    !Array.isArray(value.references) ||
    value.references.length > 64 ||
    !isPlainObject(value.provenance) ||
    !hasExactKeys(value.provenance, [
      "source_id",
      "record_id",
      "definition_sha256",
    ]) ||
    !isIdentifier(value.provenance.source_id) ||
    !isIdentifier(value.provenance.record_id) ||
    typeof value.provenance.definition_sha256 !== "string" ||
    !SHA256_PATTERN.test(value.provenance.definition_sha256) ||
    value.meaning_id !==
      `${value.provenance.source_id}:${value.provenance.record_id}`
  ) {
    throw new TypeError("malformed meaning");
  }

  for (const reference of value.references) {
    assertReference(reference, value.provenance.source_id);
  }
}

export async function assertResolution(value, expectedQuery) {
  if (
    !isPlainObject(value) ||
    !hasExactKeys(value, [
      "protocol",
      "mode",
      "query",
      "found",
      "meanings",
      "ambiguity",
      "selection",
    ]) ||
    value.protocol !== "word-reference/0.1" ||
    value.mode !== "exact_name" ||
    typeof value.found !== "boolean" ||
    !Array.isArray(value.meanings) ||
    value.meanings.length > 8192 ||
    value.selection !== null ||
    !isPlainObject(value.query) ||
    !hasExactKeys(value.query, ["input", "normalized"]) ||
    !isBoundedString(value.query.input, 1, 256, RAW_CONTROL_PATTERN) ||
    !isCanonicalWord(value.query.normalized) ||
    value.query.input !== expectedQuery.input ||
    value.query.normalized !== expectedQuery.normalized ||
    !isPlainObject(value.ambiguity) ||
    !hasExactKeys(value.ambiguity, [
      "meanings",
      "references",
      "automatic_selection",
    ]) ||
    !Number.isInteger(value.ambiguity.meanings) ||
    !Number.isInteger(value.ambiguity.references) ||
    value.ambiguity.automatic_selection !== false
  ) {
    throw new TypeError("malformed resolution");
  }

  let references = 0;
  let previousMeaning;
  for (const meaning of value.meanings) {
    assertMeaning(meaning, value.query.normalized);
    if (
      previousMeaning &&
      compareMeaningCoordinates(previousMeaning, meaning) >= 0
    ) {
      throw new TypeError("non-canonical meaning order");
    }
    previousMeaning = meaning;

    let previousReferenceId;
    for (const reference of meaning.references) {
      if (
        previousReferenceId !== undefined &&
        compareStrings(previousReferenceId, reference.reference_id) >= 0
      ) {
        throw new TypeError("non-canonical reference order");
      }
      previousReferenceId = reference.reference_id;
    }

    references += meaning.references.length;
  }

  if (
    value.found !== (value.meanings.length > 0) ||
    value.ambiguity.meanings !== value.meanings.length ||
    value.ambiguity.references !== references ||
    references > 4096
  ) {
    throw new TypeError("inconsistent resolution");
  }
  if (
    value.meanings.length > MAX_RENDER_MEANINGS ||
    references > MAX_RENDER_REFERENCES
  ) {
    throw new RangeError("resolution exceeds explorer render budget");
  }
  await Promise.all(value.meanings.map(async (meaning) => {
    const digest = await definitionSha256(meaning.definition);
    if (digest !== meaning.provenance.definition_sha256) {
      throw new TypeError("incorrect definition digest");
    }
  }));
  return value;
}

function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function resolutionSummary(resolution) {
  return `${plural(resolution.ambiguity.meanings, "meaning")} · ${
    plural(resolution.ambiguity.references, "asserted reference")
  }. No winner was selected; protocol order is deterministic, not ranking.`;
}

function element(documentObject, name, className, text) {
  const node = documentObject.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendPair(documentObject, list, term, value, className = "") {
  list.append(element(documentObject, "dt", "", term));
  const description = element(documentObject, "dd", className);
  const isolate = element(documentObject, "bdi", "", value);
  description.append(isolate);
  list.append(description);
}

function renderReference(documentObject, reference) {
  const item = element(documentObject, "li", "reference");
  const heading = element(documentObject, "h4", "reference__title");
  heading.append(
    element(documentObject, "span", "badge", reference.kind),
    documentObject.createTextNode(" "),
    element(documentObject, "bdi", "", reference.reference_id),
  );
  item.append(heading);

  item.append(element(
    documentObject,
    "p",
    "reference__label",
    "Asserted URL — shown as text only; this explorer will not open it.",
  ));
  const address = element(documentObject, "code", "reference__url");
  address.dir = "ltr";
  address.textContent = reference.href;
  item.append(address);

  const status = element(
    documentObject,
    "p",
    "trust-note",
    "Unverified · untrusted",
  );
  item.append(status);

  const details = element(documentObject, "details", "details");
  details.append(element(
    documentObject,
    "summary",
    "",
    "Inspect assertion details",
  ));
  const metadata = element(documentObject, "dl", "metadata");
  appendPair(documentObject, metadata, "Source", reference.source_id, "mono");
  appendPair(
    documentObject,
    metadata,
    "Asserted by",
    reference.asserted_by ?? "not supplied",
    "break-anywhere",
  );
  appendPair(
    documentObject,
    metadata,
    "Proof assertion",
    reference.proof ?? "not supplied",
    "break-anywhere",
  );
  details.append(metadata);
  item.append(details);
  return item;
}

function renderMeaning(documentObject, meaning) {
  const item = element(documentObject, "li", "meaning-card");
  const article = element(documentObject, "article");
  const heading = element(documentObject, "h3");
  heading.append(
    documentObject.createTextNode("Meaning under source label "),
    element(documentObject, "bdi", "", meaning.provenance.source_id),
  );
  article.append(heading);

  const definition = element(
    documentObject,
    "p",
    "definition",
    meaning.definition,
  );
  definition.lang = meaning.language;
  definition.dir = "auto";
  article.append(definition);

  const coordinate = element(documentObject, "p", "coordinate");
  coordinate.append(
    documentObject.createTextNode("Record "),
    element(documentObject, "code", "", meaning.provenance.record_id),
    documentObject.createTextNode(" · untrusted"),
  );
  article.append(coordinate);

  const provenance = element(documentObject, "details", "details");
  provenance.append(element(
    documentObject,
    "summary",
    "",
    "Inspect provenance",
  ));
  const metadata = element(documentObject, "dl", "metadata");
  appendPair(
    documentObject,
    metadata,
    "Meaning coordinate",
    meaning.meaning_id,
    "mono",
  );
  appendPair(
    documentObject,
    metadata,
    "Language",
    meaning.language,
    "mono",
  );
  appendPair(
    documentObject,
    metadata,
    "Definition digest (SHA-256; not proof)",
    meaning.provenance.definition_sha256,
    "mono break-anywhere",
  );
  provenance.append(metadata);
  article.append(provenance);

  const referenceHeading = element(
    documentObject,
    "h4",
    "references-title",
    "References asserted by this source record",
  );
  article.append(referenceHeading);
  if (meaning.references.length === 0) {
    article.append(element(
      documentObject,
      "p",
      "muted",
      "No references were asserted.",
    ));
  } else {
    const references = element(documentObject, "ul", "reference-list");
    for (const reference of meaning.references) {
      references.append(renderReference(documentObject, reference));
    }
    article.append(references);
  }

  item.append(article);
  return item;
}

function isJsonMediaType(value) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/u.test(mediaType);
}

function cancelReader(reader) {
  try {
    void reader.cancel().catch(() => {
      // The primary validation error remains stable.
    });
  } catch {
    // The primary validation error remains stable.
  }
}

async function readJson(response) {
  if (!isJsonMediaType(response.headers.get("content-type"))) {
    throw new TypeError("resolver response is not JSON");
  }

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    const normalized = lengthHeader.trim();
    if (!/^(0|[1-9]\d*)$/u.test(normalized)) {
      throw new TypeError("invalid resolver content length");
    }
    const announcedLength = Number(normalized);
    if (
      !Number.isSafeInteger(announcedLength) ||
      announcedLength > MAX_RESPONSE_BYTES
    ) {
      throw new RangeError("resolution exceeds explorer display budget");
    }
  }
  if (response.body === null) {
    throw new TypeError("resolver response body is unavailable");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        throw new TypeError("resolver response body is invalid");
      }
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        cancelReader(reader);
        throw new RangeError("resolution exceeds explorer display budget");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export function initializeExplorer(
  documentObject = document,
  locationLike = window.location,
  fetchImplementation = window.fetch.bind(window),
) {
  const form = documentObject.getElementById("word-form");
  const input = documentObject.getElementById("word-input");
  const submit = documentObject.getElementById("word-submit");
  const inputError = documentObject.getElementById("word-error");
  const status = documentObject.getElementById("explorer-status");
  const requestError = documentObject.getElementById("explorer-error");
  const results = documentObject.getElementById("explorer-results");
  const resultsTitle = documentObject.getElementById("results-title");
  const resultsSummary = documentObject.getElementById("results-summary");
  const meanings = documentObject.getElementById("meaning-list");
  const origin = documentObject.getElementById("origin");
  const resolveLink = documentObject.getElementById("resolve");
  const discoveryLink = documentObject.getElementById("discovery");
  const healthLink = documentObject.getElementById("health");

  if (
    !form || !input || !submit || !inputError || !status || !requestError ||
    !results || !resultsTitle || !resultsSummary || !meanings || !origin ||
    !resolveLink || !discoveryLink || !healthLink
  ) {
    return;
  }

  const apiOrigin = apiOriginFor(locationLike);
  origin.textContent = apiOrigin;
  resolveLink.href = resolutionUrl(apiOrigin, "love");
  discoveryLink.href = `${apiOrigin}/.well-known/word-reference`;
  healthLink.href = `${apiOrigin}/health`;
  input.disabled = false;
  submit.disabled = false;
  status.textContent = "";

  let activeController;
  let requestNumber = 0;

  function clearInputError() {
    input.removeAttribute("aria-invalid");
    inputError.hidden = true;
    inputError.textContent = "";
  }

  function clearOutput() {
    status.textContent = "";
    requestError.hidden = true;
    requestError.textContent = "";
    results.hidden = true;
    resultsTitle.replaceChildren();
    resultsSummary.textContent = "";
    meanings.replaceChildren();
  }

  function resetBusy() {
    form.removeAttribute("aria-busy");
    submit.disabled = false;
    submit.textContent = "Explore meanings";
  }

  function finishBusy(currentRequest) {
    if (currentRequest !== requestNumber) return;
    resetBusy();
  }

  function showRequestError(message) {
    requestError.textContent = message;
    requestError.hidden = false;
  }

  input.addEventListener("input", clearInputError);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    activeController?.abort();
    const currentRequest = ++requestNumber;
    clearInputError();
    clearOutput();

    const query = validateWordInput(input.value);
    if (!query.ok) {
      activeController = undefined;
      resetBusy();
      input.setAttribute("aria-invalid", "true");
      inputError.textContent = query.message;
      inputError.hidden = false;
      input.focus();
      return;
    }

    const controller = new AbortController();
    activeController = controller;
    let timedOut = false;
    const timeout = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    form.setAttribute("aria-busy", "true");
    submit.disabled = true;
    submit.textContent = "Exploring…";
    status.textContent =
      `Resolving “${query.normalized}” exactly. Nothing will be selected or opened.`;

    try {
      const target = resolutionUrl(apiOrigin, query.input);
      const response = await fetchImplementation(
        target,
        {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        },
      );
      if (
        response.redirected ||
        (response.url !== "" && response.url !== target)
      ) {
        throw new TypeError("resolver response changed destination");
      }
      const body = await readJson(response);
      if (currentRequest !== requestNumber) return;

      if (response.status === 400) {
        input.setAttribute("aria-invalid", "true");
        inputError.textContent =
          "The resolver rejected this exact name. Check that it is one dotless word.";
        inputError.hidden = false;
        status.textContent = "";
        input.focus();
        return;
      }
      if (response.status === 503) {
        status.textContent = "";
        showRequestError(
          "The local meaning sources are unavailable. Nothing was selected or opened; please try again later.",
        );
        return;
      }
      if (!response.ok) {
        throw new Error(`resolver returned HTTP ${response.status}`);
      }

      const resolution = await assertResolution(body, query);
      const word = element(
        documentObject,
        "bdi",
        "",
        resolution.query.normalized,
      );
      if (resolution.found) {
        resultsTitle.append(documentObject.createTextNode("Meanings for "), word);
      } else {
        resultsTitle.append(
          documentObject.createTextNode("No observed meanings for "),
          word,
        );
      }
      resultsSummary.textContent = resolution.found
        ? resolutionSummary(resolution)
        : "No current local source record describes this word. Unknown is ordinary—not inventory to claim or purchase.";

      for (const meaning of resolution.meanings) {
        meanings.append(renderMeaning(documentObject, meaning));
      }
      results.hidden = false;
      status.textContent = resolution.found
        ? `${plural(resolution.ambiguity.meanings, "meaning")} and ${
          plural(resolution.ambiguity.references, "asserted reference")
        } found. No winner was selected.`
        : `No observed meanings found for “${resolution.query.normalized}”.`;
      results.focus();
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      status.textContent = "";
      if (timedOut) {
        showRequestError(
          "The resolver took too long to answer. Nothing was selected or opened; please try again.",
        );
      } else if (error?.name !== "AbortError") {
        showRequestError(
          error instanceof RangeError
            ? "This valid-looking response exceeds the explorer’s bounded display budget. Nothing was selected or opened."
            : "The resolver response could not be safely displayed. Nothing was selected or opened; please try again.",
        );
      }
    } finally {
      globalThis.clearTimeout(timeout);
      if (currentRequest === requestNumber) {
        activeController = undefined;
      }
      finishBusy(currentRequest);
    }
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => initializeExplorer(),
      { once: true },
    );
  } else {
    initializeExplorer();
  }
}
