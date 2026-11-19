# Harbor evals (`eval`)

- `lmnr-cli eval run [dataset] [--dir evals]` runs each dataset folder
  (`<dir>/<folder>/harbor.yaml`, a Harbor JobConfig; named by folder or by
  `[dataset] name`, formerly "suite") with **pinned** Harbor + the Laminar
  plugin through `uvx` (`harbor.ts`: `HARBOR_VERSION`, `LMNR_PYTHON_VERSION`),
  from inside the dataset dir so relative paths and custom agent imports
  resolve the same way everywhere. Harbor's stdout goes to OUR stderr; stdout
  is data only. Before running, `pullRunTasks` pulls pinned tasks (see "Eval
  datasets" below). The plugin gets `--pk group_name=<--group, else dataset
  name, else folder>` always (`--group` is one dataset's: with several
  selected it is an `InvalidArgumentError`; it travels to remote runs in
  `RunOverrides`), and `--pk dataset=<name> --pk
  task_hashes_file=<staging>/task-hashes.json` (`{<task dir>: {name, hash}}`
  of every named task under `tasks/`) only with a `tasks/dataset.toml`. Wire
  names keep "suite" (`hostedMetadata.suitePath`, `?suite=` on job uploads).
  - default: trials on local Docker; harbor.yaml `images` are `docker build`-ed first.
  - `--remote`: runs in Laminar sandboxes and prints the run's log until it
    ends. Hashes the run's tasks and asks `missingVersions`: tasks Laminar
    has are left out of the upload (`remoteExclude`: also other dataset
    folders, task dirs `--task` doesn't select, `.lmnr-state.json`; never
    `dataset.toml`) and listed in `RunSpec.downloads` (`{<folder>: {dataset,
    tasks: [{task, hash, dir}]}}`), which `eval orchestrate` downloads (run
    key, `/v1`) into `<folder>/tasks/<dir>` before running;
    `RunSpec.taskHashes` feeds the plugin. Without dataset storage (`storage_not_configured`) every task
    is uploaded. Packs the folder (`pack.ts`) and checks the 1 GiB
    cap BEFORE pushing images, then uploads it, `PUT
    /v1[/cli]/hosted-evals/uploads/{id}/index {files}` (a failure only
    warns: the index is just for Laminar's file view), and `POST
    /v1[/cli]/hosted-evals/runs {uploadId, cliVersion, spec}`. The server's
    orchestrator sandbox runs `npx lmnr-cli@<cliVersion> eval orchestrate`
    (hidden command), so `RunSpec` only has to stay readable by the SAME version.
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
    becomes `Laminar evaluation for dataset <dataset>: <url>` the first time (the
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
    Log tab (`jobUploads` in `remote.ts`, `jobs.ts`): `runDatasets` gets a
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
  resolution, the Harbor process env), `datasets.ts` (dataset discovery, name
  rules, `.gitignore`, `SKIPPED_DIRS`, the run's tasks (`findTaskTomls`),
  `buildJobConfig`), `harbor.ts` (uvx/Harbor only), `images.ts` (harbor.yaml
  `images`, what tasks start from, `ensureRemoteImages`), `client.ts` (login
  or project key client), `dataset-toml.ts`, `task-hash.ts`, `dataset-state.ts`,
  `dataset-sync.ts` (pure pull / push / run planning, download + extract,
  upload), `dataset-command.ts` (`eval dataset pull / push`, `pullRunTasks`),
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
- **Images:** tasks name an image with `docker_image`; `images: {name:
  {dockerfile, context}}` in the dataset's harbor.yaml declares how to build
  it (paths relative to the dataset dir). It is OUR key: `buildJobConfig`
  drops it from the config Harbor gets (Harbor's `JobConfig` ignores unknown
  keys anyway, so a bare `harbor run -c harbor.yaml` still works). A leftover
  `lmnr.yaml` (evals root or dataset) only warns. Local
  runs `docker build` the ones the run's tasks reference (`localImageDefs`)
  and let Harbor handle the rest; local builds are tagged by name, so two
  datasets of one run defining a name differently is `invalid_evals_dir`.
- **Which tasks a run includes** (`findTaskTomls`, used for images and
  `${VAR}`s) mirrors Harbor's `JobPlan.resolve_task_configs` on the job config
  after overrides: `tasks` entries with a local `path`, plus each local
  dataset's child dirs with a `task.toml`, matched by DIRECTORY name (Harbor's
  `LocalTaskId.get_name`, not `[task] name`) against `task_names` /
  `exclude_task_names` with fnmatch; a symlinked task dir is followed and
  named after its target, as Harbor resolves it (remote runs don't pack
  symlinks, so such a task only runs locally). `--task` replaces every dataset's
  `task_names` and filters `tasks` by name, so it narrows images too.
  `n_tasks` is ignored (Harbor counts only fully valid dirs, so applying it
  could skip a task that runs: over-pushing is the safe side). Task dirs no
  dataset or `tasks` entry points at are never built. Checked against Harbor
  0.25.0 on a fixture with excludes, a `../` task and `--task` globs.
- What a task starts from mirrors Harbor's
  `should_use_prebuilt_docker_image` (`findTaskImages`): its `docker_image`,
  unless the dataset's harbor.yaml sets `environment.force_build: true` and the
  task has `environment/Dockerfile`, which is otherwise used only without a
  `docker_image`.
- **Remote runs push every image the run's tasks use, from here**
  (`ensureRemoteImages`): per-task `environment/Dockerfile`s and the
  harbor.yaml images tasks reference are built (`pusher.build`; unreferenced
  ones are skipped), other `docker_image`s are pulled
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
  errors and its local tag (`ImageDef.name`: the harbor.yaml name, the pulled
  ref, or `<dataset>/<env dir key>`). One run builds an image once per
  Dockerfile + context and pulls a ref once. Docker is assumed for every
  mode: there is no fallback. Measured: an app change uploads one small
  layer; unchanged → nothing.
- **Image map shape** (digest strings only): `RemoteImages = {images:
  {dataset: {docker_image: digest}}, dockerfiles: {dataset: {envDirKey:
  digest}}}`, spread into `RunSpec`. Each dataset's Harbor gets
  `LMNR_EVAL_IMAGES = {images: <its>, dockerfiles: <its>}` (`datasetImages`;
  the env var's shape is unchanged). Dockerfile keys are the env dir relative
  to the dataset dir (Harbor's cwd), always with `/` (`dockerfileKey`: a
  remote run looks a Windows-built map up on Linux).
- **Remote limitations:** a per-task Dockerfile `FROM <harbor.yaml image>` does
  not work remotely and is not supported: remote pushes tag harbor.yaml images
  `lmnr-evals-remote:<hash>`, not by name, so the `FROM` resolves to a
  registry image or a stale local build. Tasks from git/registry datasets are
  fetched by Harbor, so their per-task Dockerfiles and `docker_image`s aren't
  pushed; local task paths outside the evals folder aren't packed either.
- **Every build lmnr-cli runs excludes `.git` and `.env*` without copying the
  context** (`guardedDockerfile` in `docker.ts`, local harbor.yaml image builds too;
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
  non-amd64 image, zstd layers), 21 `remote_run_failed` (a `--remote` run's
  orchestrator exited with anything but 0 or 18, or its sandbox was lost; 18
  from it stays `harbor_failed`), 22 `local_edits` (pull would overwrite or
  delete edited tasks; `--force`), 23 `pin_moved` (push refused). The eval
  dataset API's `storage_not_configured`, `version_not_found` and
  `dataset_not_found` exit 1 with their own `code`. Bad `--env` flags are
  commander `InvalidArgumentError`s.
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
  datasets), and skip symlinks (sandboxes extract with Python
  `filter="data"`). Every file is packed 0755 if it has any exec bit, else
  0644 (`fileMode`); on Windows, which has none, `.sh` files are 0755
  (Harbor's own rule, `needs_chmod`). Ownership and mtimes are fixed so local
  user names and times don't leak. Task version archives are packed from
  `collectTaskFiles` instead (Harbor's selection; see below).

## Eval datasets (`eval dataset pull / push`)

- **Harbor's own files.** `<folder>/tasks/dataset.toml` is Harbor's dataset
  manifest (`harbor.models.dataset.manifest`): `[dataset] name` is the
  dataset's name in Laminar, `[[tasks]] {name, digest = "sha256:<hex>"}` its
  pins (`dataset-toml.ts`; no `[[tasks]]` at all = no pins = pull takes the
  latest, `tasks = []` = nothing pinned; every other key is kept on rewrite,
  pins sorted bytewise). Each task is known by `[task] name` in its
  `task.toml`, NEVER by its dir. Both names are Harbor's `org/name`
  (`ORG_NAME_PATTERN`, no `..`, ≤ 255 bytes here; the org is free text).
  `tasks/` is git-ignored except the manifest (`<dir>/.gitignore` gets
  `*/tasks/*` + `!*/tasks/dataset.toml`); `tasks/.lmnr-state.json` =
  `{tasks: {<name>: <base>}}`, the base being the hash the task had when last
  pulled or pushed on THIS disk.
- **Scanning** (`scanTasks`): dirs under `tasks/` with a `task.toml`; dot dirs
  (our temp dirs) are skipped. pull and push fail (`assertNamedTasks`) on a
  `task.toml` without a valid `[task] name` and on a name two dirs share (a
  copied task); `eval run` doesn't. A symlinked task dir is unmanaged
  (`linkedNames`, with a warning): pull, push and run's pre-pull never hash,
  replace or unpin it (Harbor still follows it). A pulled task that has no
  dir yet goes into `tasks/<name after the org>`; if anything has that name
  (another dir, or a file: `acme/dataset.toml` is a valid name), pull fails
  (`placePull`) and run's pre-pull skips it with a warning.
- **Hash** (`task-hash.ts`) = Harbor's `Packager.compute_content_hash`
  (0.25.0), so `harbor sync` agrees: only `task.toml`, `instruction.md`,
  `README.md`, `trajectory.json` and `environment/`, `tests/`, `solution/`,
  `steps/` count, minus `.harborignore` rules (scoped to `tests/`,
  `solution/`, `steps/*/{tests,solution}`, applied per directory, last match
  wins, any `.harborignore` file itself excluded) and the task's `.gitignore`
  (else Harbor's `DEFAULT_IGNORES`); sha256 hex of `"<path>\0<sha256 hex>\n"`
  per file, by path (UTF-8 byte order = Python's code point order). Modes
  don't count. Links to files are followed, links to dirs aren't walked, a
  link leaving the task is an error. `task-hash.test.ts` holds trees whose
  hashes Harbor itself computed; recompute them with
  `uvx --from harbor==<HARBOR_VERSION> python` + `Packager` when bumping
  Harbor. Matching uses the `ignore` package (`ignorecase: false`, as
  `pathspec`); known gap: `pathspec` lets `!x` re-include a file inside an
  ignored dir, `ignore` (like git) doesn't.
- **What a version archive holds:** the hashed files PLUS the ignore files
  that selected them (`.gitignore`, in-scope `.harborignore`s), which Harbor
  itself doesn't package: without them a pulled copy would fall back to the
  default ignores and hash differently. Files outside Harbor's set (e.g.
  `notes.md` at the task root) are neither hashed nor stored. Push refuses
  tasks whose hashed files include `.env*` (Harbor would hash them; a task
  `.gitignore` can leave them out).
- Per task: pin = dataset.toml, base = state, local = hash of its dir,
  edited = local exists and ≠ base (no base counts as edited), latest =
  Laminar's (`GET` dataset).
- **pull** (`planPull`): target = pin (or latest with `--latest` / no pins;
  selected tasks' pins are then replaced, others kept). No local dir →
  added, local ≠ target → changed, in state + pin gone + dir exists →
  removed. Changing or removing an edited task without `--force` → 22,
  checked for every dataset before anything is written; `missingVersions`
  then turns unknown pins into `version_not_found`. Downloads go to
  `tasks/.lmnr-pull-*` (`modern-tar` refuses escaping paths; only files and
  dirs are extracted, modes normalized), are re-hashed against the target
  and renamed into place. State is written even after a partial failure,
  for the tasks that were written. A dataset Laminar lacks, with nothing
  pinned, is skipped. Datasets are named by folder or `[dataset] name`; a
  folder without dataset.toml is skipped with a warning (named: an error
  showing the file to create).
- **push** (`planPush`): pin moved → 23, no override, when (a) base set and
  latest ≠ base, (b) base and pin set and pin ≠ base, (c) no base and latest
  ≠ local. Else local = latest = pin → unchanged; otherwise added / changed,
  sent as `{task, hash, base: latest ?? null}` (in every accepted case the
  disk's base equals latest, and with `base` null the server would call any
  older version a move). Tasks in state AND pinned that are no longer on
  disk (dir deleted, or `[task] name` changed) lose their pin;
  pinned-but-never-pulled tasks are untouched. Apply: `missingVersions` →
  `packTaskDir` (re-checks the hash) → `uploadVersion` + `uploadVersionIndex`
  → `push`; a 409 `moved` is 23 too. `--dry-run` runs the GET, the checks and
  `missingVersions`.
- **`--task`:** for `eval dataset` it globs the task name, with or without
  its org (`taskFilter`); for `eval run` (and its pre-pull, and the remote
  upload) it is Harbor's, matching task DIR names (`dirFilter`).
- **run** (`planRunPull`): pulls selected pinned tasks that are missing or
  unedited with pin ≠ local; edited ones warn and run as they are. If Laminar
  can't be reached (or no login/key) and every such task is on disk, it warns
  and goes on.
- Client: `client.evalDatasets` (`@lmnr-ai/client`) sends each `org/name` as
  two path segments; errors are `LaminarApiError` with the server's `code`;
  the CLI checks `code` by the error's `name` (`apiErrorCode`), since tests
  mock the client module.
