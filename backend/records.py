"""Builds and validates the records exchanged with the Model and Verification groups."""
from __future__ import annotations

import json
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from store import now

SCHEMA_DIR = Path(__file__).parent / "schemas"


def _load(name: str) -> dict:
    return json.loads((SCHEMA_DIR / name).read_text())


_SCHEMAS = {n: _load(n) for n in ("training_example.schema.json", "training_set.schema.json",
                                   "correction_request.schema.json")}
_REGISTRY = Registry().with_resources(
    [(n, Resource.from_contents(s)) for n, s in _SCHEMAS.items()]
)


def validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(_SCHEMAS[name], registry=_REGISTRY)


def validation_errors(name: str, record: dict) -> list[str]:
    errs = sorted(validator(name).iter_errors(record), key=lambda e: list(e.path))
    return [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errs]


def training_example(project: dict, point: dict) -> dict:
    cls = next(c for c in project["classes"] if c["class_id"] == point["class_id"])
    return {
        "schema": "training_example/1.0",
        "project_id": project["project_id"],
        "image_id": point["image_id"],
        "point_id": point["point_id"],
        "pixel_id": point["pixel_id"],
        "pixel": {"row": point["row"], "col": point["col"]},
        "map": point["map"],
        "class": {"class_id": cls["class_id"], "name": cls["name"]},
        "bands": point["bands"],
        "approval_status": point["approval_status"],
        "source": point["source"],
        "created_at": point["created_at"],
    }


def training_set_csv(ts: dict) -> str:
    """Flat, one-row-per-pixel version for pandas: pd.read_csv(...)."""
    import csv
    import io

    band_names = [b["name"] for b in ts["image"]["bands"]]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["project_id", "image_id", "point_id", "pixel_id", "row", "col", "x", "y", "crs",
                "class_id", "class_name", *band_names, "approval_status", "source"])
    for e in ts["examples"]:
        m = e["map"] or {}
        vals = {b["name"]: b["value"] for b in e["bands"]}
        w.writerow([e["project_id"], e["image_id"], e["point_id"], e["pixel_id"], e["pixel"]["row"],
                    e["pixel"]["col"], m.get("x", ""), m.get("y", ""), m.get("crs", ""),
                    e["class"]["class_id"], e["class"]["name"], *[vals.get(n, "") for n in band_names],
                    e["approval_status"], e["source"]])
    return buf.getvalue()


def training_set(project: dict, image_id: str, approved_only: bool = False) -> dict:
    img = project["images"][image_id]
    examples = [
        training_example(project, p) for p in project["points"]
        if p["image_id"] == image_id and (not approved_only or p["approval_status"] == "approved")
    ]
    return {
        "schema": "training_set/1.0",
        "project_id": project["project_id"],
        "exported_at": now(),
        "image": {
            "image_id": image_id,
            "filename": img["filename"],
            "width": img["width"],
            "height": img["height"],
            "crs": img["crs"],
            "transform": img["transform"],
            "bands": img["bands"],
        },
        "classes": [{"class_id": c["class_id"], "name": c["name"], "color": c["color"]}
                    for c in project["classes"]],
        "examples": examples,
    }
