/** Where a repository keeps the instructions it wants reviewers to follow. */
export const REVIEW_INSTRUCTIONS_PATH = ".code-factory/review.md";

/**
 * Used when a repository ships no instructions of its own.
 *
 * It asks for the same thing a careful colleague would: defects that a reader
 * can act on, and silence everywhere else.
 */
export const DEFAULT_REVIEW_INSTRUCTIONS = `Review this pull request for defects.

Report only findings that are real, specific, and actionable:

- Correctness bugs, including edge cases the change introduces or fails to handle.
- Security problems, including untrusted input reaching a sensitive operation.
- Data loss, corruption, or irreversible actions that are not guarded.
- Contradictions between the change and the surrounding code it must work with.

Do not report style preferences, naming opinions, formatting, or missing tests
unless the repository's own instructions ask for them. Do not restate what the
change does. If you find nothing worth acting on, say so in one sentence.

For every finding, give the file, the line, what breaks, and the input or state
that makes it break.`;
