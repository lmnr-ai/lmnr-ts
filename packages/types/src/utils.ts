// UUID type alias
export type StringUUID = `${string}-${string}-${string}-${string}-${string}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether `obj` has `key` as an own property (never an inherited one, like
 * `"constructor" in {}`). `Object.hasOwn` is ES2022. */
export const hasOwn = (obj: object, key: PropertyKey): boolean =>
  // biome-ignore lint/suspicious/noPrototypeBuiltins: `Object.hasOwn` is ES2022
  Object.prototype.hasOwnProperty.call(obj, key);
