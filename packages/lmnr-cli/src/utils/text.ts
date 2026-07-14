/** First non-empty string among the candidates, or "" if none. */
export const firstNonEmpty = (...candidates: (string | undefined)[]): string => {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return "";
};
