import * as client from "openid-client";

export const CLI_CLIENT_ID = "lmnr-cli";
export const CLI_SCOPE = "projects:rw";

/**
 * Discover the AS via RFC 8414 metadata at /.well-known/oauth-authorization-server.
 * The CLI is a public client (token_endpoint_auth_method=none).
 */
export async function getConfig(issuer: string): Promise<client.Configuration> {
  const discoveryUrl = new URL(
    "/.well-known/oauth-authorization-server",
    issuer.endsWith("/") ? issuer : issuer + "/",
  );
  // openid-client rejects non-HTTPS issuers by default outside of the
  // AllowInsecureRequests hook — allow http for localhost dev.
  const options: client.DiscoveryRequestOptions = {};
  if (discoveryUrl.protocol === "http:") {
    options.execute = [client.allowInsecureRequests];
  }
  return await client.discovery(discoveryUrl, CLI_CLIENT_ID, undefined, client.None(), options);
}

export async function initiate(
  config: client.Configuration,
  scope: string = CLI_SCOPE,
  extraParams?: Record<string, string>,
): Promise<client.DeviceAuthorizationResponse> {
  return await client.initiateDeviceAuthorization(config, { scope, ...(extraParams ?? {}) });
}

export async function poll(
  config: client.Configuration,
  da: client.DeviceAuthorizationResponse,
  opts: client.DeviceAuthorizationGrantPollOptions = {},
): Promise<client.TokenEndpointResponse & client.TokenEndpointResponseHelpers> {
  return await client.pollDeviceAuthorizationGrant(config, da, undefined, opts);
}

export async function refresh(
  config: client.Configuration,
  refreshToken: string,
): Promise<client.TokenEndpointResponse & client.TokenEndpointResponseHelpers> {
  return await client.refreshTokenGrant(config, refreshToken);
}
