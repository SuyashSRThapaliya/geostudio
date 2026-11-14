import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

function progress(p) {
  if (p.images === 0) return { text: "No image yet", tone: "idle" };
  if (p.annotations === 0) return { text: "Ready to label", tone: "idle" };
  if (p.open_requests > 0) return { text: `${p.open_requests} correction request${p.open_requests > 1 ? "s" : ""} to review`, tone: "warn" };
  if (p.models === 0) return { text: "Labeling", tone: "busy" };
  if (p.verified_images === p.images) return { text: "Verified", tone: "done" };
  return { text: "Model trained · needs verification", tone: "busy" };
}

export default function ProjectScreen({ onOpen }) {
  const [projects, setProjects] = useState(null);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [renaming, setRenaming] = useState(null); // {id, name}
  const importInput = useRef(null);

  const refresh = () => api.listProjects().then(setProjects).catch((e) => setError(e.message));
  useEffect(() => { refresh(); }, []);

  const attempt = async (fn) => {
    setError(null);
    try { return await fn(); } catch (e) { setError(e.message); return null; }
  };

  const create = async (e) => {
    e.preventDefault();
    const p = await attempt(() => api.createProject(name.trim() || "Untitled project"));
    if (p) onOpen(p.project_id);
  };
  const importFile = async (file) => {
    if (!file) return;
    const p = await attempt(() => api.importProject(file));
    importInput.current.value = "";
    if (p) refresh();
  };
  const remove = async (p) => {
    if (!window.confirm(`Delete "${p.name}" with its images and labels? This cannot be undone.`)) return;
    await attempt(() => api.deleteProject(p.project_id));
    refresh();
  };
  const saveName = async (e) => {
    e.preventDefault();
    await attempt(() => api.renameProject(renaming.id, renaming.name));
    setRenaming(null);
    refresh();
  };

  const shown = (projects || []).filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>Training Selection</h1>
          <p>Label satellite images, train a model, and check its predictions.</p>
        </div>
      </header>

      <section className="home-actions">
        <form onSubmit={create} className="new-project">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name" aria-label="New project name" />
          <button className="primary" type="submit">Create project</button>
        </form>
        <button onClick={() => importInput.current.click()}>Import project…</button>
        <input ref={importInput} type="file" accept=".zip" hidden onChange={(e) => importFile(e.target.files?.[0])} />
        <span className="spacer" />
        <input className="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Search projects" aria-label="Search projects" />
      </section>

      {error && <div className="notice error" role="alert">{error}</div>}

      <section className="project-list">
        <h2>{query ? "Search results" : "Recent projects"}</h2>
        {projects === null && !error && <p className="muted">Loading…</p>}
        {projects && shown.length === 0 && (
          <p className="muted">{projects.length === 0 ? "No projects yet. Type a name above and create your first one." : "No project matches your search."}</p>
        )}
        {shown.map((p) => {
          const st = progress(p);
          return (
            <article key={p.project_id} className="project-row">
              <div className="project-main">
                {renaming?.id === p.project_id ? (
                  <form onSubmit={saveName} className="rename">
                    <input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                    <button type="submit">Save</button>
                    <button type="button" onClick={() => setRenaming(null)}>Cancel</button>
                  </form>
                ) : (
                  <button className="project-name" onClick={() => onOpen(p.project_id)}>{p.name}</button>
                )}
                <div className="project-meta">
                  {p.images} image{p.images !== 1 && "s"} · {p.labels} label{p.labels !== 1 && "s"} · {p.annotations} annotation{p.annotations !== 1 && "s"}
                  {p.pending > 0 && ` · ${p.pending} to review`} · {p.models} model{p.models !== 1 && "s"} · saved {when(p.updated_at)}
                </div>
              </div>
              <span className={`status ${st.tone}`}>{st.text}</span>
              <div className="project-buttons">
                <button className="primary" onClick={() => onOpen(p.project_id)}>Open</button>
                <button onClick={() => setRenaming({ id: p.project_id, name: p.name })}>Rename</button>
                <a className="button" href={api.exportProjectUrl(p.project_id)} download>Export</a>
                <button className="danger" onClick={() => remove(p)}>Delete</button>
              </div>
            </article>
          );
        })}
      </section>
    </div>
  );
}
