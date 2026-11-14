// Thin wrapper around the Flask API. Every function throws an Error whose
// message is the user-facing text sent by the backend.

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new Error("Cannot reach the app server. Is the window where you ran 'python run.py' still open?");
  }
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const msg = body?.error || `Request failed (${res.status})`;
    throw new Error(body?.details ? `${msg} ${body.details.join("; ")}` : msg);
  }
  return body;
}

const send = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});
const upload = (file) => {
  const form = new FormData();
  form.append("file", file);
  return { method: "POST", body: form };
};

export const api = {
  listProjects: () => request("/api/projects"),
  createProject: (name) => request("/api/projects", send("POST", { name })),
  getProject: (pid) => request(`/api/projects/${pid}`),
  renameProject: (pid, name) => request(`/api/projects/${pid}`, send("PATCH", { name })),
  deleteProject: (pid) => request(`/api/projects/${pid}`, { method: "DELETE" }),
  importProject: (file) => request("/api/projects/import", upload(file)),
  exportProjectUrl: (pid) => `/api/projects/${pid}/export.zip`,

  uploadImage: (pid, file) => request(`/api/projects/${pid}/images`, upload(file)),
  deleteImage: (pid, iid) => request(`/api/projects/${pid}/images/${iid}`, { method: "DELETE" }),
  setVerified: (pid, iid, verified) =>
    request(`/api/projects/${pid}/images/${iid}`, send("PATCH", { verification_status: verified ? "verified" : "needs_verification" })),
  previewUrl: (pid, iid, bands) => `/api/projects/${pid}/images/${iid}/preview.png?bands=${bands.join(",")}`,
  pixel: (pid, iid, row, col) => request(`/api/projects/${pid}/images/${iid}/pixel?row=${row}&col=${col}`),

  addLabel: (pid, name, color, parent_id = null) => request(`/api/projects/${pid}/labels`, send("POST", { name, color, parent_id })),
  updateLabel: (pid, lid, changes) => request(`/api/projects/${pid}/labels/${lid}`, send("PATCH", changes)),
  deleteLabel: (pid, lid, force) => request(`/api/projects/${pid}/labels/${lid}${force ? "?force=1" : ""}`, { method: "DELETE" }),

  addAnnotation: (pid, image_id, type, vertices, label_id) =>
    request(`/api/projects/${pid}/annotations`, send("POST", { image_id, type, vertices, label_id })),
  updateAnnotations: (pid, ids, changes) => request(`/api/projects/${pid}/annotations`, send("PATCH", { ids, ...changes })),
  deleteAnnotations: (pid, ids) => request(`/api/projects/${pid}/annotations/delete`, send("POST", { ids })),
  annotationStats: (pid, aid) => request(`/api/projects/${pid}/annotations/${aid}/stats`),
  undo: (pid) => request(`/api/projects/${pid}/undo`, send("POST")),
  redo: (pid) => request(`/api/projects/${pid}/redo`, send("POST")),

  trainingSetUrl: (pid, iid, format, approvedOnly = true) =>
    `/api/projects/${pid}/images/${iid}/training-set?download=1&format=${format}&approved_only=${approvedOnly ? 1 : 0}`,

  train: (pid, level) => request(`/api/projects/${pid}/models/train`, send("POST", { level })),
  predict: (pid, iid, model_version) => request(`/api/projects/${pid}/images/${iid}/predict`, send("POST", { model_version })),
  predictionUrl: (pid, iid, stamp, hide) => `/api/projects/${pid}/images/${iid}/prediction.png?v=${encodeURIComponent(stamp)}&hide=${hide.join(",")}`,
  suggest: (pid, iid, n, strategy) => request(`/api/projects/${pid}/images/${iid}/suggest`, send("POST", { n, strategy })),

  addRequest: (pid, body) => request(`/api/projects/${pid}/correction-requests`, send("POST", body)),
  reviewRequest: (pid, rid, status) => request(`/api/projects/${pid}/correction-requests/${rid}`, send("PATCH", { status })),
  deleteRequest: (pid, rid) => request(`/api/projects/${pid}/correction-requests/${rid}`, { method: "DELETE" }),
};

export const isTiff = (name) => /\.tiff?$/i.test(name);

export const local = {
  get: (k, fallback = null) => { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
