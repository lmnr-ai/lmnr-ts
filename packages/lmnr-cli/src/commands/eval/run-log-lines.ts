/**
 * What a remote run's log shows of Harbor's output. Written by `eval
 * orchestrate` and read back by `eval run --remote`, which is the same CLI
 * version, so the line format below is shared by both.
 */

/** Harbor's job summary lines, which point at files in the orchestrator sandbox. */
const SANDBOX_PATH_LINE =
  /^(Results written to |Inspect results by running `harbor view |Share results by running `harbor upload )/;
/** The Laminar Harbor plugin's log line with the evaluation's link. */
const PLUGIN_LINK_LINE =
  /lmnr\.integrations\.harbor\.plugin::INFO: Laminar evaluation: (\S+)/;
const EVALUATION_LINE = /^Laminar evaluation for task set (.+): (\S+)$/;

export interface EvaluationLink {
  /** The task set's name. */
  taskSet: string;
  url: string;
}

export const formatEvaluationLine = ({ taskSet, url }: EvaluationLink) =>
  `Laminar evaluation for task set ${taskSet}: ${url}`;

export const parseEvaluationLine = (text: string): EvaluationLink | null => {
  const match = EVALUATION_LINE.exec(text);
  return match ? { taskSet: match[1], url: match[2] } : null;
};

/**
 * Rewrites one task set's Harbor output line for the run's log, or drops it
 * (null): sandbox paths go, and the plugin's link becomes an evaluation line
 * the first time it shows up (the plugin logs it again when the job ends).
 * `seen` is shared across the run's task sets.
 */
export const harborLogLine =
  (taskSet: string, seen: Set<string>) =>
  (line: string): string | null => {
    if (SANDBOX_PATH_LINE.test(line)) return null;
    const url = PLUGIN_LINK_LINE.exec(line)?.[1];
    if (!url) return line;
    if (seen.has(url)) return null;
    seen.add(url);
    return formatEvaluationLine({ taskSet, url });
  };
