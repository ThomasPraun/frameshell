import { useCallback, useEffect, useState } from "react";
import type { OpenOutcome, ProjectView } from "../../shared/api.js";
import { Welcome } from "./components/Welcome.js";
import { Workspace } from "./components/Workspace.js";

/** Root: the welcome screen until main attaches a project to this window. */
export function App() {
  const [project, setProject] = useState<ProjectView | null | undefined>(undefined);

  useEffect(() => {
    void window.frameshell.project.current().then(setProject);
  }, []);

  const onOutcome = useCallback((outcome: OpenOutcome) => {
    if (outcome.status === "opened") setProject(outcome.project);
  }, []);

  if (project === undefined) return <div className="boot" />;
  if (!project) return <Welcome onOutcome={onOutcome} />;
  return <Workspace project={project} />;
}
