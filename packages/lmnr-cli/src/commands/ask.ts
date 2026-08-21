import { resolveAuth } from "../auth/resolve";
import type { GlobalOpts } from "../auth/with-client";
import { pc } from "../utils/colors";
import { emitData, emitErr, outputJson } from "../utils/output";

/** One SSE frame from the agent stream; only the fields the CLI consumes are typed. */
interface AgentFrame {
  type: "conversation" | "delta" | "thought" | "message" | "finish" | "error";
  conversationId?: string;
  text?: string;
  message?: {
    role: string;
    parts?: { type: string; text?: string; name?: string }[];
  };
}

/** `ask`-specific opts on top of the shared globals. `conversation` continues a prior session. */
type AskOpts = GlobalOpts & { conversation?: string };

/**
 * `lmnr-cli ask "<question>"` — ask the Laminar agent a question. Streams the
 * answer to stdout (activity to stderr). `--conversation <id>` continues a prior
 * session; its id is echoed on stderr.
 */
export const handleAsk = async (
  query: string,
  opts: AskOpts,
): Promise<void> => {
  const question = query?.trim();
  if (!question) {
    throw new Error(
      'Provide a question, e.g. lmnr-cli ask "why did my latest trace fail?"',
    );
  }

  // User-token auth + resolved project — same resolution `withProjectClient` uses.
  const { bearer, baseUrl, port, projectId } = await resolveAuth(opts);

  if (baseUrl === undefined) {
    throw new Error(
      "Could not resolve base url. Set it using environment or the --base-url option",
    );
  }

  // baseUrl carries no port by convention; splice the resolved port on.
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  if (port) url.port = String(port);
  url.pathname = "/v1/cli/agent/chat";

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "x-lmnr-project-id": projectId,
      "Content-Type": "application/json",
      // --json gets one buffered JSON result; humans stream.
      Accept: opts.json ? "application/json" : "text/event-stream",
    },
    // `--conversation` continues a prior session; omitted → server mints a fresh one and echoes it.
    body: JSON.stringify({
      message: question,
      ...(opts.conversation ? { conversationId: opts.conversation } : {}),
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    const suffix = detail ? `: ${detail.slice(0, 500)}` : "";
    throw new Error(`Agent request failed (HTTP ${res.status})${suffix}`);
  }

  // --json: the server buffered the whole run; emit it verbatim.
  if (opts.json) {
    outputJson(await res.json());
    return;
  }

  // Human mode: stream-parse the SSE frames — `delta` tokens form the answer
  // (stdout), thoughts + tool calls go to stderr, a trailing `error` aborts.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let streamed = false;
  let failure: string | undefined;
  // Arrives on the leading `conversation` frame (or equals `--conversation`).
  let conversationId: string | undefined = opts.conversation;

  const onFrame = (data: string): void => {
    let frame: AgentFrame;
    try {
      frame = JSON.parse(data) as AgentFrame;
    } catch {
      return; // ignore keep-alives / malformed lines
    }
    switch (frame.type) {
      case "conversation":
        if (frame.conversationId) conversationId = frame.conversationId;
        break;
      case "delta":
        // Only a non-empty delta counts as streamed, else it would flip
        // `streamed` and suppress the `message`-frame fallback for empty tokens.
        if (typeof frame.text === "string" && frame.text.length > 0) {
          answer += frame.text;
          emitData(frame.text);
          streamed = true;
        }
        break;
      case "thought":
        if (typeof frame.text === "string") {
          emitErr(pc.dim(frame.text));
        }
        break;
      case "message": {
        const parts = frame.message?.parts ?? [];
        if (frame.message?.role === "assistant") {
          for (const part of parts) {
            if (part.type === "toolCall" && part.name) {
              emitErr(pc.dim(`\n  → ${part.name}\n`));
            }
          }
          // Fallback: only used if no deltas streamed the text.
          const text = parts
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("");
          if (text) answer = text;
        }
        break;
      }
      case "error": {
        // Here `message` is a string (unlike the `message` frame's object).
        const raw = (frame as unknown as { message?: unknown }).message;
        failure =
          typeof raw === "string" && raw.length > 0 ? raw : "Agent error";
        break;
      }
      case "finish":
        break;
    }
  };

  const drain = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while (buffer.indexOf("\n\n") !== -1) {
      idx = buffer.indexOf("\n\n");
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
      if (dataLine) onFrame(dataLine.slice("data:".length).trim());
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    drain(decoder.decode(value, { stream: true }));
  }
  drain(decoder.decode());
  // Flush a trailing unterminated frame, if any.
  const tail = buffer.split("\n").find((l) => l.startsWith("data:"));
  if (tail) onFrame(tail.slice("data:".length).trim());

  if (failure) throw new Error(failure);

  if (streamed) {
    emitData("\n");
  } else if (answer.trim()) {
    emitData(`${answer.trim()}\n`);
  } else {
    emitErr(pc.dim("(the agent returned no answer)\n"));
  }

  // Echo a ready-to-run continuation hint on stderr (stdout stays the clean answer).
  if (conversationId) {
    emitErr(
      pc.dim(
        `\ncontinue with: lmnr-cli ask "<question>" --conversation ${conversationId}\n`,
      ),
    );
  }
};
