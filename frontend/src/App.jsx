import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isSupported } from "./api.js";
import ImageViewer from "./components/ImageViewer.jsx";
import ClassPanel from "./components/ClassPanel.jsx";
import { ImageInfo, PixelDetails, PointList } from "./components/InfoPanel.jsx";

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

function defaultBands(image) {
  if (!image) return [1, 2, 3];
  const idx = (n) => image.bands.find((b) => b.name.toLowerCase() === n)?.index;
  const r = idx("red"), g = idx("green"), b = idx("blue");
  if (r && g && b) return [r, g, b];
  return image.band_count >= 3 ? [1, 2, 3] : [1, 1, 1];
}

export default function App() {
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [imageId, setImageId] = useState(null);
  const [bands, setBands] = useState([1, 2, 3]);
  const [selectedClassId, setSelectedClassId] = useState(null);
  const [hiddenClasses, setHiddenClasses] = useState(new Set());
  const [labelOpacity, setLabelOpacity] = useState(1);
  const [selectedPointId, setSelectedPointId] = useState(null);
  const [hover, setHover] = useState(null);
  const [zoom, setZoom] = useState(null);
  const [message, setMessage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);

  const say = (type, text) => setMessage({ type, text });
  const fail = (e) => say("error", e.message);

  // ---------- loading ----------
  const loadProject = useCallback(async (pid) => {
    const p = await api.getProject(pid);
    setProject(p);
    store.set("training.projectId", pid);
    const ids = Object.keys(p.images);
    setImageId((cur) => (cur && p.images[cur] ? cur : ids[ids.length - 1] || null));
    setSelectedClassId((cur) => cur ?? p.classes[0]?.class_id ?? null);
    return p;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        let list = await api.listProjects();
        if (list.length === 0) {
          await api.createProject("My first project");
          list = await api.listProjects();
        }
        setProjects(list);
        const remembered = store.get("training.projectId");
        await loadProject(list.find((p) => p.project_id === remembered)?.project_id || list[0].project_id);
      } catch (e) {
        say("error", `Cannot reach the backend (${e.message}). Is Flask running on port 5000?`);
      }
    })();
  }, [loadProject]);

  const image = project && imageId ? project.images[imageId] : null;
  useEffect(() => setBands(defaultBands(image)), [imageId]); // eslint-disable-line react-hooks/exhaustive-deps

  const points = useMemo(
    () => (project?.points || []).filter((p) => p.image_id === imageId),
    [project, imageId]
  );
  const selectedPoint = points.find((p) => p.point_id === selectedPointId) || null;

  // ---------- actions ----------
  const newProject = async () => {
    const name = window.prompt("Project name", "New project");
    if (!name) return;
    try {
      const p = await api.createProject(name);
      setProjects(await api.listProjects());
      setImageId(null);
      setSelectedClassId(null);
      await loadProject(p.project_id);
    } catch (e) { fail(e); }
  };

  const openFile = async (file) => {
    if (!file) return;
    if (!isSupported(file.name)) {
      say("error", `"${file.name}" is not supported. Please choose a GeoTIFF file (.tif or .tiff).`);
      return;
    }
    setUploading(true);
    say("info", `Loading ${file.name}…`);
    try {
      const img = await api.uploadImage(project.project_id, file);
      await loadProject(project.project_id);
      setImageId(img.image_id);
      say("ok", `Loaded ${img.filename}: ${img.width} × ${img.height} px, ${img.band_count} bands.`);
    } catch (e) { fail(e); }
    finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const addClass = async (name, color) => {
    try {
      const c = await api.addClass(project.project_id, name, color);
      await loadProject(project.project_id);
      setSelectedClassId(c.class_id);
      return true;
    } catch (e) { fail(e); return false; }
  };

  const labelPixel = async (row, col) => {
    if (!selectedClassId) { say("error", "Create or select a class before labeling."); return; }
    try {
      const pt = await api.addPoint(project.project_id, imageId, selectedClassId, row, col);
      await loadProject(project.project_id);
      setSelectedPointId(pt.point_id);
      setMessage(null);
    } catch (e) { fail(e); }
  };

  const removePoint = async (pointId) => {
    try {
      await api.removePoint(project.project_id, pointId);
      await loadProject(project.project_id);
      if (pointId === selectedPointId) setSelectedPointId(null);
      say("info", "Point removed. Press Undo (Ctrl+Z) to bring it back.");
    } catch (e) { fail(e); }
  };

  const undo = useCallback(async () => {
    if (!project) return;
    try {
      const r = await api.undo(project.project_id);
      await loadProject(project.project_id);
      say("info", r.message);
    } catch (e) { fail(e); }
  }, [project, loadProject]);

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && project?.classes[n - 1]) setSelectedClassId(project.classes[n - 1].class_id);
      if ((e.key === "Delete" || e.key === "Backspace") && selectedPointId) removePoint(selectedPointId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // re-bind every render so handlers see fresh state

  const toggleVisible = (cid) =>
    setHiddenClasses((s) => { const n = new Set(s); n.has(cid) ? n.delete(cid) : n.add(cid); return n; });

  const nir = image?.bands.find((b) => b.name.toLowerCase() === "nir")?.index;
  const activeClass = project?.classes.find((c) => c.class_id === selectedClassId);

  return (
    <div className="app">
      <header className="toolbar">
        <strong className="brand">Training Selection</strong>
        <select value={project?.project_id || ""} aria-label="Project"
                onChange={(e) => { setImageId(null); setSelectedClassId(null); loadProject(e.target.value).catch(fail); }}>
          {projects.map((p) => <option key={p.project_id} value={p.project_id}>{p.name}</option>)}
        </select>
        <button onClick={newProject}>New project</button>
        <span className="sep" />
        <button onClick={() => fileInput.current?.click()} disabled={!project || uploading}>
          {uploading ? "Loading…" : "Open TIFF…"}
        </button>
        <input ref={fileInput} type="file" accept=".tif,.tiff,image/tiff" hidden
               onChange={(e) => openFile(e.target.files?.[0])} />
        {project && Object.keys(project.images).length > 1 && (
          <select value={imageId || ""} onChange={(e) => setImageId(e.target.value)} aria-label="Image">
            {Object.values(project.images).map((i) => <option key={i.image_id} value={i.image_id}>{i.filename}</option>)}
          </select>
        )}
        {image && (
          <>
            <span className="sep" />
            <label className="bands">Display
              {["R", "G", "B"].map((ch, i) => (
                <select key={ch} value={bands[i]} aria-label={`${ch} channel`}
                        onChange={(e) => setBands((b) => b.map((v, j) => (j === i ? Number(e.target.value) : v)))}>
                  {image.bands.map((b) => <option key={b.index} value={b.index}>{ch}: {b.name}</option>)}
                </select>
              ))}
            </label>
            <button onClick={() => setBands(defaultBands(image))}>True colour</button>
            {nir && <button onClick={() => setBands([nir, defaultBands(image)[0], defaultBands(image)[1]])}>False colour (NIR)</button>}
          </>
        )}
        <span className="spacer" />
        <label className="opacity">Label opacity
          <input type="range" min="0.1" max="1" step="0.05" value={labelOpacity}
                 onChange={(e) => setLabelOpacity(Number(e.target.value))} />
        </label>
        <button onClick={undo} disabled={!project?.can_undo} title="Undo last labeling action (Ctrl+Z)">↶ Undo</button>
        {image && (
          <>
            <a className="button" href={api.trainingSetUrl(project.project_id, imageId)} download>Export JSON</a>
            <a className="button" href={api.trainingSetUrl(project.project_id, imageId, "csv")} download>CSV</a>
          </>
        )}
      </header>

      <main className="workspace">
        <aside className="sidebar left">
          {project && (
            <ClassPanel classes={project.classes} points={points} selectedClassId={selectedClassId}
                        onSelect={setSelectedClassId} onAdd={addClass}
                        hiddenClasses={hiddenClasses} onToggleVisible={toggleVisible} />
          )}
          <ImageInfo image={image} />
        </aside>

        <ImageViewer
          imageUrl={image ? api.previewUrl(image.image_id, bands) : null}
          info={image}
          points={points}
          classes={project?.classes || []}
          hiddenClasses={hiddenClasses}
          labelOpacity={labelOpacity}
          selectedPointId={selectedPointId}
          labelingEnabled={!!activeClass}
          onPixelClick={labelPixel}
          onHover={setHover}
          onViewChange={({ zoom: z }) => setZoom(z)}
        />

        <aside className="sidebar right">
          <PixelDetails point={selectedPoint} classes={project?.classes || []} />
          <PointList points={points} classes={project?.classes || []} selectedPointId={selectedPointId}
                     onSelect={setSelectedPointId} onRemove={removePoint} />
        </aside>
      </main>

      {message && (
        <div className={`banner ${message.type}`} role={message.type === "error" ? "alert" : "status"}>
          {message.text}
          <button className="link" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <footer className="statusbar">
        <span>{activeClass ? <>Labeling as <b style={{ color: activeClass.color }}>{activeClass.name}</b> — click to add a point, drag to pan, scroll to zoom</> : "Select a class to start labeling"}</span>
        <span className="spacer" />
        {hover && <span>row {hover.row}, col {hover.col} · pixel ID {hover.row * image.width + hover.col}</span>}
        {zoom != null && <span>1 image px = {zoom.toFixed(2)} screen px ({Math.round(zoom * 100)}%)</span>}
        {image && <span>scale factor ×{image.preview_scale}</span>}
      </footer>
    </div>
  );
}
