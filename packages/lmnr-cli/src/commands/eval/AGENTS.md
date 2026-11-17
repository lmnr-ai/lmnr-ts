# Harbor evals and task sets (`eval`)

- **Layout** (`layout.ts`, LAM-2543 v4): the evals folder (`--dir`, default
  `evals`) holds one folder per **task set**: `evals/<set>/eval.yaml` =
  `{images: {name: {dockerfile, context}}, job: <Harbor JobConfig minus
  datasets/tasks>, version: N}` (paths relative to the set's folder; `version`
  = the **pin**, `EvalConfig.version`, edited by hand only: the CLI never
  writes it), the set's scripts beside it (adapter, Dockerfiles, seed
  loaders, in git), and `tasks/` = the working copy of its tasks from Laminar
  (a task = a direct child dir with `task.toml`; gitignored). A child of
  `evals/` without eval.yaml holds files sets share (`evals/common/`). The
  folder name is the task set's name, matching
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$` (`assertName`): it goes into API paths.
  There are no agents (locally or in Laminar), suites, `agent.yaml`,
  `harbor.yaml` or `lmnr.yaml` (clean break).
- **Laminar stores and versions only the tasks.** Task sets are keyed by
  name, unique per project (`listTaskSets`, `listTaskSetVersions(set)`,
  `createTaskSetVersion(set, {hash, base, tasks})`); every version is a push
  with a number (no run snapshots). Files travel as content-addressed blobs
  (`ensureBlob`: `treeDigest` of the files `pack.ts` packs → `getBlobIndex` →
  `putBlob` + `putBlobIndex` only if missing; the index goes last, its
  presence marks the blob complete). The **scripts** of a run are ONE blob:
  the whole evals folder minus every `<set>/tasks/` (`scriptsOf` /
  `scriptsExclude` in `store.ts`), so sets can share files by relative path
  locally and remotely. A run uploads it and the run's local task copies and
  names them in each evaluation's metadata (below);
  `getLatestScripts(set)` reads back the scripts the project's latest
  evaluation of that set used. Contract with the server: lmnr
  `docs/internal/hosted-evals.md`.
- **Hashes** (`digest.ts`): sha256 over `${posix path}\0${sha256(content)}\n`
  per file, sorted by path in JS string order (NOT the per-directory walk
  order: `a-b/x` sorts before `a/x`). Modes don't count. Task digest = its dir;
  task set hash = the `tasks/` dir minus `.lmnr.json` (`TASK_SET_FILES`);
  scripts hash = the evals folder minus the sets' `tasks/`. The server stores
  them unverified.
- **`eval run [sets...]`** (`index.ts`, `prepare.ts` `prepareRun`): each arg
  is `<set>`, `<set>@<N>` or `<set>@latest`; none → every set folder.
  - scripts: every set run needs its `evals/<set>/eval.yaml` (else
    `not_found` naming `eval pull <set>`; no fallback to Laminar's copy). The
    scripts blob is uploaded once per run, with `git rev-parse HEAD` as
    `gitSha`. Image names are shared by the run's sets: one name defined
    differently by two eval.yaml files fails with `invalid_evals_dir`
    (`assertImagesAgree`).
  - tasks, first match wins (`prepareTasks`): `@N` / `@latest` → the local
    `tasks/` copy (as is, uploaded as a blob, never a version; warns when its
    number differs from the pin, or, unpinned, when it is behind head; logs
    `<set>: running your local copy; it is not a pushed version, so the
    evaluation won't link to one (...)` when its hash matches no pushed
    version) → the pin → Laminar's head with a warning (`<set> isn't pinned:
    running the latest version, vN. Set \`version: N\` ...`). Nothing
    anywhere → `not_found`. CI (no copies, `tasks/` is gitignored) runs
    exactly the pins. A run never creates a version.
  - Both modes need the API (blob uploads), so local runs use
    `buildEvalClient` (login, else `LMNR_PROJECT_API_KEY`) too.
- **Harbor runs once per task set** (`harbor.ts` `runTaskSets`), cwd = the
  set's folder, with `PYTHONPATH` = staging, the set's folder, the evals
  folder (so a custom agent is `adapter:X` or a shared `common.adapter:X`),
  job config = `buildJobConfig(eval.yaml job, tasksDir, overrides, remote)`:
  the tasks dir (absolute) as the only dataset, `--task` as its
  `task_names`. One Harbor run = one evaluation, grouped by the set's name
  (`--pk group_name=` and `HARBOR_LAMINAR_GROUP`). `linkEnv` sets
  `LMNR_EVAL_HOSTED_METADATA` = `{taskSet, taskSetHash, scriptsHash, gitSha?,
  runId?}` (JSON; the
  Laminar Harbor plugin, lmnr-python, sends it as the evaluation's
  `hostedMetadata` as is, and the server links the pushed version whose hash
  matches) and `LMNR_EVAL_TASK_SET_ROOT` = the tasks dir (the plugin records
  each datapoint's `task_path` relative to it). Harbor's stdout goes to OUR stderr; stdout is data
  only.
  - default: trials on local Docker; the eval.yaml images the tasks use are
    `docker build`-ed first.
  - `--remote` (`remote.ts`): ONE run per command for all its sets (they
    share the scripts blob): push the images (`runImageDefs`),
    `startRun({cliVersion, spec})` → `{runId, sandboxId}`, then follow its
    log. `RunSpec = {scripts: {hash}, gitSha?, taskSets: [{name, hash}],
    overrides, env, images}`, read only by the same CLI version. The
    orchestrator sandbox runs `npx lmnr-cli@<cliVersion> eval orchestrate`,
    which downloads the scripts into `$LMNR_EVALS_ROOT/` and each set's tasks
    into `$LMNR_EVALS_ROOT/<set>/tasks/` (`materialize`) and runs them like a
    local run, with the run key.
  - **The run's log** (`run-log.ts`; lmnr `docs/internal/hosted-evals.md`,
    "Run log"): `eval orchestrate` ships every line it prints
    (`createRunLogShipper`): logger records via `onStderr`
    (`utils/command-capture.ts`; warnings / errors get a `WARN: ` / `ERROR: `
    label there) and Harbor's output via `runSuites`' `output` sinks, which
    make `runCommand` pipe instead of inherit (Rich doesn't animate when piped
    anyway). Each source (logger, Harbor stdout, Harbor stderr) has its own
    `writer()`, so one's unfinished line can't swallow another's; `runCommand`
    calls a sink's `end` when its stream ends, so a task set's last line without
    a newline goes out before the next task set or the error. Harbor runs with
    `COLUMNS=500` (Rich wraps at 80 off a terminal) and its lines go through
    `harborLogLine` (`run-log-lines.ts`): the job summary's sandbox paths are
    dropped, and the Laminar plugin's `Laminar evaluation: <url>` log line
    becomes `Laminar evaluation for task set <set>: <url>` the first time (the
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
  - **`eval orchestrate` uploads each task set's Harbor job** for Laminar's
    trial Log tab (`jobUploads` in `remote.ts`, `jobs.ts`): `runTaskSets` gets
    a `JobOutput` that forces `jobs_dir` to `<tmp>/<set>` (never `job_name`:
    the plugin names the evaluation after it, a timestamp by default), and
    after each `harbor run` exits (passed or not) the one job dir in there
    (`findJobDir`) has its trial dirs packed with `packFiles` and sent with
    `uploadJob(runId, set)` + `uploadJobIndex` (run key). Job-level files,
    `<trial>/artifacts` and `steps/*/artifacts` are left out; files over 50 MiB
    and anything past 256 MiB are skipped. A failure only warns. The sandbox
    (and the job) is deleted after the run, so this is the only copy.
  - **No extra secret pass:** Harbor scrubs each trial dir before `harbor run`
    exits, but only values from the agent's / verifier's env (not the task's
    `[environment] env`, resolved inside each environment backend). Uploads
    carry that gap as is; fixing it upstream is LAM-2534.
- **`eval pull <set>[@n]...` / `eval push [sets...]`** (`sync.ts`,
  `merge.ts`): `.lmnr.json` in `<set>/tasks/` = `{versionId, number, hash,
  tasks: {name: digest}, files: {name: digest}}`, the version the copy is
  based on; `files` are the top-level entries beside the tasks (READMEs,
  shared data; `otherEntryDigests`).
  - pull: when `<set>/eval.yaml` is missing, it first fetches the scripts the
    set's last run used (`getLatestScripts(set)` → `pullScripts`: the
    blob's `<set>/` plus its shared entries, i.e. top-level entries that
    aren't other set folders, copied over the evals folder; extra local files
    stay; a local file with different content, or a symlink on a script's
    path, fails it with `merge_conflict` unless `--force`, which replaces the
    link itself; a local entry of the wrong kind on the path, a folder where a
    script file goes or a file where a folder is needed, is `merge_conflict`
    even with `--force`, which never deletes a local folder); none recorded → the tasks still come, with a warning. Then
    it downloads the version (head by default) to a temp dir and merges task
    by task (`planMerge(base, local, remote)`): changed only remotely →
    taken, only locally → kept, both (differently) → `merge_conflict` (22)
    before anything is written. Entries beside the tasks merge the same way
    (`files` in the base). `.lmnr.json` then = the pulled version. Every pull
    and push makes sure `<set>/.gitignore` lists `tasks/` (`ignoreTasks`,
    appended once; a committed copy would beat the pin in CI).
  - push (and run, for local copies) rejects tasks with
    `environment/Dockerfile` or `docker-compose.yaml` and tasks without
    `[environment] docker_image` (`assertTaskImages`: tasks name an eval.yaml
    or registry image, which is all remote trials can start from; per-task
    data goes in `environment/`, which Harbor copies into a prebuilt-image
    sandbox), sends `base`, and on `{headMoved}` (409) pulls the head in and
    retries once. Bare `push` pushes every set folder with a `tasks/` copy
    (never scripts). After each push it logs the pin to set: "<set>'s
    eval.yaml pins vX; set version: Y ..." or "Pin it: set version: Y in
    <dir>/<set>/eval.yaml ...". It reads eval.yaml only for those hints:
    an invalid one warns and skips them rather than blocking the push.
  - `eval list` prints the project's task sets and their heads.
- Modules: `index.ts` (`eval run`, reporting), `prepare.ts` (what a run uses),
  `layout.ts` (folder layout, eval.yaml, task dirs, job config, `${VAR}`s,
  `.lmnr.json`), `store.ts` (blobs, versions, downloads), `digest.ts`,
  `merge.ts`, `sync.ts` (`pull` / `push` / `list`), `remote.ts` (`RunSpec`,
  `PreparedRun`, `startRemoteRun`, `eval orchestrate`), `client.ts` (API client, project
  URLs), `run-log.ts`, `run-log-lines.ts`, `jobs.ts`, `env.ts` (`--env`,
  `${VAR}` resolution, the Harbor process env), `harbor.ts` (uvx/Harbor only),
  `images.ts` (which images the tasks use, `ensureRemoteImages`), `docker.ts`
  (builds, the ignore guard, `imagePusher`), `push.ts` (`docker save` output →
  layer upload), `run-command.ts` (spawn; a missing binary is `missing_tool`).
  `ensureRemoteImages` takes an `ImagePusher` so its selection logic is tested
  without Docker; tests mock `run-command.ts` and the client for the rest
  (`sync.test.ts` runs push/pull against an in-memory server).
- **Remote trials use `assets/lmnr_hosted_env.py`**, a Harbor `BaseEnvironment`
  subclass copied next to the staged job config and loaded via
  `environment.import_path` (`buildJobConfig(job, setDir, overrides, remote)` swaps
  the job's environment type/kwargs for it). It calls
  `/v1/hosted-evals/sandboxes/*` with `LMNR_PROJECT_API_KEY`; the app-server
  proxies to Daytona (lmnr `docs/internal/hosted-evals.md`). Every task names an image (`docker_image`); the class looks its digest up in
  `LMNR_EVAL_IMAGES = {images: {docker_image: digest}}`. Sandbox `state` is
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
- **Images:** tasks name an image with `docker_image` in task.toml;
  eval.yaml `images` declares how to build it. Local runs `docker build` the
  ones the run's tasks reference (`localImageDefs`) and let Harbor pull the
  rest. `--task` narrows which images are built or pushed.
- **Remote runs push every image the run's tasks use, from here**
  (`ensureRemoteImages`): the eval.yaml images tasks reference are built
  (`pusher.build`; unreferenced ones are skipped), other `docker_image`s are pulled
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
  errors and its local tag (`ImageDef.name`: the eval.yaml name or the pulled ref). Docker is assumed for every mode: there is
  no fallback. Measured: an app change uploads one small layer; unchanged →
  nothing.
- **Every build lmnr-cli runs excludes `.git` and `.env*` without copying the
  context** (`guardedDockerfile` in `docker.ts`, local eval.yaml builds too): the Dockerfile is
  copied to a temp dir next to a generated `Dockerfile.dockerignore` = the
  image's own ignore file (`<Dockerfile>.dockerignore`, else the context's
  `.dockerignore`) + the guard rules LAST, so no `!` rule undoes them. BuildKit
  reads a Dockerfile-specific ignore file instead of the context's, so the
  build runs `-f <tmp>/Dockerfile` from the real context, and it only sends
  what `COPY`/`ADD` reference. Needs BuildKit, Docker's default builder since
  23.0.
- **Exit codes** (`errors.ts`): 16 `invalid_evals_dir` / `archive_too_large`,
  17 `missing_tool`, 18 `harbor_failed` (Harbor runs only), 19 `missing_env`
  (also a missing or malformed `LMNR_EVAL_RUN` / `LMNR_EVAL_RUN_ID` in `eval
  orchestrate`), 20 `docker_failed` (build / pull / save, unreadable `docker
  save` output, a non-amd64 image, zstd layers), 21 `remote_run_failed` (a
  `--remote` run's orchestrator exited with anything but 0 or 18, or its
  sandbox was lost; 18 from it stays `harbor_failed`), 22 `merge_conflict`
  (pull / push), 23 `not_found` (no eval.yaml for a set a run names, a set
  with no tasks anywhere, or a task set or version Laminar doesn't have). Bad `--env` flags are commander `InvalidArgumentError`s.
- **Secrets are Harbor `${VAR}` placeholders**, not flags: `findTemplateVars`
  scans each set's eval.yaml + the run's task.toml files (so a task `--task` leaves out
  needs none of its vars), `resolveTemplateEnv` reads ONLY those names from
  process env then `.env.local` / `.env` (`findEnvKey`), and a missing
  required one fails before anything runs (`resolveRunEnv`). The values become
  the Harbor process env (`harborEnv` adds the project key and
  `LMNR_BASE_URL`), so Harbor fills agent, verifier and environment sections
  itself. `--env KEY[=V]` adds vars and references them from every Harbor agent as
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
  up to +34% on folders of tiny files. The lmnr frontend reads blobs
  this way (lmnr `docs/internal/hosted-evals.md`).
- Uploads never contain `.env*`, `SKIPPED_DIRS` (`.git`, `node_modules`,
  virtualenvs, caches, Harbor `jobs/` output; also skipped when finding
  task sets and tasks), and skip symlinks (sandboxes extract with Python
  `filter="data"`). Exec bits are kept (`tests/test.sh`); on Windows, which has
  none, `.sh` files are packed 0755 and the rest 0644 (Harbor's own rule,
  `needs_chmod`). Ownership and mtimes are fixed so local user names and times
  don't leak.
