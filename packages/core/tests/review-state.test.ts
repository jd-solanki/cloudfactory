import { Effect, Layer } from "effect";
import { expect, test } from "vite-plus/test";
import { GitHub } from "../src/github.ts";
import { REQUEST_LABEL, STATE_LABELS, setReviewState } from "../src/review-state.ts";

const target = { owner: "acme", repo: "widgets", pullNumber: 7 };

/** Records label calls in order, so the sequence itself can be asserted. */
const recordingGitHub = (calls: string[]) =>
  Layer.succeed(GitHub, {
    addLabel: (_t: unknown, label: string) =>
      Effect.sync(() => {
        calls.push(`add ${label}`);
      }),
    removeLabel: (_t: unknown, label: string) =>
      Effect.sync(() => {
        calls.push(`remove ${label}`);
      }),
  } as unknown as GitHub);

const run = (state: Parameters<typeof setReviewState>[1]) => {
  const calls: string[] = [];
  Effect.runSync(setReviewState(target, state).pipe(Effect.provide(recordingGitHub(calls))));
  return calls;
};

test("claims the request and adds the state before removing anything", () => {
  const calls = run("reviewing");
  expect(calls[0]).toBe(`add ${STATE_LABELS.reviewing}`);
  expect(calls).toContain(`remove ${REQUEST_LABEL}`);
});

test("leaves only the wanted state label", () => {
  const calls = run("reviewing");
  expect(calls).toContain(`remove ${STATE_LABELS.failed}`);
  expect(calls).not.toContain(`remove ${STATE_LABELS.reviewing}`);
});

test("clears every label this capability owns", () => {
  const calls = run(null);
  expect(calls.some((call) => call.startsWith("add "))).toBe(false);
  expect(calls).toContain(`remove ${REQUEST_LABEL}`);
  expect(calls).toContain(`remove ${STATE_LABELS.reviewing}`);
  expect(calls).toContain(`remove ${STATE_LABELS.failed}`);
});
