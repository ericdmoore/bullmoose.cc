import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv, type FakeWorker } from "@bullmoose/test-fakes";
import { loadBayesState } from "@bullmoose/mailstore";
import { __resetRecordedBayesLabels, recordBayesLabel } from "./bouncerContract";

// The merge seam between wave 2-D (conversations) and wave 2-C (training
// store): D's tests assert the journal, C's assert the store — this file
// asserts the DELEGATION, so dropping the store call cannot pass silently.

const ACCOUNT = "t_x__a_seam";

describe("recordBayesLabel delegates to the mailstore training write", () => {
  let w: FakeWorker;
  beforeEach(() => {
    w = fakeEnv();
    __resetRecordedBayesLabels();
  });

  it("a spam label lands in bayes_state, not only the journal", async () => {
    await recordBayesLabel(
      w.env.DB,
      ACCOUNT,
      { sender: "junk@spamfarm.example", subject: "WIN BIG", text: "click the prize link now" },
      "spam",
    );
    const state = await loadBayesState(w.env.DB, ACCOUNT);
    expect(state).not.toBeNull();
    expect(state!.spamCount).toBe(1);
    expect(state!.hamCount).toBe(0);
  });

  it("a ham label trains the other class", async () => {
    await recordBayesLabel(
      w.env.DB,
      ACCOUNT,
      { sender: "friend@good.example", subject: "dinner", text: "see you at seven" },
      "ham",
    );
    const state = await loadBayesState(w.env.DB, ACCOUNT);
    expect(state!.hamCount).toBe(1);
  });
});
