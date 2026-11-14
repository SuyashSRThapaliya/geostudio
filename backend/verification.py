"""Verification side: builds correction requests in the agreed format.

Verification never edits training labels. It flags a location; Training decides.
"""
from __future__ import annotations

import numpy as np

import label_processing as lp
import ml
from store import Invalid, ProjectStore, label_by_id, new_id, now

ACTIONS = {"relabel", "add_points", "remove_points"}


def build_request(store: ProjectStore, project: dict, body: dict) -> dict:
    image_id = body.get("image_id")
    img = project["images"].get(image_id)
    if img is None:
        raise Invalid("Image not found in this project.")
    action = body.get("requested_action")
    if action not in ACTIONS:
        raise Invalid("Choose what should change: relabel, add points or remove points.")
    explanation = (body.get("explanation") or "").strip()
    if len(explanation) < 3:
        raise Invalid("Add a short explanation so Training knows what to check.")
    cls, conf = ml.load_prediction(store, project, image_id)   # needs a prediction to refer to
    w, h = img["width"], img["height"]
    names = {l["label_id"]: l["name"] for l in project["labels"]}
    loc = body.get("location") or {}

    if loc.get("type") == "point":
        (r, c), = lp.check_vertices("point", [[loc.get("row"), loc.get("col")]], w, h)
        location = {"type": "point", "pixel": {"row": r, "col": c}, "pixel_id": r * w + c,
                    "map": None, "point_id": None}
        if img.get("transform"):
            x, y = lp.map_xy(img["transform"], r, c)
            location["map"] = {"x": float(x), "y": float(y), "crs": img["crs"]}
        hit = next((a for a in project["annotations"] if a["image_id"] == image_id and a["type"] == "point"
                    and a["vertices"][0] == [r, c]), None)
        if hit:
            location["point_id"] = hit["annotation_id"]
        cid, confidence = int(cls[r, c]), float(conf[r, c]) / 255
    elif loc.get("type") == "polygon":
        v = lp.check_vertices("polygon", loc.get("pixel_vertices"), w, h)
        location = {"type": "polygon", "pixel_vertices": v}
        if img.get("transform"):
            location["map_vertices"] = [[float(t) for t in lp.map_xy(img["transform"], r, c)] for r, c in v]
            location["crs"] = img["crs"]
        rows, cols = lp.shape_pixels("polygon", v, w, h)
        ids, counts = np.unique(cls[rows, cols], return_counts=True)
        cid = int(ids[counts.argmax()])            # most common predicted class in the area
        confidence = float(conf[rows, cols][cls[rows, cols] == cid].mean()) / 255
    else:
        raise Invalid("location.type must be point or polygon.")

    suggested = None
    if body.get("suggested_label_id"):
        lab = label_by_id(project, int(body["suggested_label_id"]))
        suggested = {"class_id": lab["label_id"], "class_name": lab["name"]}
    pred = img["prediction"]
    return {
        "schema": "correction_request/1.0",
        "request_id": new_id("cr"),
        "project_id": project["project_id"], "image_id": image_id,
        "location": location,
        "original_prediction": {"class_id": cid, "class_name": names.get(cid, f"class {cid}"),
                                "confidence": round(confidence, 3)},
        "model": {"model_id": pred["model_id"], "model_version": pred["model_version"],
                  "trained_at": pred["trained_at"]},
        "requested_action": action,
        "suggested_class": suggested,
        "explanation": explanation,
        "created_by": (body.get("created_by") or "verification").strip(),
        "created_at": now(),
        "status": "open",
    }
