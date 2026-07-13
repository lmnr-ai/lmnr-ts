import { createInterface } from "node:readline/promises";

import { type CliProject, LaminarClient } from "@lmnr-ai/client";

import type { Credentials } from "../auth/credentials";
import { envHttpPort, refreshIfNeeded } from "../auth/resolve";
import { pc } from "./colors";

/**
 * List the projects the logged-in user can access (user-JWT discovery, no
 * project scope). Shared by every command that resolves a project before one is
 * selected (`setup`, `plugin add`).
 */
export const listProjects = async (creds: Credentials, baseUrl: string): Promise<CliProject[]> => {
  const updated = await refreshIfNeeded(creds);
  const client = new LaminarClient({
    baseUrl,
    // setup/plugin have no --port flag; honor LMNR_HTTP_PORT for local self-host.
    port: envHttpPort(),
    auth: { type: "userToken", token: updated.accessToken, projectId: "" },
  });
  return client.cli.listProjects();
};

/**
 * Interactive numbered project picker on stderr (stdout is the --json contract).
 * `intro` is the prompt line so callers can tailor it (e.g. `setup` vs the
 * dedicated-project nudge in `plugin add`).
 */
export const promptProjectChoice = async (
  projects: CliProject[],
  intro: string,
): Promise<CliProject> => {
  process.stderr.write(intro);
  projects.forEach((p, i) => {
    process.stderr.write(`  ${i + 1}) ${p.workspaceName} / ${p.name}\n`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    while (true) {
      const answer = (await rl.question(`Select [1-${projects.length}]: `)).trim();
      const idx = Number.parseInt(answer, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= projects.length) {
        return projects[idx - 1];
      }
      process.stderr.write(`${pc.red("Invalid selection.")}\n`);
    }
  } finally {
    rl.close();
  }
};
