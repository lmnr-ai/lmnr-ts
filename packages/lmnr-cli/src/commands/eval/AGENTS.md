# Harbor evals (`eval`)

- `lmnr-cli eval run [dir=evals]` runs each suite (`<dir>/<suite>/harbor.yaml`,
  a Harbor JobConfig) with **pinned** Harbor + the Laminar plugin through
  `uvx` (`harbor.ts`: `HARBOR_VERSION`, `LMNR_PYTHON_VERSION`), from inside the
  suite dir so relative paths and custom agent imports resolve the same way
  everywhere. Harbor's stdout goes to OUR stderr; stdout is data only.
  - default: trials on local Docker; `lmnr.yaml` images are `docker build`-ed first.
  - `--remote`: runs in Laminar sandboxes and the CLI exits once the run
    starts. Packs the folder (`pack.ts`) and checks the 1 GiB
    cap BEFORE pushing images, then uploads it and `POST
    /v1[/cli]/hosted-evals/runs {uploadId, cliVersion, spec}`. The server's
    orchestrator sandbox runs `npx lmnr-cli@<cliVersion> eval orchestrate`
    (hidden command), so `RunSpec` only has to stay readable by the SAME version.
    Streaming results back to the CLI is the follow-up.
- `lmnr-cli eval setup` (`setup.ts`) gets a repo ready for `eval run`, then
  hands the work to the user's coding agent. It runs the `setup` steps via
  `runSetup({quiet: true})` (one `✓ Laminar ready` line when nothing changed),
  asks "is the agent instrumented?" (default from `findLaminarSdk` in
  `instrumentation.ts`, a manifest scan that only sets the default, never
  skips the question) and, if not, "instrument it?", then builds a SHORT
  prompt (`buildEvalSetupPrompt`). Keep it short: the how-to lives in the
  `laminar` skill (instrumentation refs + `env-evals.md`), so the prompt
  carries only the user's answers plus the installed `SKILL.md` path (named
  explicitly because not every agent auto-loads `.claude`/`.agents` skills).
  - Handoff: launch an installed agent CLI from `utils/coding-agents.ts`
    (`LAUNCHABLE_AGENTS`), else the task is already on screen to paste.
    Clipboard copy is opt-in (`--copy`, or a `[y/N]` question).
  - When an agent is the caller (`isAgentCaller`: no TTY, or `CLAUDECODE` /
    `AI_AGENT` / `CODEX_THREAD_ID` / `GEMINI_CLI` / ...), or with `--json` /
    `--print-prompt`, nothing is asked or launched; the prompt goes to stdout.
    Without `--instrumentation` the prompt is then the `unknown` variant,
    which tells the agent to check and ask the user itself.
- Modules: `index.ts` (`eval run` flow, reporting), `setup.ts` (`eval setup`),
  `instrumentation.ts` (Laminar SDK manifest scan), `remote.ts` (`RunSpec`,
  `startRemoteRun`, `eval orchestrate`), `env.ts` (`--env`, `${VAR}`
  resolution, the Harbor process env), `suites.ts` (suite discovery,
  `SKIPPED_DIRS`, the run's tasks (`findTaskTomls`), `buildJobConfig`), `harbor.ts` (uvx/Harbor
  only), `images.ts` (`lmnr.yaml`, what tasks start from, `ensureRemoteImages`),
  `docker.ts` (builds, the ignore guard, `imagePusher`), `push.ts` (`docker
  save` output → layer upload), `run-command.ts` (spawn; a missing binary is
  `missing_tool`). Import graph is acyclic: `docker.ts` imports only types from
  `images.ts`. `ensureRemoteImages` takes an `ImagePusher` so its selection
  logic is tested without Docker; tests mock `run-command.ts` for the rest.
- **Remote trials use `assets/lmnr_hosted_env.py`**, a Harbor `BaseEnvironment`
  subclass copied next to the staged job config and loaded via
  `environment.import_path` (`buildJobConfig(config, overrides, remote)` swaps
  the suite's environment type/kwargs for it). It calls
  `/v1/hosted-evals/sandboxes/*` with `LMNR_PROJECT_API_KEY`; the app-server
  proxies to Daytona (lmnr `docs/internal/hosted-evals.md`). Sandbox `state` is
  `pending | started | error | destroyed`; snapshot state is `ready | pending
  | failed` (+`errorReason`), and only a failed snapshot raises Harbor's
  `SandboxBuildFailedError`. Requests retry transport errors, 429s and 5xx,
  except the two with side effects (`POST /sandboxes`, `POST .../commands`,
  `once=True`): those retry only when the request was never sent or got a 429,
  so a timeout can't create a second sandbox or run a command twice. The
  server keeps the first 10 MiB of each command's stdout / stderr and flags a
  cut (`stdoutTruncated` / `stderrTruncated`); `exec` logs a warning then. It
  subclasses Harbor internals, so bump `HARBOR_VERSION` only together with a
  remote run against the new version.
  `assets/` ships in the npm package (`files`); `environmentModulePath` finds it
  next to `dist/` or in the source tree.
- **Images:** tasks name an image with `docker_image`; `<dir>/lmnr.yaml`
  `images: {name: {dockerfile, context}}` declares how to build it (paths
  relative to `<dir>`). Local runs `docker build` the ones the run's tasks
  reference (`localImageDefs`) and let Harbor handle the rest.
- **Which tasks a run includes** (`findTaskTomls`, used for images and
  `${VAR}`s) mirrors Harbor's `JobPlan.resolve_task_configs` on the job config
  after overrides: `tasks` entries with a local `path`, plus each local
  dataset's child dirs with a `task.toml`, matched by DIRECTORY name (Harbor's
  `LocalTaskId.get_name`, not `[task] name`) against `task_names` /
  `exclude_task_names` with fnmatch. `--task` replaces every dataset's
  `task_names` and filters `tasks` by name, so it narrows images too.
  `n_tasks` is ignored (Harbor counts only fully valid dirs, so applying it
  could skip a task that runs: over-pushing is the safe side). Task dirs no
  dataset or `tasks` entry points at are never built. Checked against Harbor
  0.25.0 on a fixture with excludes, a `../` task and `--task` globs.
- What a task starts from mirrors Harbor's
  `should_use_prebuilt_docker_image` (`findTaskImages`): its `docker_image`,
  unless the suite's harbor.yaml sets `environment.force_build: true` and the
  task has `environment/Dockerfile`, which is otherwise used only without a
  `docker_image`.
- **Remote runs push every image the run's tasks use, from here**
  (`ensureRemoteImages`): per-task `environment/Dockerfile`s and the
  `lmnr.yaml` images tasks reference are built (`pusher.build`; unreferenced
  `lmnr.yaml` images are skipped), other `docker_image`s are pulled
  (`pusher.pull`, a `FROM <ref>` build in one temp dir, so the amd64 variant
  saves like a built image even from a multi-platform index). Each goes
  `docker build --platform linux/amd64` → `docker save -o` + unpack →
  `manifest.json` gives config + layer files (both image stores write it;
  containerd store layers are often gzip already, classic ones are
  uncompressed tars and get gzipped on the fly; zstd is rejected). Layers go
  by `diff_id` (from the config, no hashing): `missingLayers` → `uploadLayer`
  (streamed, `duplex: "half"`) → `createImage(config)` → manifest digest. The
  server pushes into its registry (ECR) and Harbor's class waits on `POST
  /images/snapshots` before `POST /sandboxes {image: <digest>}` (lmnr
  `docs/internal/hosted-evals.md`). Each image has ONE display name for logs,
  errors and its local tag (`ImageDef.name`: the `lmnr.yaml` name, the pulled
  ref, or `<suite>/<env dir key>`). Docker is assumed for every mode: there is
  no fallback. Measured: an app change uploads one small layer; unchanged →
  nothing.
- **Image map shape** (digest strings only): `RemoteImages = {images:
  {docker_image: digest}, dockerfiles: {suite: {envDirKey: digest}}}`, spread
  into `RunSpec`. Each suite's Harbor gets `LMNR_EVAL_IMAGES = {images,
  dockerfiles: <that suite's>}` (`suiteImages`). Dockerfile keys are the env
  dir relative to the suite dir (Harbor's cwd), always with `/`
  (`dockerfileKey`: a remote run looks a Windows-built map up on Linux).
- **Remote limitations:** a per-task Dockerfile `FROM <lmnr.yaml image>` does
  not work remotely and is not supported: remote pushes tag `lmnr.yaml` images
  `lmnr-evals-remote:<hash>`, not by name, so the `FROM` resolves to a
  registry image or a stale local build. Tasks from git/registry datasets are
  fetched by Harbor, so their per-task Dockerfiles and `docker_image`s aren't
  pushed; local task paths outside the evals folder aren't packed either.
- **Every build lmnr-cli runs excludes `.git` and `.env*` without copying the
  context** (`guardedDockerfile` in `docker.ts`, local `lmnr.yaml` builds too;
  local per-task Dockerfiles are built by Harbor, unguarded): the Dockerfile is
  copied to a temp dir next to a generated `Dockerfile.dockerignore` = the
  image's own ignore file (`<Dockerfile>.dockerignore`, else the context's
  `.dockerignore`) + the guard rules LAST, so no `!` rule undoes them. BuildKit
  reads a Dockerfile-specific ignore file instead of the context's, so the
  build runs `-f <tmp>/Dockerfile` from the real context, and it only sends
  what `COPY`/`ADD` reference. Needs BuildKit, Docker's default builder since
  23.0.
- **Exit codes** (`errors.ts`): 16 `invalid_evals_dir` / `archive_too_large`,
  17 `missing_tool`, 18 `harbor_failed` (Harbor runs only), 19 `missing_env`
  (also a missing or malformed `LMNR_EVAL_RUN` in `eval orchestrate`), 20
  `docker_failed` (build / pull / save, unreadable `docker save` output, a
  non-amd64 image, zstd layers). Bad `--env` flags are commander
  `InvalidArgumentError`s.
- **Secrets are Harbor `${VAR}` placeholders**, not flags: `findTemplateVars`
  scans harbor.yaml + the run's task.toml files (`findTaskTomls`, so a task
  `--task` leaves out needs none of its vars), `resolveTemplateEnv` reads ONLY those
  names from process env then `.env.local` / `.env` (`findEnvKey`), and a
  missing required one fails before anything runs (`resolveRunEnv`). The
  values become the Harbor process env (`harborEnv` adds the project key and
  `LMNR_BASE_URL`), so Harbor fills agent, verifier and environment sections
  itself. `--env KEY[=V]` adds vars and references them from every agent as
  `${KEY}`, so literal values never hit the job config. Remote runs send the
  values in the spec and drop `LMNR_*` (the orchestrator gets its own key and
  URL).
- `LMNR_GRPC_PORT` (env or `.env`) becomes `--pk grpc_port=`: the plugin
  exports spans over gRPC and defaults to 8443, so self-hosted traces need it.
- Auth: local runs need `LMNR_PROJECT_API_KEY` (the plugin reports with it;
  in the orchestrator it is the run key). `--remote` calls the API as the logged-in user and falls back to
  the project key when there is no login (CI).
- Uploads never contain `.env*`, `SKIPPED_DIRS` (`.git`, `node_modules`,
  virtualenvs, caches, Harbor `jobs/` output; also skipped when finding
  suites), and skip symlinks (sandboxes extract with Python
  `filter="data"`). Exec bits are kept (`tests/test.sh`); on Windows, which has
  none, `.sh` files are packed 0755 and the rest 0644 (Harbor's own rule,
  `needs_chmod`). Ownership and mtimes are fixed so local user names and times
  don't leak.
- **Agent CLI argv** (`LAUNCHABLE_AGENTS`), checked against each CLI's
  `--help` in 2026-10: `claude <p>`, `codex <p>`, `cursor-agent <p>`,
  `gemini -i <p>`, `opencode --prompt <p>`, `copilot -i <p>`. Always the
  interactive form: `-p` is headless for Claude/Gemini/Copilot, and the user
  must see and approve the edits. Cursor is detected as `cursor-agent`, not its
  generic `agent` alias. Detection is a PATH lookup (`findOnPath`), never
  `--version` (six probes would cost seconds). `launchAgent` ignores SIGINT
  while the child runs (Ctrl-C belongs to the agent) and on Windows flattens
  the prompt's newlines (cmd.exe ends the command line at one).
- Testing `eval setup` end to end without a Laminar account: point
  `XDG_CONFIG_HOME` at a dir with a `lmnr/credentials.json` whose
  `accessTokenExpiresAt` is far in the future (no refresh call), serve
  `GET /v1/cli/projects` and `POST /v1/cli/project` from a stub
  (`LMNR_BASE_URL=http://localhost LMNR_HTTP_PORT=<port>`), put a fake
  `claude` script first on PATH that records its argv, and drive the CLI in a
  PTY (Python `pty.fork`). Run under `env -i`: a sandbox running inside Claude
  Code has `CLAUDECODE` / `AI_AGENT` / `LMNR_PROJECT_API_KEY` set, which flips
  the flow to the agent-caller path and makes the key probe fail.
