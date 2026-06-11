import { DEFAULT_BASE_URL, DEFAULT_FRONTEND_URL } from "../constants";

/**
 * Derive the frontend/web URL from the resolved data-API base URL.
 *
 * The CLI cannot import the SDK's `getFrontendUrl` (`lmnr-cli` has NO dependency
 * on `@lmnr-ai/lmnr`), so this is a small local port of that mapping:
 *  - the cloud API base (`https://api.lmnr.ai`) maps to the cloud frontend
 *    (`DEFAULT_FRONTEND_URL`),
 *  - a localhost/127.0.0.1 base keeps its host but defaults the port to 5667
 *    (the local frontend port) when none is present,
 *  - any other base URL (self-host) is used verbatim (trailing slash trimmed).
 *
 * `LMNR_FRONTEND_URL` (and an explicit `--base-url`) flow in through `baseUrl`'s
 * caller; an explicit `LMNR_FRONTEND_URL` short-circuits the mapping entirely.
 */
export const getFrontendUrl = (baseUrl?: string): string => {
  const envFrontend = process.env.LMNR_FRONTEND_URL?.trim();
  if (envFrontend) {
    return trimSlash(envFrontend);
  }

  let url = (baseUrl ?? DEFAULT_BASE_URL).trim();
  if (url === DEFAULT_BASE_URL) {
    return DEFAULT_FRONTEND_URL;
  }
  url = trimSlash(url);

  if (/localhost|127\.0\.0\.1/.test(url)) {
    if (/:\d{1,5}$/.test(url)) {
      url = url.replace(/:\d{1,5}$/, ":5667");
    } else {
      url = `${url}:5667`;
    }
  }
  return url;
};

const trimSlash = (url: string): string => url.replace(/\/+$/, "");
