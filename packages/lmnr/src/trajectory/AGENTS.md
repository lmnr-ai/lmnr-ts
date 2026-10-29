# lmnr-atif (`src/trajectory/`)

TS port of the Python SDK's `lmnr/sdk/trajectory/` (lmnr-python PRs #402 / #405 / #407, LAM-2431, LAM-2438): Harbor's ATIF trajectory format plus Laminar's `extra.lmnr` extension.

## The shared spec is owned by lmnr-python

- `spec/lmnr-atif/` at the lmnr-ts repo root (doc, schema, `fixtures/`, `writer-golden/`) is a **byte-for-byte copy** of lmnr-python's `spec/lmnr-atif/`. Never edit it here. To change a golden case, a fixture or a normalizer/builder rule both SDKs share: open an lmnr-python PR first (regenerate with `LMNR_ATIF_UPDATE_GOLDEN=1 uv run pytest tests/test_lmnr_atif_builder.py`, add a row to `writer-golden/README.md`), then copy the directory here and port the code change. TS only compares against the golden files; it never writes them. Check the copy with `diff -r spec/lmnr-atif ../lmnr-python/spec/lmnr-atif`.
- biome ignores `spec/lmnr-atif/**` (`files.includes` in `biome.json`): it would reformat the JSON and the files must stay verbatim.
- A spec change is a version bump in five places in BOTH repos (see lmnr-python's `src/lmnr/sdk/trajectory/AGENTS.md`); `spec.ts::SPEC_VERSION` is the TS one. `test/trajectory-spec.test.ts` checks they agree.

## Porting rules

- **`spec.ts`, `reader.ts`, `normalize.ts`, `builder.ts`, `py.ts`, `log.ts` are the pure layer**: no OTel, no `fs`, nothing from `opentelemetry-lib/` or `utils.ts` (which pulls in OTel). `log.ts` exists only so `reader.ts` can log without `utils.ts`. `reader.ts` is internal (not exported from the package).
- **Keep each file line-comparable with its Python twin**: same function names (camelCase), same order, same structure, so a fix can be mirrored by diffing the two. Don't improve an algorithm while porting; the golden suite pins the output, and an improvement belongs in both SDKs (Python first).
- **Python semantics go through `py.ts`, never ad hoc**:
  - `truthy(x)` / `or(a, b, ...)` for `if x:` / `a or b` (`[]` and `{}` are falsy in Python, truthy in JS). Every Python truthiness check, including `or` chains, must use them.
  - `get(obj, key)` / `has(obj, key)` for `dict.get` / `in` (`has` is `hasOwn` from `@lmnr-ai/types`, which the tracing collector uses too): own keys only (`"constructor" in {}` is true in JS). Copy objects with spread or `Object.fromEntries`, never `obj[key] = v` with a key from data (`__proto__`).
  - `pyEquals` / `pyIn` for `==` / `in` (`1 == 1.0`, `True == 1`, deep, dict order ignored). `isNone` for `is None` (missing key and JSON null are both None).
  - `pyStr` for `str()` (`"True"`, `"None"`, single-quoted reprs), including inside f-strings.
  - `pyJsonDumps` for `json.dumps(value, ensure_ascii=False)`: Python's `", "` / `": "` separators and float repr (`1e-07`). Golden strings contain e.g. `"{\"temp_c\": 18}"`, so `JSON.stringify` fails them. Pass `{ ensureAscii: true }` where Python calls bare `json.dumps` (`normalize.ts` non-string content).
  - `canonicalJson` for `canonical_json` (`sort_keys`, `","` / `":"`): keys sort by **code point** (`compareCodePoints`), not UTF-16 unit. `defKey` is `sha256:` of it, via `@noble/hashes`.
  - `setdefault`, `counter` (`Counter`, first-seen order), `compareTuples` (`sorted(key=tuple)`; JS `sort` is stable like Python's), `pyRound` (`round(x, n)`).
  - Unfixable from JS (no golden case may depend on them): a parsed `1.0` is `1`, so Python writes `3790.0` where TS writes `3790` (deep-equal treats them the same); ints past 2^53 lose precision; objects put integer-like keys first.
- **Times are integer microseconds** (`parseTimeUs` / `formatTime`), not Python's nanoseconds: epoch nanoseconds don't fit in a Number. Python truncates to microseconds, so does `parseTimeUs`.
- `SpanRecord` fields are snake_case on purpose: the record IS the language-neutral JSON form (`writer-golden/README.md`). `BuildOptions` is camelCase; the golden runner maps `project_id`. The default producer is `{name: "lmnr-ts", version}`; the golden runner overrides it with `lmnr-golden`.
- Every bullet of lmnr-python's `src/lmnr/sdk/trajectory/AGENTS.md` (prefill outputs, concurrent tool matching, Gemini id collisions, empty system prompt, the input-copy bug, ...) applies here unchanged; the regression tests are ported by name in `test/trajectory-builder.test.ts`.

## Writer (`writer.ts`)

- Not part of the pure layer (it uses `node:fs` / `node:crypto`); the tracing collector (`opentelemetry-lib/tracing/trajectory.ts`, see the tracing AGENTS.md) is its only caller. Port of `writer.py`: `renderPath` (`{trace_id}`, `{pid}`, `~`), `writeJsonAtomic` (temp file in the same directory, then rename; `JSON.stringify(v, null, 2)`, which matches Python's `indent=2, ensure_ascii=False`), `mediaSink` (`images/<first 32 hex of sha256>.<ext>`, the four ATIF image types only, `null` on invalid base64: the regex is `b64decode(validate=True)`'s alphabet-and-padding check), `writeTrajectories` (one file per trace with `{trace_id}`, else one file; a file is `complete: false` when a trace it covers is still open).
- **Everything is synchronous** on purpose: the final write runs in a process `exit` handler, which can't await.

## Tests

- `test/trajectory-spec.test.ts` (from `test_lmnr_atif.py`): versions agree, fixtures validate, def keys, doc tables vs schema, reader.
- `test/trajectory-builder.test.ts` (from `test_lmnr_atif_builder.py`): every golden case deep-equals `trajectory.json`, matches the schema, is deterministic, and **`reader rebuilds every call's input`**, the real correctness check (see the Python AGENTS.md). Plus the builder/normalizer unit tests and `py.ts` checks.
- Schema validation uses `ajv/dist/2020` (the schema is draft 2020-12) with `strict: false`: ajv's strict mode is its own lint (it rejects `required` without `properties`), not JSON Schema validity.
- `test/trajectory-writer.test.ts` (from `test_trajectory_writer.py`): writer, collector, `spanType` vs app-server, processor wiring, `Laminar.initialize` modes, and child-process checks (exit hook, unref'd timer, `.env` + `writeTrajectory: false`). Child scripts are `.mts` (top-level await needs ESM) run with `node --import <tsx loader>`; ad hoc scratch scripts importing workspace packages must live inside `packages/lmnr`, not `/tmp`, or `@opentelemetry/*` doesn't resolve. `test/trajectory-openai.test.ts`: the OpenAI tool loop end to end with a nock cassette and the reader round trip.
- Harbor's validator isn't runnable from TS: `uv run --with harbor==0.25.0 python -m harbor.utils.trajectory_validator <file>`.
