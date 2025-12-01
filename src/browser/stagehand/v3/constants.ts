import { initializeLogger } from "../../../utils";

export const logger = initializeLogger();

// CDP timeout for operations
export const CDP_OPERATION_TIMEOUT_MS = 10000;

// URLs that should be skipped for recording
export const SKIP_URL_PATTERNS = [
  "about:blank",
  "chrome-error://",
  "chrome://",
  "edge-error://",
  "edge://",
  "about:neterror",
  "about:certerror",
  "devtools://",
];
