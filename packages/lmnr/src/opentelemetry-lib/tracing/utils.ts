import {
  Context,
  context,
  createContextKey,
  ROOT_CONTEXT,
} from "@opentelemetry/api";

import { CONTEXT_SPAN_PATH_KEY } from "./context";

// Function to check if a global context manager is already configured
export const isGlobalContextManagerConfigured = () => {
  // Create a temporary context key for testing
  const testKey = createContextKey('lmnr-test-context-manager-check');

  // Create a context with this key
  const testContext = ROOT_CONTEXT.setValue(testKey, 'lmnr-test-value');

  // Try to make this context active
  let isContextManagerWorking = false;

  context.with(testContext, () => {
    // If the context manager is configured and enabled,
    // active() should return our test context
    const activeContext = context.active();
    isContextManagerWorking = activeContext.getValue(testKey) === 'lmnr-test-value';
  });

  return isContextManagerWorking;
};

export const getSpanPath = (entityContext: Context): string | undefined => {
  const path = entityContext.getValue(CONTEXT_SPAN_PATH_KEY) as string | undefined;
  return path ? `${path}` : undefined;
};
