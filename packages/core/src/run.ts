import type { ReviewRequest } from "./review-request.ts";

/** Cloudflare sandbox ids allow this character set. */
const UNSAFE_ID_CHARACTERS = /[^a-z0-9-]/g;

const MAX_ID_LENGTH = 64;

const slug = (value: string) => value.toLowerCase().replace(UNSAFE_ID_CHARACTERS, "-");

/**
 * Identify the Sandbox for one attempt at one revision.
 *
 * A live Sandbox is not durable state, so every attempt gets its own. Including
 * the head SHA also stops a superseded revision from reaching a running
 * container that belongs to a newer one.
 */
export const sandboxRunId = (request: ReviewRequest, attempt: number) =>
  `run-${request.headSha.slice(0, 12)}-${request.pullNumber}-${attempt}-${slug(
    `${request.owner}-${request.repo}`,
  )}`.slice(0, MAX_ID_LENGTH);

/** Where the repository is extracted inside the Sandbox. */
export const WORKSPACE_PATH = "/workspace";
