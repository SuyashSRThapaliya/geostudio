import { useEffect, useState } from "react";
import ProjectScreen from "./ProjectScreen.jsx";
import Workspace from "./Workspace.jsx";

// Pages:  #/            project screen
//         #/project/ID  training / verification workspace
const route = () => window.location.hash.match(/^#\/project\/([\w-]+)/)?.[1] || null;

export default function App() {
  const [projectId, setProjectId] = useState(route());
  useEffect(() => {
    const onHash = () => setProjectId(route());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return projectId
    ? <Workspace key={projectId} projectId={projectId} onExit={() => { window.location.hash = "#/"; }} />
    : <ProjectScreen onOpen={(id) => { window.location.hash = `#/project/${id}`; }} />;
}
