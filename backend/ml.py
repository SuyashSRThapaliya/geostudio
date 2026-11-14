"""A simple model so the whole loop can be tried: train -> predict -> suggest -> verify.

Random forest on the original band values (plus NDVI when Red and NIR exist).
This stands in for the Model / Learning & Tools group's engine and uses the same
agreed data (label_processing.collect_examples).
"""
from __future__ import annotations

import io

import joblib
import numpy as np
import rasterio
from PIL import Image
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold, cross_val_predict

import label_processing as lp
import tiff_service as tiff
from store import Invalid, ProjectStore, new_id, now

MAX_PER_CLASS = 20_000
N_TREES = 60


def _features(values: np.ndarray, names: list[str]) -> tuple[np.ndarray, list[str]]:
    x = values.astype(np.float32)
    low = [n.lower() for n in names]
    feats = list(names)
    if "red" in low and "nir" in low:
        red, nir = x[:, low.index("red")], x[:, low.index("nir")]
        ndvi = (nir - red) / np.maximum(nir + red, 1e-6)
        x = np.column_stack([x, ndvi])
        feats.append("NDVI")
    return x, feats


def _forest() -> RandomForestClassifier:
    return RandomForestClassifier(n_estimators=N_TREES, n_jobs=-1, random_state=0, class_weight="balanced")


def train(store: ProjectStore, project: dict, level: str = "class") -> dict:
    """level='class' trains on label classes (top level); 'label' trains on the exact labels."""
    if level not in ("class", "label"):
        raise Invalid("level must be 'class' or 'label'.")
    pid = project["project_id"]
    xs, ys, groups, band_ref, skipped, conflicts = [], [], [], None, [], 0
    for g, (iid, img) in enumerate(project["images"].items()):
        ex = lp.collect_examples(project, iid, store.image_path(pid, iid), approved_only=True)
        if ex["pixel_ids"].size == 0:
            continue
        names = [b["name"] for b in img["bands"]]
        if band_ref is None:
            band_ref = names
        elif names != band_ref:
            skipped.append(img["filename"])
            continue
        xs.append(ex["values"])
        ys.append(ex["class_ids"] if level == "class" else ex["label_ids"])
        groups.append(g * 1_000_000 + ex["ann_index"])
        conflicts += ex["conflicts"]
    if not xs:
        raise Invalid("There are no approved labels yet. Label some pixels first.")
    values, y, groups = np.concatenate(xs), np.concatenate(ys), np.concatenate(groups)
    classes, counts = np.unique(y, return_counts=True)
    if classes.size < 2:
        raise Invalid("The model needs examples of at least 2 different classes.")

    rng = np.random.default_rng(0)
    keep = np.concatenate([rng.permutation(np.nonzero(y == c)[0])[:MAX_PER_CLASS] for c in classes])
    values, y, groups = values[keep], y[keep], groups[keep]
    x, feats = _features(values, band_ref)

    names = {l["label_id"]: l["name"] for l in project["labels"]}
    metrics = _evaluate(x, y, groups, classes, names)
    clf = _forest().fit(x, y)

    version = f"v{len(project['models']) + 1}"
    meta = {
        "model_id": f"rf_{pid}", "model_version": version, "trained_at": now(),
        "algorithm": f"Random forest ({N_TREES} trees)", "level": level,
        "bands": band_ref, "features": feats,
        "classes": [{"class_id": int(c), "name": names[int(c)], "examples": int(n)} for c, n in zip(classes, counts)],
        "examples_used": int(y.size), "conflicting_pixels_excluded": conflicts,
        "skipped_images": skipped, "metrics": metrics,
    }
    path = store.model_path(pid, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"clf": clf, "meta": meta}, path)
    project["models"].append(meta)
    return meta


def _evaluate(x, y, groups, classes, names) -> dict | None:
    """Cross-validated confusion matrix. Pixels from one drawn shape stay together when possible."""
    min_pixels = min(int((y == c).sum()) for c in classes)
    if min_pixels < 4:
        return None
    min_groups = min(len(np.unique(groups[y == c])) for c in classes)
    if min_groups >= 2:
        k = min(5, min_groups)
        cv, method = StratifiedGroupKFold(n_splits=k), (
            f"{k}-fold cross-validation; all pixels of one drawn shape are kept in the same fold")
        pred = cross_val_predict(_forest(), x, y, groups=groups, cv=cv)
    else:
        k = min(5, min_pixels)
        cv, method = StratifiedKFold(n_splits=k, shuffle=True, random_state=0), (
            f"{k}-fold cross-validation on pixels. Some classes have only one drawn shape, so neighbouring "
            "pixels are in both training and test data and this score is optimistic")
        pred = cross_val_predict(_forest(), x, y, cv=cv)
    cm = confusion_matrix(y, pred, labels=classes)
    prec, rec, _, _ = precision_recall_fscore_support(y, pred, labels=classes, zero_division=0)
    return {
        "method": method, "accuracy": round(float((pred == y).mean()), 4),
        "labels": [{"class_id": int(c), "name": names[int(c)]} for c in classes],
        "confusion_matrix": cm.tolist(),
        "precision": [round(float(v), 3) for v in prec], "recall": [round(float(v), 3) for v in rec],
        "note": "Measured on your own labeled pixels, not on independent data.",
    }


def _load(store: ProjectStore, project: dict, version: str | None):
    if not project["models"]:
        raise Invalid("Train a model first.")
    version = version or project["models"][-1]["model_version"]
    path = store.model_path(project["project_id"], version)
    if not path.exists():
        raise Invalid(f"Model {version} was not found.")
    saved = joblib.load(path)
    return saved["clf"], saved["meta"]


def predict(store: ProjectStore, project: dict, image_id: str, version: str | None = None) -> dict:
    clf, meta = _load(store, project, version)
    pid = project["project_id"]
    img = project["images"][image_id]
    have = [b["name"] for b in img["bands"]]
    missing = [b for b in meta["bands"] if b not in have]
    if missing:
        raise Invalid(f"This image cannot be used with model {meta['model_version']}: it has no "
                      f"{', '.join(missing)} band. The model needs: {', '.join(meta['bands'])}. "
                      "Choose another image or train a model on this image's bands.")
    indexes = [have.index(b) + 1 for b in meta["bands"]]
    h, w = img["height"], img["width"]
    cls = np.zeros((h, w), dtype=np.uint16)
    conf = np.zeros((h, w), dtype=np.uint8)
    with rasterio.open(store.image_path(pid, image_id)) as ds:
        for r0 in range(0, h, 256):
            n = min(256, h - r0)
            block = ds.read(indexes, window=rasterio.windows.Window(0, r0, w, n))
            x, _ = _features(block.reshape(len(indexes), -1).T, meta["bands"])
            proba = clf.predict_proba(x)
            cls[r0:r0 + n] = clf.classes_[proba.argmax(axis=1)].reshape(n, w)
            conf[r0:r0 + n] = np.round(proba.max(axis=1) * 255).reshape(n, w)
    path = store.prediction_path(pid, image_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, cls=cls, conf=conf)
    ids, counts = np.unique(cls, return_counts=True)
    img["prediction"] = {
        "model_id": meta["model_id"], "model_version": meta["model_version"], "trained_at": meta["trained_at"],
        "predicted_at": now(), "mean_confidence": round(float(conf.mean()) / 255, 3),
        "class_share": {str(int(i)): round(float(c) / cls.size, 4) for i, c in zip(ids, counts)},
    }
    img["verification"] = {"status": "needs_verification", "verified_at": None}
    return img["prediction"]


def load_prediction(store: ProjectStore, project: dict, image_id: str):
    path = store.prediction_path(project["project_id"], image_id)
    if not project["images"][image_id].get("prediction") or not path.exists():
        raise Invalid("Run the model on this image first.")
    with np.load(path) as z:
        return z["cls"], z["conf"]


def overlay_png(store: ProjectStore, project: dict, image_id: str, hidden: set[int]) -> bytes:
    """Predicted classes as a coloured, transparent-background PNG at preview resolution."""
    cls, _ = load_prediction(store, project, image_id)
    h, w = cls.shape
    scale = max(1.0, max(w, h) / tiff.MAX_PREVIEW_SIDE)
    rows = np.minimum((np.arange(round(h / scale)) * scale).astype(int), h - 1)
    cols = np.minimum((np.arange(round(w / scale)) * scale).astype(int), w - 1)
    small = cls[np.ix_(rows, cols)]
    lut = np.zeros((int(cls.max()) + 1, 4), dtype=np.uint8)
    lut[:, :3], lut[:, 3] = 128, 255
    for lab in project["labels"]:
        if lab["label_id"] < len(lut):
            c = lab["color"].lstrip("#")
            lut[lab["label_id"], :3] = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
            if lab["label_id"] in hidden:
                lut[lab["label_id"], 3] = 0
    buf = io.BytesIO()
    Image.fromarray(lut[small], mode="RGBA").save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def predicted_at(store: ProjectStore, project: dict, image_id: str, row: int, col: int) -> dict | None:
    try:
        cls, conf = load_prediction(store, project, image_id)
    except Invalid:
        return None
    names = {l["label_id"]: l["name"] for l in project["labels"]}
    cid = int(cls[row, col])
    return {"class_id": cid, "class_name": names.get(cid, f"class {cid}"),
            "confidence": round(float(conf[row, col]) / 255, 3),
            "model_version": project["images"][image_id]["prediction"]["model_version"]}


def suggest(store: ProjectStore, project: dict, image_id: str, n: int = 20, strategy: str = "uncertain") -> list[dict]:
    """Propose labels for unlabeled pixels. They are 'pending' until a person reviews them."""
    cls, conf = load_prediction(store, project, image_id)
    img = project["images"][image_id]
    h, w = cls.shape
    n = max(1, min(int(n), 500))
    taken = set()
    for a in project["annotations"]:
        if a["image_id"] == image_id:
            r, c = lp.shape_pixels(a["type"], a["vertices"], w, h)
            taken.update((r * w + c).tolist())
    rng = np.random.default_rng()
    cand = rng.choice(h * w, size=min(h * w, 20_000), replace=False)
    cand = cand[~np.isin(cand, np.fromiter(taken, dtype=np.int64, count=len(taken)))]
    if strategy == "uncertain":   # least confident first: these teach the model the most
        cand = cand[np.argsort(conf.ravel()[cand], kind="stable")]
    cand = np.sort(cand[:n])
    rows, cols = cand // w, cand % w
    values = tiff.read_pixels(store.image_path(project["project_id"], image_id), rows, cols)
    pred = img["prediction"]
    xs = ys = None
    if img.get("transform"):
        xs, ys = lp.map_xy(img["transform"], rows, cols)
    out = []
    for k in range(cand.size):
        r, c = int(rows[k]), int(cols[k])
        out.append({
            "annotation_id": new_id("sg"), "image_id": image_id, "type": "point", "vertices": [[r, c]],
            "label_id": int(cls[r, c]), "pixel_count": 1, "pixel_id": int(cand[k]),
            "bands": [{"index": b["index"], "name": b["name"], "value": values[k, i].item()}
                      for i, b in enumerate(img["bands"])],
            "map": {"x": float(xs[k]), "y": float(ys[k]), "crs": img["crs"]} if xs is not None else None,
            "approval_status": "pending", "source": "model_suggestion", "created_at": now(), "note": "",
            "suggestion": {"model_version": pred["model_version"], "predicted_label_id": int(cls[r, c]),
                           "confidence": round(float(conf[r, c]) / 255, 3)},
        })
    return out
