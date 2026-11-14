import { useEffect, useState } from "react";
import { api } from "./api.js";
import { REQUEST_COLORS } from "./Viewer.jsx";

const fmt = (n) => (typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n);
const pct = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);
const STATUS_TEXT = { approved: "approved", pending: "to review", rejected: "rejected", unresolved: "postponed" };
const TYPE_ICON = { point: "•", line: "╱", polygon: "⬠" };
const ACTION_TEXT = { relabel: "Wrong class", add_points: "Add training points here", remove_points: "Remove training points here" };

const Swatch = ({ color }) => <span className="swatch" style={{ background: color }} />;
const Row = ({ k, children }) => (<><dt>{k}</dt><dd>{children}</dd></>);

// =============================================================== images
export function ImagesPanel({ images, imageId, onSelect, onImport, onDelete, busy }) {
  const image = images.find((i) => i.image_id === imageId);
  return (
    <section className="panel">
      <h2>Images <button className="mini" onClick={onImport} disabled={busy}>＋ Import</button></h2>
      {images.length === 0 && <p className="hint">Import a GeoTIFF (.tif / .tiff) to begin.</p>}
      <ul className="image-list">
        {images.map((i) => (
          <li key={i.image_id} className={i.image_id === imageId ? "active" : ""}>
            <button className="link" onClick={() => onSelect(i.image_id)} title={i.filename}>{i.filename}</button>
            {i.verification?.status === "verified" && <span className="badge ok" title="Verified">✓</span>}
            <button className="icon danger-text" title="Remove this image and its labels" onClick={() => onDelete(i)}>✕</button>
          </li>
        ))}
      </ul>
      {image && (
        <dl className="kv small">
          <Row k="Size">{fmt(image.width)} × {fmt(image.height)} px</Row>
          <Row k="Bands">{image.band_count}: {image.bands.map((b) => b.name).join(", ")}</Row>
          <Row k="Type">{image.dtype}</Row>
          <Row k="CRS">{image.crs || "not georeferenced"}</Row>
          {image.pixel_size && <Row k="Pixel">{image.pixel_size[0]} × {image.pixel_size[1]} map units</Row>}
        </dl>
      )}
      {image?.preview_scale > 1 && (
        <p className="warn">Large image: the display is reduced ×{image.preview_scale.toFixed(2)}. Labels and band values still use the original pixels.</p>
      )}
    </section>
  );
}

// =============================================================== annotations
export function AnnotationPanel({ pid, annotations, labels, labelsById, selected, onSelect, onChange, onDelete, onGoTo }) {
  const [filter, setFilter] = useState("all");
  const [stats, setStats] = useState(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    setStats(null);
    setNote(selected?.note || "");
    if (!selected || selected.type === "point") return;
    let live = true;
    api.annotationStats(pid, selected.annotation_id).then((s) => live && setStats(s)).catch(() => {});
    return () => { live = false; };
  }, [selected?.annotation_id, selected?.label_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const count = (s) => annotations.filter((a) => a.approval_status === s).length;
  const shown = annotations.filter((a) => filter === "all" || a.approval_status === filter
    || (filter === "review" && ["pending", "unresolved"].includes(a.approval_status)));
  const sug = selected?.suggestion;

  return (
    <>
      <section className="panel">
        <h2>Selected</h2>
        {!selected && <p className="hint">Pick a drawing tool and click the image, or select an existing label with the arrow tool.</p>}
        {selected && (
          <>
            <dl className="kv">
              <Row k="Type">{TYPE_ICON[selected.type]} {selected.type}{selected.type !== "point" && ` · ${fmt(selected.pixel_count)} pixels`}</Row>
              <Row k="Label">
                <select value={selected.label_id} onChange={(e) => onChange([selected.annotation_id], { label_id: Number(e.target.value), ...(sug ? { approval_status: "approved" } : {}) })}>
                  {labels.map((l) => <option key={l.label_id} value={l.label_id}>{l.parent_id ? "  – " : ""}{l.name}</option>)}
                </select>
              </Row>
              <Row k="Status"><span className={`badge ${selected.approval_status}`}>{STATUS_TEXT[selected.approval_status]}</span></Row>
              {selected.type === "point" && (
                <>
                  <Row k="Pixel">row {selected.vertices[0][0]}, col {selected.vertices[0][1]}</Row>
                  <Row k="Pixel ID">{selected.pixel_id}</Row>
                  {selected.map && <Row k="Map">{fmt(selected.map.x)}, {fmt(selected.map.y)}</Row>}
                  {selected.bands.map((b) => <Row key={b.index} k={`B${b.index} ${b.name}`}>{fmt(b.value)}</Row>)}
                </>
              )}
              {selected.type !== "point" && stats?.annotation_id === selected.annotation_id &&
                stats.bands.map((b) => <Row key={b.index} k={`B${b.index} ${b.name}`}>mean {fmt(b.mean)} <small>({fmt(b.min)}–{fmt(b.max)})</small></Row>)}
            </dl>
            {sug && (
              <div className="suggestion">
                Model {sug.model_version} suggested <b>{labelsById.get(sug.predicted_label_id)?.name || "?"}</b> ({pct(sug.confidence)} confident)
                {sug.predicted_label_id !== selected.label_id && <> · you corrected it</>}
                <div className="btn-row">
                  <button className="primary" onClick={() => onChange([selected.annotation_id], { approval_status: "approved" })} title="Approve (A)">Approve</button>
                  <button onClick={() => onChange([selected.annotation_id], { approval_status: "rejected" })} title="Reject (R)">Reject</button>
                  <button onClick={() => onChange([selected.annotation_id], { approval_status: "unresolved" })} title="Decide later (U)">Postpone</button>
                </div>
                <small>To correct it, choose another label above.</small>
              </div>
            )}
            <input className="note" placeholder="Note (e.g. mixed surface near field edge)" value={note}
                   onChange={(e) => setNote(e.target.value)}
                   onBlur={() => note !== (selected.note || "") && onChange([selected.annotation_id], { note })} />
            <div className="btn-row">
              <button onClick={() => onGoTo(selected)}>Go to</button>
              <button className="danger" onClick={() => onDelete([selected.annotation_id])} title="Delete (Del)">Delete</button>
            </div>
          </>
        )}
      </section>

      <section className="panel grow">
        <h2>On this image ({annotations.length})
          <select className="mini" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter">
            <option value="all">All</option>
            <option value="approved">Approved ({count("approved")})</option>
            <option value="review">To review ({count("pending") + count("unresolved")})</option>
            <option value="rejected">Rejected ({count("rejected")})</option>
          </select>
        </h2>
        {shown.length === 0 && <p className="hint">Nothing here yet.</p>}
        <ul className="ann-list">
          {[...shown].reverse().map((a) => (
            <li key={a.annotation_id} className={a.annotation_id === selected?.annotation_id ? "active" : ""}>
              <button className="link" onClick={() => onSelect(a.annotation_id)} onDoubleClick={() => onGoTo(a)}>
                <Swatch color={labelsById.get(a.label_id)?.color} />
                <span className="grow-text">{labelsById.get(a.label_id)?.name}</span>
                <small>{TYPE_ICON[a.type]} {a.type === "point" ? `r${a.vertices[0][0]} c${a.vertices[0][1]}` : `${fmt(a.pixel_count)} px`}</small>
                {a.approval_status !== "approved" && <span className={`badge ${a.approval_status}`}>{STATUS_TEXT[a.approval_status]}</span>}
              </button>
              <button className="icon danger-text" title="Delete" onClick={() => onDelete([a.annotation_id])}>✕</button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

// =============================================================== model
function ConfusionMatrix({ m }) {
  if (!m) return <p className="hint">Not enough examples to measure accuracy yet (at least 4 pixels per class are needed).</p>;
  const max = Math.max(1, ...m.confusion_matrix.flat());
  return (
    <>
      <p className="metric"><b>{pct(m.accuracy)}</b> accuracy <small>on your labeled pixels</small></p>
      <div className="cm-wrap">
        <table className="cm">
          <thead><tr><th title="rows = your label, columns = model's answer">label ↓ / model →</th>{m.labels.map((l) => <th key={l.class_id}>{l.name}</th>)}<th>recall</th></tr></thead>
          <tbody>
            {m.confusion_matrix.map((row, i) => (
              <tr key={i}><th>{m.labels[i].name}</th>
                {row.map((v, j) => <td key={j} className={i === j ? "diag" : v ? "off" : ""} style={{ "--k": v / max }}>{v}</td>)}
                <td>{pct(m.recall[i])}</td></tr>
            ))}
            <tr><th>precision</th>{m.precision.map((v, i) => <td key={i}>{pct(v)}</td>)}<td /></tr>
          </tbody>
        </table>
      </div>
      <p className="hint small">{m.method}. {m.note}</p>
    </>
  );
}

export function ModelPanel({ project, image, annotations, busy, overlay, setOverlay, onTrain, onPredict, onSuggest, onReviewNext }) {
  const models = project.models;
  const [level, setLevel] = useState("class");
  const [version, setVersion] = useState(null);
  const [n, setN] = useState(20);
  const [strategy, setStrategy] = useState("uncertain");
  const shown = models.find((m) => m.model_version === version) || models[models.length - 1];
  const hasSub = project.labels.some((l) => l.parent_id != null);
  const pred = image?.prediction;
  const sug = annotations.filter((a) => a.source === "model_suggestion");
  const c = (s) => sug.filter((a) => a.approval_status === s).length;

  return (
    <>
      <section className="panel">
        <h2>1 · Train</h2>
        <p className="hint">Uses only approved labels, from every image in this project.</p>
        {hasSub && (
          <label className="field">Train on
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="class">label classes (top level)</option>
              <option value="label">individual labels</option>
            </select>
          </label>
        )}
        <button className="primary wide" disabled={busy} onClick={() => onTrain(level)}>{busy === "train" ? "Training…" : models.length ? "Retrain (new version)" : "Train model"}</button>
        {models.length > 0 && (
          <>
            <label className="field">Version
              <select value={shown.model_version} onChange={(e) => setVersion(e.target.value)}>
                {[...models].reverse().map((m) => (
                  <option key={m.model_version} value={m.model_version}>{m.model_version} · {m.metrics ? pct(m.metrics.accuracy) : "no score"} · {fmt(m.examples_used)} px</option>
                ))}
              </select>
            </label>
            <p className="hint small">{shown.algorithm} · trained {new Date(shown.trained_at).toLocaleString()} · needs bands {shown.bands.join(", ")}
              {shown.conflicting_pixels_excluded > 0 && ` · ${shown.conflicting_pixels_excluded} conflicting pixels left out`}</p>
            <ConfusionMatrix m={shown.metrics} />
          </>
        )}
      </section>

      {models.length > 0 && image && (
        <section className="panel">
          <h2>2 · Predict this image</h2>
          <button className="wide" disabled={busy} onClick={() => onPredict(shown.model_version)}>
            {busy === "predict" ? "Classifying every pixel…" : `Run ${shown.model_version} on ${image.filename}`}
          </button>
          {pred && (
            <>
              <p className="hint small">Showing {pred.model_version} · average confidence {pct(pred.mean_confidence)}</p>
              <label className="check"><input type="checkbox" checked={overlay.on} onChange={(e) => setOverlay({ ...overlay, on: e.target.checked })} /> Show prediction on the image</label>
              <label className="field">Opacity
                <input type="range" min="0.1" max="1" step="0.05" value={overlay.opacity} onChange={(e) => setOverlay({ ...overlay, opacity: Number(e.target.value) })} />
              </label>
              <ul className="share">
                {Object.entries(pred.class_share).sort((a, b) => b[1] - a[1]).map(([id, share]) => {
                  const l = project.labels.find((x) => x.label_id === Number(id));
                  return <li key={id}><Swatch color={l?.color} /> {l?.name || `class ${id}`} <span>{pct(share)}</span></li>;
                })}
              </ul>
            </>
          )}
        </section>
      )}

      {pred && (
        <section className="panel">
          <h2>3 · Model-aided labels</h2>
          <p className="hint">The model proposes labels for pixels you have not labeled. Nothing is used for training until you approve it.</p>
          <div className="btn-row">
            <input type="number" min="1" max="500" value={n} onChange={(e) => setN(e.target.value)} aria-label="How many" style={{ width: 64 }} />
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="uncertain">least certain first</option>
              <option value="random">random</option>
            </select>
            <button disabled={busy} onClick={() => onSuggest(Number(n) || 20, strategy)}>Suggest</button>
          </div>
          {sug.length > 0 && (
            <>
              <p className="tally">
                <span className="badge pending">{c("pending")} to review</span>
                <span className="badge approved">{c("approved")} approved</span>
                <span className="badge rejected">{c("rejected")} rejected</span>
                <span className="badge unresolved">{c("unresolved")} postponed</span>
              </p>
              <button className="wide" disabled={!c("pending") && !c("unresolved")} onClick={onReviewNext} title="N">Review next suggestion →</button>
              <p className="hint small">◆ dashed diamond = suggestion · ● circle = approved. Keys: A approve · R reject · U postpone · N next.</p>
            </>
          )}
        </section>
      )}
    </>
  );
}

// =============================================================== correction requests (shared)
function RequestCard({ r, selected, onSelect, children }) {
  return (
    <li className={`request ${r.status}${selected ? " active" : ""}`}>
      <button className="link" onClick={() => onSelect(r)}>
        <span className="swatch" style={{ background: REQUEST_COLORS[r.requested_action] }} />
        <b>{ACTION_TEXT[r.requested_action]}</b>
        <span className={`badge ${r.status}`}>{r.status}</span>
      </button>
      <p>
        Model {r.model.model_version} said <b>{r.original_prediction.class_name}</b>
        {r.original_prediction.confidence != null && ` (${pct(r.original_prediction.confidence)})`}
        {r.suggested_class && <> → reviewer suggests <b>{r.suggested_class.class_name}</b></>}
        {" · "}{r.location.type === "point" ? `row ${r.location.pixel.row}, col ${r.location.pixel.col}` : "highlighted area"}
      </p>
      <p className="quote">“{r.explanation}”</p>
      {children}
    </li>
  );
}

export function RequestsPanel({ requests, selectedId, onSelect, onReview }) {
  const open = requests.filter((r) => r.status === "open");
  return (
    <section className="panel grow">
      <h2>Correction requests ({open.length} open)</h2>
      <p className="hint">Sent by Verification. They never change your labels: fix the labels yourself, then mark the request.</p>
      {requests.length === 0 && <p className="hint">None for this image.</p>}
      <ul className="request-list">
        {[...open, ...requests.filter((r) => r.status !== "open")].map((r) => (
          <RequestCard key={r.request_id} r={r} selected={r.request_id === selectedId} onSelect={onSelect}>
            <div className="btn-row">
              {r.status === "open" ? (
                <>
                  <button className="primary" onClick={() => onReview(r, "accepted")}>Mark fixed</button>
                  <button onClick={() => onReview(r, "dismissed")}>Dismiss</button>
                </>
              ) : <button onClick={() => onReview(r, "open")}>Reopen</button>}
            </div>
          </RequestCard>
        ))}
      </ul>
    </section>
  );
}

// =============================================================== verification
export function VerifyPanel({ project, image, overlay, setOverlay, inspect, flag, onSubmitFlag, onCancelFlag,
                              requests, selectedId, onSelectRequest, onDeleteRequest, onSetVerified, onPredict, busy }) {
  const [action, setAction] = useState("relabel");
  const [suggested, setSuggested] = useState("");
  const [why, setWhy] = useState("");
  useEffect(() => { setWhy(""); setSuggested(""); }, [flag]);
  const pred = image?.prediction;
  const verified = image?.verification?.status === "verified";
  const model = project.models.find((m) => m.model_version === pred?.model_version);

  if (!image) return <section className="panel"><p className="hint">Open an image first.</p></section>;
  if (!pred) {
    return (
      <section className="panel">
        <h2>Verification</h2>
        <p className="hint">This image has no prediction to check yet.</p>
        {project.models.length
          ? <button className="primary wide" disabled={busy} onClick={() => onPredict(null)}>{busy ? "Classifying…" : "Run the latest model on this image"}</button>
          : <p className="hint">Switch to Training, label some pixels and train a model first.</p>}
      </section>
    );
  }
  return (
    <>
      <section className="panel">
        <h2>Verify prediction <span className={`badge ${verified ? "ok" : "pending"}`}>{verified ? `verified ${new Date(image.verification.verified_at).toLocaleDateString()}` : "needs verification"}</span></h2>
        <p className="hint small">Model {pred.model_version} · average confidence {pct(pred.mean_confidence)}{model?.metrics && ` · ${pct(model.metrics.accuracy)} on training labels`}</p>
        <label className="check"><input type="checkbox" checked={overlay.on} onChange={(e) => setOverlay({ ...overlay, on: e.target.checked })} /> Show prediction (untick to see the original image)</label>
        <label className="field">Opacity
          <input type="range" min="0.1" max="1" step="0.05" value={overlay.opacity} onChange={(e) => setOverlay({ ...overlay, opacity: Number(e.target.value) })} />
        </label>
        <p className="hint small">Tick or untick labels on the left to focus on certain classes.</p>
        <button className={verified ? "wide" : "primary wide"} onClick={() => onSetVerified(!verified)}>{verified ? "Mark as not verified" : "Mark image as verified"}</button>
      </section>

      <section className="panel">
        <h2>Clicked pixel</h2>
        {!inspect && <p className="hint">Click the image with the arrow tool to see what the model predicted there.</p>}
        {inspect && (
          <dl className="kv">
            <Row k="Pixel">row {inspect.row}, col {inspect.col}</Row>
            <Row k="Predicted"><b>{inspect.prediction?.class_name}</b> ({pct(inspect.prediction?.confidence)})</Row>
            {inspect.bands.map((b) => <Row key={b.index} k={`B${b.index} ${b.name}`}>{fmt(b.value)}</Row>)}
          </dl>
        )}
      </section>

      {flag && (
        <section className="panel flag-form">
          <h2>New correction request</h2>
          <p className="hint">{flag.type === "point" ? `Pixel row ${flag.row}, col ${flag.col}` : `Highlighted area (${flag.pixel_vertices.length} corners)`}</p>
          <label className="field">Problem
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              {Object.entries(ACTION_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </label>
          <label className="field">Should be
            <select value={suggested} onChange={(e) => setSuggested(e.target.value)}>
              <option value="">(not sure)</option>
              {project.labels.map((l) => <option key={l.label_id} value={l.label_id}>{l.name}</option>)}
            </select>
          </label>
          <textarea rows={3} placeholder="Explain what you see (required)" value={why} onChange={(e) => setWhy(e.target.value)} autoFocus />
          <div className="btn-row">
            <button className="primary" disabled={why.trim().length < 3}
                    onClick={() => onSubmitFlag({ location: flag, requested_action: action, suggested_label_id: suggested ? Number(suggested) : null, explanation: why })}>Send to Training</button>
            <button onClick={onCancelFlag}>Cancel</button>
          </div>
        </section>
      )}

      <section className="panel grow">
        <h2>Requests sent ({requests.length})</h2>
        {requests.length === 0 && <p className="hint">Found a mistake? Use the flag tools on the left to mark a pixel or an area.</p>}
        <p className="legend">
          {Object.entries(ACTION_TEXT).map(([k, v]) => <span key={k}><span className="swatch" style={{ background: REQUEST_COLORS[k] }} /> {v}</span>)}
        </p>
        <ul className="request-list">
          {[...requests].reverse().map((r) => (
            <RequestCard key={r.request_id} r={r} selected={r.request_id === selectedId} onSelect={onSelectRequest}>
              {r.status === "open" && <div className="btn-row"><button onClick={() => onDeleteRequest(r)}>Withdraw</button></div>}
            </RequestCard>
          ))}
        </ul>
      </section>
    </>
  );
}

// =============================================================== help
export function HelpDialog({ onClose }) {
  const keys = [
    ["V", "Select / move tool"], ["P", "Point"], ["L", "Line"], ["G", "Polygon"], ["Z", "Zoom to a region"], ["M", "Magnifier on / off"],
    ["1 – 9", "Choose a label"], ["Enter or double-click", "Finish a line / polygon"], ["Backspace", "Remove the last corner"], ["Esc", "Cancel the shape"],
    ["Ctrl/Cmd + Z", "Undo"], ["Ctrl/Cmd + Shift + Z or Ctrl + Y", "Redo"], ["Delete", "Delete the selected label"],
    ["Scroll", "Zoom"], ["Drag", "Move the image"], ["0", "Fit image to window"], ["A / R / U / N", "Approve / reject / postpone / next suggestion"],
  ];
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Help">
        <h2>How it works</h2>
        <ol>
          <li><b>Import</b> a GeoTIFF and add <b>labels</b> (＋ inside a label makes sub-labels, e.g. vegetation → grass, trees).</li>
          <li>Pick a label and a tool, then click the image. Lines and polygons are split into pixels automatically.</li>
          <li><b>Model</b> tab: train, run the model on the image, and review its suggested labels.</li>
          <li><b>Verification</b> mode: compare the prediction with the image and flag mistakes. They come back to Training as correction requests.</li>
          <li><b>File → Export</b> gives the training set (JSON or CSV) in the format agreed with the other groups.</li>
        </ol>
        <p>Everything is saved automatically. Brightness, contrast and band choices only change the display, never the data.</p>
        <table className="keys"><tbody>{keys.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
        <button className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
