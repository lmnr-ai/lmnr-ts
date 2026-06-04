import * as client from "openid-client";

export const CLI_CLIENT_ID = "lmnr-cli";
export const CLI_SCOPE = "projects:rw";

/**
 * Discover the AS via /.well-known/openid-configuration.
 * The CLI is a public client (token_endpoint_auth_method=none).
 */
export async function getConfig(issuer: string): Promise<client.Configuration> {
  const issuerUrl = new URL(issuer);
  // Mark the issuer as HTTP-allowed when targeting localhost — openid-client
  // rejects non-HTTPS issuers by default outside of the AllowInsecureRequests
  // hook.
  const options: client.DiscoveryRequestOptions = {};
  if (issuerUrl.protocol === "http:") {
    options.execute = [client.allowInsecureRequests];
  }
  return await client.discovery(issuerUrl, CLI_CLIENT_ID, undefined, client.None(), options);
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
