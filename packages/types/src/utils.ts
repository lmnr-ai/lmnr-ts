// UUID type alias
export type StringUUID = `${string}-${string}-${string}-${string}-${string}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
