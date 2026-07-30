import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  WORD_REFERENCE_LIMITS,
  WORD_REFERENCE_PROTOCOL,
  normalizeWordName,
  resolveWordReference,
  type WordMeaningRecordInput,
  type WordReferenceSourceInput,
} from "../src/reference";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function source(
  source_id: string,
  records: WordMeaningRecordInput[],
): WordReferenceSourceInput {
  return {
    protocol: WORD_REFERENCE_PROTOCOL,
    source_id,
    records,
  };
}

function meaning(
  record_id: string,
  definition: string,
  href?: string,
): WordMeaningRecordInput {
  return {
    record_id,
    word: "love",
    language: "en",
    definition,
    references: href
      ? [
          {
            reference_id: `${record_id}-site`,
            kind: "site",
            href,
            asserted_by: `did:example:${record_id}`,
            proof: `proof:${record_id}`,
          },
        ]
      : [],
  };
}

describe("word-reference/0.1 exact-name resolution", () => {
  test("preserves two meanings and two sites without selecting either", () => {
    const result = resolveWordReference({
      mode: "exact_name",
      word: "LOVE",
      sources: [
        source("source.z", [
          meaning("staying", "Care that remains.", "https://z.example/love"),
        ]),
        source("source.a", [
          meaning("giving", "Love received as gift.", "https://a.example/love"),
        ]),
      ],
    });

    expect(result).toMatchObject({
      protocol: WORD_REFERENCE_PROTOCOL,
      mode: "exact_name",
      query: { input: "LOVE", normalized: "love" },
      found: true,
      ambiguity: {
        meanings: 2,
        references: 2,
        automatic_selection: false,
      },
      selection: null,
    });
    expect(result.meanings.map((entry) => entry.meaning_id)).toEqual([
      "source.a:giving",
      "source.z:staying",
    ]);
    expect(result.meanings.map((entry) => entry.definition)).toEqual([
      "Love received as gift.",
      "Care that remains.",
    ]);
    expect(result.meanings.flatMap((entry) => entry.references)).toHaveLength(2);
    expect(result.meanings.every((entry) => entry.trust === "untrusted")).toBe(
      true,
    );
    expect(result.meanings[0]!.provenance.definition_sha256).toBe(
      createHash("sha256")
        .update("Love received as gift.", "utf8")
        .digest("hex"),
    );
  });

  test("source order does not change normalized substantive output", () => {
    const sources = [
      source("source.z", [
        meaning("staying", "Care that remains.", "https://z.example/love"),
      ]),
      source("source.a", [
        meaning("giving", "Love received as gift.", "https://a.example/love"),
      ]),
    ];

    const forward = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources,
    });
    const reversed = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [...sources].reverse(),
    });

    expect(reversed).toEqual(forward);
  });

  test("a meaning with no references is a valid result", () => {
    const result = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [source("lexicon", [meaning("love", "Care that remains.")])],
    });

    expect(result.found).toBe(true);
    expect(result.meanings[0]!.references).toEqual([]);
    expect(result.ambiguity).toEqual({
      meanings: 1,
      references: 0,
      automatic_selection: false,
    });
    expect(result.selection).toBeNull();
  });

  test("rejects non-HTTP schemes and URL userinfo", () => {
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning("love", "Care that remains.", "ftp://example.test/love"),
          ]),
        ],
      }),
    ).toThrow("must use http or https");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning(
              "love",
              "Care that remains.",
              "https:/example.test/love",
            ),
          ]),
        ],
      }),
    ).toThrow("must begin with an http or https authority");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning(
              "love",
              "Care that remains.",
              "https://owner:secret@example.test/love",
            ),
          ]),
        ],
      }),
    ).toThrow("must not contain userinfo");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning(
              "love",
              "Care that remains.",
              "https://@example.test/love",
            ),
          ]),
        ],
      }),
    ).toThrow("must not contain userinfo");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning(
              "love",
              "Care that remains.",
              "https://exa\nmple.test/love",
            ),
          ]),
        ],
      }),
    ).toThrow("must not contain control characters");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning(
              "love",
              "Care that remains.",
              " https://example.test/love",
            ),
          ]),
        ],
      }),
    ).toThrow("must not contain surrounding whitespace");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning(
              "love",
              "Care that remains.",
              `https://example.test/${"é".repeat(8_000)}`,
            ),
          ]),
        ],
      }),
    ).toThrow("serialized reference.href");
  });

  test("exact duplicate source records and references collapse deterministically", () => {
    const first = meaning(
      "love",
      "Care that remains.",
      "https://a.example/love",
    );
    first.references = [
      ...(first.references ?? []),
      { ...first.references![0]! },
    ];
    const second = structuredClone(first);

    const forward = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [source("lexicon", [first, second])],
    });
    const reversed = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [source("lexicon", [second, first])],
    });

    expect(reversed).toEqual(forward);
    expect(forward.meanings).toHaveLength(1);
    expect(forward.meanings[0]!.definition).toBe("Care that remains.");
    expect(forward.meanings[0]!.references).toHaveLength(1);
  });

  test("rejects conflicting records or references at one source coordinate", () => {
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [
          source("lexicon", [
            meaning("love", "Definition A"),
            meaning("love", "Definition B"),
          ]),
        ],
      }),
    ).toThrow("conflicting duplicate record");

    const record = meaning(
      "love",
      "Definition A",
      "https://a.example/love",
    );
    record.references = [
      ...(record.references ?? []),
      {
        ...record.references![0]!,
        href: "https://b.example/love",
      },
    ];
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", [record])],
      }),
    ).toThrow("conflicting duplicate reference_id");

    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "freedom",
        sources: [
          source("lexicon", [
            meaning("love", "Definition A"),
            meaning("love", "Definition B"),
          ]),
        ],
      }),
    ).toThrow("conflicting duplicate record");
  });

  test("publisher and proof assertions never upgrade verification or trust", () => {
    const record = meaning(
      "love",
      "Care that remains.",
      "https://example.test/love",
    );
    Object.assign(record.references![0]!, {
      verification: "verified",
      trust: "trusted",
    });

    const result = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [source("lexicon", [record])],
    });
    const reference = result.meanings[0]!.references[0]!;

    expect(reference).toMatchObject({
      asserted_by: "did:example:love",
      proof: "proof:love",
      verification: "unverified",
      trust: "untrusted",
    });

    const opaqueSource = meaning(
      "love",
      "Care that remains.",
      "https://example.test/love",
    );
    const opaqueAssertion = "\u0344".repeat(
      WORD_REFERENCE_LIMITS.assertedBy,
    );
    opaqueSource.references![0]!.asserted_by = opaqueAssertion;
    const opaqueResult = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [source("lexicon", [opaqueSource])],
    });
    expect(
      opaqueResult.meanings[0]!.references[0]!.asserted_by,
    ).toBe(opaqueAssertion);
  });

  test("rejects unknown source fields and malformed import assertions", () => {
    const record = meaning(
      "love",
      "Care that remains.",
      "https://example.test/love",
    );
    Object.assign(record, { owner: "nobody" });
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", [record])],
      }),
    ).toThrow("unknown field: owner");

    const malformed = meaning(
      "love",
      "Care that remains.",
      "https://example.test/love",
    );
    Object.assign(malformed.references![0]!, { trust: { score: 1 } });
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", [malformed])],
      }),
    ).toThrow("trust must be a string");
  });

  test("exact-name mode rejects prose and meaning-search mode", () => {
    expect(() => normalizeWordName("care that remains")).toThrow(
      "one dotless Unicode word",
    );
    expect(() =>
      resolveWordReference({
        mode: "meaning_search",
        word: "love",
        sources: [],
      } as never),
    ).toThrow("mode must be exact_name");
  });

  test("normalizes a dotless Unicode word and rejects a dotted name", () => {
    expect(normalizeWordName("  E\u0301LAN  ")).toBe("élan");
    expect(() => normalizeWordName("love.com")).toThrow(
      "one dotless Unicode word",
    );
    expect(() => normalizeWordName("\ud800")).toThrow(
      "Unicode scalar values",
    );
    expect(() => normalizeWordName("\nlove")).toThrow("control characters");
  });

  test("requires stable source coordinates and BCP 47-shaped languages", () => {
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("source with spaces", [meaning("love", "Care.")])],
      }),
    ).toThrow("ASCII source-scoped identifier");

    const record = meaning("love", "Care.");
    record.language = "x";
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", [record])],
      }),
    ).toThrow("BCP 47-shaped");

    const noncanonical = meaning("love", "Care.");
    noncanonical.word = "LOVE";
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", [noncanonical])],
      }),
    ).toThrow("canonical exact-name form");
  });

  test("unknown words return an empty result without a claim invitation", () => {
    const result = resolveWordReference({
      mode: "exact_name",
      word: "freedom",
      sources: [source("lexicon", [meaning("love", "Care that remains.")])],
    });

    expect(result).toEqual({
      protocol: WORD_REFERENCE_PROTOCOL,
      mode: "exact_name",
      query: { input: "freedom", normalized: "freedom" },
      found: false,
      meanings: [],
      ambiguity: {
        meanings: 0,
        references: 0,
        automatic_selection: false,
      },
      selection: null,
    });
    expect(JSON.stringify(result)).not.toContain("claim");
  });

  test("resolution performs no network call", () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("network must not be used");
    }) as typeof fetch;

    const result = resolveWordReference({
      mode: "exact_name",
      word: "love",
      sources: [
        source("lexicon", [
          meaning(
            "love",
            "Care that remains.",
            "https://example.test/love",
          ),
        ]),
      ],
    });

    expect(result.found).toBe(true);
    expect(calls).toBe(0);
  });

  test("bounds source, record, and reference fan-out", () => {
    const emptySources = Array.from(
      { length: WORD_REFERENCE_LIMITS.sources + 1 },
      (_, index) => source(`source.${index}`, []),
    );
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: emptySources,
      }),
    ).toThrow(`at most ${WORD_REFERENCE_LIMITS.sources}`);

    const tooManyReferences = meaning("love", "Care that remains.");
    tooManyReferences.references = Array.from(
      { length: WORD_REFERENCE_LIMITS.referencesPerRecord + 1 },
      (_, index) => ({
        reference_id: `site-${index}`,
        kind: "site",
        href: `https://example.test/${index}`,
      }),
    );
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", [tooManyReferences])],
      }),
    ).toThrow(`at most ${WORD_REFERENCE_LIMITS.referencesPerRecord}`);

    const referenceHeavyRecords = Array.from(
      {
        length:
          Math.floor(
            WORD_REFERENCE_LIMITS.referencesTotal
              / WORD_REFERENCE_LIMITS.referencesPerRecord,
          ) + 1,
      },
      (_, recordIndex) => ({
        ...meaning(`love-${recordIndex}`, "Care that remains."),
        references: Array.from(
          { length: WORD_REFERENCE_LIMITS.referencesPerRecord },
          (_, referenceIndex) => ({
            reference_id: `site-${referenceIndex}`,
            kind: "site",
            href: `https://example.test/${recordIndex}/${referenceIndex}`,
          }),
        ),
      }),
    );
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", referenceHeavyRecords)],
      }),
    ).toThrow(`at most ${WORD_REFERENCE_LIMITS.referencesTotal}`);

    const textHeavyRecords = Array.from(
      {
        length:
          Math.floor(
            WORD_REFERENCE_LIMITS.sourceTextCodePointsTotal
              / WORD_REFERENCE_LIMITS.definition,
          ) + 2,
      },
      (_, index) =>
        meaning(
          `love-${index}`,
          "a".repeat(WORD_REFERENCE_LIMITS.definition),
        ),
    );
    expect(() =>
      resolveWordReference({
        mode: "exact_name",
        word: "love",
        sources: [source("lexicon", textHeavyRecords)],
      }),
    ).toThrow(
      `at most ${WORD_REFERENCE_LIMITS.sourceTextCodePointsTotal} aggregate`,
    );
  });
});
