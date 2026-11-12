import { stripVTControlCharacters } from "node:util";

import type {
  HostedEvalRunLogLine,
  HostedEvalRunLogPage,
  HostedEvalSandboxStatus,
} from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

/** Lines wait this long at most before they go out. */
const FLUSH_MS = 1000;
/** One batch, well under the server's 1000-line and request-size caps. */
const MAX_BATCH_LINES = 500;
const MAX_BATCH_CHARS = 1024 * 1024;
/** The server cuts longer lines too. */
const MAX_LINE_CHARS = 16 * 1024;
/** Kept while the server is unreachable; the oldest go first past this. */
const MAX_PENDING_LINES = 20_000;
/** A batch that fails this many times in a row is dropped. */
const MAX_SEND_FAILURES = 5;
/** `close` gives up on sending what's left after this. */
const CLOSE_TIMEOUT_MS = 15_000;

/** The server's page size: a full page means more lines are already there. */
const PAGE_LINES = 1000;
const POLL_MS = 2000;
/** How often a quiet run's orchestrator is checked on. */
const CHECK_MS = 30_000;
/** Read errors are retried for this long (a laptop asleep, a network blip). */
const MAX_ERROR_MS = 5 * 60_000;

export interface RunLogShipper {
  /**
   * A writer for one source of output (a stream, the logger). It splits what
   * it gets into lines and holds back an unfinished last one, so sources
   * don't cut into each other's lines.
   */
  writer: () => (chunk: string) => void;
  /** Send everything left, unfinished last lines included. */
  close: () => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bypasses the logger: the logger's output is what's being shipped. */
const warn = (message: string) => process.stderr.write(`${message}\n`);

/**
 * Numbers the run's output lines and sends them with `send`, one batch at a
 * time so the server stores them in order. `send` returning false means the
 * server keeps no run logs: shipping stops. `onStarted` runs after the first
 * batch is stored.
 */
export const createRunLogShipper = (
  send: (lines: HostedEvalRunLogLine[]) => Promise<boolean>,
  onStarted?: () => void,
): RunLogShipper => {
  const pending: HostedEvalRunLogLine[] = [];
  const partials: { text: string }[] = [];
  let seq = 0;
  let dropped = 0;
  let failures = 0;
  let enabled = true;
  let started = false;
  let sending: Promise<void> | undefined;

  const push = (line: string) => {
    if (!enabled) return;
    // Harbor's loggers color their output even when it isn't a terminal.
    const text = stripVTControlCharacters(line);
    if (pending.length >= MAX_PENDING_LINES) {
      pending.shift();
      dropped += 1;
    }
    pending.push({
      seq: seq++,
      time: Date.now(),
      text:
        text.length > MAX_LINE_CHARS
          ? `${text.slice(0, MAX_LINE_CHARS)}…`
          : text,
    });
  };

  const nextBatch = () => {
    let chars = 0;
    let count = 0;
    while (count < pending.length && count < MAX_BATCH_LINES) {
      chars += pending[count].text.length;
      if (count > 0 && chars > MAX_BATCH_CHARS) break;
      count += 1;
    }
    return pending.slice(0, count);
  };

  const sendPending = async () => {
    while (enabled && pending.length > 0) {
      const batch = nextBatch();
      try {
        if (!(await send(batch))) {
          enabled = false;
          pending.length = 0;
          warn("This Laminar server doesn't keep run logs; not sending them.");
          return;
        }
      } catch (error) {
        failures += 1;
        if (failures < MAX_SEND_FAILURES) return;
        warn(`Dropping ${batch.length} run log lines: ${errorMessage(error)}`);
        dropped += batch.length;
      }
      failures = 0;
      // By seq, not count: a full queue sheds its oldest lines while a batch
      // is in flight, so the batch may no longer be the queue's prefix.
      const last = batch[batch.length - 1].seq;
      const sent = pending.findIndex((line) => line.seq > last);
      pending.splice(0, sent === -1 ? pending.length : sent);
      if (!started && dropped === 0) {
        started = true;
        onStarted?.();
      }
      if (dropped > 0) {
        push(`[lmnr-cli] ${dropped} run log lines were dropped`);
        dropped = 0;
      }
    }
  };

  const flush = () => {
    sending ??= sendPending().finally(() => {
      sending = undefined;
    });
    return sending;
  };

  const timer = setInterval(flush, FLUSH_MS);
  timer.unref();

  return {
    writer: () => {
      const partial = { text: "" };
      partials.push(partial);
      return (chunk) => {
        const lines = (partial.text + chunk).split("\n");
        partial.text = lines.pop() ?? "";
        for (const line of lines) push(line.replace(/\r$/, ""));
      };
    },
    close: async () => {
      clearInterval(timer);
      for (const partial of partials) {
        if (partial.text) push(partial.text);
        partial.text = "";
      }
      const deadline = Date.now() + CLOSE_TIMEOUT_MS;
      while (enabled && pending.length > 0 && Date.now() < deadline) {
        await flush();
        if (pending.length > 0) await sleep(FLUSH_MS);
      }
    },
  };
};

/** What `followRunLog` reads with: the hosted-evals client's two calls. */
export interface RunLogSource {
  getRunLogs: (
    uploadId: string,
    from: number,
  ) => Promise<HostedEvalRunLogPage | null>;
  getSandbox: (sandboxId: string) => Promise<HostedEvalSandboxStatus | null>;
}

export type FollowResult =
  | { kind: "exited"; exitCode: number }
  /** The orchestrator is gone without having reported an exit code. */
  | { kind: "lost"; state: string; reason?: string }
  /** The server keeps no run logs (older than lmnr-cli). */
  | { kind: "unsupported" };

export interface FollowOptions {
  write?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Print a remote run's log as it arrives until its orchestrator exits. The
 * orchestrator sandbox is checked every 30 s, so a run whose sandbox died (its
 * time limit, a provider failure) before reporting an exit code doesn't hang
 * here.
 */
export const followRunLog = async (
  source: RunLogSource,
  uploadId: string,
  sandboxId: string,
  {
    write = (text) => process.stderr.write(text),
    sleep: wait = sleep,
    now = Date.now,
  }: FollowOptions = {},
): Promise<FollowResult> => {
  let from = 0;
  let lastCheck = now();
  let failingSince: number | undefined;

  const read = async (): Promise<HostedEvalRunLogPage | null> => {
    const page = await source.getRunLogs(uploadId, from);
    if (page) {
      for (const line of page.lines) write(`${line.text}\n`);
    }
    return page;
  };

  for (;;) {
    let page: HostedEvalRunLogPage | null;
    const start = from;
    try {
      page = await read();
      failingSince = undefined;
    } catch (error) {
      failingSince ??= now();
      if (now() - failingSince > MAX_ERROR_MS) throw error;
      await wait(POLL_MS);
      continue;
    }
    if (page === null) return { kind: "unsupported" };
    from = page.next;
    // Only the page holding the run's last row has it, so no lines are left.
    if (page.exitCode !== null) {
      return { kind: "exited", exitCode: page.exitCode };
    }
    if (from - start >= PAGE_LINES) continue;

    if (now() - lastCheck >= CHECK_MS) {
      lastCheck = now();
      // Null: not found, e.g. deleted and past the server's record of it.
      const status = await source.getSandbox(sandboxId).catch(() => undefined);
      if (
        status === null ||
        status?.state === "destroyed" ||
        status?.state === "error"
      ) {
        // The exit code may have landed between the read and the check.
        const last = await read().catch(() => null);
        if (last && last.exitCode !== null) {
          return { kind: "exited", exitCode: last.exitCode };
        }
        return {
          kind: "lost",
          state: status?.state ?? "destroyed",
          reason: status?.errorReason,
        };
      }
    }
    await wait(POLL_MS);
  }
};
