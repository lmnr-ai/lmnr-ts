import { createColors } from "picocolors";

// Human-readable status output goes to STDERR; stdout is reserved for the
// machine-readable JSON contract (`--json`). picocolors' default auto-detect
// keys on stdout (FD 1), so `lmnr-cli setup --json | jq` would wrongly strip
// color from an interactive stderr. Decide based on stderr's TTY instead, while
// still honoring the NO_COLOR / FORCE_COLOR conventions (NO_COLOR present at any
// value disables; FORCE_COLOR present and not "0" forces on).
const enabled =
  !("NO_COLOR" in process.env) &&
  (("FORCE_COLOR" in process.env && process.env.FORCE_COLOR !== "0") ||
    Boolean(process.stderr.isTTY));

export const pc = createColors(enabled);
