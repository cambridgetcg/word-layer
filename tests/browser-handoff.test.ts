import { describe, expect, test } from "bun:test";

import {
  WORD_BROWSER_HANDOFF_PROTOCOL,
  WordBrowserHandoffError,
  WordBrowserSession,
  type WordBrowserPlan,
} from "../src/browser-handoff";
import {
  WORD_REFERENCE_PROTOCOL,
  type ExactNameResolutionInput,
  type WordMeaningRecordInput,
  type WordReferenceSourceInput,
} from "../src/reference";

const RETAINED_URL =
  "https://shared.example/love/path?token=private-value#quiet-fragment";

interface FakePlan extends WordBrowserPlan {
  summary: string;
}

class FakeBrowser {
  readonly plans: Array<Readonly<{ kind: "new_tab"; url: string }>> = [];
  readonly opens: string[] = [];

  planImplementation:
    | ((action: Readonly<{ kind: "new_tab"; url: string }>) => FakePlan)
    | undefined;
  openImplementation: ((url: string) => Promise<{ tab_id: string }>) | undefined;

  plan(action: Readonly<{ kind: "new_tab"; url: string }>): FakePlan {
    this.plans.push(action);
    return this.planImplementation?.(action) ?? {
      execution: false,
      summary: "Would open one new tab.",
    };
  }

  async open(url: string): Promise<{ tab_id: string }> {
    this.opens.push(url);
    return this.openImplementation?.(url) ?? { tab_id: "tab-1" };
  }
}

function deterministicEntropy(seed = 1): (length: number) => Uint8Array {
  let call = seed;
  return (length) => {
    const bytes = new Uint8Array(length);
    bytes.fill(call % 256);
    call += 1;
    return bytes;
  };
}

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

function pluralInput(): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word: "LOVE",
    sources: [
      source("source.b", [
        {
          record_id: "staying",
          word: "love",
          language: "en",
          definition: "Care that remains.",
          references: [
            {
              reference_id: "same-site",
              kind: "site",
              href: RETAINED_URL,
              asserted_by: "did:example:b",
              proof: "proof:b",
            },
          ],
        },
      ]),
      source("source.a", [
        {
          record_id: "giving",
          word: "love",
          language: "en",
          definition: "Care offered freely.",
          references: [
            {
              reference_id: "same-site",
              kind: "site",
              href: RETAINED_URL,
              asserted_by: "did:example:a",
              proof: "proof:a",
            },
            {
              reference_id: "public-feed",
              kind: "feed",
              href: "https://shared.example/love/feed?format=atom#latest",
            },
          ],
        },
      ]),
    ],
  };
}

function singleSiteInput(
  href = RETAINED_URL,
): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word: "love",
    sources: [
      source("source.a", [
        {
          record_id: "giving",
          word: "love",
          language: "en",
          definition: "Care offered freely.",
          references: [
            {
              reference_id: "site",
              kind: "site",
              href,
              asserted_by: "did:example:a",
              proof: "proof:a",
            },
          ],
        },
      ]),
    ],
  };
}

function nonSiteInput(): ExactNameResolutionInput {
  return {
    mode: "exact_name",
    word: "love",
    sources: [
      source("source.a", [
        {
          record_id: "giving",
          word: "love",
          language: "en",
          definition: "Care offered freely.",
          references: [
            {
              reference_id: "feed",
              kind: "feed",
              href: "https://shared.example/love/feed?format=atom",
            },
          ],
        },
      ]),
    ],
  };
}

function createSession(
  browser = new FakeBrowser(),
  overrides: Partial<{
    now: () => number;
    randomBytes: (length: number) => Uint8Array;
    ttlMs: number;
    maxActiveHandles: number;
    maxActiveResolutions: number;
    maxOfferBytes: number;
  }> = {},
): WordBrowserSession<FakePlan, { tab_id: string }> {
  return new WordBrowserSession({
    browser,
    randomBytes: deterministicEntropy(),
    ...overrides,
  });
}

function expectSyncCode(
  operation: () => unknown,
  code: WordBrowserHandoffError["code"],
): void {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WordBrowserHandoffError);
  expect((thrown as WordBrowserHandoffError).code).toBe(code);
}

async function expectAsyncCode(
  operation: () => Promise<unknown>,
  code: WordBrowserHandoffError["code"],
): Promise<void> {
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(WordBrowserHandoffError);
  expect((thrown as WordBrowserHandoffError).code).toBe(code);
}

function onlySiteChoice(
  session: WordBrowserSession<FakePlan, { tab_id: string }>,
): string {
  const offer = session.resolve(singleSiteInput());
  return offer.meanings[0]!.references[0]!.choice_handle!;
}

describe("word-browser-handoff/0.1", () => {
  test("resolution is effect-free, plural, redacted, and only sites are selectable", () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);
    const offer = session.resolve(pluralInput());
    const references = offer.meanings.flatMap((meaning) => meaning.references);
    const siteReferences = references.filter(
      (reference) => reference.kind === "site",
    );
    const feed = references.find((reference) => reference.kind === "feed")!;

    expect(offer).toMatchObject({
      protocol: WORD_BROWSER_HANDOFF_PROTOCOL,
      source_protocol: WORD_REFERENCE_PROTOCOL,
      query: { input: "LOVE", normalized: "love" },
      found: true,
      ambiguity: {
        meanings: 2,
        references: 3,
        browser_choices: 2,
        automatic_selection: false,
      },
      selection: null,
      authority: "none",
      automatic_action: "never",
    });
    expect(browser.plans).toEqual([]);
    expect(browser.opens).toEqual([]);
    expect(siteReferences).toHaveLength(2);
    expect(siteReferences[0]!.choice_handle).not.toBe(
      siteReferences[1]!.choice_handle,
    );
    expect(siteReferences.every((reference) => reference.selectable)).toBe(
      true,
    );
    expect(feed).toMatchObject({
      selectable: false,
      choice_handle: null,
      display_url: "https://shared.example/love/feed",
      target_redacted: true,
    });

    const serialized = JSON.stringify(offer);
    expect(serialized).not.toContain("private-value");
    expect(serialized).not.toContain("quiet-fragment");
    expect(serialized).not.toContain("\"href\"");
    expect(serialized).toContain("/love/path");
  });

  test("retains one exact URL across selection, planning, mutation, and opening", async () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);
    const mutableInput = singleSiteInput() as {
      sources: Array<{
        records: Array<{
          references: Array<{ href: string }>;
        }>;
      }>;
    } & ExactNameResolutionInput;
    const offer = session.resolve(mutableInput);
    const offered = offer.meanings[0]!.references[0]!;
    const choiceHandle = offered.choice_handle!;

    mutableInput.sources[0]!.records[0]!.references[0]!.href =
      "https://attacker.example/substituted";
    offered.display_url = "https://attacker.example/offer-mutation";
    offered.proof = "mutated proof";

    const selection = session.select({ choice_handle: choiceHandle });
    expect(selection.selected).toMatchObject({
      query: { normalized: "love" },
      meaning_id: "source.a:giving",
      word: "love",
      language: "en",
      provenance: {
        source_id: "source.a",
        record_id: "giving",
        definition_sha256:
          offer.meanings[0]!.provenance.definition_sha256,
      },
      reference_id: "site",
      display_url: "https://shared.example/love/path",
      target_redacted: true,
      proof: "proof:a",
    });
    expect(selection.next).toBe("plan");
    selection.selected.display_url =
      "https://attacker.example/selection-mutation";

    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });
    expect(browser.plans).toEqual([
      { kind: "new_tab", url: RETAINED_URL },
    ]);
    expect(plan).toMatchObject({
      browser_action: { kind: "new_tab" },
      browser_plan: { execution: false },
      next: "open",
    });
    expect(plan.expires_at).toBe(selection.expires_at);
    plan.selected.display_url = "https://attacker.example/plan-mutation";

    const opened = await session.open({ open_handle: plan.open_handle });
    expect(browser.opens).toEqual([RETAINED_URL]);
    expect(opened).toMatchObject({
      attempted_once: true,
      selected: {
        display_url: "https://shared.example/love/path",
        proof: "proof:a",
      },
      browser_result: { tab_id: "tab-1" },
    });
  });

  test("rejects URL substitution and enforces each capability stage", async () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);
    const choice = onlySiteChoice(session);

    expectSyncCode(
      () =>
        session.select({
          choice_handle: choice,
          url: "https://attacker.example",
        } as { choice_handle: string }),
      "invalid_request",
    );
    expectSyncCode(
      () => session.plan({ selection_handle: choice }),
      "invalid_handle",
    );

    const selection = session.select({ choice_handle: choice });
    expectSyncCode(
      () => session.select({ choice_handle: choice }),
      "invalid_handle",
    );
    expectSyncCode(
      () =>
        session.plan({
          selection_handle: selection.selection_handle,
          url: "https://attacker.example",
        } as { selection_handle: string }),
      "invalid_request",
    );
    expect(browser.plans).toEqual([]);
    await expectAsyncCode(
      () => session.open({ open_handle: selection.selection_handle }),
      "invalid_handle",
    );

    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });
    expectSyncCode(
      () => session.plan({ selection_handle: selection.selection_handle }),
      "invalid_handle",
    );
    expectSyncCode(
      () => session.select({ choice_handle: plan.open_handle }),
      "invalid_handle",
    );
    await expectAsyncCode(
      () =>
        session.open({
          open_handle: plan.open_handle,
          url: "https://attacker.example",
        } as { open_handle: string }),
      "invalid_request",
    );
    expect(browser.opens).toEqual([]);
    await session.open({ open_handle: plan.open_handle });
    expect(browser.opens).toEqual([RETAINED_URL]);
  });

  test("a failed or effectful plan creates no open ticket and preserves selection", () => {
    const browser = new FakeBrowser();
    let attempt = 0;
    browser.planImplementation = () => {
      attempt += 1;
      if (attempt === 1) throw new Error("planning unavailable");
      if (attempt === 2) {
        return {
          execution: true,
          summary: "invalid",
        } as unknown as FakePlan;
      }
      return {
        execution: false,
        summary: "Would open one new tab.",
      };
    };
    const session = createSession(browser);
    const selection = session.select({
      choice_handle: onlySiteChoice(session),
    });

    expectSyncCode(
      () => session.plan({ selection_handle: selection.selection_handle }),
      "browser_plan_failed",
    );
    expectSyncCode(
      () => session.plan({ selection_handle: selection.selection_handle }),
      "browser_plan_failed",
    );
    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });

    expect(plan.browser_plan.execution).toBe(false);
    expect(browser.plans).toHaveLength(3);
    expect(browser.opens).toEqual([]);
  });

  test("rejects plan data that could violate the handoff wire schema", () => {
    const browser = new FakeBrowser();
    const session = createSession(browser);
    const selection = session.select({
      choice_handle: onlySiteChoice(session),
    });
    browser.planImplementation = () => ({
      execution: false,
      summary: "unsafe structural port output",
      nested: { href: RETAINED_URL },
    } as FakePlan);

    expectSyncCode(
      () =>
        session.plan({
          selection_handle: selection.selection_handle,
        }),
      "browser_plan_failed",
    );

    browser.planImplementation = undefined;
    const recovered = session.plan({
      selection_handle: selection.selection_handle,
    });
    expect(recovered.browser_plan.execution).toBe(false);
  });

  test("entropy failure after planning is transactional", () => {
    const browser = new FakeBrowser();
    let entropyCall = 0;
    const randomBytes = (length: number): Uint8Array => {
      entropyCall += 1;
      if (entropyCall === 5) {
        throw new Error("entropy temporarily unavailable");
      }
      return new Uint8Array(length).fill(entropyCall);
    };
    const session = createSession(browser, { randomBytes });
    const selection = session.select({
      choice_handle: onlySiteChoice(session),
    });

    expectSyncCode(
      () => session.plan({ selection_handle: selection.selection_handle }),
      "internal_error",
    );
    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });

    expect(plan.open_handle).toStartWith("open_");
    expect(browser.plans).toHaveLength(2);
    expect(browser.opens).toEqual([]);
  });

  test("open is one-shot before I/O, including concurrent and failed attempts", async () => {
    const browser = new FakeBrowser();
    let release:
      | ((value: { tab_id: string }) => void)
      | undefined;
    browser.openImplementation = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const session = createSession(browser);
    const selection = session.select({
      choice_handle: onlySiteChoice(session),
    });
    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });

    const first = session.open({ open_handle: plan.open_handle });
    expect(browser.opens).toEqual([RETAINED_URL]);
    await expectAsyncCode(
      () => session.open({ open_handle: plan.open_handle }),
      "invalid_handle",
    );
    expect(browser.opens).toEqual([RETAINED_URL]);
    release!({ tab_id: "tab-concurrent" });
    await expect(first).resolves.toMatchObject({
      browser_result: { tab_id: "tab-concurrent" },
    });

    const failingBrowser = new FakeBrowser();
    failingBrowser.openImplementation = async () => {
      throw new Error("navigation outcome unknown");
    };
    const failingSession = createSession(failingBrowser, {
      randomBytes: deterministicEntropy(90),
    });
    const failingSelection = failingSession.select({
      choice_handle: onlySiteChoice(failingSession),
    });
    const failingPlan = failingSession.plan({
      selection_handle: failingSelection.selection_handle,
    });
    await expectAsyncCode(
      () => failingSession.open({ open_handle: failingPlan.open_handle }),
      "browser_open_failed",
    );
    await expectAsyncCode(
      () => failingSession.open({ open_handle: failingPlan.open_handle }),
      "invalid_handle",
    );
    expect(failingBrowser.opens).toEqual([RETAINED_URL]);
  });

  test("spends an open handle when Browser returns non-JSON data", async () => {
    const browser = new FakeBrowser();
    browser.openImplementation = async () =>
      undefined as unknown as { tab_id: string };
    const session = createSession(browser);
    const selection = session.select({
      choice_handle: onlySiteChoice(session),
    });
    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });

    await expectAsyncCode(
      () => session.open({ open_handle: plan.open_handle }),
      "browser_open_failed",
    );
    await expectAsyncCode(
      () => session.open({ open_handle: plan.open_handle }),
      "invalid_handle",
    );
    expect(browser.opens).toEqual([RETAINED_URL]);
  });

  test("all stages inherit one deadline and expiry is closed at the boundary", async () => {
    const browser = new FakeBrowser();
    let now = 10_000;
    const session = createSession(browser, {
      now: () => now,
      ttlMs: 1_000,
    });
    const offer = session.resolve(singleSiteInput());

    now = 10_999;
    const selection = session.select({
      choice_handle: offer.meanings[0]!.references[0]!.choice_handle!,
    });
    const plan = session.plan({
      selection_handle: selection.selection_handle,
    });
    expect(selection.expires_at).toBe(offer.expires_at);
    expect(plan.expires_at).toBe(offer.expires_at);

    now = 11_000;
    await expectAsyncCode(
      () => session.open({ open_handle: plan.open_handle }),
      "handle_expired",
    );
    expect(browser.opens).toEqual([]);
  });

  test("handles are session-local and close invalidates all outstanding state", () => {
    const first = createSession(new FakeBrowser(), {
      randomBytes: deterministicEntropy(1),
    });
    const secondBrowser = new FakeBrowser();
    const second = createSession(secondBrowser, {
      randomBytes: deterministicEntropy(1),
    });
    const firstChoice = onlySiteChoice(first);
    const secondOffer = second.resolve(
      singleSiteInput("https://session-b.example/two"),
    );
    const secondChoice =
      secondOffer.meanings[0]!.references[0]!.choice_handle!;

    expect(firstChoice).not.toBe(secondChoice);
    expectSyncCode(
      () => second.select({ choice_handle: firstChoice }),
      "invalid_handle",
    );
    expect(
      second.select({ choice_handle: secondChoice }).selection_handle,
    ).toStartWith("selection_");
    expect(secondBrowser.plans).toEqual([]);
    expect(secondBrowser.opens).toEqual([]);
    first.close();
    first.close();
    expectSyncCode(
      () => first.select({ choice_handle: firstChoice }),
      "session_closed",
    );
    expectSyncCode(
      () => first.resolve(singleSiteInput()),
      "session_closed",
    );
  });

  test("capacity and mid-resolution entropy failures commit no partial state", () => {
    const capacitySession = createSession(new FakeBrowser(), {
      maxActiveHandles: 1,
    });
    expectSyncCode(
      () => capacitySession.resolve(pluralInput()),
      "state_full",
    );
    expect(
      capacitySession.resolve(singleSiteInput()).ambiguity.browser_choices,
    ).toBe(1);

    let entropyCall = 0;
    const entropySession = createSession(new FakeBrowser(), {
      randomBytes: (length) => {
        entropyCall += 1;
        if (entropyCall === 4) return new Uint8Array(length - 1);
        return new Uint8Array(length).fill(entropyCall);
      },
    });
    expectSyncCode(
      () => entropySession.resolve(pluralInput()),
      "internal_error",
    );
    const recovered = entropySession.resolve(singleSiteInput());
    expect(recovered.ambiguity.browser_choices).toBe(1);
  });

  test("rejects oversized offers before committing their capabilities", () => {
    const session = createSession(new FakeBrowser(), {
      maxActiveResolutions: 1,
      maxOfferBytes: 1_200,
    });

    expectSyncCode(
      () => session.resolve(pluralInput()),
      "result_too_large",
    );

    const recovered = session.resolve(singleSiteInput());
    expect(recovered.ambiguity.browser_choices).toBe(1);
    expect(session.discardResolution(recovered.resolution_id)).toBe(true);
    expect(session.discardResolution(recovered.resolution_id)).toBe(false);
  });

  test("reentrant entropy cannot bypass session capacity", () => {
    const browser = new FakeBrowser();
    let session:
      | WordBrowserSession<FakePlan, { tab_id: string }>
      | undefined;
    let entropyCall = 0;
    let nestedError: unknown;
    const randomBytes = (length: number): Uint8Array => {
      entropyCall += 1;
      if (entropyCall === 2) {
        try {
          session!.resolve(
            singleSiteInput("https://nested.example/should-not-commit"),
          );
        } catch (error) {
          nestedError = error;
        }
      }
      return new Uint8Array(length).fill(entropyCall);
    };
    session = createSession(browser, {
      randomBytes,
      maxActiveHandles: 1,
    });

    const outer = session.resolve(singleSiteInput());
    expect(outer.ambiguity.browser_choices).toBe(1);
    expect(nestedError).toBeInstanceOf(WordBrowserHandoffError);
    expect((nestedError as WordBrowserHandoffError).code).toBe(
      "internal_error",
    );
    expectSyncCode(
      () => session!.resolve(singleSiteInput("https://another.example")),
      "state_full",
    );
  });

  test("resolve and select never return handles at or beyond their deadline", () => {
    const resolveTimes = [1_000, 1_001];
    const resolvingSession = createSession(new FakeBrowser(), {
      now: () => resolveTimes.shift() ?? 1_001,
      ttlMs: 1,
    });
    expectSyncCode(
      () => resolvingSession.resolve(singleSiteInput()),
      "handle_expired",
    );

    let now = 2_000;
    let entropyCall = 0;
    const selectingSession = createSession(new FakeBrowser(), {
      now: () => now,
      ttlMs: 1,
      randomBytes: (length) => {
        entropyCall += 1;
        if (entropyCall === 4) now = 2_001;
        return new Uint8Array(length).fill(entropyCall);
      },
    });
    const offer = selectingSession.resolve(singleSiteInput());
    expectSyncCode(
      () =>
        selectingSession.select({
          choice_handle:
            offer.meanings[0]!.references[0]!.choice_handle!,
        }),
      "handle_expired",
    );
  });

  test("non-site references remain visible without allocating capabilities", () => {
    const session = createSession(new FakeBrowser(), {
      maxActiveHandles: 1,
      maxActiveResolutions: 1,
    });
    for (let index = 0; index < 20; index += 1) {
      const offer = session.resolve(nonSiteInput());
      expect(offer.ambiguity.browser_choices).toBe(0);
      expect(offer.meanings[0]!.references[0]).toMatchObject({
        kind: "feed",
        selectable: false,
        choice_handle: null,
      });
    }
  });

  test("reports even empty query or fragment delimiters as redacted", () => {
    const queryOffer = createSession(
      new FakeBrowser(),
      { randomBytes: deterministicEntropy(40) },
    ).resolve(singleSiteInput("https://shared.example/love?"));
    const fragmentOffer = createSession(
      new FakeBrowser(),
      { randomBytes: deterministicEntropy(80) },
    ).resolve(singleSiteInput("https://shared.example/love#"));

    expect(queryOffer.meanings[0]!.references[0]).toMatchObject({
      display_url: "https://shared.example/love",
      target_redacted: true,
    });
    expect(fragmentOffer.meanings[0]!.references[0]).toMatchObject({
      display_url: "https://shared.example/love",
      target_redacted: true,
    });
  });

  test("standalone receipts retain the selected meaning provenance", () => {
    const session = createSession(new FakeBrowser());
    const firstInput = singleSiteInput();
    const secondInput = singleSiteInput();
    (
      secondInput.sources[0]!.records[0] as {
        definition: string;
      }
    ).definition = "A substantively different account of care.";

    const firstOffer = session.resolve(firstInput);
    const secondOffer = session.resolve(secondInput);
    const firstSelection = session.select({
      choice_handle:
        firstOffer.meanings[0]!.references[0]!.choice_handle!,
    });
    const secondSelection = session.select({
      choice_handle:
        secondOffer.meanings[0]!.references[0]!.choice_handle!,
    });

    expect(firstSelection.selected.provenance).toEqual(
      firstOffer.meanings[0]!.provenance,
    );
    expect(secondSelection.selected.provenance).toEqual(
      secondOffer.meanings[0]!.provenance,
    );
    expect(firstSelection.selected.provenance.definition_sha256).not.toBe(
      secondSelection.selected.provenance.definition_sha256,
    );
    expect(firstSelection.selected.query.normalized).toBe("love");
    expect(secondSelection.selected.query.normalized).toBe("love");
  });
});
