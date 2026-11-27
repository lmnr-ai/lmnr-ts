/**
 * `MockedError.name` of every failure that isn't a handler's own error: an
 * unreachable server, a failed call, a function that can't be mocked.
 */
export const MOCK_FAILURE = "MockFailure";

/**
 * Thrown by an observed function whose call the eval's mock server answered
 * with an error (`mock.Error(type, message)` in the handler; `name` is that
 * type), or whose mocked call failed (`name === "MockFailure"`).
 */
export class MockedError extends Error {
  constructor(type: string, message: string) {
    super(message);
    this.name = type;
  }
}
