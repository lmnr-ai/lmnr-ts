import { createColors } from "picocolors";

// Decide color support per stream: NO_COLOR (present at any value) disables,
// FORCE_COLOR (present and not "0") forces on, otherwise fall back to that
// stream's own TTY-ness. We key each stream independently because the CLI writes
// human status to STDERR (stdout is reserved for the `--json` contract) but ALSO
// prints a human summary to STDOUT in non-json mode — each should follow its own
// stream's redirection (e.g. `setup > out.txt` must not get ANSI in the file).
function enabledFor(stream: NodeJS.WriteStream): boolean {
  if ("NO_COLOR" in process.env) return false;
  if ("FORCE_COLOR" in process.env && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY);
}

// Human status lines (✓ / ⚠ / errors) → stderr.
export const pc = createColors(enabledFor(process.stderr));
// The non-json human summary ("Next steps") → stdout.
export const pcOut = createColors(enabledFor(process.stdout));

// Laminar brand orange (#D0754E = rgb(208,117,78)). picocolors only ships the 16
// ANSI colors, so wrap a truecolor escape ourselves — gated on stderr color
// support (the brand banner is a stderr line, same as `pc`).
const stderrColorEnabled = enabledFor(process.stderr);
export const orange = (text: string): string =>
  stderrColorEnabled ? `\x1b[38;2;208;117;78m${text}\x1b[39m` : text;
