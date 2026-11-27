/**
 * Observe-level mocks for evals: when `LMNR_MOCK_URL` is set (an eval trial
 * with mocks), an observed function whose key is mocked is answered by the
 * trial's mock server instead of running. Protocol: `spec/lmnr-mock/`.
 */
export { MOCK_FAILURE, MockedError } from "./errors";
export { mockCall } from "./intercept";
