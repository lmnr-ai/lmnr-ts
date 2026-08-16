/**
 * End-to-end tests for `lmnr-cli signal *` against the BUILT CLI and a REAL
 * app-server (localhost:8000 by default), using real stored credentials.
 *
 * Unlike the other files in this directory there is no mock server: the point is
 * to pin the whole path — commander flag parsing → client-side validation →
 * `/v1/cli/signals` → the human/`--json` rendering — including the server's
 * 400/404/409 messages, which the CLI deliberately does NOT duplicate (see
 * src/commands/signal/validate.ts).
 *
 * The surface under test is the post-LAM-2126 one: a signal has ONE `trigger`
 * (when it is evaluated), a `filters` list (whether it runs) and a `mode`, as
 * three independent fields.
 *
 * Requires: `pnpm build` in this package, a running app-server + frontend (for
 * the token refresh), and credentials for THAT server. When any of that is
 * missing the suite SKIPS with a reason rather than failing, so CI stays green.
 *
 * Overrides:
 *   LMNR_TEST_BASE_URL     default http://localhost   (no port, by convention)
 *   LMNR_TEST_PORT         default 8000
 *   LMNR_TEST_CONFIG_HOME  XDG_CONFIG_HOME to read credentials from — point this
 *                          at a dir holding credentials for the local stack when
 *                          your default login targets production
 *   LMNR_TEST_PROJECT_ID   default: the project named by LMNR_TEST_PROJECT_NAME
 *   LMNR_TEST_PROJECT_NAME default "signals", falling back to the first project
 *
 * Every signal created here is named `zz-cli-test-<runId>-*` and swept in
 * afterAll, so a crashed run leaves at most one run's worth of debris and
 * concurrent runs never delete each other's signals.
 */

import { execFile } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterAll, describe, expect, it, vi } from 'vitest';

const exec = promisify(execFile);

// Each test drives several CLI processes against a real server; the 10s default
// from vitest.config.ts is too tight for the create+update+get chains.
vi.setConfig({ testTimeout: 30_000 });

/** The BUILT cli, not src/index.ts — this suite is about the shipped artifact. */
const CLI_PATH = path.resolve(__dirname, '../../dist/index.cjs');
const PACKAGE_DIR = path.resolve(__dirname, '../..');

const BASE_URL = process.env.LMNR_TEST_BASE_URL?.trim() || 'http://localhost';
const PORT = process.env.LMNR_TEST_PORT?.trim() || '8000';
const CONFIG_HOME = process.env.LMNR_TEST_CONFIG_HOME?.trim() || undefined;

type CliResult = { stdout: string; stderr: string; exitCode: number };

/** Human output is pino-pretty on stderr with colors forced on; strip them. */
const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\[[0-9;]*m/g, '');

async function runCli(
  args: string[],
  opts: { cwd?: string; xdgConfigHome?: string; logLevel?: string } = {},
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // vitest.config.ts silences the logger for unit tests, but the human-mode
    // assertions below read exactly that output, so opt back in.
    LMNR_LOG_LEVEL: opts.logLevel ?? 'info',
    NO_COLOR: '1',
  };
  // The endpoint is always passed as flags; drop the env fallbacks so a
  // developer's shell can't retarget the suite halfway.
  delete env.LMNR_BASE_URL;
  delete env.LMNR_HTTP_PORT;
  const configHome = opts.xdgConfigHome ?? CONFIG_HOME;
  if (configHome !== undefined) {
    env.XDG_CONFIG_HOME = configHome;
  }

  try {
    const { stdout, stderr } = await exec('node', [CLI_PATH, ...args], {
      cwd: opts.cwd ?? PACKAGE_DIR,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr: stripAnsi(stderr), exitCode: 0 };
  } catch (err: unknown) {
    const failure = err as { stdout?: string; stderr?: string; code?: unknown };
    return {
      stdout: failure.stdout ?? '',
      stderr: stripAnsi(failure.stderr ?? ''),
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
  }
}

const endpoint = (): string[] => ['--base-url', BASE_URL, '--port', PORT];

interface Project { id: string; name: string }

/**
 * Decide whether the live stack is reachable AND which project to write to.
 * Returns a reason instead of throwing so the suite can skip.
 */
async function preflight(): Promise<
  { ok: true; projectId: string; projectLabel: string } | { ok: false; reason: string }
> {
  if (!existsSync(CLI_PATH)) {
    return {
      ok: false,
      reason: `built CLI missing at ${CLI_PATH} — run \`pnpm build\` in packages/lmnr-cli`,
    };
  }

  let projectId = process.env.LMNR_TEST_PROJECT_ID?.trim();
  let projectLabel = projectId ? `${projectId} (LMNR_TEST_PROJECT_ID)` : '';

  if (!projectId) {
    const listed = await runCli(['project', 'list', '--json', ...endpoint()]);
    if (listed.exitCode !== 0) {
      const detail = listed.stdout.trim() || listed.stderr.trim();
      return {
        ok: false,
        reason:
          `\`project list\` failed against ${BASE_URL}:${PORT} — app-server up, and are ` +
          `the credentials for THAT server? Set LMNR_TEST_CONFIG_HOME if not. (${detail})`,
      };
    }
    let projects: Project[];
    try {
      projects = JSON.parse(listed.stdout.trim()) as Project[];
    } catch {
      return { ok: false, reason: `\`project list --json\` was not JSON: ${listed.stdout}` };
    }
    const preferred = process.env.LMNR_TEST_PROJECT_NAME?.trim() || 'signals';
    const chosen = projects.find((p) => p.name === preferred) ?? projects[0];
    if (!chosen) {
      return { ok: false, reason: 'the signed-in user has no accessible projects' };
    }
    projectId = chosen.id;
    projectLabel = `"${chosen.name}" (${chosen.id})`;
  }

  const probe = await runCli([
    'signal', 'list', '--json', '--project-id', projectId, ...endpoint(),
  ]);
  if (probe.exitCode !== 0) {
    const detail = probe.stdout.trim() || probe.stderr.trim();
    return { ok: false, reason: `\`signal list\` failed for ${projectLabel}: ${detail}` };
  }
  return { ok: true, projectId, projectLabel };
}

const live = await preflight();
if (!live.ok) {
  console.warn(`[signals.live] SKIPPED — ${live.reason}`);
} else {
  console.info(`[signals.live] target ${BASE_URL}:${PORT}, project ${live.projectLabel}`);
}

const PROJECT_ID = live.ok ? live.projectId : '';
const describeLive = live.ok ? describe : describe.skip;

/** Namespace every name to this process so parallel runs can't collide. */
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const PREFIX = `zz-cli-test-${RUN_ID}-`;
let nameCounter = 0;
const uniqueName = (label: string): string => `${PREFIX}${label}-${nameCounter++}`;

/**
 * `signal <args>` with the project + endpoint appended. Passing your own
 * `--project-id`/`--base-url` here would be silently overridden by the appended
 * ones (commander keeps the last occurrence), so those cases must call
 * {@link runCli} directly — guarded rather than left to produce a green test.
 */
const sig = (args: string[], opts?: Parameters<typeof runCli>[1]): Promise<CliResult> => {
  for (const flag of ['--project-id', '--base-url', '--port']) {
    if (args.includes(flag)) {
      throw new Error(`sig() appends ${flag}; use runCli() to override it`);
    }
  }
  return runCli(['signal', ...args, '--project-id', PROJECT_ID, ...endpoint()], opts);
};

type TriggerShape =
  | { type: 'rootSpanFinished' }
  | { type: 'spanName'; spanNames: string[] };

interface FilterShape { column: string; operator: string; value: unknown }

interface SignalShape {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  structuredOutput: { type: string; properties: Record<string, unknown>; required: string[] };
  sampleRate: number | null;
  disabled: boolean;
  createdAt: string;
  trigger: TriggerShape;
  filters: FilterShape[];
  mode: 'batch' | 'realtime';
}

const SIMPLE_SCHEMA = '{"properties":{"reason":{"type":"string","description":"Refund reason"}}}';

const STATUS_FILTER = '{"column":"status","operator":"eq","value":"error"}';
const TOKEN_FILTER = '{"column":"total_token_count","operator":"gt","value":"5000"}';
/** What the server seeds when `--filter` is omitted. */
const DEFAULT_FILTER = { column: 'total_token_count', operator: 'gt', value: '1000' };

/** Parse a `--json` success payload, asserting exit 0 first for a useful failure. */
function expectJson<T>(result: CliResult): T {
  expect(
    result.exitCode,
    `expected exit 0, got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  ).toBe(0);
  return JSON.parse(result.stdout.trim()) as T;
}

/** Parse the `{"error": ...}` envelope `--json` mode writes to stdout on failure. */
function expectJsonError(result: CliResult): string {
  expect(result.exitCode, `expected a non-zero exit, stdout: ${result.stdout}`).not.toBe(0);
  const parsed = JSON.parse(result.stdout.trim()) as { error?: string };
  expect(parsed.error, `no error field in ${result.stdout}`).toBeTruthy();
  return parsed.error as string;
}

async function createSignal(name: string, extra: string[] = []): Promise<SignalShape> {
  const signal = expectJson<SignalShape>(
    await sig(['create', name, '--prompt', 'Detect refund asks', '--schema', SIMPLE_SCHEMA,
      ...extra, '--json']),
  );
  expect(signal.id).toMatch(/^[0-9a-f-]{36}$/);
  return signal;
}

afterAll(async () => {
  if (!live.ok) return;
  // Sweep by prefix rather than by remembered ids so signals created inside a
  // failed assertion (or by a `create` we never parsed) are cleaned up too.
  const listed = await sig(['list', PREFIX, '--json']);
  if (listed.exitCode !== 0) {
    console.warn(`[signals.live] cleanup list failed: ${listed.stdout || listed.stderr}`);
    return;
  }
  const leftovers = JSON.parse(listed.stdout.trim() || '[]') as SignalShape[];
  for (const s of leftovers) {
    const deleted = await sig(['delete', s.id, '--json']);
    if (deleted.exitCode !== 0) {
      console.warn(`[signals.live] could not delete ${s.name} (${s.id})`);
    }
  }
}, 120_000);

describeLive('signal create — defaults', () => {
  it('defaults to a root-span trigger, the >1000 token filter, and batch mode', async () => {
    const name = uniqueName('minimal');
    const signal = await createSignal(name);

    expect(signal.name).toBe(name);
    expect(signal.projectId).toBe(PROJECT_ID);
    expect(signal.prompt).toBe('Detect refund asks');
    expect(signal.sampleRate).toBeNull();
    expect(signal.disabled).toBe(false);
    // The three "when/whether/how" fields each have their own default.
    expect(signal.trigger).toEqual({ type: 'rootSpanFinished' });
    expect(signal.filters).toEqual([DEFAULT_FILTER]);
    expect(signal.mode).toBe('batch');
  });

  it('fills the omitted schema type and required list from properties', async () => {
    const signal = await createSignal(uniqueName('schema-defaults'));

    expect(signal.structuredOutput.type).toBe('object');
    expect(signal.structuredOutput.required).toEqual(['reason']);
    expect(signal.structuredOutput.properties).toEqual({
      reason: { type: 'string', description: 'Refund reason' },
    });
  });

  it('passes an explicit type/required/enum schema through unchanged', async () => {
    const schema = JSON.stringify({
      type: 'object',
      properties: {
        sev: { type: 'string', enum: ['low', 'high'], description: 'Severity' },
        count: { type: 'number', description: 'How many' },
        flagged: { type: 'boolean', description: 'Whether flagged' },
      },
      required: ['sev', 'count', 'flagged'],
    });
    const signal = expectJson<SignalShape>(
      await sig(['create', uniqueName('enum'), '--prompt', 'Rate severity',
        '--schema', schema, '--json']),
    );

    expect(signal.structuredOutput.required.sort()).toEqual(['count', 'flagged', 'sev']);
    expect(signal.structuredOutput.properties.sev).toEqual({
      type: 'string', enum: ['low', 'high'], description: 'Severity',
    });
  });

  it('trims surrounding whitespace from the name', async () => {
    const name = uniqueName('trimmed');
    const signal = await createSignal(`   ${name}   `);

    expect(signal.name).toBe(name);
  });
});

describeLive('signal create — trigger, filters and mode', () => {
  it('accepts --trigger root-span-finished explicitly', async () => {
    const signal = await createSignal(uniqueName('root'), ['--trigger', 'root-span-finished']);

    expect(signal.trigger).toEqual({ type: 'rootSpanFinished' });
  });

  it('builds a span-name trigger from one --span-name', async () => {
    const signal = await createSignal(uniqueName('span-one'), [
      '--trigger', 'span-name', '--span-name', 'agent.run',
    ]);

    expect(signal.trigger).toEqual({ type: 'spanName', spanNames: ['agent.run'] });
  });

  it('collects a repeated --span-name in order', async () => {
    const signal = await createSignal(uniqueName('span-many'), [
      '--trigger', 'span-name',
      '--span-name', 'agent.run',
      '--span-name', 'worker.step',
      '--span-name', 'tool.call',
    ]);

    expect(signal.trigger).toEqual({
      type: 'spanName',
      spanNames: ['agent.run', 'worker.step', 'tool.call'],
    });
  });

  it('trims span names and drops blank ones', async () => {
    const signal = await createSignal(uniqueName('span-trim'), [
      '--trigger', 'span-name', '--span-name', '  agent.run  ', '--span-name', '   ',
    ]);

    expect(signal.trigger).toEqual({ type: 'spanName', spanNames: ['agent.run'] });
  });

  it('replaces the default filter with an explicit --filter', async () => {
    const signal = await createSignal(uniqueName('one-filter'), ['--filter', STATUS_FILTER]);

    expect(signal.filters).toEqual([{ column: 'status', operator: 'eq', value: 'error' }]);
  });

  it('ANDs a repeated --filter', async () => {
    const signal = await createSignal(uniqueName('two-filters'), [
      '--filter', STATUS_FILTER, '--filter', TOKEN_FILTER,
    ]);

    expect(signal.filters).toHaveLength(2);
    expect(signal.filters.map((f) => f.column).sort())
      .toEqual(['status', 'total_token_count']);
  });

  it('accepts every documented filter column and operator', async () => {
    const signal = await createSignal(uniqueName('all-filters'), [
      '--filter', '{"column":"total_token_count","operator":"lte","value":"200"}',
      '--filter', '{"column":"status","operator":"ne","value":"success"}',
      '--filter', '{"column":"span_names","operator":"eq","value":"agent.run"}',
    ]);

    expect(signal.filters).toHaveLength(3);
  });

  it('takes a numeric filter value as a JSON number', async () => {
    const signal = await createSignal(uniqueName('numeric-filter'), [
      '--filter', '{"column":"total_token_count","operator":"gt","value":5000}',
    ]);

    expect(signal.filters[0].value).toBe(5000);
  });

  it('sets --mode realtime and batch', async () => {
    const realtime = await createSignal(uniqueName('realtime'), ['--mode', 'realtime']);
    const batch = await createSignal(uniqueName('batch'), ['--mode', 'batch']);

    expect(realtime.mode).toBe('realtime');
    expect(batch.mode).toBe('batch');
  });

  it('combines trigger, filters, mode, sampling and disabled', async () => {
    const signal = await createSignal(uniqueName('everything'), [
      '--trigger', 'span-name', '--span-name', 'agent.run',
      '--filter', STATUS_FILTER,
      '--mode', 'realtime',
      '--sample-rate', '25',
      '--disabled',
    ]);

    expect(signal.trigger).toEqual({ type: 'spanName', spanNames: ['agent.run'] });
    expect(signal.filters).toEqual([{ column: 'status', operator: 'eq', value: 'error' }]);
    expect(signal.mode).toBe('realtime');
    expect(signal.sampleRate).toBe(25);
    expect(signal.disabled).toBe(true);

    // Re-read: the create response could echo the request rather than the row.
    const reread = expectJson<SignalShape>(await sig(['get', signal.id, '--json']));
    expect(reread).toEqual(signal);
  });

  it('accepts the boundary sample rates 1 and 95', async () => {
    const low = await createSignal(uniqueName('rate-1'), ['--sample-rate', '1']);
    const high = await createSignal(uniqueName('rate-95'), ['--sample-rate', '95']);

    expect(low.sampleRate).toBe(1);
    expect(high.sampleRate).toBe(95);
  });

  it('prints a human summary (not JSON) without --json', async () => {
    const name = uniqueName('human-create');
    const { stdout, stderr, exitCode } = await sig([
      'create', name, '--prompt', 'Detect refund asks', '--schema', SIMPLE_SCHEMA,
      '--trigger', 'span-name', '--span-name', 'agent.run', '--span-name', 'worker.step',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(`Created signal "${name}".`);
    expect(stderr).toContain('prompt:       Detect refund asks');
    expect(stderr).toContain('fields:       reason');
    // The trigger renders in the same words --trigger accepts, so it can be fed back.
    expect(stderr).toContain('trigger:      span-name: agent.run, worker.step');
    // Filters render as JSON; the server's key order is not column-first.
    expect(stderr).toMatch(/filters: +\{/);
    expect(stderr).toContain('"column":"total_token_count"');
    expect(stderr).toContain('mode:         batch');
    expect(stderr).toContain('sample rate:  none');
    expect(stderr).toContain('status:       active');
  });

  it('renders no filters as "none" in human mode', async () => {
    const created = await createSignal(uniqueName('human-nofilter'), ['--filter', STATUS_FILTER]);
    await sig(['update', created.id, '--no-filters', '--json']);

    const { stderr } = await sig(['get', created.id]);
    expect(stderr).toContain('filters:      none');
  });
});

describeLive('signal create — client-side validation', () => {
  it('rejects a blank name before any request', async () => {
    const error = expectJsonError(
      await sig(['create', '   ', '--prompt', 'p', '--schema', SIMPLE_SCHEMA, '--json']),
    );
    expect(error).toBe('Signal name is required');
  });

  it('rejects a blank --prompt', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('blank-prompt'), '--prompt', '  ',
        '--schema', SIMPLE_SCHEMA, '--json']),
    );
    expect(error).toBe('Signal prompt is required');
  });

  it('reports malformed --schema JSON with the flag name', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-schema'), '--prompt', 'p',
        '--schema', '{not json', '--json']),
    );
    expect(error).toContain('--schema is not valid JSON');
  });

  it('rejects a --schema that is valid JSON but not an object', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('array-schema'), '--prompt', 'p',
        '--schema', '[1,2]', '--json']),
    );
    expect(error).toContain('--schema must be a JSON object');
  });

  it('rejects a --schema with no properties object', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('no-props'), '--prompt', 'p',
        '--schema', '{"type":"object"}', '--json']),
    );
    expect(error).toContain('--schema must carry a "properties" object');
  });

  it('rejects an unknown --trigger kind and lists the valid ones', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-kind'), '--prompt', 'p',
        '--schema', SIMPLE_SCHEMA, '--trigger', 'nope', '--json']),
    );
    expect(error).toBe('--trigger must be one of root-span-finished, span-name (got "nope")');
  });

  it('rejects --span-name without --trigger span-name rather than inferring it', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('implied-kind'), '--prompt', 'p',
        '--schema', SIMPLE_SCHEMA, '--span-name', 'agent.run', '--json']),
    );
    expect(error).toBe('--span-name requires --trigger span-name');
  });

  it('rejects --span-name alongside --trigger root-span-finished', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('wrong-kind'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--trigger', 'root-span-finished', '--span-name', 'agent.run', '--json']),
    );
    expect(error).toBe('--span-name only applies to --trigger span-name, not root-span-finished');
  });

  it('rejects --trigger span-name with no usable span name', async () => {
    const expected =
      '--trigger span-name requires at least one --span-name, ' +
      'or the signal would never fire';

    const missing = expectJsonError(
      await sig(['create', uniqueName('no-span'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--trigger', 'span-name', '--json']),
    );
    expect(missing).toBe(expected);

    // All-blank is the same case: it would be stored and then never fire.
    const blank = expectJsonError(
      await sig(['create', uniqueName('blank-span'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--trigger', 'span-name', '--span-name', '   ', '--json']),
    );
    expect(blank).toBe(expected);
  });

  it('rejects an unknown --mode', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-mode'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--mode', 'fast', '--json']),
    );
    expect(error).toBe('--mode must be one of batch, realtime (got "fast")');
  });

  it('reports malformed --filter JSON with the flag name', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-filter'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '{oops', '--json']),
    );
    expect(error).toContain('--filter is not valid JSON');
  });

  it('rejects a --filter that is not an object', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('array-filter'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '[1]', '--json']),
    );
    expect(error).toContain('--filter must be a JSON object like');
  });

  it('rejects a --filter missing column, operator or value', async () => {
    const noColumn = expectJsonError(
      await sig(['create', uniqueName('f-col'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '{"operator":"gt","value":"1"}', '--json']),
    );
    expect(noColumn).toContain('--filter must carry a non-empty "column" string');

    const noOperator = expectJsonError(
      await sig(['create', uniqueName('f-op'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '{"column":"status","value":"error"}', '--json']),
    );
    expect(noOperator).toContain('--filter must carry a non-empty "operator" string');

    const noValue = expectJsonError(
      await sig(['create', uniqueName('f-val'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '{"column":"status","operator":"eq"}', '--json']),
    );
    expect(noValue).toContain('--filter must carry a "value"');
  });

  it('rejects a non-integer --sample-rate rather than sending NaN', async () => {
    for (const raw of ['abc', '2.5', '', '  ']) {
      const error = expectJsonError(
        await sig(['create', uniqueName('rate'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
          '--sample-rate', raw, '--json']),
      );
      expect(error, `--sample-rate ${JSON.stringify(raw)}`)
        .toBe('--sample-rate must be an integer');
    }
  });

  it('fails on a missing required flag before contacting the server', async () => {
    const noPrompt = await sig([
      'create', uniqueName('no-prompt'), '--schema', SIMPLE_SCHEMA, '--json',
    ]);
    expect(noPrompt.exitCode).not.toBe(0);
    // Commander exits before the action runs, so there is no --json envelope.
    expect(noPrompt.stderr).toContain("required option '--prompt <prompt>' not specified");

    const noSchema = await sig(['create', uniqueName('no-schema'), '--prompt', 'p', '--json']);
    expect(noSchema.exitCode).not.toBe(0);
    expect(noSchema.stderr).toContain("required option '--schema <json>' not specified");
  });

  it('requires the name positional', async () => {
    const { exitCode, stderr } = await sig([
      'create', '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing required argument 'name'");
  });
});

describeLive('signal create — server-side rejections surface verbatim', () => {
  it('rejects a duplicate name with 409', async () => {
    const name = uniqueName('dup');
    await createSignal(name);

    const error = expectJsonError(
      await sig(['create', name, '--prompt', 'p', '--schema', SIMPLE_SCHEMA, '--json']),
    );
    expect(error).toContain('409');
    expect(error).toContain(`A signal named "${name}" already exists in this project`);
  });

  it('rejects a sample rate outside 1-95', async () => {
    for (const raw of ['0', '96', '150', '-5']) {
      const error = expectJsonError(
        await sig(['create', uniqueName('rate-oob'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
          '--sample-rate', raw, '--json']),
      );
      expect(error, `--sample-rate ${raw}`).toContain('sampleRate must be between 1 and 95');
    }
  });

  it('rejects a name longer than 255 characters', async () => {
    const error = expectJsonError(
      await sig(['create', `${PREFIX}${'n'.repeat(300)}`, '--prompt', 'p',
        '--schema', SIMPLE_SCHEMA, '--json']),
    );
    expect(error).toContain('Name must be at most 255 characters');
  });

  it('rejects a field name that is not an identifier', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-field'), '--prompt', 'p',
        '--schema', '{"properties":{"bad-name":{"type":"string","description":"d"}}}', '--json']),
    );
    expect(error).toContain('must be a valid identifier');
  });

  it('rejects a field type outside string/number/boolean', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-type'), '--prompt', 'p',
        '--schema', '{"properties":{"f":{"type":"object","description":"d"}}}', '--json']),
    );
    expect(error).toContain('type must be string, number, or boolean');
  });

  it('rejects an empty properties map', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('no-fields'), '--prompt', 'p',
        '--schema', '{"properties":{}}', '--json']),
    );
    expect(error).toContain('At least one payload field is required');
  });

  it('rejects a schema whose type is not "object"', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('array-type'), '--prompt', 'p',
        '--schema', '{"type":"array","properties":{"a":{"type":"string","description":"d"}}}',
        '--json']),
    );
    expect(error).toContain('structuredOutput.type must be "object"');
  });

  it('rejects a partial explicit `required` list', async () => {
    // parseStructuredOutput only DEFAULTS `required` when it is omitted; an
    // explicit one is forwarded verbatim, and every field is required, so a
    // partial list is the server's 400 rather than something the CLI patches up.
    const schema = JSON.stringify({
      properties: {
        a: { type: 'string', description: 'A' },
        b: { type: 'string', description: 'B' },
      },
      required: ['a'],
    });
    const error = expectJsonError(
      await sig(['create', uniqueName('partial-required'), '--prompt', 'p',
        '--schema', schema, '--json']),
    );
    expect(error).toContain('`required` must list exactly the property names');
  });

  it('points at --trigger when a trigger column is passed as a filter', async () => {
    for (const column of ['root_span_finished', 'span_name']) {
      const error = expectJsonError(
        await sig(['create', uniqueName('trigger-as-filter'), '--prompt', 'p',
          '--schema', SIMPLE_SCHEMA,
          '--filter', `{"column":"${column}","operator":"eq","value":"x"}`, '--json']),
      );
      expect(error, column).toContain('decides WHEN a signal is evaluated, not whether it runs');
      expect(error, column).toContain('set `trigger` instead of a filter');
    }
  });

  it('rejects an unsupported filter column and names the allowed ones', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-filter-col'), '--prompt', 'p',
        '--schema', SIMPLE_SCHEMA,
        '--filter', '{"column":"nope","operator":"eq","value":"x"}', '--json']),
    );
    expect(error).toContain('Unsupported filter column "nope"');
    expect(error).toContain('total_token_count, status, or span_names');
  });

  it('rejects an operator the filter column does not support', async () => {
    const error = expectJsonError(
      await sig(['create', uniqueName('bad-op'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '{"column":"status","operator":"gt","value":"error"}', '--json']),
    );
    expect(error).toContain('status operator must be eq or ne');
  });

  it('rejects a value the filter column does not allow', async () => {
    const status = expectJsonError(
      await sig(['create', uniqueName('bad-status'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
        '--filter', '{"column":"status","operator":"eq","value":"flaky"}', '--json']),
    );
    expect(status).toContain('status value must be "error" or "success"');

    const blankSpan = expectJsonError(
      await sig(['create', uniqueName('blank-span-filter'), '--prompt', 'p',
        '--schema', SIMPLE_SCHEMA,
        '--filter', '{"column":"span_names","operator":"eq","value":"  "}', '--json']),
    );
    expect(blankSpan).toContain('span_names value must be a non-blank span name');
  });

  it('rejects a non-finite token count, including "NaN" and "inf"', async () => {
    for (const value of ['abc', 'NaN', 'inf', '']) {
      const error = expectJsonError(
        await sig(['create', uniqueName('bad-tokens'), '--prompt', 'p', '--schema', SIMPLE_SCHEMA,
          '--filter', `{"column":"total_token_count","operator":"gt","value":"${value}"}`,
          '--json']),
      );
      expect(error, `value ${JSON.stringify(value)}`)
        .toContain('total_token_count value must be a finite number');
    }
  });
});

describeLive('signal list', () => {
  it('returns a JSON array of full signal objects', async () => {
    const created = await createSignal(uniqueName('listed'));
    const signals = expectJson<SignalShape[]>(await sig(['list', '--json']));

    expect(Array.isArray(signals)).toBe(true);
    const found = signals.find((s) => s.id === created.id);
    expect(found).toBeDefined();
    // trigger/filters/mode are siblings on the signal now, not a triggers list.
    expect(Object.keys(found as object).sort()).toEqual([
      'createdAt', 'disabled', 'filters', 'id', 'mode', 'name', 'projectId', 'prompt',
      'sampleRate', 'structuredOutput', 'trigger',
    ]);
  });

  it('filters by the [name] positional as a substring', async () => {
    const created = await createSignal(uniqueName('filter-target'));
    const signals = expectJson<SignalShape[]>(await sig(['list', created.name, '--json']));

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe(created.id);
  });

  it('matches the name filter case-insensitively', async () => {
    const created = await createSignal(uniqueName('MixedCase'));
    const signals = expectJson<SignalShape[]>(
      await sig(['list', created.name.toLowerCase(), '--json']),
    );

    expect(signals.map((s) => s.id)).toContain(created.id);
  });

  it('returns [] for a filter that matches nothing', async () => {
    const signals = expectJson<SignalShape[]>(
      await sig(['list', `${PREFIX}definitely-absent`, '--json']),
    );
    expect(signals).toEqual([]);
  });

  it('renders a table with the trigger, filter count and mode columns', async () => {
    const created = await createSignal(uniqueName('tbl'), [
      '--sample-rate', '10', '--mode', 'realtime',
    ]);
    const { stdout, stderr, exitCode } = await sig(['list', created.name]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('ID');
    expect(stderr).toContain('Name');
    // Columns are truncated to an 80-col default when stdout is a pipe, so
    // assert on prefixes rather than full values.
    expect(stderr).toContain('Trigger');
    expect(stderr).toContain('Mode');
    expect(stderr).toContain(created.id.slice(0, 16));
    expect(stderr).toContain('10%');
    // Seven columns in 80 cols truncates hard, so match short prefixes only.
    expect(stderr).toMatch(/root-span/);
    expect(stderr).toMatch(/real/);
  });

  it('says "No signals found." in human mode when the filter matches nothing', async () => {
    const { stdout, stderr, exitCode } = await sig(['list', `${PREFIX}definitely-absent`]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('No signals found.');
  });

  it('shows "-" for no sampling and the disabled status in the table', async () => {
    const created = await createSignal(uniqueName('tbl-off'), ['--disabled']);
    const { stderr } = await sig(['list', created.name]);

    expect(stderr).toContain('-');
    expect(stderr).toMatch(/disa/);
  });

  it('works under the `signals` alias', async () => {
    const created = await createSignal(uniqueName('alias'));
    const result = await runCli([
      'signals', 'list', created.name, '--json', '--project-id', PROJECT_ID, ...endpoint(),
    ]);

    expect(expectJson<SignalShape[]>(result).map((s) => s.id)).toEqual([created.id]);
  });
});

describeLive('signal get', () => {
  it('resolves by id', async () => {
    const created = await createSignal(uniqueName('by-id'));
    const signal = expectJson<SignalShape>(await sig(['get', created.id, '--json']));

    expect(signal).toEqual(created);
  });

  it('resolves by exact name', async () => {
    const created = await createSignal(uniqueName('by-name'));
    const signal = expectJson<SignalShape>(await sig(['get', created.name, '--json']));

    expect(signal.id).toBe(created.id);
  });

  it('resolves by a unique name substring', async () => {
    const created = await createSignal(uniqueName('substring-unique'));
    const signal = expectJson<SignalShape>(
      await sig(['get', created.name.slice(0, created.name.length - 1), '--json']),
    );

    expect(signal.id).toBe(created.id);
  });

  it('prefers an exact name match over its own substring matches', async () => {
    const base = uniqueName('prefer');
    const exact = await createSignal(base);
    await createSignal(`${base}-extra`);

    // `base` is a substring of both, but only one is an exact match.
    const signal = expectJson<SignalShape>(await sig(['get', base, '--json']));
    expect(signal.id).toBe(exact.id);
  });

  it('errors on an ambiguous substring instead of guessing', async () => {
    const base = uniqueName('ambig');
    const a = await createSignal(`${base}-a`);
    const b = await createSignal(`${base}-b`);

    const error = expectJsonError(await sig(['get', base, '--json']));
    expect(error).toContain(`"${base}" matches 2 signals`);
    expect(error).toContain(a.id);
    expect(error).toContain(b.id);
    expect(error).toContain('Pass the id instead.');
  });

  it('errors when no signal matches the name', async () => {
    const error = expectJsonError(await sig(['get', `${PREFIX}ghost`, '--json']));
    expect(error).toBe(`No signal matching "${PREFIX}ghost" in this project.`);
  });

  it('surfaces the server 404 for a well-formed but unknown id', async () => {
    const error = expectJsonError(
      await sig(['get', '11111111-2222-3333-4444-555555555555', '--json']),
    );
    expect(error).toContain('404');
    expect(error).toContain('Signal not found');
  });

  it('prints trigger, filters and mode in human mode', async () => {
    const created = await createSignal(uniqueName('human-get'), [
      '--sample-rate', '40', '--filter', STATUS_FILTER, '--mode', 'realtime',
    ]);
    const { stdout, stderr, exitCode } = await sig(['get', created.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(`${created.name} (${created.id})`);
    expect(stderr).toContain('prompt:       Detect refund asks');
    expect(stderr).toContain('fields:       reason');
    expect(stderr).toContain('trigger:      root-span-finished');
    // Filters render as the JSON --filter accepts.
    expect(stderr).toContain('"column":"status"');
    expect(stderr).toContain('mode:         realtime');
    expect(stderr).toContain('sample rate:  40');
    expect(stderr).toContain('status:       active');
  });

  it('joins several filters with AND in human mode', async () => {
    const created = await createSignal(uniqueName('human-and'), [
      '--filter', STATUS_FILTER, '--filter', TOKEN_FILTER,
    ]);
    const { stderr } = await sig(['get', created.id]);

    expect(stderr).toContain(' AND ');
  });

  it('reports the disabled status in human mode', async () => {
    const created = await createSignal(uniqueName('human-off'), ['--disabled']);
    const { stderr } = await sig(['get', created.id]);

    expect(stderr).toContain('status:       disabled');
  });

  it('requires the signal positional', async () => {
    const { exitCode, stderr } = await sig(['get']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing required argument 'signal'");
  });
});

describeLive('signal update', () => {
  it('replaces the prompt', async () => {
    const created = await createSignal(uniqueName('upd-prompt'));
    const updated = expectJson<SignalShape>(
      await sig(['update', created.id, '--prompt', 'Only explicit refund asks', '--json']),
    );

    expect(updated.prompt).toBe('Only explicit refund asks');
    expect(updated.id).toBe(created.id);
  });

  it('replaces the payload schema', async () => {
    const created = await createSignal(uniqueName('upd-schema'));
    const updated = expectJson<SignalShape>(
      await sig(['update', created.id, '--json',
        '--schema', '{"properties":{"sev":{"type":"number","description":"Severity"}}}']),
    );

    expect(Object.keys(updated.structuredOutput.properties)).toEqual(['sev']);
    expect(updated.structuredOutput.required).toEqual(['sev']);
  });

  it('switches the trigger from root-span to span-name and back', async () => {
    const created = await createSignal(uniqueName('upd-trigger'));
    expect(created.trigger).toEqual({ type: 'rootSpanFinished' });

    const toSpan = expectJson<SignalShape>(
      await sig(['update', created.id, '--trigger', 'span-name',
        '--span-name', 'agent.run', '--span-name', 'worker.step', '--json']),
    );
    expect(toSpan.trigger).toEqual({
      type: 'spanName', spanNames: ['agent.run', 'worker.step'],
    });

    const toRoot = expectJson<SignalShape>(
      await sig(['update', created.id, '--trigger', 'root-span-finished', '--json']),
    );
    expect(toRoot.trigger).toEqual({ type: 'rootSpanFinished' });
  });

  it('replaces the whole filter set with --filter', async () => {
    const created = await createSignal(uniqueName('upd-filters'), [
      '--filter', STATUS_FILTER, '--filter', TOKEN_FILTER,
    ]);
    expect(created.filters).toHaveLength(2);

    const updated = expectJson<SignalShape>(
      await sig(['update', created.id, '--filter', STATUS_FILTER, '--json']),
    );
    expect(updated.filters).toEqual([{ column: 'status', operator: 'eq', value: 'error' }]);
  });

  it('clears every filter with --no-filters', async () => {
    const created = await createSignal(uniqueName('upd-nofilters'), ['--filter', STATUS_FILTER]);

    const updated = expectJson<SignalShape>(
      await sig(['update', created.id, '--no-filters', '--json']),
    );
    expect(updated.filters).toEqual([]);
    // The trigger is untouched — it still fires, it just runs every time.
    expect(updated.trigger).toEqual({ type: 'rootSpanFinished' });
  });

  it('changes the mode', async () => {
    const created = await createSignal(uniqueName('upd-mode'));
    expect(created.mode).toBe('batch');

    const realtime = expectJson<SignalShape>(
      await sig(['update', created.id, '--mode', 'realtime', '--json']),
    );
    expect(realtime.mode).toBe('realtime');

    const batch = expectJson<SignalShape>(
      await sig(['update', created.id, '--mode', 'batch', '--json']),
    );
    expect(batch.mode).toBe('batch');
  });

  it('sets and then clears the sample rate', async () => {
    const created = await createSignal(uniqueName('upd-rate'));

    const sampled = expectJson<SignalShape>(
      await sig(['update', created.id, '--sample-rate', '33', '--json']),
    );
    expect(sampled.sampleRate).toBe(33);

    const cleared = expectJson<SignalShape>(
      await sig(['update', created.id, '--no-sampling', '--json']),
    );
    expect(cleared.sampleRate).toBeNull();
  });

  it('deactivates with --disabled and reactivates with --no-disabled', async () => {
    const created = await createSignal(uniqueName('upd-toggle'));
    expect(created.disabled).toBe(false);

    const off = expectJson<SignalShape>(await sig(['update', created.id, '--disabled', '--json']));
    expect(off.disabled).toBe(true);

    const on = expectJson<SignalShape>(
      await sig(['update', created.id, '--no-disabled', '--json']),
    );
    expect(on.disabled).toBe(false);
  });

  it('is a partial patch: an omitted flag keeps its stored value', async () => {
    const created = await createSignal(uniqueName('upd-partial'), [
      '--trigger', 'span-name', '--span-name', 'agent.run',
      '--filter', STATUS_FILTER,
      '--mode', 'realtime',
      '--sample-rate', '30',
      '--disabled',
    ]);

    const updated = expectJson<SignalShape>(
      await sig(['update', created.id, '--prompt', 'Changed prompt only', '--json']),
    );

    expect(updated.prompt).toBe('Changed prompt only');
    // The regression this guards: a prompt edit must not clear sampling,
    // reactivate the signal, or alter when/whether/how it runs.
    expect(updated.trigger).toEqual(created.trigger);
    expect(updated.filters).toEqual(created.filters);
    expect(updated.mode).toBe('realtime');
    expect(updated.sampleRate).toBe(30);
    expect(updated.disabled).toBe(true);
    expect(updated.structuredOutput).toEqual(created.structuredOutput);
  });

  it('changes trigger, filters and mode independently of each other', async () => {
    const created = await createSignal(uniqueName('upd-independent'), [
      '--trigger', 'span-name', '--span-name', 'agent.run',
      '--filter', STATUS_FILTER,
      '--mode', 'realtime',
    ]);

    // Filters only: trigger and mode must survive.
    const filtersOnly = expectJson<SignalShape>(
      await sig(['update', created.id, '--filter', TOKEN_FILTER, '--json']),
    );
    expect(filtersOnly.trigger).toEqual(created.trigger);
    expect(filtersOnly.mode).toBe('realtime');
    expect(filtersOnly.filters).toEqual([
      { column: 'total_token_count', operator: 'gt', value: '5000' },
    ]);

    // Mode only: trigger and filters must survive.
    const modeOnly = expectJson<SignalShape>(
      await sig(['update', created.id, '--mode', 'batch', '--json']),
    );
    expect(modeOnly.trigger).toEqual(created.trigger);
    expect(modeOnly.filters).toEqual(filtersOnly.filters);

    // Trigger only: filters and mode must survive.
    const triggerOnly = expectJson<SignalShape>(
      await sig(['update', created.id, '--trigger', 'root-span-finished', '--json']),
    );
    expect(triggerOnly.filters).toEqual(filtersOnly.filters);
    expect(triggerOnly.mode).toBe('batch');
  });

  it('applies several flags at once', async () => {
    const created = await createSignal(uniqueName('upd-combo'));
    const updated = expectJson<SignalShape>(
      await sig(['update', created.id, '--prompt', 'New prompt', '--sample-rate', '15',
        '--disabled', '--trigger', 'span-name', '--span-name', 'agent.run',
        '--filter', STATUS_FILTER, '--mode', 'realtime', '--json']),
    );

    expect(updated.prompt).toBe('New prompt');
    expect(updated.sampleRate).toBe(15);
    expect(updated.disabled).toBe(true);
    expect(updated.trigger).toEqual({ type: 'spanName', spanNames: ['agent.run'] });
    expect(updated.filters).toEqual([{ column: 'status', operator: 'eq', value: 'error' }]);
    expect(updated.mode).toBe('realtime');
  });

  it('resolves the target by name as well as id', async () => {
    const created = await createSignal(uniqueName('upd-by-name'));
    const updated = expectJson<SignalShape>(
      await sig(['update', created.name, '--sample-rate', '7', '--json']),
    );

    expect(updated.id).toBe(created.id);
    expect(updated.sampleRate).toBe(7);
  });

  it('prints the updated signal in human mode', async () => {
    const created = await createSignal(uniqueName('upd-human'));
    const { stdout, stderr, exitCode } = await sig([
      'update', created.id, '--prompt', 'Human mode prompt',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(`Updated signal "${created.name}".`);
    expect(stderr).toContain('prompt:       Human mode prompt');
    expect(stderr).toContain('mode:         batch');
  });

  it('refuses an empty patch and lists the usable flags', async () => {
    const created = await createSignal(uniqueName('upd-empty'));
    const error = expectJsonError(await sig(['update', created.id, '--json']));

    expect(error).toContain('Nothing to update.');
    for (const flag of ['--prompt', '--schema', '--trigger', '--filter', '--no-filters',
      '--mode', '--sample-rate', '--no-sampling', '--disabled', '--no-disabled']) {
      expect(error, flag).toContain(flag);
    }
  });

  it('refuses --sample-rate together with --no-sampling', async () => {
    const created = await createSignal(uniqueName('upd-rate-conflict'));
    const error = expectJsonError(
      await sig(['update', created.id, '--sample-rate', '10', '--no-sampling', '--json']),
    );

    expect(error).toBe('--sample-rate cannot be combined with --no-sampling');
  });

  it('refuses --filter together with --no-filters', async () => {
    const created = await createSignal(uniqueName('upd-filter-conflict'));
    const error = expectJsonError(
      await sig(['update', created.id, '--filter', STATUS_FILTER, '--no-filters', '--json']),
    );

    expect(error).toBe('--filter cannot be combined with --no-filters');
  });

  it('rejects --span-name without --trigger span-name', async () => {
    const created = await createSignal(uniqueName('upd-implied'));
    const error = expectJsonError(
      await sig(['update', created.id, '--span-name', 'agent.run', '--json']),
    );

    expect(error).toBe('--span-name requires --trigger span-name');
  });

  it('validates flags before resolving the signal', async () => {
    // A bad --schema on a non-existent signal must report the schema problem,
    // not "no signal matching" — validation runs first.
    const error = expectJsonError(
      await sig(['update', `${PREFIX}ghost`, '--schema', '{bad', '--json']),
    );
    expect(error).toContain('--schema is not valid JSON');
  });

  it('rejects a blank --prompt', async () => {
    const created = await createSignal(uniqueName('upd-blank'));
    const error = expectJsonError(await sig(['update', created.id, '--prompt', '   ', '--json']));

    expect(error).toBe('Signal prompt is required');
  });

  it('rejects an unknown --mode and --trigger kind', async () => {
    const created = await createSignal(uniqueName('upd-bad-enums'));

    expect(expectJsonError(await sig(['update', created.id, '--mode', 'turbo', '--json'])))
      .toContain('--mode must be one of batch, realtime');
    expect(expectJsonError(await sig(['update', created.id, '--trigger', 'whenever', '--json'])))
      .toContain('--trigger must be one of root-span-finished, span-name');
  });

  it('surfaces server errors for an out-of-range rate and a bad filter', async () => {
    const created = await createSignal(uniqueName('upd-server-reject'));

    expect(expectJsonError(await sig(['update', created.id, '--sample-rate', '200', '--json'])))
      .toContain('sampleRate must be between 1 and 95');

    const badFilter = expectJsonError(
      await sig(['update', created.id, '--json',
        '--filter', '{"column":"status","operator":"eq","value":"maybe"}']),
    );
    expect(badFilter).toContain('status value must be "error" or "success"');
  });

  it('errors when the target name matches nothing', async () => {
    const error = expectJsonError(
      await sig(['update', `${PREFIX}ghost`, '--sample-rate', '5', '--json']),
    );
    expect(error).toBe(`No signal matching "${PREFIX}ghost" in this project.`);
  });

  it('errors when the target name is ambiguous', async () => {
    const base = uniqueName('upd-ambig');
    await createSignal(`${base}-a`);
    await createSignal(`${base}-b`);

    const error = expectJsonError(await sig(['update', base, '--sample-rate', '5', '--json']));
    expect(error).toContain('matches 2 signals');
    expect(error).toContain('Pass the id instead.');
  });

  it('requires the signal positional', async () => {
    const { exitCode, stderr } = await sig(['update', '--sample-rate', '5']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing required argument 'signal'");
  });
});

describeLive('signal delete', () => {
  it('deletes by id and returns the deleted row', async () => {
    const created = await createSignal(uniqueName('del-id'));
    const deleted = expectJson<SignalShape>(await sig(['delete', created.id, '--json']));

    expect(deleted.id).toBe(created.id);
    expect(deleted.name).toBe(created.name);
  });

  it('deletes by name', async () => {
    const created = await createSignal(uniqueName('del-name'));
    const deleted = expectJson<SignalShape>(await sig(['delete', created.name, '--json']));

    expect(deleted.id).toBe(created.id);
  });

  it('really removes the signal from get and list', async () => {
    const created = await createSignal(uniqueName('del-gone'));
    expect((await sig(['delete', created.id, '--json'])).exitCode).toBe(0);

    const byId = expectJsonError(await sig(['get', created.id, '--json']));
    expect(byId).toContain('404');

    const byName = expectJsonError(await sig(['get', created.name, '--json']));
    expect(byName).toContain('No signal matching');

    const listed = expectJson<SignalShape[]>(await sig(['list', created.name, '--json']));
    expect(listed).toEqual([]);
  });

  it('fails on a second delete of the same id', async () => {
    const created = await createSignal(uniqueName('del-twice'));
    expect((await sig(['delete', created.id, '--json'])).exitCode).toBe(0);

    const error = expectJsonError(await sig(['delete', created.id, '--json']));
    expect(error).toContain('404');
  });

  it('reports what was removed in human mode', async () => {
    const created = await createSignal(uniqueName('del-human'));
    const { stdout, stderr, exitCode } = await sig(['delete', created.id]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      `Deleted signal "${created.name}" (${created.id}), its triggers, alerts, and events.`,
    );
  });

  it('errors when the name matches nothing', async () => {
    const error = expectJsonError(await sig(['delete', `${PREFIX}ghost`, '--json']));
    expect(error).toBe(`No signal matching "${PREFIX}ghost" in this project.`);
  });

  it('errors on an ambiguous name rather than deleting the wrong signal', async () => {
    const base = uniqueName('del-ambig');
    const a = await createSignal(`${base}-a`);
    const b = await createSignal(`${base}-b`);

    const error = expectJsonError(await sig(['delete', base, '--json']));
    expect(error).toContain('matches 2 signals');

    // Both must still be there.
    const still = expectJson<SignalShape[]>(await sig(['list', base, '--json']));
    expect(still.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('surfaces the server 404 for an unknown id', async () => {
    const error = expectJsonError(
      await sig(['delete', '11111111-2222-3333-4444-555555555555', '--json']),
    );
    expect(error).toContain('404');
    expect(error).toContain('Signal not found');
  });

  it('requires the signal positional', async () => {
    const { exitCode, stderr } = await sig(['delete']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("missing required argument 'signal'");
  });
});

describeLive('signal — auth, project resolution and transport', () => {
  it('reports "not authenticated" when no credentials file exists', async () => {
    const emptyConfig = mkdtempSync(path.join(tmpdir(), 'lmnr-no-creds-'));
    try {
      const error = expectJsonError(await sig(['list', '--json'], { xdgConfigHome: emptyConfig }));
      expect(error).toBe('Not authenticated. Run `lmnr-cli login`.');
    } finally {
      rmSync(emptyConfig, { recursive: true, force: true });
    }
  });

  it('asks for a project when none is linked and --project-id is omitted', async () => {
    // Run from a temp dir so no .lmnr/project.json is found walking upwards.
    const unlinked = mkdtempSync(path.join(tmpdir(), 'lmnr-unlinked-'));
    try {
      const result = await runCli(['signal', 'list', '--json', ...endpoint()], { cwd: unlinked });
      const error = expectJsonError(result);
      expect(error).toContain('No project for this directory');
      expect(error).toContain('--project-id');
    } finally {
      rmSync(unlinked, { recursive: true, force: true });
    }
  });

  it('rejects a project the user is not a member of', async () => {
    const result = await runCli([
      'signal', 'list', '--json',
      '--project-id', '11111111-2222-3333-4444-555555555555', ...endpoint(),
    ]);
    const error = expectJsonError(result);
    expect(error).toContain('403');
    expect(error).toContain('not a member of this project');
  });

  it('rejects a malformed project id', async () => {
    const result = await runCli([
      'signal', 'list', '--json', '--project-id', 'not-a-uuid', ...endpoint(),
    ]);
    const error = expectJsonError(result);
    expect(error).toContain('400');
    expect(error).toContain('project-id');
  });

  it('reports a transport failure rather than hanging', async () => {
    const result = await runCli([
      'signal', 'list', '--json', '--project-id', PROJECT_ID,
      '--base-url', BASE_URL, '--port', '9',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(expectJsonError(result)).toMatch(/fetch failed|ECONNREFUSED/i);
  });
});

describeLive('signal — output contract', () => {
  it('writes JSON to stdout and nothing else, for every subcommand', async () => {
    const created = await createSignal(uniqueName('contract'));

    const results = [
      await sig(['list', created.name, '--json']),
      await sig(['get', created.id, '--json']),
      await sig(['update', created.id, '--sample-rate', '5', '--json']),
      await sig(['delete', created.id, '--json']),
    ];

    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect((): unknown => JSON.parse(result.stdout.trim())).not.toThrow();
      // Exactly one JSON line, so an agent can parse stdout without scanning.
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
    }
  });

  it('writes a parseable {error} to stdout and exits non-zero on every failure', async () => {
    const results = [
      await runCli(['signal', 'list', '--json', '--project-id', 'not-a-uuid', ...endpoint()]),
      await sig(['get', `${PREFIX}ghost`, '--json']),
      await sig(['create', '  ', '--prompt', 'p', '--schema', SIMPLE_SCHEMA, '--json']),
      await sig(['update', `${PREFIX}ghost`, '--sample-rate', '5', '--json']),
      await sig(['delete', `${PREFIX}ghost`, '--json']),
    ];

    for (const result of results) {
      expect(result.exitCode).toBe(1);
      const parsed = JSON.parse(result.stdout.trim()) as { error?: string };
      expect(typeof parsed.error).toBe('string');
      expect(parsed.error).not.toBe('');
    }
  });

  it('keeps human output on stderr so stdout stays pipe-safe', async () => {
    const created = await createSignal(uniqueName('streams'));
    for (const args of [['list'], ['get', created.id]]) {
      const { stdout, stderr } = await sig(args);
      expect(stdout).toBe('');
      expect(stderr.length).toBeGreaterThan(0);
    }
  });

  it('documents every subcommand and flag in --help, exiting 0', async () => {
    const group = await runCli(['signal', '--help']);
    expect(group.exitCode).toBe(0);
    for (const sub of ['list', 'get', 'create', 'update', 'delete']) {
      expect(group.stdout).toContain(sub);
    }

    const create = await runCli(['signal', 'create', '--help']);
    expect(create.exitCode).toBe(0);
    for (const flag of ['--prompt', '--schema', '--trigger', '--span-name', '--filter',
      '--mode', '--sample-rate', '--disabled']) {
      expect(create.stdout, flag).toContain(flag);
    }
    // The when/whether/how split is the easiest thing to get wrong.
    expect(create.stdout).toContain('WHEN it is evaluated');
    expect(create.stdout).toContain('WHETHER it runs');
    expect(create.stdout).toContain('root-span-finished');
    expect(create.stdout).toContain('span-name');

    const update = await runCli(['signal', 'update', '--help']);
    expect(update.exitCode).toBe(0);
    for (const flag of ['--prompt', '--schema', '--trigger', '--span-name', '--filter',
      '--no-filters', '--mode', '--sample-rate', '--no-sampling', '--disabled',
      '--no-disabled']) {
      expect(update.stdout, flag).toContain(flag);
    }
    expect(update.stdout).toContain('REPLACES');
  });

  it('rejects an unknown subcommand', async () => {
    const { exitCode, stderr } = await runCli(['signal', 'frobnicate']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('frobnicate');
  });
});
