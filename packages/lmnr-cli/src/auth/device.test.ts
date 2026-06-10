import { describe, expect, it } from "vitest";

import { parseProjectFromMetadata } from "./device";

const UUID = "01234567-89ab-cdef-0123-456789abcdef";

describe("parseProjectFromMetadata", () => {
  it("extracts the projectId from the metadata JSON", () => {
    expect(parseProjectFromMetadata(JSON.stringify({ projectId: UUID }))).toBe(UUID);
  });

  it("ignores unrelated keys", () => {
    expect(parseProjectFromMetadata(JSON.stringify({ projectId: UUID, foo: "bar" }))).toBe(UUID);
  });

  it("returns null for a non-uuid projectId", () => {
    expect(parseProjectFromMetadata(JSON.stringify({ projectId: "not-a-uuid" }))).toBeNull();
  });

  it("returns null when projectId is absent", () => {
    expect(parseProjectFromMetadata(JSON.stringify({ foo: "bar" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseProjectFromMetadata("{not json")).toBeNull();
  });

  it("returns null for empty / missing metadata", () => {
    expect(parseProjectFromMetadata("")).toBeNull();
    expect(parseProjectFromMetadata(undefined)).toBeNull();
    expect(parseProjectFromMetadata(null)).toBeNull();
  });
});
