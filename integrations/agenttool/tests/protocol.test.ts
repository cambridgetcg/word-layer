import { describe, expect, test } from "bun:test";

import {
  WORD_INPUT_SCHEMAS,
  unicodeScalarLength,
} from "../src/protocol.js";

describe("Word transport protocol bounds", () => {
  test("counts supplementary-plane source text as Unicode code points", () => {
    const word = "𐐨".repeat(100);
    const parsed = WORD_INPUT_SCHEMAS.word_resolve.safeParse({
      mode: "exact_name",
      word,
      sources: [{
        protocol: "word-reference/0.1",
        source_id: "deseret.source",
        records: [{
          record_id: "supplementary",
          word,
          language: "en",
          definition: `Meaning ${"😀".repeat(4_000)}`,
          references: [],
        }],
      }],
    });

    expect(word.length).toBe(200);
    expect(unicodeScalarLength(word)).toBe(100);
    expect(parsed.success).toBe(true);
  });

  test("rejects unpaired UTF-16 surrogates before core dispatch", () => {
    const invalid = "\ud800";

    expect(unicodeScalarLength(invalid)).toBeUndefined();
    expect(
      WORD_INPUT_SCHEMAS.word_resolve.safeParse({
        mode: "exact_name",
        word: invalid,
        sources: [],
      }).success,
    ).toBe(false);
  });

  test("remote resolution accepts only exact mode and a word, never an origin or sources", () => {
    expect(
      WORD_INPUT_SCHEMAS.word_resolve_remote.safeParse({
        mode: "exact_name",
        word: "love",
      }).success,
    ).toBe(true);
    expect(
      WORD_INPUT_SCHEMAS.word_resolve_remote.safeParse({
        mode: "meaning_search",
        word: "love",
      }).success,
    ).toBe(false);
    expect(
      WORD_INPUT_SCHEMAS.word_resolve_remote.safeParse({
        mode: "exact_name",
        word: "love",
        resolver_url: "https://attacker.example/",
      }).success,
    ).toBe(false);
    expect(
      WORD_INPUT_SCHEMAS.word_resolve_remote.safeParse({
        mode: "exact_name",
        word: "love",
        sources: [],
      }).success,
    ).toBe(false);
  });
});
