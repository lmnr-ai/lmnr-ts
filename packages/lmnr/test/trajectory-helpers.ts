import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020";

const dirname =
  typeof __dirname !== "undefined"
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));

/** `spec/lmnr-atif/` at the repo root: verbatim copies from lmnr-python. */
export const SPEC_DIR = path.resolve(dirname, "../../../spec/lmnr-atif");
export const GOLDEN_DIR = path.join(SPEC_DIR, "writer-golden");
export const FIXTURES = readdirSync(path.join(SPEC_DIR, "fixtures"))
  .filter((name) => name.endsWith(".json"))
  .sort();
export const CASES = readdirSync(GOLDEN_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

export const readJson = (file: string): any =>
  JSON.parse(readFileSync(file, "utf8"));

export const loadFixture = (name: string): any =>
  readJson(path.join(SPEC_DIR, "fixtures", name));

export const loadSchema = (): any =>
  readJson(path.join(SPEC_DIR, "lmnr-atif.schema.json"));

const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
  loadSchema(),
);

/** Schema violations of a document; [] when it is valid. */
export const schemaErrors = (doc: unknown): string[] =>
  validator(doc)
    ? []
    : (validator.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
