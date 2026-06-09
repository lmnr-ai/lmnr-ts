import { LaminarClient } from "@lmnr-ai/client";
import { errorMessage } from "@lmnr-ai/types";

import { resolveUserToken } from "../../auth/resolve";
import { initializeLogger } from "../../utils/logger";
import { outputJson, outputJsonError } from "../../utils/output";
import { readProjectLink } from "../../utils/project-link";
import { renderTable } from "../../utils/table";

const logger = initializeLogger();

interface ProjectsOptions {
  baseUrl?: string;
  port?: number;
  json?: boolean;
}

export const handleProjectsList = async (options: ProjectsOptions): Promise<void> => {
  try {
    const auth = await resolveUserToken({ baseUrl: options.baseUrl, port: options.port });
    const client = new LaminarClient({
      projectApiKey: auth.bearer,
      baseUrl: auth.baseUrl,
      port: options.port,
    });
    const projects = await client.cli.listProjects();

    // Mark the project linked to the current directory (.lmnr/project.json).
    const linked = (await readProjectLink())?.projectId;

    if (options.json) {
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
  } catch (error) {
    if (options.json) outputJsonError(error);
    logger.error(`Failed to list projects: ${errorMessage(error)}`);
    process.exit(1);
  }
};
