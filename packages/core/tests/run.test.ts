import { expect, test } from "vite-plus/test";
import { REVIEW_REQUEST_VERSION, type ReviewRequest } from "../src/review-request.ts";
import { sandboxRunId } from "../src/run.ts";

const request: ReviewRequest = {
  version: REVIEW_REQUEST_VERSION,
  owner: "Acme.Corp",
  repo: "Widgets_2",
  pullNumber: 12,
  headSha: "0123456789abcdef0123456789abcdef01234567",
};

test("uses only characters a sandbox id allows", () => {
  expect(sandboxRunId(request, 1)).toMatch(/^[a-z0-9-]+$/);
});

test("separates attempts of the same revision", () => {
  expect(sandboxRunId(request, 1)).not.toBe(sandboxRunId(request, 2));
});

test("separates revisions of the same pull request", () => {
  const newer = { ...request, headSha: "89abcdef0123456789abcdef0123456789abcdef" };
  expect(sandboxRunId(request, 1)).not.toBe(sandboxRunId(newer, 1));
});

test("stays inside the length limit for a long repository name", () => {
  const long = { ...request, owner: "a".repeat(60), repo: "b".repeat(60) };
  expect(sandboxRunId(long, 1).length).toBeLessThanOrEqual(64);
});
