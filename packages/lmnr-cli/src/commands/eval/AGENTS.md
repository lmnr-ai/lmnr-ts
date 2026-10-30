# Harbor evals (`eval`)

- `lmnr-cli eval run [dir=evals]` runs each suite (`<dir>/<suite>/harbor.yaml`,
  a Harbor JobConfig) with **pinned** Harbor + the Laminar plugin through
  `uvx` (`harbor.ts`: `HARBOR_VERSION`, `LMNR_PYTHON_VERSION`), from inside the
  suite dir so relative paths and custom agent imports resolve the same way
  everywhere. Harbor's stdout goes to OUR stderr; stdout is data only.
  - default: trials on local Docker; `lmnr.yaml` images are `docker build`-ed first.
  - `--remote`: detached. Packs the folder (`pack.ts`) and checks the 1 GiB
    cap BEFORE pushing images, then uploads it and `POST
    /v1[/cli]/hosted-evals/runs {uploadId, cliVersion, spec}`. The server's
    orchestrator sandbox runs `npx lmnr-cli@<cliVersion> eval orchestrate`
    (hidden command), so `RunSpec` only has to stay readable by the SAME version.
  - `--remote --attach`: Harbor runs here, trials in Laminar sandboxes.
- Modules: `index.ts` (`eval run` flow, reporting), `detached.ts` (`RunSpec`,
  `startDetachedRun`, `eval orchestrate`), `env.ts` (`--env`, `${VAR}`
  resolution, the Harbor process env), `suites.ts` (suite discovery,
  `SKIPPED_DIRS`, task.toml scan, `buildJobConfig`), `harbor.ts` (uvx/Harbor
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
  `SandboxBuildFailedError`. It subclasses Harbor internals, so bump
  `HARBOR_VERSION` only together with a remote run against the new version.
  `assets/` ships in the npm package (`files`); `environmentModulePath` finds it
  next to `dist/` or in the source tree.
- **Images:** tasks name an image with `docker_image`; `<dir>/lmnr.yaml`
  `images: {name: {dockerfile, context}}` declares how to build it (paths
  relative to `<dir>`). Local runs `docker build` all of those and let Harbor
  handle the rest. What a task starts from mirrors Harbor's
  `should_use_prebuilt_docker_image` (`findTaskImages`): its `docker_image`,
  unless the suite's harbor.yaml sets `environment.force_build: true` and the
  task has `environment/Dockerfile`, which is otherwise used only without a
  `docker_image`.
- **Remote runs push every image the selected suites' tasks use, from here**
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
  (`dockerfileKey`: a detached run looks a Windows-built map up on Linux).
- **Remote limitations:** a per-task Dockerfile `FROM <lmnr.yaml image>` does
  not work remotely and is not supported: remote pushes tag `lmnr.yaml` images
  `lmnr-evals-remote:<hash>`, not by name, so the `FROM` resolves to a
  registry image or a stale local build. Only `task.toml` files under the suite dir are scanned, so tasks
  from paths outside it or from git/registry datasets get no per-task
  Dockerfile pushed, and their `docker_image`s aren't pushed either.
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
  non-amd64 image, zstd layers). `--attach` without `--remote` and bad `--env`
  flags are commander `InvalidArgumentError`s.
- **Secrets are Harbor `${VAR}` placeholders**, not flags: `findTemplateVars`
  scans harbor.yaml + every task.toml, `resolveTemplateEnv` reads ONLY those
  names from process env then `.env.local` / `.env` (`findEnvKey`), and a
  missing required one fails before anything runs (`resolveRunEnv`). The
  values become the Harbor process env (`harborEnv` adds the project key and
  `LMNR_BASE_URL`), so Harbor fills agent, verifier and environment sections
  itself. `--env KEY[=V]` adds vars and references them from every agent as
  `${KEY}`, so literal values never hit the job config. Detached runs send the
  values in the spec and drop `LMNR_*` (the orchestrator gets its own key and
  URL).
- `LMNR_GRPC_PORT` (env or `.env`) becomes `--pk grpc_port=`: the plugin
  exports spans over gRPC and defaults to 8443, so self-hosted traces need it.
- Auth: local and attached need `LMNR_PROJECT_API_KEY` (the plugin reports
  with it). `--remote` calls the API as the logged-in user and falls back to
  the project key when there is no login (CI).
- Uploads never contain `.env*`, `SKIPPED_DIRS` (`.git`, `node_modules`,
  virtualenvs, caches, Harbor `jobs/` output; also skipped when finding suites
  and tasks), and skip symlinks (sandboxes extract with Python
  `filter="data"`). Exec bits are kept (`tests/test.sh`); ownership and mtimes
  are fixed so local user names and times don't leak.
