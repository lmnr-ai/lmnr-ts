import { diag } from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationModuleDefinition,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from "@opentelemetry/instrumentation";

import { version as SDK_VERSION } from "../../../../package.json";
import { observe } from "../../../decorators";
import { Laminar } from "../../../laminar";
import {
  SPAN_INSTRUMENTATION_SCOPE_NAME,
  SPAN_INSTRUMENTATION_SCOPE_VERSION,
} from "../../tracing/attributes";
import { LaminarSpan } from "../../tracing/span";
import { getPackageVersion, recordPackageVersion } from "./package-version";

type AnyFunction = (...args: any[]) => any;

export interface LaminarInstrumentationConfig {
  traceContent?: boolean;
}

/**
 * A file inside a package, for targets that are only reachable through the
 * package's internals (e.g. `@langchain/core/dist/callbacks/manager.cjs`).
 */
export interface InstrumentedFile {
  /** Path of the file, starting with the package name. */
  name: string;
  patch: (fileExports: any) => void;
  unpatch: (fileExports: any) => void;
}

/** An npm package an instrumentation patches. */
export interface InstrumentedModule {
  /**
   * The package name. It is also the instrumentation scope stamped on the
   * spans this package's calls produce.
   */
  name: string;
  supportedVersions: string[];
  patch?: (moduleExports: any) => void;
  unpatch?: (moduleExports: any) => void;
  files?: InstrumentedFile[];
  /**
   * Whether a value handed to `manuallyInstrument` is this package (its
   * module namespace, default export or client class). `patch` must accept
   * every value this returns true for.
   */
  accepts?: (input: any) => boolean;
}

/**
 * What a patched method's wrapper reads at call time. Re-patching an already
 * patched method only swaps in the newest `instrumentation`, so a repeated
 * `initialize()` refreshes the config (e.g. `traceContent`) without wrapping
 * twice.
 */
export interface PatchedMethod<
  T extends LaminarInstrumentation = LaminarInstrumentation,
> {
  instrumentation: T;
  original: AnyFunction;
}

export type InstrumentationSpanOptions = Parameters<
  typeof Laminar.startSpan
>[0];

/**
 * `lmnr.span.instrumentation_scope.{name,version}` for spans produced by a
 * call into `packageName`. All Laminar spans come from the same OTel tracer,
 * so the real OTel instrumentation scope can't tell the wrapped library
 * apart; these attributes do. The version is left out when it can't be
 * resolved.
 */
export const instrumentationScopeAttributes = (
  packageName: string,
): Record<string, string> => {
  const version = getPackageVersion(packageName);
  return {
    [SPAN_INSTRUMENTATION_SCOPE_NAME]: packageName,
    ...(version ? { [SPAN_INSTRUMENTATION_SCOPE_VERSION]: version } : {}),
  };
};

/**
 * An `observe()` that stamps every span it opens with the instrumentation
 * scope of `packageName`. Instrumentations that build their spans with
 * `observe()` (browser automation, kernel) use it in place of `observe`:
 *
 *     const laminarObserve = instrumentedObserve("@browserbasehq/stagehand");
 */
export const instrumentedObserve =
  (packageName: string) =>
  <A extends unknown[], R>(
    options: Parameters<typeof observe>[0],
    fn: (...args: A) => R,
    ...args: A
  ): R =>
    observe(
      options,
      (...innerArgs: A) => {
        // `observe()` activates its span before calling `fn`.
        Laminar.getCurrentSpan()?.setAttributes(
          instrumentationScopeAttributes(packageName),
        );
        return fn(...innerArgs);
      },
      ...args,
    );

/**
 * Set `target[key]`, redefining it when a plain assignment would fail: a
 * getter-only accessor (how bundlers emit CJS `exports`) or a read-only but
 * configurable data property. Same approach as shimmer.
 */
const setProperty = (target: any, key: string, value: unknown): void => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor?.configurable && !descriptor.writable) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
    });
    return;
  }
  target[key] = value;
};

/**
 * Base class for Laminar's library instrumentations.
 *
 * A subclass lists the packages it patches in `modules()`, and gets from it:
 * - the `require-in-the-middle` hooks (`init`), which also record the version
 *   of each package as it loads;
 * - a default `manuallyInstrument`, dispatching on `InstrumentedModule.accepts`;
 * - `wrapMethod` / `unwrapMethod`, for idempotent method patching;
 * - `startSpan`, which stamps the wrapped package's name and version on every
 *   span. Wrappers should create their spans through it.
 *
 * Note that `init()`, and so `modules()`, runs inside the `InstrumentationBase`
 * constructor, before any subclass field is assigned. `modules()` must only
 * reference instance state lazily, from inside the patch callbacks.
 */
export abstract class LaminarInstrumentation extends InstrumentationBase {
  public readonly traceContent: boolean;

  /**
   * @param name - short name of the instrumentation, e.g. `"openai"`. It
   * becomes the OTel instrumentation name `@lmnr/<name>-instrumentation`.
   */
  constructor(name: string, config?: LaminarInstrumentationConfig) {
    super(`@lmnr/${name}-instrumentation`, SDK_VERSION, { enabled: true });
    this.traceContent = config?.traceContent ?? true;
  }

  /** The packages this instrumentation patches. The first one is primary. */
  protected abstract modules(): InstrumentedModule[];

  protected init(): InstrumentationModuleDefinition[] {
    return this.modules().map(
      (module) =>
        new InstrumentationNodeModuleDefinition(
          module.name,
          module.supportedVersions,
          module.patch &&
            ((moduleExports: any, moduleVersion?: string) => {
              recordPackageVersion(module.name, moduleVersion);
              diag.debug(`Patching ${module.name}`);
              module.patch!(moduleExports);
              return moduleExports;
            }),
          module.unpatch &&
            ((moduleExports: any) => {
              if (!moduleExports) return;
              diag.debug(`Unpatching ${module.name}`);
              module.unpatch!(moduleExports);
            }),
          module.files?.map(
            (file) =>
              new InstrumentationNodeModuleFile(
                file.name,
                module.supportedVersions,
                (fileExports: any, moduleVersion?: string) => {
                  recordPackageVersion(module.name, moduleVersion);
                  diag.debug(`Patching ${file.name}`);
                  file.patch(fileExports);
                  return fileExports;
                },
                (fileExports: any) => {
                  if (fileExports) file.unpatch(fileExports);
                },
              ),
          ),
        ),
    );
  }

  /**
   * Patch a module the user imported themselves (`instrumentModules`). Takes
   * one module (or class), or an array of them for instrumentations that
   * cover several packages.
   */
  public manuallyInstrument(input: any): void {
    const modules = this.modules();
    for (const value of Array.isArray(input) ? input : [input]) {
      const module = modules.find((m) => m.patch && m.accepts?.(value));
      if (!module) {
        const names = modules.map((m) => m.name).join(" or ");
        diag.warn(
          `Could not find ${names} in ${this.instrumentationName} manual ` +
            `instrumentation input. Pass the ${names} module.`,
        );
        continue;
      }
      diag.debug(`Manually instrumenting ${module.name}`);
      module.patch!(value);
    }
  }

  /**
   * Start a span stamped with the instrumentation scope of `packageName`
   * (default: the primary module). It is not activated; run the call under
   * it with `Laminar.withSpan`.
   */
  public startSpan(
    options: InstrumentationSpanOptions,
    packageName: string = this.modules()[0].name,
  ): LaminarSpan {
    const span = Laminar.startSpan(options) as LaminarSpan;
    span.setAttributes(instrumentationScopeAttributes(packageName));
    return span;
  }

  /**
   * Replace `target[method]` with `wrap(patched)`. The original is kept in a
   * non-enumerable record owned by `target` itself, so a subclass prototype
   * never sees its parent's record, and the same copy of a library (or a
   * second copy of this SDK) is never wrapped twice.
   */
  protected wrapMethod(
    target: any,
    method: string,
    wrap: (patched: PatchedMethod<this>) => AnyFunction,
  ): void {
    if (!target || typeof target[method] !== "function") return;
    const patches = this.ownPatches(target, true)!;
    const existing = patches[method];
    if (existing) {
      existing.instrumentation = this;
      return;
    }
    const patched: PatchedMethod<this> = {
      instrumentation: this,
      original: target[method],
    };
    patches[method] = patched;
    setProperty(target, method, wrap(patched));
  }

  /** Restore a method patched with `wrapMethod`. */
  protected unwrapMethod(target: any, method: string): void {
    const patches = this.ownPatches(target, false);
    const patched = patches?.[method];
    if (!patches || !patched) return;
    setProperty(target, method, patched.original);
    delete patches[method];
    if (Object.keys(patches).length === 0) {
      delete target[this.patchesSymbol];
    }
  }

  /** Whether `wrapMethod` currently has `target[method]` patched. */
  protected isWrapped(target: any, method: string): boolean {
    return Boolean(this.ownPatches(target, false)?.[method]);
  }

  private get patchesSymbol(): symbol {
    // `Symbol.for`, so CJS and ESM copies of the SDK loaded side by side
    // recognize each other's patches.
    return Symbol.for(`lmnr.${this.instrumentationName}.patches`);
  }

  private ownPatches(
    target: any,
    create: boolean,
  ): Record<string, PatchedMethod<any>> | undefined {
    if (!target) return undefined;
    const symbol = this.patchesSymbol;
    if (Object.getOwnPropertyDescriptor(target, symbol) === undefined) {
      if (!create) return undefined;
      Object.defineProperty(target, symbol, {
        value: {},
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
    return target[symbol];
  }
}
