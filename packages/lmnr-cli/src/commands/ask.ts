import { probeProjectKey } from "../auth/project-id";
import { envHttpPort, resolveBaseUrl } from "../auth/resolve";
import type { GlobalOpts } from "../auth/with-client";
import { pc } from "../utils/colors";
import { readLocalProjectFile } from "../utils/local-project-file";
import { outputJson } from "../utils/output";

const PROJECT_API_KEY_ENV = "LMNR_PROJECT_API_KEY";

/**
 * One SSE frame from the app-server agent stream (`AgentEvent`, camelCase). Only
 * the fields the CLI consumes are typed; unknown variants are ignored so the
 * stream stays forward-compatible.
 */
interface AgentFrame {
  type: "session" | "delta" | "thought" | "message" | "finish" | "error";
  sessionId?: string;
  text?: string;
  message?: { role: string; parts?: { type: string; text?: string; name?: string }[] };
}

/**
 * Resolve the project the question targets: explicit `--project-id` → the linked
 * `.lmnr/project.json` → `LMNR_PROJECT_ID` → probe which project the API key owns.
 */
async function resolveProjectId(
  optProjectId: string | undefined,
  projectApiKey: string,
  baseUrl: string,
  port: number | undefined,
): Promise<string> {
  const explicit =
    optProjectId?.trim() ||
    (await readLocalProjectFile())?.projectId ||
    process.env.LMNR_PROJECT_ID?.trim();
  if (explicit) return explicit;

  const probe = await probeProjectKey(projectApiKey, baseUrl, port);
  if (probe.status === "ok") return probe.projectId;
  if (probe.status === "invalid") {
    throw new Error(
      "Project API key is invalid or revoked. Run `lmnr-cli setup` to mint a fresh one.",
    );
  }
  throw new Error(
    "No project resolved. Pass --project-id, set LMNR_PROJECT_ID, or run `lmnr-cli setup`.",
  );
}

/**
 * `lmnr-cli ask "<question>"` — ask the Laminar agent a natural-language question
 * about the project. Streams the agent's answer to stdout (tool activity to
 * stderr). Authenticates with the project API key (`LMNR_PROJECT_API_KEY`, written
 * by `lmnr-cli setup`) against the project-scoped agent endpoint, tagging the run
 * as the `cli` channel. Pure handler: `withLocalOpts` owns the error envelope.
 */
export const handleAsk = async (query: string, opts: GlobalOpts): Promise<void> => {
  const question = query?.trim();
  if (!question) {
    throw new Error('Provide a question, e.g. lmnr-cli ask "why did my latest trace fail?"');
  }

  const projectApiKey = process.env[PROJECT_API_KEY_ENV]?.trim();
  if (!projectApiKey) {
    throw new Error(
      `No ${PROJECT_API_KEY_ENV}. Run \`lmnr-cli setup\` to write it to ./.env, ` +
        "or set it in the environment.",
    );
  }

  const baseUrl = resolveBaseUrl(opts.baseUrl);
  const port = opts.port ?? envHttpPort();
  const projectId = await resolveProjectId(opts.projectId, projectApiKey, baseUrl, port);

  // baseUrl carries no port by convention; splice the resolved port onto the URL.
  const url = new URL(baseUrl.replace(/\/+$/, ""));
  if (port) url.port = String(port);
  url.pathname = `/api/v1/projects/${projectId}/agent/chat`;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${projectApiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      context: { type: "project" },
      channelType: "cli",
      messages: [{ role: "user", parts: [{ type: "text", text: question }] }],
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    const suffix = detail ? `: ${detail.slice(0, 500)}` : "";
    throw new Error(`Agent request failed (HTTP ${res.status})${suffix}`);
  }

  // Stream-parse the SSE frames: `delta` tokens form the answer (stdout), tool
  // calls surface as activity (stderr), a trailing `error` frame aborts.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sessionId: string | undefined;
  let answer = "";
  let streamed = false;
  let failure: string | undefined;
  const tools: string[] = [];

  const onFrame = (data: string): void => {
    let frame: AgentFrame;
    try {
      frame = JSON.parse(data) as AgentFrame;
    } catch {
      return; // ignore keep-alives / malformed lines
    }
    switch (frame.type) {
      case "session":
        sessionId = frame.sessionId;
        break;
      case "delta":
        if (typeof frame.text === "string") {
          answer += frame.text;
          if (!opts.json) {
            process.stdout.write(frame.text);
            streamed = true;
          }
        }
        break;
      case "thought":
        if (!opts.json && typeof frame.text === "string") {
          process.stderr.write(pc.dim(frame.text));
        }
        break;
      case "message": {
        const parts = frame.message?.parts ?? [];
        if (frame.message?.role === "assistant") {
          for (const part of parts) {
            if (part.type === "toolCall" && part.name) {
              tools.push(part.name);
              if (!opts.json) process.stderr.write(pc.dim(`\n  → ${part.name}\n`));
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

  if (opts.json) {
    outputJson({ answer: answer.trim(), sessionId, tools });
    return;
  }
  if (streamed) {
    process.stdout.write("\n");
  } else if (answer.trim()) {
    process.stdout.write(`${answer.trim()}\n`);
  } else {
    process.stderr.write(pc.dim("(the agent returned no answer)\n"));
  }
};
