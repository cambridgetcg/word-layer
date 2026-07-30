import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import {
  WORD_BROWSER_HANDOFF_PROTOCOL,
  WordBrowserSession,
  type WordBrowserPlan,
} from "../src/browser-handoff";
import {
  WORD_REFERENCE_LIMITS,
  WORD_REFERENCE_PROTOCOL,
  type ExactNameResolutionInput,
} from "../src/reference";

type JsonObject = Record<string, any>;

async function loadSchema(name: string): Promise<JsonObject> {
  const url = new URL(`../schema/${name}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

function patterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(patterns);
  if (!value || typeof value !== "object") return [];
  const object = value as JsonObject;
  return [
    ...(typeof object.pattern === "string" ? [object.pattern] : []),
    ...Object.values(object).flatMap(patterns),
  ];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("word-reference/0.1 schemas", () => {
  test("parse and contain valid Unicode-aware regular expressions", async () => {
    const schemas = await Promise.all([
      loadSchema("word-reference-source-v0.1.schema.json"),
      loadSchema("word-reference-resolution-v0.1.schema.json"),
      loadSchema("word-browser-handoff-v0.1.schema.json"),
    ]);

    for (const schema of schemas) {
      expect(schema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      for (const pattern of patterns(schema)) {
        expect(() => new RegExp(pattern, "u")).not.toThrow();
      }
    }
  });

  test("keep source and response bounds aligned with the resolver", async () => {
    const source = await loadSchema(
      "word-reference-source-v0.1.schema.json",
    );
    const resolution = await loadSchema(
      "word-reference-resolution-v0.1.schema.json",
    );
    const maximumMeanings =
      WORD_REFERENCE_LIMITS.sources * WORD_REFERENCE_LIMITS.recordsPerSource;

    expect(source.properties.records.maxItems).toBe(
      WORD_REFERENCE_LIMITS.recordsPerSource,
    );
    expect(source.$defs.record.properties.references.maxItems).toBe(
      WORD_REFERENCE_LIMITS.referencesPerRecord,
    );
    expect(source.$defs.word.maxLength).toBe(WORD_REFERENCE_LIMITS.word);
    expect(source.$defs.record.properties.definition.maxLength).toBe(
      WORD_REFERENCE_LIMITS.definition,
    );
    expect(source.$defs.reference.properties.href.maxLength).toBe(
      WORD_REFERENCE_LIMITS.href,
    );
    expect(source.$defs.reference.properties.href.format).toBe("iri");

    expect(resolution.properties.meanings.maxItems).toBe(maximumMeanings);
    expect(resolution.$defs.meaning.properties.references.maxItems).toBe(
      WORD_REFERENCE_LIMITS.referencesPerRecord,
    );
    expect(resolution.$defs.ambiguity.properties.meanings.maximum).toBe(
      maximumMeanings,
    );
    expect(resolution.$defs.ambiguity.properties.references.maximum).toBe(
      WORD_REFERENCE_LIMITS.referencesTotal,
    );
    expect(resolution.$defs.query.properties.input.maxLength).toBe(
      WORD_REFERENCE_LIMITS.wordInput,
    );
    expect(resolution.$defs.reference.properties.href.format).toBe("uri");
  });

  test("encode plurality and zero automatic authority", async () => {
    const source = await loadSchema(
      "word-reference-source-v0.1.schema.json",
    );
    const resolution = await loadSchema(
      "word-reference-resolution-v0.1.schema.json",
    );

    expect(source.additionalProperties).toBe(false);
    expect(source.$defs.record.additionalProperties).toBe(false);
    expect(source.$defs.reference.additionalProperties).toBe(false);
    expect(resolution.properties.protocol.const).toBe("word-reference/0.1");
    expect(resolution.properties.mode.const).toBe("exact_name");
    expect(
      resolution.$defs.ambiguity.properties.automatic_selection.const,
    ).toBe(false);
    expect(resolution.properties.selection.const).toBeNull();
    expect(resolution.$defs.reference.properties.verification.const).toBe(
      "unverified",
    );
    expect(resolution.$defs.reference.properties.trust.const).toBe(
      "untrusted",
    );
  });
});

interface SchemaTestPlan extends WordBrowserPlan {
  schema: "test-browser-plan/0.1";
  action: {
    kind: "new_tab";
    url: string;
  };
  authority: {
    decision: "checked_at_execution";
  };
}

function handoffInput(): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word: "LOVE",
    sources: [
      {
        protocol: WORD_REFERENCE_PROTOCOL,
        source_id: "source.a",
        records: [
          {
            record_id: "giving",
            word: "love",
            language: "en",
            definition: "Care offered freely.",
            references: [
              {
                reference_id: "site",
                kind: "site",
                href:
                  "https://shared.example/love/path?token=private#fragment",
                asserted_by: "did:example:a",
                proof: "proof:a",
              },
              {
                reference_id: "feed",
                kind: "feed",
                href: "https://shared.example/love/feed?format=atom",
              },
            ],
          },
        ],
      },
    ],
  };
}

async function canonicalHandoffOutputs() {
  const browser = {
    plan(): SchemaTestPlan {
      return {
        schema: "test-browser-plan/0.1",
        execution: false,
        action: {
          kind: "new_tab",
          url: "https://shared.example/love/path?token=%5Bredacted%5D",
        },
        authority: {
          decision: "checked_at_execution",
        },
      };
    },
    async open() {
      return {
        tab_id: "tab-1",
        observation: {
          title: "Love",
          nodes: [1, true, null],
        },
      };
    },
  };
  let entropy = 0;
  const session = new WordBrowserSession({
    browser,
    now: () => Date.parse("2026-07-30T12:00:00.000Z"),
    randomBytes(length) {
      entropy += 1;
      return new Uint8Array(length).fill(entropy);
    },
  });
  const offer = session.resolve(handoffInput());
  const site = offer.meanings[0]!.references.find(
    (reference) => reference.kind === "site",
  )!;
  const selection = session.select({
    choice_handle: site.choice_handle!,
  });
  const plan = session.plan({
    selection_handle: selection.selection_handle,
  });
  const open = await session.open({
    open_handle: plan.open_handle,
  });
  return { offer, selection, plan, open };
}

describe("word-browser-handoff/0.1 schema", () => {
  test("accepts every canonical runtime output", async () => {
    const schema = await loadSchema(
      "word-browser-handoff-v0.1.schema.json",
    );
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
    });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const outputs = await canonicalHandoffOutputs();

    for (const output of Object.values(outputs)) {
      expect(validate(output), JSON.stringify(validate.errors)).toBe(true);
    }

    const planWithExtraBrowserFields = clone(outputs.plan);
    (planWithExtraBrowserFields.browser_plan as Record<string, unknown>)
      .possibleEffects = ["external_read_intent"];
    expect(
      validate(planWithExtraBrowserFields),
      JSON.stringify(validate.errors),
    ).toBe(true);

    const openWithGenericBrowserResult = {
      ...outputs.open,
      browser_result: ["opaque", { nested: true }, null],
    };
    expect(
      validate(openWithGenericBrowserResult),
      JSON.stringify(validate.errors),
    ).toBe(true);
  });

  test("rejects unknown fields and leaked href values", async () => {
    const schema = await loadSchema(
      "word-browser-handoff-v0.1.schema.json",
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const outputs = await canonicalHandoffOutputs();

    const adversarial = [
      { ...outputs.offer, unexpected: true },
      { ...outputs.selection, unexpected: true },
      { ...outputs.plan, unexpected: true },
      { ...outputs.open, unexpected: true },
      clone(outputs.offer),
      clone(outputs.selection),
      clone(outputs.plan),
      clone(outputs.open),
      clone(outputs.plan),
    ];
    (adversarial[4]!.meanings[0].references[0] as JsonObject).href =
      "https://leak.example/offer";
    (adversarial[5]!.selected as JsonObject).href =
      "https://leak.example/selection";
    (adversarial[6]!.selected as JsonObject).href =
      "https://leak.example/plan";
    (adversarial[7]!.selected as JsonObject).href =
      "https://leak.example/open";
    (adversarial[8]!.browser_plan as JsonObject).nested = {
      href: "https://leak.example/browser-plan",
    };

    for (const output of adversarial) {
      expect(validate(output)).toBe(false);
    }
  });

  test("locks protocol, authority, automatic action, and selection stages", async () => {
    const schema = await loadSchema(
      "word-browser-handoff-v0.1.schema.json",
    );
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const outputs = await canonicalHandoffOutputs();

    const protocolDrift = clone(outputs.offer);
    protocolDrift.protocol =
      "word-browser-handoff/0.2" as typeof WORD_BROWSER_HANDOFF_PROTOCOL;
    const authorityDrift = clone(outputs.selection);
    authorityDrift.authority = "resolver" as "none";
    const automaticActionDrift = clone(outputs.plan);
    automaticActionDrift.automatic_action = "open" as "never";
    const automaticSelectionDrift = clone(outputs.offer);
    automaticSelectionDrift.ambiguity.automatic_selection = true as false;
    const offerSelectionDrift = {
      ...outputs.offer,
      selection: { reference_id: "site" },
    };
    const selectionStageDrift = clone(outputs.selection);
    selectionStageDrift.next = "open" as "plan";
    const planStageDrift = clone(outputs.plan);
    planStageDrift.next = "done" as "open";
    const selectedKindDrift = clone(outputs.selection);
    selectedKindDrift.selected.kind = "feed" as "site";
    const effectfulPlan = clone(outputs.plan);
    effectfulPlan.browser_plan.execution = true as false;
    const disabledSiteChoice = clone(outputs.offer);
    const offeredSite = disabledSiteChoice.meanings[0]!.references.find(
      (reference) => reference.kind === "site",
    )!;
    offeredSite.selectable = false;
    offeredSite.choice_handle = null;
    const selectableFeed = clone(outputs.offer);
    const offeredFeed = selectableFeed.meanings[0]!.references.find(
      (reference) => reference.kind === "feed",
    )!;
    offeredFeed.selectable = true;
    offeredFeed.choice_handle =
      outputs.offer.meanings[0]!.references.find(
        (reference) => reference.kind === "site",
      )!.choice_handle;
    const missingQuery = clone(outputs.selection) as JsonObject;
    delete missingQuery.selected.query;
    const missingProvenance = clone(outputs.open) as JsonObject;
    delete missingProvenance.selected.provenance.definition_sha256;

    for (const output of [
      protocolDrift,
      authorityDrift,
      automaticActionDrift,
      automaticSelectionDrift,
      offerSelectionDrift,
      selectionStageDrift,
      planStageDrift,
      selectedKindDrift,
      effectfulPlan,
      disabledSiteChoice,
      selectableFeed,
      missingQuery,
      missingProvenance,
    ]) {
      expect(validate(output)).toBe(false);
    }
  });
});
