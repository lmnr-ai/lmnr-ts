import { LaminarClient } from "@lmnr-ai/client";

import type { GlobalOpts } from "../../auth/with-client";
import { readLocalProjectFile } from "../../utils/local-project-file";
import { outputJson } from "../../utils/output";
import { renderTable } from "../../utils/table";

/**
 * List the projects the signed-in user can access (discovery — no project
 * scope). Pure handler: the `withUserToken` wrapper resolves the user-token
 * client and owns the error envelope.
 */
export const handleProjectsList = async (
  client: LaminarClient,
  opts: GlobalOpts,
): Promise<void> => {
  const projects = await client.cli.listProjects();

  // Mark the project linked to the current directory (.lmnr/project.json).
  const linked = (await readLocalProjectFile())?.projectId;

  if (opts.json) {
    outputJson(projects.map((p) => ({ ...p, linked: p.id === linked })));
    return;
  }

  if (projects.length === 0) {
    console.log("No projects found. Create one in the dashboard, then run `lmnr-cli setup`.");
    return;
  }

  const columns = ["", "Workspace", "Project", "Project ID"];
  const rows = projects.map((p) => [p.id === linked ? "●" : "", p.workspaceName, p.name, p.id]);
  console.log(renderTable(columns, rows));
  console.log(
    linked
      ? "\n● = linked to this directory (lmnr-cli setup). " +
      "Override per-command with --project-id.\n"
      : "\nNot linked here. Run `lmnr-cli setup` in your project directory, " +
      "or pass --project-id.\n",
  );
};
