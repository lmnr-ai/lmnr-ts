import { withTask } from './sdk/node-server-sdk'
import { Laminar } from './laminar';

interface ObserveOptions {
    name?: string;
    sessionId?: string;
    userId?: string;
}

/**
 * The main decorator entrypoint for Laminar. This is used to wrap
 * functions and methods to create spans.
 *
 * @param name - Name of the span. Function name is used if not specified.
 * @param user_id - User ID to associate with the span and the following context.
 * @param session_id - Session ID to associate with the span and the following context.
 * @returns Returns the result of the wrapped function.
 * @throws Exception - Re-throws the exception if the wrapped function throws an exception.
 * 
 * @example
 * ```typescript
 * import { observe } from '@lmnr-ai/lmnr';
 * 
 * await observe({ name: 'my_function' }, () => {
 *    // Your code here
 * });
 */
export async function observe<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    {
        name,
        sessionId,
        userId,
    }: ObserveOptions, fn: F, ...args: A): Promise<ReturnType<F>> {

    if (!Laminar.initialized()) {
        throw new Error('Laminar not initialized. Please call Laminar.initialize(projectApiKey) before using observe.');
    };
    let associationProperties = {};
    if (sessionId) {
        associationProperties = { ...associationProperties, "session_id": sessionId };
    }
    if (userId) {
        associationProperties = { ...associationProperties, "user_id": userId };
    }
    return await withTask<A, F>({ name: name ?? fn.name, associationProperties }, fn, ...args);
}
