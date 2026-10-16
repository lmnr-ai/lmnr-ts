import { execFile, spawn } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import * as http from "http";
import { tmpdir } from "os";
import * as path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);

const CLI_PATH = path.resolve(__dirname, "../../src/index.ts");

const SIGNAL_ID = "7143fab6-7a80-4d9f-81ed-4ee3d5d82254";
const TRACE_A = "0198a7f2-0000-7000-8000-00000000000a";
const TRACE_B = "0198a7f2-0000-7000-8000-00000000000b";
const TRACE_MISSING = "0198a7f2-0000-7000-8000-0000000000ff";

type CliResult = { stdout: string; stderr: string; exitCode: number };
type Captured = { method?: string; url?: string; body: string };

// Same user-token fixture as sql.test.ts: far-future expiry, no refresh.
let credsDir: string;

function writeCredentialsFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lmnr-cli-test-"));
  mkdirSync(path.join(dir, "lmnr"), { recursive: true });
  writeFileSync(
    path.join(dir, "lmnr", "credentials.json"),
    JSON.stringify({
      version: 1,
      issuer: "http://localhost:0",
      baseUrl: "http://localhost:0",
      sessionToken: "fake-session",
      accessToken: "fake-jwt",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      userId: "00000000-0000-0000-0000-000000000000",
      userEmail: "test@example.com",
      createdAt: "2024-01-01T00:00:00.000Z",
    }),
  );
  return dir;
}

describe("signal update CLI integration — with mock server", () => {
  let mockServer: http.Server;
  let mockPort: number;
  let requests: Captured[] = [];

  const signal = (name: string) => ({
    id: SIGNAL_ID,
    name,
    prompt: "Detect refund asks",
    structuredOutput: {},
    trigger: { type: "rootSpanFinished" },
    filters: [],
    mode: "realtime",
    sampleRate: null,
    disabled: false,
  });

  const runCli = async (args: string[]): Promise<CliResult> => {
    try {
      const { stdout, stderr } = await exec(
        "npx",
        [
          "tsx",
          CLI_PATH,
          ...args,
          "--json",
          "--project-id",
          "fake-project",
          "--base-url",
          `http://localhost:${mockPort}`,
          "--port",
          String(mockPort),
        ],
        {
          cwd: path.resolve(__dirname, "../.."),
          env: {
            ...process.env,
            LMNR_LOG_LEVEL: "silent",
            XDG_CONFIG_HOME: credsDir,
          },
        },
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: err.code ?? 1,
      };
    }
  };

  const cliArgs = (args: string[]): string[] => [
    "tsx",
    CLI_PATH,
    ...args,
    "--json",
    "--project-id",
    "fake-project",
    "--base-url",
    `http://localhost:${mockPort}`,
    "--port",
    String(mockPort),
  ];

  /** Like runCli, but pipes `stdin` into the process. */
  const runCliWithStdin = (args: string[], stdin: string): Promise<CliResult> =>
    new Promise((resolve) => {
      const child = spawn("npx", cliArgs(args), {
        cwd: path.resolve(__dirname, "../.."),
        env: {
          ...process.env,
          LMNR_LOG_LEVEL: "silent",
          XDG_CONFIG_HOME: credsDir,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (code) =>
        resolve({ stdout, stderr, exitCode: code ?? 1 }),
      );
      child.stdin.end(stdin);
    });

  beforeAll(async () => {
    credsDir = writeCredentialsFixture();
    mockServer = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.setHeader("Content-Type", "application/json");

        if (req.method === "GET" && req.url?.startsWith("/v1/cli/signals?")) {
          res.writeHead(200);
          res.end(JSON.stringify({ signals: [signal("Refund requests")] }));
        } else if (
          req.method === "PATCH" &&
          req.url === `/v1/cli/signals/${SIGNAL_ID}`
        ) {
          const patch = JSON.parse(body) as { name?: string };
          if (patch.name === "Taken") {
            res.writeHead(409);
            res.end(
              JSON.stringify({
                error: 'A signal named "Taken" already exists in this project',
              }),
            );
            return;
          }
          res.writeHead(200);
          res.end(JSON.stringify(signal(patch.name ?? "Refund requests")));
        } else if (
          req.method === "POST" &&
          req.url === `/v1/cli/signals/${SIGNAL_ID}/backfill`
        ) {
          const { traceIds } = JSON.parse(body) as { traceIds: string[] };
          const unique = [...new Set(traceIds)];
          res.writeHead(200);
          res.end(
            JSON.stringify({
              jobId: "job-1",
              signalId: SIGNAL_ID,
              totalTraces: unique.filter((t) => t !== TRACE_MISSING).length,
              missingTraceIds: unique.filter((t) => t === TRACE_MISSING),
            }),
          );
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, () => {
        mockPort = (mockServer.address() as any).port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    requests = [];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      mockServer.close(() => resolve());
    });
    if (credsDir) rmSync(credsDir, { recursive: true, force: true });
  });

  it("--name sends only the trimmed name in the PATCH", async () => {
    const { stdout, exitCode } = await runCli([
      "signal",
      "update",
      "Refund requests",
      "--name",
      "  Refund asks  ",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim()).name).toBe("Refund asks");
    const patch = requests.find((r) => r.method === "PATCH");
    expect(patch?.url).toBe(`/v1/cli/signals/${SIGNAL_ID}`);
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ name: "Refund asks" });
  });

  it("rejects a blank --name before calling the server", async () => {
    const { exitCode } = await runCli([
      "signal",
      "update",
      SIGNAL_ID,
      "--name",
      "   ",
    ]);

    expect(exitCode).not.toBe(0);
    expect(requests).toHaveLength(0);
  });

  it("surfaces the server's duplicate-name error", async () => {
    const { stdout, exitCode } = await runCli([
      "signal",
      "update",
      SIGNAL_ID,
      "--name",
      "Taken",
    ]);

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout.trim()).error).toContain(
      'A signal named "Taken" already exists',
    );
  });

  it("backfill resolves the name and posts positional + comma ids", async () => {
    const { stdout, exitCode } = await runCli([
      "signal",
      "backfill",
      "Refund requests",
      `${TRACE_A},${TRACE_B}`,
      TRACE_MISSING,
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      jobId: "job-1",
      signalId: SIGNAL_ID,
      totalTraces: 2,
      missingTraceIds: [TRACE_MISSING],
    });
    const post = requests.find((r) => r.method === "POST");
    expect(post?.url).toBe(`/v1/cli/signals/${SIGNAL_ID}/backfill`);
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      traceIds: [TRACE_A, TRACE_B, TRACE_MISSING],
    });
  });

  it("backfill reads `sql query --json` rows from stdin", async () => {
    const { stdout, exitCode } = await runCliWithStdin(
      ["signal", "backfill", SIGNAL_ID, "--file", "-"],
      JSON.stringify([{ id: TRACE_A }, { id: TRACE_B }]),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.trim()).totalTraces).toBe(2);
    const post = requests.find((r) => r.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      traceIds: [TRACE_A, TRACE_B],
    });
  });

  it("backfill with no ids fails before calling the server", async () => {
    const { stdout, exitCode } = await runCliWithStdin(
      ["signal", "backfill", SIGNAL_ID, "--file", "-"],
      "\n",
    );

    expect(exitCode).not.toBe(0);
    expect(JSON.parse(stdout.trim()).error).toContain("No trace ids given");
    expect(requests).toHaveLength(0);
  });
});
