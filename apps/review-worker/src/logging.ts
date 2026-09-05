/** One structured line in Workers Logs. */
export const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, ...fields }));
};

/** Workers Logs truncates a line past 256 KB, so stay well under it. */
const MAX_CHUNK = 8_000;

/** How much of one stream is worth keeping. Codex is chatty on stderr. */
const MAX_STREAM = 64_000;

const logStream = (name: string, stream: "stdout" | "stderr", text: string) => {
  const kept = text.length > MAX_STREAM ? text.slice(-MAX_STREAM) : text;
  if (kept.trim() === "") return;

  for (let index = 0; index < kept.length; index += MAX_CHUNK) {
    log("process.output", {
      process: name,
      stream,
      truncated: kept.length < text.length,
      chunk: kept.slice(index, index + MAX_CHUNK),
    });
  }
};

/**
 * Put a finished process's output into Workers Logs.
 *
 * The output is logged in chunks after the process exits rather than streamed
 * while it runs. Streaming spends the step's CPU budget on decoding and
 * logging; awaiting the process spends none.
 */
export const logProcessOutput = (
  name: string,
  output: { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
): void => {
  log("process.exited", {
    process: name,
    exitCode: output.exitCode,
    stdoutBytes: output.stdout.length,
    stderrBytes: output.stderr.length,
  });
  logStream(name, "stdout", output.stdout);
  logStream(name, "stderr", output.stderr);
};
