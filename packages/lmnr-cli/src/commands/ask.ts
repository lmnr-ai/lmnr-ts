import { resolveAuth } from "../auth/resolve";
import type { GlobalOpts } from "../auth/with-client";
import { pc } from "../utils/colors";
import { outputJson } from "../utils/output";

/**
 * One SSE frame from the app-server agent stream (`AgentEvent`, camelCase). Only
 * the fields the CLI consumes are typed; unknown variants are ignored so the
 * stream stays forward-compatible.
 */
interface AgentFrame {
  type: "conversation" | "delta" | "thought" | "message" | "finish" | "error";
  conversationId?: string;
  text?: string;
  message?: { role: string; parts?: { type: string; text?: string; name?: string }[] };
}

/** `ask`-specific opts on top of the shared globals. `conversation` continues a prior session. */
type AskOpts = GlobalOpts & { conversation?: string };

/**
 * `lmnr-cli ask "<question>"` — ask the Laminar agent a natural-language question
 * about the project. Streams the agent's answer to stdout (tool activity to
 * stderr). User-token authed (the stored BetterAuth JWT, auto-refreshed — like the
 * rest of the CLI) against the `/v1/cli/agent/chat` twin: the project rides in the
 * `x-lmnr-project-id` header and the run is tagged the `cli` channel server-side.
 * Pass `--conversation <id>` to continue a prior session; the resolved id is echoed
 * (muted, on stderr) after each answer so the next turn can reuse it.
 * Pure handler: `withLocalOpts` owns the error envelope.
 */
export const handleAsk = async (query: string, opts: AskOpts): Promise<void> => {
  const question = query?.trim();
  if (!question) {
    throw new Error('Provide a question, e.g. lmnr-cli ask "why did my latest trace fail?"');
  }

  // User-token auth (auto-refreshed) + resolved project — same resolution `withProjectClient` uses.
  const { bearer, baseUrl, port, projectId } = await resolveAuth(opts);

  // baseUrl carries no port by convention; splice the resolved port onto the URL.
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  if (port) url.port = String(port);
  url.pathname = "/v1/cli/agent/chat";

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "x-lmnr-project-id": projectId,
      "Content-Type": "application/json",
      // Content negotiation: agents/scripts (`--json`) get one buffered JSON result; humans stream.
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

  // `--json`: the server buffered the run into `{ answer, conversationId, tools }` — no stream
  // to parse. Emit it verbatim.
  if (opts.json) {
    outputJson(await res.json());
    return;
  }

  // Human mode: stream-parse the SSE frames — `delta` tokens form the answer (stdout), thoughts +
  // tool calls surface as activity (stderr), a trailing `error` frame aborts.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let streamed = false;
  let failure: string | undefined;
  // Resolved server-side; arrives on the leading `conversation` frame (or equals `--conversation`).
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
        if (typeof frame.text === "string") {
          answer += frame.text;
          process.stdout.write(frame.text);
          streamed = true;
        }
        break;
      case "thought":
        if (typeof frame.text === "string") {
          process.stderr.write(pc.dim(frame.text));
        }
        break;
      case "message": {
        const parts = frame.message?.parts ?? [];
        if (frame.message?.role === "assistant") {
          for (const part of parts) {
            if (part.type === "toolCall" && part.name) {
              process.stderr.write(pc.dim(`\n  → ${part.name}\n`));
            }
          }
          // Final assistant text: only used if no deltas streamed it (defensive).
          const text = parts
            .filter((p) => p.type === "text" && typeof p.text === "string")
            .map((p) => p.text)
            .join("");
          if (text) answer = text;
        }
        break;
      }
      case "error": {
        // The `error` frame's `message` is a string (the `message` frame's is the
        // ChatMessage object) — read it off the raw payload.
        const raw = (frame as unknown as { message?: unknown }).message;
        failure = typeof raw === "string" && raw.length > 0 ? raw : "Agent error";
        break;
      }
      case "finish":
        break;
    }
  };

  const drain = (chunk: string): void => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
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
    process.stdout.write("\n");
  } else if (answer.trim()) {
    process.stdout.write(`${answer.trim()}\n`);
  } else {
    process.stderr.write(pc.dim("(the agent returned no answer)\n"));
  }

  // Echo a ready-to-run continuation hint (muted, on stderr so stdout stays the clean answer) —
  // copy it into the next turn's `--conversation`.
  if (conversationId) {
    process.stderr.write(
      pc.dim(`\ncontinue with: lmnr-cli ask "<question>" --conversation ${conversationId}\n`),
    );
  }
};
