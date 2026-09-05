import { expect, test } from "vite-plus/test";
import { sandboxRunId } from "../src/run.ts";

test("uses only characters a sandbox id allows", () => {
  expect(sandboxRunId("review-1d4e245ff09b-1-33985914539-jd-solanki-cloudfactory")).toMatch(
    /^[a-z0-9-]+$/,
  );
});

test("every step of one Run reaches the same sandbox", () => {
  const instanceId = "review-1d4e245ff09b-1-33985914539-jd-solanki-cloudfactory";
  expect(sandboxRunId(instanceId)).toBe(sandboxRunId(instanceId));
});

test("separates Runs", () => {
  expect(sandboxRunId("review-abc-1-111-acme-widgets")).not.toBe(
    sandboxRunId("review-abc-1-222-acme-widgets"),
  );
});

test("stays inside the length limit", () => {
  expect(sandboxRunId("r".repeat(200)).length).toBeLessThanOrEqual(64);
});
