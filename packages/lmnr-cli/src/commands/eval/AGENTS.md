# Harbor evals (`eval`)

- `lmnr-cli eval run [dataset]` runs one / every **eval dataset** (a folder
  `<--dir, default evals>/<dataset>/` with `harbor.yaml`, a Harbor JobConfig,
  and its tasks in `tasks/`; "suites" are gone, no backward compat) with
  **pinned** Harbor + the Laminar plugin through `uvx` (`harbor.ts`:
  `HARBOR_VERSION`, `LMNR_PYTHON_VERSION` = the lmnr release whose plugin reads
  `dataset` / `task_hashes`), from inside the dataset dir so relative paths and
  custom agent imports resolve the same way everywhere. Harbor's stdout goes
  to OUR stderr; stdout is data only.
  - **harbor.yaml must not set `datasets` or `tasks`** (`loadDatasetConfig`
    throws `invalid_evals_dir`); it injects `datasets: [{path: tasks}]`, and
    `--task` becomes that dataset's `task_names`.
  - Before running, `prepareRunDatasets` (`dataset-sync.ts`) syncs each
    dataset with its `tasks.toml` and hashes the run's tasks (see "Eval
    datasets" below). The plugin gets `--pk group_name=<folder>` (the
    evaluation group is the dataset name) and, when the folder is a valid
    dataset name (the server 400s `datasetV2Id` otherwise), `--pk
    dataset=<folder> --pk task_hashes=<staging>/task_hashes.json` (`{task:
    hash}` of the run's tasks, written next to the staged job config).
  - default: trials on local Docker; each dataset's `lmnr.yaml` images are
    `docker build`-ed right before that dataset runs (`runDatasets`' `before`
    hook): datasets may define the same image name differently, and local
    tags are global.
  - `--remote`: runs in Laminar sandboxes and prints the run's log until it
    ends. Packs the folder (`pack.ts`) and checks the 1 GiB
    cap BEFORE pushing images, then uploads it, `PUT
    /v1[/cli]/hosted-evals/uploads/{id}/index {files}` (a failure only
    warns: the index is just for Laminar's file view), and `POST
    /v1[/cli]/hosted-evals/runs {uploadId, cliVersion, spec}`. The server's
    orchestrator sandbox runs `npx lmnr-cli@<cliVersion> eval orchestrate`
    (hidden command), so `RunSpec` only has to stay readable by the SAME version.
    `RunSpec.datasets` is `[{path, taskHashes, tasks?}]`. `withStoredTasks`
    asks `POST .../tasks/missing` for the run's tasks; the ones Laminar has go
    into `tasks` and are left out of the upload (`packEvalsDir`'s `exclude`,
    `<dataset>/tasks/<task>`); unpushed / edited tasks are packed as before. A
    failing check only warns and packs everything. `eval orchestrate` downloads
    `tasks` (`fetchTasks`: run key, `/v1`, same cache / verify / install as
    pull) into `<dataset>/tasks/` before Harbor runs; it never syncs otherwise.
  - **The run's log** (`run-log.ts`; lmnr `docs/internal/hosted-evals.md`,
    "Run log"): `eval orchestrate` ships every line it prints
    (`createRunLogShipper`): logger records via `onStderr`
    (`utils/command-capture.ts`; warnings / errors get a `WARN: ` / `ERROR: `
    label there) and Harbor's output via `runDatasets`' `output` sinks, which
    make `runCommand` pipe instead of inherit (Rich doesn't animate when piped
    anyway). Each source (logger, Harbor stdout, Harbor stderr) has its own
    `writer()`, so one's unfinished line can't swallow another's; `runCommand`
    calls a sink's `end` when its stream ends, so a dataset's last line without
    a newline goes out before the next dataset or the error. Harbor runs with
    `COLUMNS=500` (Rich wraps at 80 off a terminal) and its lines go through
    `harborLogLine` (`run-log-lines.ts`): the job summary's sandbox paths are
    dropped, and the Laminar plugin's `Laminar evaluation: <url>` log line
    becomes `Laminar evaluation for dataset <folder>: <url>` the first time (the
    plugin repeats it at job end). `eval run --remote` highlights those lines
    and prints them all again when the run ends (`evaluations` in `--json`).
    Lines are
    numbered from 0, ANSI-stripped, cut at 16 Ki chars, and
    sent with `appendRunLogs` about once a second, one batch in flight, so the
    server stores them in order. A failing batch is retried (dropped after 5
    tries, with a marker line); a 404 turns shipping off. The first stored
    batch creates `$LMNR_RUN_LOG_MARKER`, which tells the sandbox's shell
    not to send its own output tail. A thrown error is written to the log
    before the rethrow: `runWithEnvelope` `process.exit`s right after logging
    it, so a flush there would never run. `followRunLog` (`eval run --remote`)
    polls `getRunLogs` every 2 s, checks `getSandbox` every 30 s, and returns
    `exited` / `lost` / `unsupported`; `assertRemotePassed` maps those to exit
    codes. Ctrl-C stops following (exit 130); the run goes on.
  - **`eval orchestrate` uploads each dataset's Harbor job** for Laminar's trial
    Log tab (`jobUploads` in `remote.ts`, `jobs.ts`; the server's query
    parameter is still `?suite=<dataset folder>`): `runDatasets` gets a
    `JobOutput` that forces `jobs_dir` to `<tmp>/<dataset>` (never `job_name`:
    the plugin names the evaluation after it, a timestamp by default), and
    after each `harbor run` exits (passed or not) the one job dir in there
    (`findJobDir`) has its trial dirs packed with
    `packFiles` and sent with `uploadJob` + `uploadJobIndex` (`LMNR_EVAL_UPLOAD_ID`,
    run key). Job-level files, `<trial>/artifacts` and `steps/*/artifacts` are
    left out; files over 50 MiB and anything past 256 MiB are skipped. A
    failure only warns. The sandbox (and the job) is deleted after the run, so
    this is the only copy.
  - **No extra secret pass:** Harbor scrubs each trial dir before `harbor run`
    exits, but only values from the agent's / verifier's env (not the task's
    `[environment] env`, resolved inside each environment backend). Uploads
    carry that gap as is; fixing it upstream is LAM-2534.
- Modules: `index.ts` (`eval run` flow, reporting), `remote.ts` (`RunSpec`,
  `startRemoteRun`, `eval orchestrate`), `run-log.ts` (the run's log: shipper
  and follower), `run-log-lines.ts` (what the log shows of Harbor's output),
  `jobs.ts` (packing a finished Harbor
  job), `env.ts` (`--env`, `${VAR}`
  resolution, the Harbor process env), `datasets.ts` (dataset discovery,
  `SKIPPED_DIRS`, `loadDatasetConfig`, the run's tasks (`findTaskTomls`),
  `buildJobConfig`), `harbor.ts` (uvx/Harbor only), `client.ts` (the API
  client for push / pull / `--remote`), `tasks.ts` (task listing, hashing,
  packing), `tasks-toml.ts` (`tasks.toml`, `.lmnr-state.json`,
  `<evals>/.gitignore`), `sync.ts` (pure per-task plans: `planPull`,
  `planPush`), `task-cache.ts` (download cache, safe extraction, installing),
  `dataset-sync.ts` (`eval dataset push` / `pull`, `prepareRunDatasets`,
  `fetchTasks`), `images.ts` (`lmnr.yaml`, what tasks start from, `ensureRemoteImages`),
  `docker.ts` (builds, the ignore guard, `imagePusher`), `push.ts` (`docker
  save` output → layer upload), `run-command.ts` (spawn; a missing binary is
  `missing_tool`). Import graph is acyclic: `docker.ts` imports only types from
  `images.ts`. `ensureRemoteImages` takes an `ImagePusher` so its selection
  logic is tested without Docker; tests mock `run-command.ts` for the rest.
- **Remote trials use `assets/lmnr_hosted_env.py`**, a Harbor `BaseEnvironment`
  subclass copied next to the staged job config and loaded via
  `environment.import_path` (`buildJobConfig(config, overrides, remote)` swaps
  the dataset's environment type/kwargs for it). It calls
  `/v1/hosted-evals/sandboxes/*` with `LMNR_PROJECT_API_KEY`; the app-server
  proxies to Daytona (lmnr `docs/internal/hosted-evals.md`). Sandbox `state` is
  `pending | started | error | destroyed`; snapshot state is `ready | pending
  | failed` (+`errorReason`), and only a failed snapshot raises Harbor's
  `SandboxBuildFailedError`. It logs a few INFO lines per trial, prefixed
  with the trial name (`session_id` up to `__`): image preparing / ready,
  sandbox started, 429 retries. Harbor's console handler shows INFO, so they
  reach the run's log. Requests retry transport errors, 429s and 5xx,
  except the two with side effects (`POST /sandboxes`, `POST .../commands`,
  `once=True`): those retry only when the request was never sent or got a 429,
  so a timeout can't create a second sandbox or run a command twice. The
  server keeps the first 10 MiB of each command's stdout / stderr and flags a
  cut (`stdoutTruncated` / `stderrTruncated`); `exec` logs a warning then. It
  subclasses Harbor internals, so bump `HARBOR_VERSION` only together with a
  remote run against the new version.
  `assets/` ships in the npm package (`files`); `environmentModulePath` finds it
  next to `dist/` or in the source tree.
- **Images:** tasks name an image with `docker_image`; `<dataset>/lmnr.yaml`
  `images: {name: {dockerfile, context}}` declares how to build it (paths
  relative to the dataset dir). A root `<dir>/lmnr.yaml` is an error telling
  the user to move it (`discoverDatasets`). Local runs `docker build` the
  ones the dataset's tasks reference (`localImageDefs`) and let Harbor handle
  the rest.
- **Which tasks a run includes** (`findTaskTomls`, used for images and
  `${VAR}`s) mirrors Harbor resolving the injected `tasks/` dataset: child
  dirs with a `task.toml`, matched by DIRECTORY name (Harbor's
  `LocalTaskId.get_name`, not `[task] name`) against `--task` globs with
  fnmatch; a symlinked task dir is followed and named after its target, as
  Harbor resolves it (remote runs, hashing and push skip symlinks, so such a
  task only runs locally and is never versioned).
- What a task starts from mirrors Harbor's
  `should_use_prebuilt_docker_image` (`findTaskImages`): its `docker_image`,
  unless the dataset's harbor.yaml sets `environment.force_build: true` and the
  task has `environment/Dockerfile`, which is otherwise used only without a
  `docker_image`.
- **Remote runs push every image the run's tasks use, from here**
  (`ensureRemoteImages`): per-task `environment/Dockerfile`s and the
  `lmnr.yaml` images tasks reference are built (`pusher.build`; unreferenced
  `lmnr.yaml` images are skipped; one Dockerfile + context or one pulled ref
  shared by several datasets is pushed once), other `docker_image`s are pulled
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
  ref, or `<dataset>/<env dir key>`). Docker is assumed for every mode: there is
  no fallback. Measured: an app change uploads one small layer; unchanged →
  nothing.
- **Image map shape** (digest strings only): `RemoteImages = {<dataset>:
  {images: {docker_image: digest}, dockerfiles: {envDirKey: digest}}}`
  (per dataset: each has its own `lmnr.yaml`), `RunSpec.images`. Each
  dataset's Harbor gets its entry as `LMNR_EVAL_IMAGES`. Dockerfile keys are
  the env dir relative to the dataset dir (Harbor's cwd), always with `/`
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
- **Eval datasets** (`eval dataset push` / `pull`; lmnr `docs/internal/` has
  the server side): a dataset = a folder, named after it, with NO version.
  Each task is versioned on its own by its content hash; Laminar keeps every
  pushed version and the latest is the one most recently pushed (a push of an
  older hash makes it latest again). `<dataset>/tasks.toml` (committed) pins
  one hash per task: `[tasks]` only, keys sorted by UTF-8 bytes, quoted unless
  `[A-Za-z0-9_-]+` (a `.` would make a dotted key). Written by hand
  (`formatTasksToml`), parsed with `smol-toml` so hand edits / merges with
  comments or either quote style read fine; anything but `[tasks]` with valid
  names + hashes is `invalid_evals_dir`. `<evals>/.gitignore` gets `*/tasks/`.
  Client: `client.evalDatasets` (`/v1[/cli]/eval-datasets/{dataset}/tasks...`),
  auth via `buildEvalClient` (login, else `LMNR_PROJECT_API_KEY`), built
  lazily so runs of unpushed datasets need no login.
  - **Names / hash** (validated before any call; the server checks again):
    dataset and task `^[A-Za-z0-9][A-Za-z0-9._-]*$`, ≤ 100 / 255 bytes; hash
    = bare 64 lowercase hex (no `sha256:` prefix anywhere: toml, state, cache
    dir names, archive check). They become path segments (S3 keys, cache
    dirs, `tasks/<task>`), so `ensureCachedTask` rejects a non-hash and
    `fetchTasks` asserts names even for server-supplied ones.
  - **Task hash** (`tasks.ts`, server stores it opaque): sha256 hex of
    `<mode> <content sha256> <path>\n` per file, paths sorted by UTF-8
    bytes (NOT JS string order: they differ above U+FFFF). Files are what
    packing takes (`walkTaskFiles`: `SKIPPED_DIRS`, `isExcludedFile` = `.env*`,
    `.DS_Store`, `.lmnr-state.json`; symlinks skipped); mode is 755 if any
    exec bit (Windows: `.sh`), else 644 (`normalizedMode`). Task archives are
    packed with those normalized modes, so the archive behind a hash doesn't
    depend on whose umask uploaded it. A task = a non-hidden, non-symlink
    dir directly in `tasks/`.
  - **Sync state** `<dataset>/tasks/.lmnr-state.json` `{tasks, localHashes?}`
    = each task's hash as last pulled / pushed on THIS disk, plus
    `localHashes`: what such a task hashes to here where that differs
    (Windows takes modes from extensions, so a task with a non-`.sh`
    executable or a non-executable `.sh` never re-hashes to its pinned hash
    there). `readDataset` maps a task still on its `localHashes` entry to the
    synced hash (`canonicalHashes`): `hashes` is what every machine computes,
    `diskHashes` this disk's; push packs from disk, so it refuses to upload a
    mapped task. A task has **local edits** when `hashes[t] !== state[t]`
    (no entry counts). Unreadable state = empty = everything edited.
  - **Plans are per task and pure** (`sync.ts`). Pull: target = `tasks.toml`
    ∩ `--task` (with `--latest`, or no `tasks.toml`: server latest ∩ `--task`
    merged INTO the toml, unknown pins stay); added / changed / removed, where
    removed = on disk AND in state AND not in target (a never-synced local
    task stays). Edited ∧ (changed ∨ removed) ⇒ `local_changes` unless
    `--force`. Push: added (not in toml) / changed / removed = in toml, not on
    disk, AND in state (a pin never pulled here, e.g. after `pull --task`,
    must not be dropped: deviation from the contract's plain "not on disk");
    unedited ∧ toml ≠ state (incl. pin dropped) ⇒ `tasks_behind_lock` (the
    toml moved via git; pushing would undo it). Edited ∧ synced ∧ toml ≠
    state ∧ toml ≠ disk (`diverged`: the edit started from an older version)
    ⇒ `tasks_behind_lock` too; there is no push override, the message says
    to pull `--force` that task and re-apply the edit. `--task` scopes every
    list.
  - Every dataset is planned and checked before any is touched; `--dry-run`
    runs the same checks (so it exits 22/23 too), then prints the plan
    (stdout; `--json` `{datasets: [...]}`) and writes / downloads nothing
    (`--latest` still calls `GET .../tasks`). No-arg pull skips (warns)
    folders with no `tasks.toml` that Laminar doesn't have or whose name is
    invalid; a named one is created (`<evals>/<name>/`) or fails 24.
  - **Pull** downloads `GET .../tasks/{task}/versions/{hash}` into
    `$LMNR_CACHE_DIR` / `$XDG_CACHE_HOME/lmnr` / `~/.cache/lmnr`
    `eval-tasks/<hash>/` (keyed by hash only: content-addressed and
    verified, so shared across datasets): streamed gunzip →
    `createTarDecoder` (strict) → only `file` / `directory` entries with safe
    relative paths (`safeEntryPath`), files opened `wx` (never through an
    existing link), chmod 755/644; the archive must hash to its name
    (`extractTaskArchive` hashes entries with their HEADER modes as it writes
    them, never by re-reading the tree: Windows can't read exec bits back) or
    it's dropped; staged in `.tmp-*` and renamed in. Installing copies into a
    hidden `tasks/.<name>.lmnr-tmp-*` then renames; unchanged tasks stay.
  - **Push**: `missingTasks` `{task: hash}` (≤ 10 000 per call) → per missing
    task re-walk + re-hash (a mid-push edit fails instead of uploading under
    the wrong hash) → `uploadTask` + `uploadTaskIndex` (4 at a time; the
    index PUT creates the version row) → `pushTasks` (added + changed; a 409
    `missing` is uploaded and retried once) → `tasks.toml` + state. Removed
    tasks only leave `tasks.toml`; Laminar keeps them.
  - **Run** (`prepareRunDatasets`): no `tasks.toml` → run `tasks/` as is
    (must exist). Else the pull plan with conflicts SKIPPED and warned (edited
    tasks run as they are), everything else applied (`applyPull`), then
    `taskHashes` = the run's tasks' `hashes` (`--task`-scoped).
  - Commands: `eval dataset` is a group under `eval`, so `eval`'s options
    (`--json`, `--project-id`, ...) parse anywhere in the line (commander
    without `enablePositionalOptions`). Never give a subcommand a `--version`
    option: the root `-v, --version` would swallow it.
- **Exit codes** (`errors.ts`): 16 `invalid_evals_dir` / `archive_too_large`,
  17 `missing_tool`, 18 `harbor_failed` (Harbor runs only), 19 `missing_env`
  (also a missing or malformed `LMNR_EVAL_RUN` in `eval orchestrate`), 20
  `docker_failed` (build / pull / save, unreadable `docker save` output, a
  non-amd64 image, zstd layers), 21 `remote_run_failed` (a `--remote` run's
  orchestrator exited with anything but 0 or 18, or its sandbox was lost; 18
  from it stays `harbor_failed`), 22 `local_changes` (`eval dataset pull`
  would overwrite / delete edited tasks), 23 `tasks_behind_lock` (`eval
  dataset push` of unedited tasks older than `tasks.toml` pins), 24
  `dataset_not_found` (a 404 from the dataset routes, except the "needs S3
  storage" 404, which stays a plain error). Bad `--env` flags are commander
  `InvalidArgumentError`s. `--json` errors carry the code:
  `{"error": <message>, "code": <code>}` (`outputJsonError`).
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
- **The archive is a run of gzip members** (`packFiles`), so the UI can read
  one file without the whole archive: consecutive files of one directory share
  a member until it holds 1 MiB (a big file stays whole in one member), and
  the tar end blocks are a member of their own. `tar -xzf`, Python `tarfile`
  and `gunzipSync` read it as one `.tar.gz`. Each entry is packed alone
  (`packTar([file])` minus its 1024-byte end blocks), so its header size is
  `entry.length - padded(size)`; the index entry `{path, size, offset, length,
  dataOffset}` gives the member's range and the content's start in the
  decompressed member (`size` comes from `stat` in the walk). Grouping by
  directory measured within ~6% of one gzip stream; one member per file was
  up to +34% on folders of tiny files. The lmnr frontend reads it
  (`lib/actions/evaluation/files.ts`; lmnr `docs/internal/hosted-evals.md`).
- Uploads never contain `.env*`, `SKIPPED_DIRS` (`.git`, `node_modules`,
  virtualenvs, caches, Harbor `jobs/` output; also skipped when finding
  datasets), `.lmnr-state.json` (`isExcludedFile`), and skip symlinks (sandboxes extract with Python
  `filter="data"`). Exec bits are kept (`tests/test.sh`); on Windows, which has
  none, `.sh` files are packed 0755 and the rest 0644 (Harbor's own rule,
  `needs_chmod`). Ownership and mtimes are fixed so local user names and times
  don't leak.
