"""Label processing: turns what the user drew into training pixels.

    point    -> 1 pixel
    line     -> every pixel the line passes through (Bresenham between vertices)
    polygon  -> its outline plus every pixel whose centre is inside

Vertices are [row, col] of the clicked pixels. Only the labeled pixels' band values
are read from the TIFF and sent on to the model (Sprint 1, section 2.5).
"""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import numpy as np
from jsonschema import Draft202012Validator
from rasterio.features import rasterize
from referencing import Registry, Resource

import tiff_service as tiff
from store import Invalid, label_by_id, now, root_label

MAX_PIXELS_PER_SHAPE = 2_000_000
SOURCE_FOR_TYPE = {"point": "manual_point", "line": "line", "polygon": "polygon"}


# ------------------------------------------------------------------ geometry
def _segment(r0: int, c0: int, r1: int, c1: int) -> list[tuple[int, int]]:
    """Bresenham line between two pixels, both ends included."""
    out = []
    dr, dc = abs(r1 - r0), abs(c1 - c0)
    sr, sc = (1 if r0 < r1 else -1), (1 if c0 < c1 else -1)
    err = dc - dr
    r, c = r0, c0
    while True:
        out.append((r, c))
        if r == r1 and c == c1:
            return out
        e2 = 2 * err
        if e2 > -dr:
            err -= dr
            c += sc
        if e2 < dc:
            err += dc
            r += sr


def _path_pixels(vertices: list[list[int]], closed: bool) -> np.ndarray:
    pts = list(vertices) + ([vertices[0]] if closed else [])
    out = []
    for (r0, c0), (r1, c1) in zip(pts[:-1], pts[1:]):
        out.extend(_segment(int(r0), int(c0), int(r1), int(c1)))
    return np.array(out, dtype=np.int64).reshape(-1, 2)


def shape_pixels(kind: str, vertices: list[list[int]], width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    """Unique (rows, cols) covered by a point, line or polygon, clipped to the image."""
    v = np.array(vertices, dtype=np.int64).reshape(-1, 2)
    if kind == "point":
        px = v[:1]
    elif kind == "line":
        px = _path_pixels(v.tolist(), closed=False)
    elif kind == "polygon":
        r0, c0 = v.min(axis=0)
        r1, c1 = v.max(axis=0)
        h, w = int(r1 - r0 + 1), int(c1 - c0 + 1)
        if h * w > MAX_PIXELS_PER_SHAPE * 4:
            raise Invalid("This polygon is too large. Draw a smaller one.")
        # polygon through pixel centres, in a small window around the shape
        ring = [(float(c - c0) + 0.5, float(r - r0) + 0.5) for r, c in v.tolist()]
        ring.append(ring[0])
        mask = rasterize([({"type": "Polygon", "coordinates": [ring]}, 1)], out_shape=(h, w),
                         fill=0, dtype="uint8", all_touched=False).astype(bool)
        edge = _path_pixels(v.tolist(), closed=True)
        mask[edge[:, 0] - r0, edge[:, 1] - c0] = True
        rr, cc = np.nonzero(mask)
        px = np.stack([rr + r0, cc + c0], axis=1)
    else:
        raise Invalid("type must be point, line or polygon.")
    inside = (px[:, 0] >= 0) & (px[:, 0] < height) & (px[:, 1] >= 0) & (px[:, 1] < width)
    px = np.unique(px[inside], axis=0)
    if len(px) > MAX_PIXELS_PER_SHAPE:
        raise Invalid(f"This shape covers {len(px):,} pixels; the limit is {MAX_PIXELS_PER_SHAPE:,}.")
    return px[:, 0], px[:, 1]


def check_vertices(kind: str, vertices, width: int, height: int) -> list[list[int]]:
    need = {"point": 1, "line": 2, "polygon": 3}
    if kind not in need:
        raise Invalid("type must be point, line or polygon.")
    try:
        v = [[int(r), int(c)] for r, c in vertices]
    except (TypeError, ValueError):
        raise Invalid("vertices must be a list of [row, col] pairs.") from None
    v = [p for i, p in enumerate(v) if i == 0 or p != v[i - 1]]  # drop repeated clicks
    if kind == "polygon" and len(v) > 1 and v[0] == v[-1]:
        v.pop()
    if len(v) < need[kind]:
        raise Invalid(f"A {kind} needs at least {need[kind]} different pixel(s).")
    for r, c in v:
        if not (0 <= r < height and 0 <= c < width):
            raise Invalid(f"Pixel (row={r}, col={c}) is outside the {width}x{height} image.")
    return v[:1] if kind == "point" else v


# ------------------------------------------------------------------ examples
def collect_examples(project: dict, image_id: str, tif_path: Path, approved_only: bool = True) -> dict:
    """One row per labeled pixel of one image, with original band values.

    A pixel labeled twice with the same class is kept once. A pixel labeled with two
    DIFFERENT classes is ambiguous, so it is left out and counted in 'conflicts'.
    """
    img = project["images"][image_id]
    w, h = img["width"], img["height"]
    best: dict[int, tuple] = {}   # pixel_id -> (class_id, label_id, annotation index)
    conflicted: set[int] = set()
    anns = [a for a in project["annotations"]
            if a["image_id"] == image_id and (not approved_only or a["approval_status"] == "approved")]
    for i, a in enumerate(anns):
        rows, cols = shape_pixels(a["type"], a["vertices"], w, h)
        cls = root_label(project, a["label_id"])["label_id"]
        for pid in (rows * w + cols).tolist():
            if pid in best:
                if best[pid][0] != cls:
                    conflicted.add(pid)
            else:
                best[pid] = (cls, a["label_id"], i)
    for pid in conflicted:
        best.pop(pid, None)
    pids = np.array(sorted(best), dtype=np.int64)
    rows, cols = pids // w, pids % w
    return {
        "image": img, "annotations": anns,
        "pixel_ids": pids, "rows": rows, "cols": cols,
        "class_ids": np.array([best[p][0] for p in pids.tolist()], dtype=np.int64),
        "label_ids": np.array([best[p][1] for p in pids.tolist()], dtype=np.int64),
        "ann_index": np.array([best[p][2] for p in pids.tolist()], dtype=np.int64),
        "values": tiff.read_pixels(tif_path, rows, cols),
        "conflicts": len(conflicted),
    }


def map_xy(transform, row, col):
    """Map coordinates of the pixel centre (works on numbers or numpy arrays)."""
    a, b, c, d, e, f = transform
    return a * (col + 0.5) + b * (row + 0.5) + c, d * (col + 0.5) + e * (row + 0.5) + f


def shape_stats(project: dict, ann: dict, tif_path: Path) -> dict:
    img = project["images"][ann["image_id"]]
    rows, cols = shape_pixels(ann["type"], ann["vertices"], img["width"], img["height"])
    vals = tiff.read_pixels(tif_path, rows, cols).astype(np.float64)
    return {
        "annotation_id": ann["annotation_id"], "pixel_count": int(rows.size),
        "bands": [{"index": b["index"], "name": b["name"], "mean": round(float(vals[:, i].mean()), 2),
                   "min": float(vals[:, i].min()), "max": float(vals[:, i].max())}
                  for i, b in enumerate(img["bands"])],
    }


# ------------------------------------------------------------------ records
def _example_rows(project: dict, image_id: str, ex: dict):
    img = ex["image"]
    names = {l["label_id"]: l["name"] for l in project["labels"]}
    xs = ys = None
    if img.get("transform"):
        xs, ys = map_xy(img["transform"], ex["rows"], ex["cols"])
    for k in range(ex["pixel_ids"].size):
        a = ex["annotations"][int(ex["ann_index"][k])]
        pid = int(ex["pixel_ids"][k])
        yield {
            "point_id": a["annotation_id"] if a["type"] == "point" else f"{a['annotation_id']}:{pid}",
            "annotation": a, "pixel_id": pid,
            "row": int(ex["rows"][k]), "col": int(ex["cols"][k]),
            "x": float(xs[k]) if xs is not None else None, "y": float(ys[k]) if ys is not None else None,
            "class_id": int(ex["class_ids"][k]), "class_name": names[int(ex["class_ids"][k])],
            "label_id": int(ex["label_ids"][k]), "label_name": names[int(ex["label_ids"][k])],
            "values": ex["values"][k].tolist(),
        }


def training_set(project: dict, image_id: str, tif_path: Path, approved_only: bool = True) -> dict:
    ex = collect_examples(project, image_id, tif_path, approved_only)
    img = ex["image"]
    examples = []
    for r in _example_rows(project, image_id, ex):
        a = r["annotation"]
        rec = {
            "schema": "training_example/1.0",
            "project_id": project["project_id"], "image_id": image_id,
            "point_id": r["point_id"], "annotation_id": a["annotation_id"],
            "pixel_id": r["pixel_id"], "pixel": {"row": r["row"], "col": r["col"]},
            "map": {"x": r["x"], "y": r["y"], "crs": img["crs"]} if r["x"] is not None else None,
            "class": {"class_id": r["class_id"], "name": r["class_name"]},
            "label": {"label_id": r["label_id"], "name": r["label_name"]},
            "bands": [{"index": b["index"], "name": b["name"], "value": v}
                      for b, v in zip(img["bands"], r["values"])],
            "approval_status": a["approval_status"], "source": a["source"],
            "created_at": a["created_at"],
        }
        if a.get("note"):
            rec["note"] = a["note"]
        examples.append(rec)
    return {
        "schema": "training_set/1.0",
        "project_id": project["project_id"],
        "exported_at": now(),
        "image": {k: img[k] for k in ("image_id", "filename", "width", "height", "crs", "transform", "bands")},
        "classes": [{"class_id": l["label_id"], "name": l["name"], "color": l["color"], "parent_id": l["parent_id"]}
                    for l in project["labels"]],
        "summary": {"examples": len(examples), "conflicting_pixels_excluded": ex["conflicts"]},
        "examples": examples,
    }


def training_set_csv(project: dict, image_id: str, tif_path: Path, approved_only: bool = True) -> str:
    """Flat one-row-per-pixel table for pandas: pd.read_csv(...)."""
    ex = collect_examples(project, image_id, tif_path, approved_only)
    img = ex["image"]
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["project_id", "image_id", "point_id", "annotation_id", "pixel_id", "row", "col", "x", "y", "crs",
                "class_id", "class_name", "label_id", "label_name", *[b["name"] for b in img["bands"]],
                "approval_status", "source"])
    for r in _example_rows(project, image_id, ex):
        a = r["annotation"]
        w.writerow([project["project_id"], image_id, r["point_id"], a["annotation_id"], r["pixel_id"],
                    r["row"], r["col"], "" if r["x"] is None else r["x"], "" if r["y"] is None else r["y"],
                    img["crs"] or "", r["class_id"], r["class_name"], r["label_id"], r["label_name"],
                    *r["values"], a["approval_status"], a["source"]])
    return buf.getvalue()


# ------------------------------------------------------------------ schema checks
SCHEMA_DIR = Path(__file__).parent / "schemas"
_SCHEMAS = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in SCHEMA_DIR.glob("*.schema.json")}
_REGISTRY = Registry().with_resources([(n, Resource.from_contents(s)) for n, s in _SCHEMAS.items()])


def validation_errors(schema_name: str, record: dict) -> list[str]:
    v = Draft202012Validator(_SCHEMAS[schema_name], registry=_REGISTRY)
    errs = sorted(v.iter_errors(record), key=lambda e: [str(p) for p in e.path])
    return [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errs]


# ------------------------------------------------------------------ building annotations
def make_annotation(project: dict, image_id: str, kind: str, vertices, label_id: int, tif_path: Path) -> dict:
    img = project["images"].get(image_id)
    if img is None:
        raise Invalid("Open an image before labeling.")
    try:
        label_by_id(project, label_id)
    except Exception:
        raise Invalid("Select a label before drawing.") from None
    v = check_vertices(kind, vertices, img["width"], img["height"])
    rows, _ = shape_pixels(kind, v, img["width"], img["height"])
    from store import new_id
    ann = {
        "annotation_id": new_id({"point": "pt", "line": "ln", "polygon": "pg"}[kind]),
        "image_id": image_id, "type": kind, "vertices": v, "label_id": label_id,
        "pixel_count": int(rows.size),
        "approval_status": "approved",   # drawn by a person; model suggestions start as "pending"
        "source": SOURCE_FOR_TYPE[kind],
        "created_at": now(), "note": "", "suggestion": None,
    }
    if kind == "point":
        px = tiff.pixel_values(tif_path, v[0][0], v[0][1])
        ann.update(pixel_id=px["pixel_id"], bands=px["bands"], map=px["map"])
    return ann
