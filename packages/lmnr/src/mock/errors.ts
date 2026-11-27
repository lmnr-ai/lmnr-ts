/**
 * `MockedError.type` of every failure that isn't a handler's own error: an
 * unreachable server, a failed call, a function that can't be mocked.
 */
export const MOCK_FAILURE = "MockFailure";

/**
 * Thrown by an observed function whose call the eval's mock server answered
 * with an error (`mock.Error(type, message)` in the handler; `type` is that
 * type), or whose mocked call failed (`type === "MockFailure"`). `name` is
 * the type too, so it prints as `<type>: <message>` like Python's.
 */
export class MockedError extends Error {
  readonly type: string;

  constructor(type: string, message: string) {
    super(message);
    this.type = type;
    this.name = type;
  }
}
