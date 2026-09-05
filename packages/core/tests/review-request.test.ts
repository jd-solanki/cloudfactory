import { Effect, Either } from "effect";
import { expect, test } from "vite-plus/test";
import { REVIEW_REQUEST_VERSION, parseReviewRequest } from "../src/review-request.ts";

const HEAD_SHA = "a".repeat(40);

const valid = {
  version: REVIEW_REQUEST_VERSION,
  owner: "acme",
  repo: "widgets",
  pullNumber: 7,
  headSha: HEAD_SHA,
};

const parse = (input: unknown) => Effect.runSync(Effect.either(parseReviewRequest(input)));

test("accepts a complete request", () => {
  expect(parse(valid)).toStrictEqual(Either.right(valid));
});

test("rejects an unknown contract version", () => {
  const result = parse({ ...valid, version: 99 });
  expect(Either.isLeft(result)).toBe(true);
});

test("rejects a short head SHA", () => {
  const result = parse({ ...valid, headSha: "a1b2c3d" });
  expect(Either.isLeft(result)).toBe(true);
});

test("rejects a pull number that is not a positive integer", () => {
  expect(Either.isLeft(parse({ ...valid, pullNumber: 0 }))).toBe(true);
  expect(Either.isLeft(parse({ ...valid, pullNumber: 1.5 }))).toBe(true);
});

test("rejects a non-object payload", () => {
  expect(Either.isLeft(parse(null))).toBe(true);
  expect(Either.isLeft(parse("review"))).toBe(true);
});
