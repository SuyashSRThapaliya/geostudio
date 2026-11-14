import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, isTiff, local } from "./api.js";
import Viewer from "./Viewer.jsx";
import LabelTree from "./LabelTree.jsx";
import { AnnotationPanel, HelpDialog, ImagesPanel, ModelPanel, RequestsPanel, VerifyPanel } from "./Panels.jsx";

// ---------------------------------------------------------------- small pieces
const Icon = ({ d, fill }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill={fill ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d.split("|").map((p, i) => <path key={i} d={p} />)}
  </svg>
);
const ICONS = {
  pan: "M5 3l14 8-6 2-2 6z",
  point: "M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0",
  line: "M5 19L19 5|M5 19m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0|M19 5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0",
  polygon: "M12 3l8 6-3 10H7L4 9z",
  zoombox: "M3 3h12v12H3z|M15 15l6 6",
  lens: "M10 10m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0|M15 15l6 6|M10 7v6|M7 10h6",
  flag: "M5 21V4|M5 4h12l-2 4 2 4H5",
  flagArea: "M4 4h16v16H4z|M9 16V8h6l-1 2 1 2H9",
  grid: "M4 4h16v16H4z|M4 10h16|M4 15h16|M10 4v16|M15 4v16",
  fit: "M4 9V4h5|M20 9V4h-5|M4 15v5h5|M20 15v5h-5",
};
const TOOLS = {
  training: [["pan", "Select / move (V)"], ["point", "Label a pixel (P)"], ["line", "Label a line (L)"], ["polygon", "Label an area (G)"], ["zoombox", "Zoom to a region (Z)"]],
  verification: [["pan", "Inspect / move (V)"], ["flag-point", "Flag a pixel (P)"], ["flag-polygon", "Flag an area (G)"], ["zoombox", "Zoom to a region (Z)"]],
};
const TOOL_ICON = { "flag-point": "flag", "flag-polygon": "flagArea" };

function Menu({ label, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className={`menu-btn${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>{label}</button>
      {open && <div className="menu-list" onClick={(e) => { if (e.target.closest("[data-close]")) setOpen(false); }}>{children}</div>}
    </div>
  );
}
const Item = ({ onClick, children, keys, disabled, checked, href }) => href
  ? <a className="menu-item" data-close href={href} download>{children}</a>
  : (
    <button className="menu-item" data-close disabled={disabled} onClick={onClick}>
      <span className="tick">{checked ? "✓" : ""}</span><span>{children}</span>{keys && <kbd>{keys}</kbd>}
    </button>
  );

function defaultBands(image) {
  if (!image) return [1, 2, 3];
  const idx = (n) => image.bands.find((b) => b.name.toLowerCase() === n)?.index;
  const r = idx("red"), g = idx("green"), b = idx("blue");
  if (r && g && b) return [r, g, b];
  return image.band_count >= 3 ? [1, 2, 3] : [1, 1, 1];
}

// ---------------------------------------------------------------- workspace
export default function Workspace({ projectId, onExit }) {
  const [project, setProject] = useState(null);
  const [imageId, setImageId] = useState(local.get(`ts.image.${projectId}`));
  const [mode, setMode] = useState("training");
  const [tool, setTool] = useState("pan");
  const [activeLabelId, setActiveLabelId] = useState(null);
  const [hidden, setHidden] = useState(() => new Set(local.get(`ts.hidden.${projectId}`, [])));
  const [alpha, setAlpha] = useState(1);
  const [selectedId, setSelectedId] = useState(null);
  const [bands, setBands] = useState([1, 2, 3]);
  const [display, setDisplay] = useState({ brightness: 100, contrast: 100 });
  const [show, setShow] = useState(() => ({ grid: true, minimap: true, left: true, right: true, rejected: false, ...local.get("ts.show", {}) }));
  const [lens, setLens] = useState(false);
  const [overlay, setOverlay] = useState({ on: false, opacity: 0.55 });
  const [tab, setTab] = useState("labels");
  const [zoom, setZoom] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(null);
  const [help, setHelp] = useState(false);
  const [flag, setFlag] = useState(null);
  const [inspect, setInspect] = useState(null);
  const [selectedRequestId, setSelectedRequestId] = useState(null);
  const viewer = useRef(null);
  const fileInput = useRef(null);
  const hoverRef = useRef(null);

  const say = (type, text) => setMessage({ type, text, at: Date.now() });
  useEffect(() => {
    if (!message || message.type === "error") return;
    const t = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(t);
  }, [message]);

  /** Run an API call; every call answers with the up-to-date project. */
  const act = useCallback(async (fn, working) => {
    if (working) setBusy(working);
    try {
      const r = await fn();
      const p = r?.project ?? r;
      if (p?.project_id) setProject(p);
      return r;
    } catch (e) {
      say("error", e.message);
      return null;
    } finally {
      if (working) setBusy(null);
    }
  }, []);

  useEffect(() => { act(() => api.getProject(projectId)).then((p) => { if (!p) say("error", "This project could not be opened. Go back to Projects."); }); }, [projectId, act]);

  // ---------- derived
  const images = useMemo(() => Object.values(project?.images || {}), [project]);
  const image = project?.images[imageId] || images[images.length - 1] || null;
  const iid = image?.image_id || null;
  useEffect(() => { if (iid) local.set(`ts.image.${projectId}`, iid); }, [iid, projectId]);
  useEffect(() => { setBands(defaultBands(image)); setSelectedId(null); setInspect(null); setFlag(null); }, [iid]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => local.set(`ts.hidden.${projectId}`, [...hidden]), [hidden, projectId]);
  useEffect(() => local.set("ts.show", show), [show]);

  const labels = project?.labels || [];
  const orderedLabels = useMemo(() => labels.filter((l) => l.parent_id == null).flatMap((t) => [t, ...labels.filter((l) => l.parent_id === t.label_id)]), [labels]);
  const labelsById = useMemo(() => new Map(labels.map((l) => [l.label_id, l])), [labels]);
  const hiddenIds = useMemo(() => new Set(labels.filter((l) => hidden.has(l.label_id) || hidden.has(l.parent_id)).map((l) => l.label_id)), [labels, hidden]);
  const activeLabel = labelsById.get(activeLabelId) || orderedLabels[0] || null;
  const annotations = useMemo(() => (project?.annotations || []).filter((a) => a.image_id === iid), [project, iid]);
  const selected = annotations.find((a) => a.annotation_id === selectedId) || null;
  const requests = useMemo(() => (project?.correction_requests || []).filter((r) => r.image_id === iid), [project, iid]);
  const openRequests = requests.filter((r) => r.status === "open").length;
  const counts = useMemo(() => {
    const c = {};
    for (const a of project?.annotations || []) if (a.approval_status === "approved") c[a.label_id] = (c[a.label_id] || 0) + 1;
    return c;
  }, [project]);
  const pid = projectId;

  // ---------- actions
  const importImage = async (file) => {
    if (!file) return;
    if (!isTiff(file.name)) { say("error", `"${file.name}" is not supported. Please choose a GeoTIFF file (.tif or .tiff).`); return; }
    say("info", `Loading ${file.name}…`);
    const r = await act(() => api.uploadImage(pid, file), "upload");
    if (fileInput.current) fileInput.current.value = "";
    if (r) {
      setImageId(r.image_id);
      const im = r.project.images[r.image_id];
      say("ok", `Loaded ${im.filename}: ${im.width} × ${im.height} px, ${im.band_count} bands.`);
    }
  };
  const deleteImage = (im) => {
    if (window.confirm(`Remove "${im.filename}" and every label drawn on it? This cannot be undone.`)) act(() => api.deleteImage(pid, im.image_id));
  };

  const addLabel = async (name, color, parentId) => {
    const r = await act(() => api.addLabel(pid, name, color, parentId));
    if (r) setActiveLabelId(r.label.label_id);
    return !!r;
  };
  const updateLabel = async (id, changes) => !!(await act(() => api.updateLabel(pid, id, changes)));
  const deleteLabel = async (l) => {
    const ids = [l.label_id, ...labels.filter((x) => x.parent_id === l.label_id).map((x) => x.label_id)];
    const used = (project.annotations || []).filter((a) => ids.includes(a.label_id)).length;
    const text = `Delete "${l.name}"${ids.length > 1 ? ` and the ${ids.length - 1} label(s) inside it` : ""}?` +
      (used ? `\n\n${used} annotation(s) use it and will be deleted too. This cannot be undone.` : "");
    if (window.confirm(text)) act(() => api.deleteLabel(pid, l.label_id, true));
  };
  const toggleLabel = (id, kids) => setHidden((h) => {
    const n = new Set(h);
    const hide = !n.has(id);
    for (const x of [id, ...kids]) hide ? n.add(x) : n.delete(x);   // a class resets everything under it
    return n;
  });

  const create = async (type, vertices) => {
    if (!activeLabel) { say("error", "Add a label first (＋ Add in the Labels panel)."); return; }
    const r = await act(() => api.addAnnotation(pid, iid, type, vertices, activeLabel.label_id));
    if (r) { setSelectedId(r.annotation.annotation_id); setMessage(null); }
  };
  const changeAnnotations = (ids, changes) => act(() => api.updateAnnotations(pid, ids, changes));
  const deleteAnnotations = async (ids) => {
    const r = await act(() => api.deleteAnnotations(pid, ids));
    if (r) { if (ids.includes(selectedId)) setSelectedId(null); say("info", "Deleted. Press Undo (Ctrl+Z) to bring it back."); }
  };
  const undo = useCallback(async () => { const r = await act(() => api.undo(pid)); if (r) say("info", r.message); }, [act, pid]);
  const redo = useCallback(async () => { const r = await act(() => api.redo(pid)); if (r) say("info", r.message); }, [act, pid]);
  const goTo = (a) => { setSelectedId(a.annotation_id); const v = a.vertices; viewer.current?.centerOn(v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length); };
  const reviewNext = () => {
    const todo = annotations.filter((a) => a.source === "model_suggestion" && ["pending", "unresolved"].includes(a.approval_status));
    const pendingFirst = [...todo.filter((a) => a.approval_status === "pending"), ...todo.filter((a) => a.approval_status === "unresolved")];
    const next = pendingFirst.find((a) => a.annotation_id !== selectedId) || pendingFirst[0];
    if (next) { setTool("pan"); setTab("labels"); goTo(next); } else say("ok", "No suggestions left to review.");
  };
  const review = async (status) => {
    if (!selected?.suggestion) return;
    await changeAnnotations([selected.annotation_id], { approval_status: status });
  };

  const train = async (level) => { const r = await act(() => api.train(pid, level), "train"); if (r) say("ok", `Model ${r.model.model_version} trained on ${r.model.examples_used.toLocaleString()} pixels${r.model.metrics ? ` · ${Math.round(r.model.metrics.accuracy * 100)}% accuracy` : ""}.`); };
  const predict = async (version) => { const r = await act(() => api.predict(pid, iid, version), "predict"); if (r) { setOverlay((o) => ({ ...o, on: true })); say("ok", "Prediction ready. It is shown on top of the image."); } };
  const suggest = async (n, strategy) => { const r = await act(() => api.suggest(pid, iid, n, strategy), "suggest"); if (r) say("ok", `${r.added} suggestions added. They are not training data until you approve them.`); };

  const submitFlag = async (body) => {
    const r = await act(() => api.addRequest(pid, { image_id: iid, ...body }));
    if (r) { setFlag(null); setTool("pan"); setSelectedRequestId(r.request.request_id); say("ok", "Correction request sent to Training."); }
  };
  const selectRequest = (r) => {
    setSelectedRequestId(r.request_id);
    const v = r.location.type === "point" ? [[r.location.pixel.row, r.location.pixel.col]] : r.location.pixel_vertices;
    viewer.current?.centerOn(v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length);
  };
  const inspectPixel = async (row, col) => {
    if (mode !== "verification" || !image?.prediction) return;
    try { setInspect(await api.pixel(pid, iid, row, col)); } catch { /* ignore */ }
  };
  const switchMode = (m) => { setMode(m); setTool("pan"); setFlag(null); setSelectedId(null); if (m === "verification" && image?.prediction) setOverlay((o) => ({ ...o, on: true })); };

  // ---------- keyboard
  useEffect(() => {
    const onKey = (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || help) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        if (k === "y") { e.preventDefault(); redo(); }
        return;
      }
      const draft = viewer.current?.hasDraft();
      const t = { v: "pan", p: mode === "training" ? "point" : "flag-point", l: mode === "training" ? "line" : null, g: mode === "training" ? "polygon" : "flag-polygon", z: "zoombox" }[k];
      if (t) setTool(t);
      else if (k === "m") setLens((v) => !v);
      else if (k === "0") viewer.current?.fit();
      else if (k === "escape" && !draft) { setSelectedId(null); setFlag(null); }
      else if ((k === "delete" || k === "backspace") && selected && !draft && mode === "training") deleteAnnotations([selected.annotation_id]);
      else if (k === "a") review("approved");
      else if (k === "r") review("rejected");
      else if (k === "u") review("unresolved");
      else if (k === "n") reviewNext();
      else if (/^[1-9]$/.test(k) && orderedLabels[Number(k) - 1]) setActiveLabelId(orderedLabels[Number(k) - 1].label_id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!project) {
    return <div className="loading">{message ? <><p>{message.text}</p><button onClick={onExit}>← Projects</button></> : "Opening project…"}</div>;
  }

  const nir = image?.bands.find((b) => b.name.toLowerCase() === "nir")?.index;
  const rgb = defaultBands(image);
  const overlayUrl = overlay.on && image?.prediction
    ? api.predictionUrl(pid, iid, image.prediction.predicted_at + labels.map((l) => l.color).join(""), [...hiddenIds]) : null;
  const training = mode === "training";

  return (
    <div className="app">
      <header className="menubar">
        <button className="back" onClick={onExit} title="Back to all projects">← Projects</button>
        <strong className="project-title" title={project.name}>{project.name}</strong>
        <Menu label="File">
          <Item onClick={onExit}>Projects…</Item>
          <Item onClick={() => fileInput.current?.click()}>Import image (TIFF)…</Item>
          <hr />
          {image && <Item href={api.trainingSetUrl(pid, iid, "json")}>Export training set (JSON)</Item>}
          {image && <Item href={api.trainingSetUrl(pid, iid, "csv")}>Export training set (CSV for pandas)</Item>}
          {image && <Item href={api.trainingSetUrl(pid, iid, "csv", false)}>Export all labels incl. unreviewed (CSV)</Item>}
          <Item href={api.exportProjectUrl(pid)}>Export project (.zip)</Item>
        </Menu>
        <Menu label="View">
          <Item onClick={() => viewer.current?.fit()} keys="0">Fit image to window</Item>
          <Item onClick={() => viewer.current?.actualSize()}>Actual pixels (1:1)</Item>
          <Item onClick={() => viewer.current?.zoomIn()}>Zoom in</Item>
          <Item onClick={() => viewer.current?.zoomOut()}>Zoom out</Item>
          <hr />
          <Item checked={show.grid} onClick={() => setShow({ ...show, grid: !show.grid })}>Pixel grid (when zoomed in)</Item>
          <Item checked={show.minimap} onClick={() => setShow({ ...show, minimap: !show.minimap })}>Overview map</Item>
          <Item checked={lens} onClick={() => setLens(!lens)} keys="M">Magnifier</Item>
          <Item checked={show.rejected} onClick={() => setShow({ ...show, rejected: !show.rejected })}>Show rejected suggestions</Item>
          <hr />
          <Item onClick={() => setBands(rgb)}>True colour</Item>
          {nir && <Item onClick={() => setBands([nir, rgb[0], rgb[1]])}>False colour (NIR)</Item>}
        </Menu>
        <Menu label="Tools">
          {TOOLS[mode].map(([t, text]) => <Item key={t} checked={tool === t} onClick={() => setTool(t)}>{text}</Item>)}
          <hr />
          <Item onClick={undo} disabled={!project.can_undo} keys="Ctrl+Z">Undo{project.undo_label ? `: ${project.undo_label}` : ""}</Item>
          <Item onClick={redo} disabled={!project.can_redo} keys="Ctrl+Y">Redo{project.redo_label ? `: ${project.redo_label}` : ""}</Item>
        </Menu>
        <Menu label="Model">
          <Item onClick={() => { switchMode("training"); setTab("model"); }}>Open model tools</Item>
          <Item onClick={() => train("class")} disabled={!!busy}>Train a new model version</Item>
          <Item onClick={() => predict(null)} disabled={!!busy || !project.models.length || !image}>Run the latest model on this image</Item>
          <Item onClick={reviewNext}>Review next suggestion</Item>
        </Menu>
        <Menu label="Window">
          <Item checked={show.left} onClick={() => setShow({ ...show, left: !show.left })}>Images and labels panel</Item>
          <Item checked={show.right} onClick={() => setShow({ ...show, right: !show.right })}>Details panel</Item>
        </Menu>
        <button className="menu-btn" onClick={() => setHelp(true)}>Help</button>

        {image && (
          <div className="display-controls">
            {["R", "G", "B"].map((ch, i) => (
              <select key={ch} value={bands[i]} aria-label={`${ch} channel`} title={`Band shown as ${ch}`}
                      onChange={(e) => setBands((b) => b.map((v, j) => (j === i ? Number(e.target.value) : v)))}>
                {image.bands.map((b) => <option key={b.index} value={b.index}>{ch}: {b.name}</option>)}
              </select>
            ))}
            <Menu label="Display ▾">
              <div className="sliders">
                <label>Brightness<input type="range" min="40" max="300" value={display.brightness} onChange={(e) => setDisplay({ ...display, brightness: Number(e.target.value) })} /><span>{display.brightness}%</span></label>
                <label>Contrast<input type="range" min="40" max="300" value={display.contrast} onChange={(e) => setDisplay({ ...display, contrast: Number(e.target.value) })} /><span>{display.contrast}%</span></label>
                <label>Label opacity<input type="range" min="0.1" max="1" step="0.05" value={alpha} onChange={(e) => setAlpha(Number(e.target.value))} /><span>{Math.round(alpha * 100)}%</span></label>
                <button onClick={() => { setDisplay({ brightness: 100, contrast: 100 }); setAlpha(1); }}>Reset</button>
                <small>These only change what you see, never the image data.</small>
              </div>
            </Menu>
          </div>
        )}
        <span className="spacer" />
        <div className="mode-switch" role="tablist" aria-label="Mode">
          <button role="tab" aria-selected={training} className={training ? "on" : ""} onClick={() => switchMode("training")}>Training{openRequests > 0 && <span className="dot">{openRequests}</span>}</button>
          <button role="tab" aria-selected={!training} className={!training ? "on" : ""} onClick={() => switchMode("verification")}>Verification</button>
        </div>
        <button onClick={undo} disabled={!project.can_undo} title={project.undo_label ? `Undo: ${project.undo_label} (Ctrl+Z)` : "Nothing to undo"}aria-label="Undo">↶</button>
        <button onClick={redo} disabled={!project.can_redo} title={project.redo_label ? `Redo: ${project.redo_label} (Ctrl+Y)` : "Nothing to redo"}aria-label="Redo">↷</button>
        <input ref={fileInput} type="file" accept=".tif,.tiff,image/tiff" hidden onChange={(e) => importImage(e.target.files?.[0])} />
      </header>

      <main className={`workspace${show.left ? "" : " no-left"}${show.right ? "" : " no-right"}`}>
        {show.left && (
          <aside className="sidebar left">
            <ImagesPanel images={images} imageId={iid} onSelect={setImageId} onImport={() => fileInput.current?.click()} onDelete={deleteImage} busy={busy === "upload"} />
            <LabelTree labels={labels} counts={counts} activeId={activeLabel?.label_id} hidden={hidden}
                       onActivate={setActiveLabelId} onToggle={toggleLabel} onAdd={addLabel} onUpdate={updateLabel} onDelete={deleteLabel} />
          </aside>
        )}

        <nav className="toolstrip" aria-label="Tools">
          {TOOLS[mode].map(([t, text]) => (
            <button key={t} className={tool === t ? "on" : ""} title={text} aria-label={text} aria-pressed={tool === t} onClick={() => setTool(t)}>
              <Icon d={ICONS[TOOL_ICON[t] || t]} fill={t === "pan" || t === "point"} />
            </button>
          ))}
          <hr />
          <button className={lens ? "on" : ""} title="Magnifier (M)" aria-pressed={lens} onClick={() => setLens(!lens)}><Icon d={ICONS.lens} /></button>
          <button className={show.grid ? "on" : ""} title="Pixel grid" aria-pressed={show.grid} onClick={() => setShow({ ...show, grid: !show.grid })}><Icon d={ICONS.grid} /></button>
          <hr />
          <button title="Zoom in" onClick={() => viewer.current?.zoomIn()}>＋</button>
          <button title="Zoom out" onClick={() => viewer.current?.zoomOut()}>－</button>
          <button title="Fit image to window (0)" onClick={() => viewer.current?.fit()}><Icon d={ICONS.fit} /></button>
          <button title="Actual pixels: 1 image pixel = 1 screen pixel" onClick={() => viewer.current?.actualSize()}>1:1</button>
        </nav>

        <Viewer ref={viewer} image={image} previewUrl={image ? api.previewUrl(pid, iid, bands) : null}
                annotations={training || overlay.on === false ? annotations : []}
                labelsById={labelsById} hiddenIds={hiddenIds} alpha={alpha} showRejected={show.rejected}
                tool={tool} activeColor={activeLabel?.color} selectedId={selectedId}
                overlayUrl={overlayUrl} overlayOpacity={overlay.opacity}
                requests={requests} selectedRequestId={selectedRequestId}
                showGrid={show.grid} lens={lens} minimap={show.minimap} brightness={display.brightness} contrast={display.contrast}
                hoverRef={hoverRef} onView={setZoom} onHint={(t) => say("info", t)} onError={(t) => say("error", t)}
                onCreate={create} onSelect={(id) => training && setSelectedId(id)} onInspect={inspectPixel}
                onFlag={(loc) => { if (!image?.prediction) say("error", "Run the model on this image before flagging mistakes."); else setFlag(loc); }}>
          {!image && (
            <div className="viewer-empty">
              <p>This project has no image yet.</p>
              <button className="primary" onClick={() => fileInput.current?.click()}>Import a GeoTIFF…</button>
              <small>Try <code>sample_data/sample_4band.tif</code> from the project folder.</small>
            </div>
          )}
          {busy && <div className="working">{{ upload: "Loading image…", train: "Training the model…", predict: "Classifying every pixel…", suggest: "Finding suggestions…" }[busy]}</div>}
          {training && activeLabel && image && tool !== "pan" && tool !== "zoombox" && (
            <div className="active-label"><span className="swatch" style={{ background: activeLabel.color }} /> {activeLabel.name}</div>
          )}
        </Viewer>

        {show.right && (
          <aside className="sidebar right">
            {training ? (
              <>
                <div className="tabs" role="tablist">
                  <button role="tab" className={tab === "labels" ? "on" : ""} onClick={() => setTab("labels")}>Labels</button>
                  <button role="tab" className={tab === "model" ? "on" : ""} onClick={() => setTab("model")}>Model</button>
                  <button role="tab" className={tab === "requests" ? "on" : ""} onClick={() => setTab("requests")}>Requests{openRequests > 0 && <span className="dot">{openRequests}</span>}</button>
                </div>
                {tab === "labels" && <AnnotationPanel pid={pid} annotations={annotations} labels={orderedLabels} labelsById={labelsById} selected={selected}
                                                      onSelect={setSelectedId} onChange={changeAnnotations} onDelete={deleteAnnotations} onGoTo={goTo} />}
                {tab === "model" && <ModelPanel project={project} image={image} annotations={annotations} busy={busy} overlay={overlay} setOverlay={setOverlay}
                                                onTrain={train} onPredict={predict} onSuggest={suggest} onReviewNext={reviewNext} />}
                {tab === "requests" && <RequestsPanel requests={requests} selectedId={selectedRequestId} onSelect={selectRequest}
                                                      onReview={(r, status) => act(() => api.reviewRequest(pid, r.request_id, status))} />}
              </>
            ) : (
              <VerifyPanel project={project} image={image} overlay={overlay} setOverlay={setOverlay} inspect={inspect} flag={flag}
                           onSubmitFlag={submitFlag} onCancelFlag={() => setFlag(null)} requests={requests} selectedId={selectedRequestId}
                           onSelectRequest={selectRequest} onDeleteRequest={(r) => act(() => api.deleteRequest(pid, r.request_id))}
                           onSetVerified={(v) => act(() => api.setVerified(pid, iid, v))} onPredict={predict} busy={busy} />
            )}
          </aside>
        )}
      </main>

      {message && (
        <div className={`banner ${message.type}`} role={message.type === "error" ? "alert" : "status"}>
          <span>{message.text}</span>
          <button className="icon" onClick={() => setMessage(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <footer className="statusbar">
        <span>{{
          pan: training ? "Click a label to select it · drag to move · scroll to zoom" : "Click a pixel to see the prediction · drag to move · scroll to zoom",
          point: "Click a pixel to label it", line: "Click to add points · double-click or Enter to finish · Esc to cancel",
          polygon: "Click to add corners · double-click, Enter or click the first corner to finish · Esc to cancel",
          zoombox: "Drag a box to zoom into it", "flag-point": "Click the pixel that looks wrong",
          "flag-polygon": "Click around the area that looks wrong · double-click to finish",
        }[tool]}</span>
        <span className="spacer" />
        <span ref={hoverRef} className="hover" />
        {zoom != null && image && <span title="Size of one image pixel on screen">1 image px = {zoom.toFixed(2)} × {zoom.toFixed(2)} screen px ({Math.round(zoom * 100)}%)</span>}
        {image && <span title="Display reduction for very large images">scale factor ×{image.preview_scale}</span>}
        <span className="saved">✓ Saved</span>
      </footer>
      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
