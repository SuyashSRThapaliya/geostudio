// Thin wrapper around the Flask API. Every function throws an Error whose
// message is the user-facing text sent by the backend.

async function request(path, options = {}) {
  const res = await fetch(path, options);
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const msg = body?.error || `Request failed (${res.status})`;
    throw new Error(body?.details ? `${msg} ${body.details.join("; ")}` : msg);
  }
  return body;
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body ?? {}),
});

export const api = {
  listProjects: () => request("/api/projects"),
  createProject: (name) => request("/api/projects", json("POST", { name })),
  getProject: (pid) => request(`/api/projects/${pid}`),

  uploadImage: (pid, file) => {
    const form = new FormData();
    form.append("file", file);
    return request(`/api/projects/${pid}/images`, { method: "POST", body: form });
  },
  previewUrl: (iid, bands) => `/api/images/${iid}/preview.png?bands=${bands.join(",")}`,
  pixel: (iid, row, col) => request(`/api/images/${iid}/pixel?row=${row}&col=${col}`),

  addClass: (pid, name, color) => request(`/api/projects/${pid}/classes`, json("POST", { name, color })),
  addPoint: (pid, image_id, class_id, row, col) =>
    request(`/api/projects/${pid}/points`, json("POST", { image_id, class_id, row, col })),
  removePoint: (pid, pointId) => request(`/api/projects/${pid}/points/${pointId}`, { method: "DELETE" }),
  undo: (pid) => request(`/api/projects/${pid}/undo`, json("POST")),

  trainingSetUrl: (pid, iid, format = "json") =>
    `/api/projects/${pid}/images/${iid}/training-set${format === "csv" ? "?format=csv" : ""}`,
};

export const SUPPORTED = [".tif", ".tiff"];
export const isSupported = (name) => SUPPORTED.some((ext) => name.toLowerCase().endsWith(ext));
