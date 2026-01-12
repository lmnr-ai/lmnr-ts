// Version detection for runtime environment
export function getLangVersion(): string | null {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return `node-${process.versions.node}`;
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    return `browser-${navigator.userAgent}`;
  }
  return null;
}
