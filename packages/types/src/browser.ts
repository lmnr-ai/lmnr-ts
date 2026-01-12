/**
 * Options for masking different types of input fields during browser session recording.
 */
export interface MaskInputOptions {
  textarea?: boolean;
  text?: boolean;
  number?: boolean;
  select?: boolean;
  email?: boolean;
  tel?: boolean;
}

/**
 * Options for browser session recording configuration.
 */
export interface SessionRecordingOptions {
  maskInputOptions?: MaskInputOptions;
}
