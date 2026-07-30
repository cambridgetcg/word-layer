import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";

import {
  WORD_BROWSER_OPERATIONS,
  WORD_JSONL_PROTOCOL_VERSION,
} from "../src/protocol.js";

async function loadSchema(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      new URL(
        "../schema/agenttool-word-jsonl-v0.1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

describe("agenttool-word-jsonl/0.1 schema", () => {
  test("locks the schema operation set to the runtime registry", async () => {
    const schema = await loadSchema() as {
      $defs: { method: { enum: string[] } };
    };

    expect(schema.$defs.method.enum).toEqual([...WORD_BROWSER_OPERATIONS]);
  });

  test("validates strict request and response envelopes", async () => {
    const validate = new Ajv2020({ strict: true }).compile(
      await loadSchema(),
    );
    const request = {
      version: WORD_JSONL_PROTOCOL_VERSION,
      id: "resolve-1",
      method: "word_resolve",
      params: {
        mode: "exact_name",
        word: "love",
        sources: [],
      },
    };
    const success = {
      version: WORD_JSONL_PROTOCOL_VERSION,
      id: "resolve-1",
      ok: true,
      result: { found: false },
    };
    const failure = {
      version: WORD_JSONL_PROTOCOL_VERSION,
      id: null,
      ok: false,
      error: {
        code: "invalid_json",
        message: "line is not valid JSON",
      },
    };

    expect(validate(request)).toBe(true);
    expect(validate(success)).toBe(true);
    expect(validate(failure)).toBe(true);
    expect(validate({ ...request, extra: true })).toBe(false);
    expect(validate({ ...request, method: "word_rank" })).toBe(false);
    expect(validate({ ...failure, error: { ...failure.error, stack: "x" } }))
      .toBe(false);
  });
});
