/**
 * Where the bridge listens to the LangSmith SDK.
 *
 * Every way of tracing with LangSmith JS (`traceable`, `wrapOpenAI` /
 * `wrapAnthropic`, LangChain's and LangGraph's tracer, hand-built `RunTree`s)
 * ends in `RunTree.postRun()` / `patchRun()`, which call the client's
 * `createRun` / `updateRun`. Those sample the run, apply the client's
 * redaction (`hideInputs` / `hideOutputs` / `hideMetadata`, the anonymizer)
 * and hand the result to `Client.processRunOperation`, which queues it for
 * sending. The bridge taps there: it sees exactly what LangSmith sends, after
 * the customer's sampling and redaction, and nothing else. With
 * `autoBatchTracing: false` the client sends each run itself instead; the
 * bridge reads creates from `_mergeRuntimeEnvAndMaskMetadata` (the body it
 * posts) and updates from `updateRun` once it resolved.
 *
 * The tap never changes what LangSmith queues: it snapshots a shallow copy of
 * the run (JSON round trip, `attachments` left out) after LangSmith's
 * synchronous part ran, and returns LangSmith's own promise.
 *
 * With write replicas (`LANGSMITH_RUNS_ENDPOINTS`, `replicas` on a run),
 * `postRun()` / `patchRun()` call the client once per replica, with remapped
 * ids for some. A wrapper around them collects those calls and keeps one:
 * the one with the run's own id, else the first.
 *
 * Port of lmnr-python's `bridges/langsmith/tap.py`; keep the two in step.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { errorMessage } from "@lmnr-ai/types";
import { type Context, ROOT_CONTEXT } from "@opentelemetry/api";

import { initializeLogger, toJson } from "../../../utils";
import { LaminarContextManager } from "../../tracing/context";
import { type LangSmithRunRecorder } from "./runs";

const logger = initializeLogger();

type Json = Record<string, any>;
type AnyFunction = (...args: any[]) => any;

// LangChain run ids → Laminar's context where LangChain started the run.
const MAX_LANGCHAIN_CONTEXTS = 10_000;

// `BaseTracer` methods `CallbackManager.handle*Start` calls synchronously, in
// the caller's context, before it queues the tracer's callbacks; their third
// argument is the run id.
const LANGCHAIN_RUN_START_METHODS = [
  "_createRunForLLMStart",
  "_createRunForChatModelStart",
  "_createRunForChainStart",
  "_createRunForToolStart",
  "_createRunForRetrieverStart",
];

interface Write {
  kind: "create" | "update";
  run: Json;
  context: Context;
  version: string | undefined;
  /** Record an update only if its create was seen (non-batched path). */
  knownOnly: boolean;
}

/** One `RunTree.postRun()` / `patchRun()` call and the client writes it made. */
interface Scope {
  runId: string;
  writes: Write[];
  dispatched: boolean;
}

/** One `Client.updateRun()` call: did it reach `processRunOperation`? */
interface UpdateScope {
  batched: boolean;
}

/** One `Client.createRun()` call on langsmith < 0.8 (`wrapCreateRun`). */
interface CreateScope {
  batched: boolean;
  prepared: boolean;
}

// The `AsyncLocalStorage` every `langsmith` copy (and `@langchain/core`)
// shares through `globalThis`; `traceable` calls `postRun()` inside its `run`.
const TRACING_ALS_KEY = Symbol.for("ls:tracing_async_local_storage");

/** The object on `value`'s prototype chain that owns method `name`. */
const ownerOf = (value: unknown, name: string): Json | undefined => {
  let current: unknown = value;
  while (isObject(current)) {
    if (Object.hasOwn(current, name)) {
      return typeof current[name] === "function" ? current : undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

/** `extra.runtime.sdk_version`, which LangSmith merges into every run. */
const runtimeVersion = (run: Json): string | undefined => {
  const version = run.extra?.runtime?.sdk_version;
  return typeof version === "string" ? version : undefined;
};

const runTreeScope = new AsyncLocalStorage<Scope>();
const createScope = new AsyncLocalStorage<CreateScope>();
const updateScope = new AsyncLocalStorage<UpdateScope>();

interface Patch {
  target: Json;
  name: string;
  wrapper: AnyFunction;
  original: AnyFunction;
}

/** A loaded copy of `langsmith` (CJS, ESM, or a nested one). */
interface LangSmithCopy {
  client: Json | undefined;
  runTree: Json | undefined;
  version: string | undefined;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Resolvers to look packages up from: this SDK's location, the app's working
 * directory (strict package manager layouts), and `@langchain/core`'s
 * location, which finds the `langsmith` copy LangChain's tracer uses.
 */
const resolvers = (): NodeJS.Require[] => {
  const candidates: NodeJS.Require[] = [require];
  try {
    candidates.push(createRequire(join(process.cwd(), "package.json")));
  } catch {
    // No usable working directory, e.g. in a bundled or sandboxed runtime.
  }
  for (const resolver of [...candidates]) {
    try {
      candidates.push(createRequire(resolver.resolve("@langchain/core")));
    } catch {
      // LangChain isn't installed.
    }
  }
  return candidates;
};

/** The ESM file of an `exports` entry (`import`, else `default`). */
const esmTarget = (entry: unknown): string | undefined => {
  if (typeof entry === "string")
    return entry.endsWith(".cjs") ? undefined : entry;
  if (!isObject(entry)) return undefined;
  for (const condition of ["node", "import", "default"]) {
    if (condition in entry) {
      const target = esmTarget(entry[condition]);
      if (target) return target;
    }
  }
  return undefined;
};

/**
 * Every file a subpath of `pkg` can load from: what `require` resolves to,
 * and the ESM file of its `exports` entry, each with the package's version.
 */
const packageFiles = (
  pkg: string,
  subpath: string,
): Map<string, string | undefined> => {
  const files = new Map<string, string | undefined>();
  const specifier = subpath === "." ? pkg : `${pkg}/${subpath.slice(2)}`;
  for (const resolver of resolvers()) {
    let root: string | undefined;
    let manifest: Json | undefined;
    try {
      const manifestPath = resolver.resolve(`${pkg}/package.json`);
      root = dirname(manifestPath);
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      // `exports` hides package.json, or the package isn't there.
    }
    const version =
      typeof manifest?.version === "string" ? manifest.version : undefined;
    try {
      const cjs = resolver.resolve(specifier);
      if (!files.has(cjs)) files.set(cjs, version);
    } catch {
      // Not resolvable from here.
    }
    const exportsMap = manifest?.exports;
    const entry = isObject(exportsMap) ? exportsMap[subpath] : undefined;
    const esm = root ? esmTarget(entry) : undefined;
    if (root && esm) {
      const path = join(root, esm);
      if (!files.has(path)) files.set(path, version);
    }
  }
  return files;
};

/**
 * Load a resolved file. ESM files load through `require(esm)` (Node >=
 * 22.12, the SDK's floor), which shares the ESM loader's module cache, so the
 * app's later `import` gets the copy patched here.
 */
const load = (path: string): Json | undefined => {
  try {
    // biome-ignore lint/style/noCommonJs: loads the app's own copies by path
    const loaded = require(path);
    return isObject(loaded) || typeof loaded === "function"
      ? loaded
      : undefined;
  } catch (e) {
    logger.debug(`LangSmith bridge could not load ${path}: ${errorMessage(e)}`);
    return undefined;
  }
};

/**
 * `import()` a resolved file: the copy the ESM loader holds, which is what an
 * app's `import` gets. Usually the same objects `require(esm)` returned, but
 * loaders that compile ESM to CommonJS for `require` (tsx) give `require` a
 * separate copy, so the app's copy is reached only this way.
 */
const importModule = async (path: string): Promise<Json | undefined> => {
  try {
    const loaded: unknown = await import(pathToFileURL(path).href);
    return isObject(loaded) ? loaded : undefined;
  } catch (e) {
    logger.debug(
      `LangSmith bridge could not import ${path}: ${errorMessage(e)}`,
    );
    return undefined;
  }
};

type Loaded = [module: Json | undefined, version: string | undefined];

const loadAll = (pkg: string, subpath: string): Loaded[] =>
  [...packageFiles(pkg, subpath)].map(([path, version]) => [
    load(path),
    version,
  ]);

const importAll = (pkg: string, subpath: string): Promise<Loaded[]> =>
  Promise.all(
    [...packageFiles(pkg, subpath)].map(
      async ([path, version]): Promise<Loaded> => [
        await importModule(path),
        version,
      ],
    ),
  );

/** The distinct `Client` / `RunTree` prototypes of loaded `langsmith` files. */
const copiesOf = (clients: Loaded[], runTrees: Loaded[]): LangSmithCopy[] => {
  const copies: LangSmithCopy[] = [];
  const seen = new Set<unknown>();
  for (const [module, version] of clients) {
    const client = module?.Client;
    if (typeof client !== "function" || seen.has(client.prototype)) continue;
    seen.add(client.prototype);
    copies.push({ client: client.prototype, runTree: undefined, version });
  }
  for (const [module, version] of runTrees) {
    const runTree = module?.RunTree;
    if (typeof runTree !== "function" || seen.has(runTree.prototype)) continue;
    seen.add(runTree.prototype);
    copies.push({ client: undefined, runTree: runTree.prototype, version });
  }
  return copies;
};

/** The distinct `BaseTracer.prototype`s of loaded `@langchain/core` files. */
const tracerPrototypesOf = (modules: Loaded[]): Json[] => {
  const prototypes: Json[] = [];
  for (const [module] of modules) {
    const prototype = module?.BaseTracer?.prototype;
    if (isObject(prototype) && !prototypes.includes(prototype)) {
      prototypes.push(prototype);
    }
  }
  return prototypes;
};

/** Every copy of `langsmith` reachable from here, deduplicated. */
export const langsmithCopies = (): LangSmithCopy[] =>
  copiesOf(loadAll("langsmith", "."), loadAll("langsmith", "./run_trees"));

/** The copies `import()` reaches (see `importModule`). */
export const importedLangsmithCopies = async (): Promise<LangSmithCopy[]> =>
  copiesOf(
    await importAll("langsmith", "."),
    await importAll("langsmith", "./run_trees"),
  );

/** `BaseTracer.prototype` of every reachable `@langchain/core` copy. */
const langchainTracerPrototypes = (): Json[] =>
  tracerPrototypesOf(loadAll("@langchain/core", "./tracers/base"));

const importedLangchainTracerPrototypes = async (): Promise<Json[]> =>
  tracerPrototypesOf(await importAll("@langchain/core", "./tracers/base"));

/** A JSON copy of a run, without `attachments` (file bytes). */
const snapshot = (run: unknown): Json | undefined => {
  if (!isObject(run)) return undefined;
  const copy: Json = { ...run };
  delete copy.attachments;
  const json = toJson(copy);
  if (json === undefined) return undefined;
  const parsed = JSON.parse(json);
  return isObject(parsed) ? parsed : undefined;
};

export class LangSmithTap {
  active = false;
  private readonly patches: Patch[] = [];
  private readonly langchainContexts = new Map<string, Context>();

  constructor(private readonly recorder: LangSmithRunRecorder) {}

  // --- capture ---------------------------------------------------------------

  /** Laminar's context for a run: where LangChain started it, else here. */
  private contextFor(runId: unknown): Context {
    const key = typeof runId === "string" ? runId : String(runId ?? "");
    const captured = this.langchainContexts.get(key);
    if (captured !== undefined) {
      this.langchainContexts.delete(key);
      return captured;
    }
    return LaminarContextManager.getContext();
  }

  /** Snapshot a run LangSmith is sending, now, and record it. */
  private capture(
    kind: Write["kind"],
    run: unknown,
    version: string | undefined,
    knownOnly = false,
  ): void {
    const data = snapshot(run);
    if (!data) return;
    const write: Write = {
      kind,
      run: data,
      // An update whose create was never seen is recorded as a root run.
      context: kind === "create" ? this.contextFor(data.id) : ROOT_CONTEXT,
      // Copies patched on first use (`patchOnFirstRun`) have no known version.
      version: version ?? runtimeVersion(data),
      knownOnly,
    };
    const scope = runTreeScope.getStore();
    if (!scope) {
      this.dispatch(write);
      return;
    }
    scope.writes.push(write);
    // The run's own write goes out at once, so its children (which may be
    // posted while this `postRun` still awaits other replicas) find it.
    if (!scope.dispatched && String(data.id) === scope.runId) {
      scope.dispatched = true;
      this.dispatch(write);
    }
  }

  private dispatch(write: Write): void {
    if (write.kind === "create") {
      this.recorder.onCreate(write.run, write.context, write.version);
    } else {
      this.recorder.onUpdate(write.run, write.version, write.knownOnly);
    }
  }

  private endScope(scope: Scope): void {
    if (!scope.dispatched && scope.writes.length > 0) {
      scope.dispatched = true;
      this.dispatch(scope.writes[0]);
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      logger.debug(`LangSmith bridge failed to read a run: ${errorMessage(e)}`);
    }
  }

  // --- wrappers --------------------------------------------------------------

  /** `Client.processRunOperation({action, item})`: the batched send path. */
  private wrapProcessRunOperation(
    original: AnyFunction,
    version: string | undefined,
  ): AnyFunction {
    const tap = this;
    return function (this: unknown, ...args: any[]) {
      // LangSmith merges its runtime info into `item.item` before its first
      // await, so the snapshot after the call is what it queued.
      const result = original.apply(this, args);
      const operation = args[0];
      if (
        tap.active &&
        isObject(operation) &&
        (operation.action === "create" || operation.action === "update")
      ) {
        const scope =
          operation.action === "update"
            ? updateScope.getStore()
            : createScope.getStore();
        if (scope) scope.batched = true;
        tap.guard(() => tap.capture(operation.action, operation.item, version));
      }
      return result;
    };
  }

  /** `Client._mergeRuntimeEnvAndMaskMetadata(run)`: an unbatched create. */
  private wrapUnbatchedCreate(
    original: AnyFunction,
    version: string | undefined,
  ): AnyFunction {
    const tap = this;
    return function (this: unknown, ...args: any[]) {
      const result = original.apply(this, args);
      if (tap.active) {
        // Promise reactions keep the async context they were registered in
        // (the `postRun` scope), and run before `createRun`'s own await.
        Promise.resolve(result).then(
          (merged) => tap.guard(() => tap.capture("create", merged, version)),
          () => undefined,
        );
      }
      return result;
    };
  }

  /**
   * `Client.createRun(run)` on langsmith < 0.8, which has no
   * `_mergeRuntimeEnvAndMaskMetadata`: opens the scope `wrapPrepare` reads.
   */
  private wrapCreateRun(original: AnyFunction): AnyFunction {
    const tap = this;
    return function (this: unknown, ...args: any[]) {
      if (!tap.active) return original.apply(this, args);
      const scope: CreateScope = { batched: false, prepared: false };
      return createScope.run(scope, () => original.apply(this, args));
    };
  }

  /**
   * `Client.prepareRunCreateOrUpdateInputs(run)` on langsmith < 0.8: the
   * sampled, redacted run `createRun` sends. `createRun` then either queues
   * it (`processRunOperation`, recorded there) or POSTs it itself, merging
   * its runtime info into `run.extra` in place. Both happen in the reaction
   * after ours, so the check waits one more microtask; it still runs before
   * the POST resolves, so the run's children find it.
   */
  private wrapPrepare(
    original: AnyFunction,
    version: string | undefined,
  ): AnyFunction {
    const tap = this;
    return function (this: unknown, ...args: any[]) {
      const result = original.apply(this, args);
      const scope = createScope.getStore();
      // Only `createRun`'s own call; batch ingestion calls it outside one.
      if (!tap.active || !scope || scope.prepared) return result;
      scope.prepared = true;
      Promise.resolve(result).then(
        (prepared) =>
          queueMicrotask(() => {
            if (scope.batched) return;
            tap.guard(() => tap.capture("create", prepared, version));
          }),
        () => undefined,
      );
      return result;
    };
  }

  /**
   * `Client.updateRun(runId, run)`: when it didn't hand the run to
   * `processRunOperation`, it sent it itself; `run` is redacted in place by
   * then. Only runs whose create was seen are recorded (a sampled-out run's
   * update would otherwise look like a run that started before the bridge).
   */
  private wrapUpdateRun(
    original: AnyFunction,
    version: string | undefined,
  ): AnyFunction {
    const tap = this;
    return function (this: unknown, ...args: any[]) {
      if (!tap.active) return original.apply(this, args);
      const own: UpdateScope = { batched: false };
      const result = updateScope.run(own, () => original.apply(this, args));
      const [runId, run] = args;
      Promise.resolve(result).then(
        () => {
          if (own.batched || !isObject(run)) return;
          tap.guard(() =>
            tap.capture("update", { ...run, id: runId }, version, true),
          );
        },
        () => undefined,
      );
      return result;
    };
  }

  /** `RunTree.postRun()` / `patchRun()`: one write per replica, keep one. */
  private wrapRunTreeSend(original: AnyFunction): AnyFunction {
    const tap = this;
    return function (this: Json, ...args: any[]) {
      if (!tap.active) return original.apply(this, args);
      const scope: Scope = {
        runId: String(this?.id ?? ""),
        writes: [],
        dispatched: false,
      };
      const result = runTreeScope.run(scope, () => original.apply(this, args));
      // Registered before the caller's continuation, so the run is recorded
      // before the caller moves on (to `patchRun`, say).
      Promise.resolve(result).then(
        () => tap.guard(() => tap.endScope(scope)),
        () => tap.guard(() => tap.endScope(scope)),
      );
      return result;
    };
  }

  /** `BaseTracer._createRunFor*Start`: remember the caller's context. */
  private wrapLangchainRunStart(original: AnyFunction): AnyFunction {
    const tap = this;
    return function (this: unknown, ...args: any[]) {
      if (tap.active) {
        const runId = args[2];
        if (typeof runId === "string" && !tap.langchainContexts.has(runId)) {
          tap.langchainContexts.set(runId, LaminarContextManager.getContext());
          if (tap.langchainContexts.size > MAX_LANGCHAIN_CONTEXTS) {
            const oldest = tap.langchainContexts.keys().next().value as string;
            tap.langchainContexts.delete(oldest);
          }
        }
      }
      return original.apply(this, args);
    };
  }

  // --- install ---------------------------------------------------------------

  private patch(
    target: Json,
    name: string,
    wrap: (o: AnyFunction) => AnyFunction,
  ): boolean {
    // Already ours: `require` and `import()` often reach the same copy.
    if (this.patches.some((p) => p.target === target && p.name === name)) {
      return true;
    }
    const original = target[name];
    if (typeof original !== "function") return false;
    const wrapper = wrap(original);
    Object.defineProperty(wrapper, "name", { value: original.name });
    target[name] = wrapper;
    this.patches.push({ target, name, wrapper, original });
    return true;
  }

  /**
   * Patch every copy `require` reaches. False when no client could be
   * tapped. Then call `installImported()` for the copies only `import()`
   * reaches.
   */
  install(
    copies: LangSmithCopy[] = langsmithCopies(),
    tracerPrototypes: () => Json[] = langchainTracerPrototypes,
  ): boolean {
    const tapped = this.patchCopies(copies);
    if (tapped) {
      this.patchTracers(tracerPrototypes());
      this.patchOnFirstRun();
    }
    this.active = tapped;
    return tapped;
  }

  /**
   * Patch a copy `require` can't reach (an app's `import` under tsx) when it
   * first runs a run, before that run is posted: `traceable` calls
   * `postRun()` inside the shared `AsyncLocalStorage`'s `run(runTree, ...)`,
   * so wrapping that one instance reaches the run tree's and its client's
   * classes synchronously. `installImported()` covers the rest, one event
   * loop turn later. Nothing happens if no copy has created the storage yet.
   */
  private patchOnFirstRun(): void {
    const storage: unknown = (globalThis as Json)[TRACING_ALS_KEY];
    if (!isObject(storage) || typeof storage.run !== "function") return;
    const seen = new WeakSet<object>();
    const tap = this;
    this.patch(
      storage,
      "run",
      (original) =>
        function (this: unknown, ...args: any[]) {
          const store: unknown = args[0];
          if (tap.active && isObject(store)) {
            const prototype = Object.getPrototypeOf(store);
            if (isObject(prototype) && !seen.has(prototype)) {
              seen.add(prototype);
              tap.guard(() => tap.patchRunCopy(store));
            }
          }
          return original.apply(this, args);
        },
    );
  }

  private patchRunCopy(store: Json): void {
    const runTree = ownerOf(store, "postRun");
    const client = ownerOf(store.client, "processRunOperation");
    // `patch` skips what `require` or `import()` already reached.
    if (runTree && client) {
      this.patchCopies([{ client, runTree, version: undefined }]);
    }
  }

  /**
   * Patch the copies only `import()` reaches, e.g. an app's `import
   * "langsmith"` under tsx. Asynchronous: it lands one event loop turn after
   * `Laminar.initialize()`. `traceable` runs before then are covered by
   * `patchOnFirstRun`; a LangChain or hand-built `RunTree` run posted before
   * then loses its create, and its update is recorded as a complete run.
   */
  async installImported(): Promise<void> {
    const [copies, tracerPrototypes] = await Promise.all([
      importedLangsmithCopies(),
      importedLangchainTracerPrototypes(),
    ]);
    if (!this.active) return;
    this.patchCopies(copies);
    this.patchTracers(tracerPrototypes);
  }

  private patchTracers(prototypes: Json[]): void {
    for (const prototype of prototypes) {
      for (const name of LANGCHAIN_RUN_START_METHODS) {
        this.patch(prototype, name, (o) => this.wrapLangchainRunStart(o));
      }
    }
  }

  private patchCopies(copies: LangSmithCopy[]): boolean {
    let tapped = false;
    for (const { client, runTree, version } of copies) {
      if (client) {
        if (
          this.patch(client, "processRunOperation", (o) =>
            this.wrapProcessRunOperation(o, version),
          )
        ) {
          tapped = true;
          if (typeof client._mergeRuntimeEnvAndMaskMetadata === "function") {
            this.patch(client, "_mergeRuntimeEnvAndMaskMetadata", (o) =>
              this.wrapUnbatchedCreate(o, version),
            );
          } else {
            // langsmith < 0.8: read unbatched creates another way.
            this.patch(client, "createRun", (o) => this.wrapCreateRun(o));
            this.patch(client, "prepareRunCreateOrUpdateInputs", (o) =>
              this.wrapPrepare(o, version),
            );
          }
          this.patch(client, "updateRun", (o) =>
            this.wrapUpdateRun(o, version),
          );
        } else {
          logger.warn(
            `The Laminar langsmith bridge could not find Client.processRunOperation ` +
              `in langsmith ${version ?? "(unknown version)"}; its runs will not ` +
              "be sent to Laminar.",
          );
        }
      }
      if (runTree) {
        this.patch(runTree, "postRun", (o) => this.wrapRunTreeSend(o));
        this.patch(runTree, "patchRun", (o) => this.wrapRunTreeSend(o));
      }
    }
    return tapped;
  }

  uninstall(): void {
    // A wrapper someone else put on top of ours stays, and ours inside it
    // just calls through.
    this.active = false;
    for (const { target, name, wrapper, original } of this.patches) {
      if (target[name] === wrapper) target[name] = original;
      else logger.debug(`LangSmith bridge: ${name} was re-wrapped`);
    }
    this.patches.length = 0;
    this.langchainContexts.clear();
    this.recorder.clear();
  }
}
