import type { SandboxProcess } from "@cloudflare/sandbox";

/** One structured line in Workers Logs. */
export const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, ...fields }));
};

const decoder = new TextDecoder();

/** Keep a log line readable, and keep one runaway process from filling the log. */
const MAX_LINE = 2_000;

export type ProcessOutcome = {
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Stream a process's output to Workers Logs while it runs, and return it.
 *
 * Waiting for a process to finish before logging anything means a hung command
 * looks identical to a slow one. Streaming makes the difference visible.
 */
export const streamProcessLogs = async (
  process: SandboxProcess,
  name: string,
): Promise<ProcessOutcome> => {
  const reader = (await process.logs({ follow: true })).getReader();
  let stdout = "";
  let stderr = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type !== "stdout" && value.type !== "stderr") continue;

      const text = decoder.decode(value.data);
      if (value.type === "stdout") stdout += text;
      else stderr += text;

      for (const line of text.split("\n")) {
        if (line.trim() !== "") {
          log("process.output", {
            process: name,
            stream: value.type,
            line: line.slice(0, MAX_LINE),
          });
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { stdout, stderr };
};
