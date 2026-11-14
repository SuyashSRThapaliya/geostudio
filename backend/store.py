"""Project storage: projects, images, the label tree, annotations and undo/redo.

Each project is a folder:  data/<project_id>/project.json
                           data/<project_id>/images/<image_id>.tif
                           data/<project_id>/models/<version>.joblib
                           data/<project_id>/predictions/<image_id>.npz
"""
from __future__ import annotations

import json
import shutil
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_COLORS = ["#2e9e44", "#b5651d", "#1f6feb", "#c9302c", "#8e44ad", "#d4a017", "#16a2b8", "#e84393",
                  "#7cb342", "#5d4037", "#00897b", "#f4511e"]
SCHEMA_VERSION = "2.0"
MAX_HISTORY = 200
STATUSES = {"approved", "pending", "rejected", "unresolved"}


class NotFound(Exception):
    pass


class Invalid(Exception):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _safe(name: str) -> str:
    return "".join(c for c in str(name) if c.isalnum() or c in "_-")


class ProjectStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    # ---------- paths ----------
    def dir(self, pid: str) -> Path:
        return self.root / _safe(pid)

    def image_path(self, pid: str, iid: str) -> Path:
        return self.dir(pid) / "images" / f"{_safe(iid)}.tif"

    def model_path(self, pid: str, version: str) -> Path:
        return self.dir(pid) / "models" / f"{_safe(version)}.joblib"

    def prediction_path(self, pid: str, iid: str) -> Path:
        return self.dir(pid) / "predictions" / f"{_safe(iid)}.npz"

    # ---------- persistence ----------
    def load(self, pid: str) -> dict:
        p = self.dir(pid) / "project.json"
        if not pid or not p.exists():
            raise NotFound(f"Project '{pid}' was not found.")
        return json.loads(p.read_text(encoding="utf-8"))

    def save(self, project: dict) -> None:
        project["updated_at"] = now()
        d = self.dir(project["project_id"])
        for sub in ("images", "models", "predictions"):
            (d / sub).mkdir(parents=True, exist_ok=True)
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(project), encoding="utf-8")
        tmp.replace(d / "project.json")

    @contextmanager
    def edit(self, pid: str):
        """Load, let the caller change, save. Nothing is saved if the caller raises."""
        with self._lock:
            project = self.load(pid)
            yield project
            self.save(project)

    # ---------- projects ----------
    def create_project(self, name: str) -> dict:
        project = {
            "schema_version": SCHEMA_VERSION,
            "project_id": new_id("prj"),
            "name": (name or "").strip() or "Untitled project",
            "created_at": now(),
            "updated_at": now(),
            "images": {},
            "labels": [],
            "annotations": [],
            "models": [],
            "correction_requests": [],
            "undo": [],
            "redo": [],
        }
        self.save(project)
        return project

    def list_projects(self) -> list[dict]:
        out = []
        for f in self.root.glob("*/project.json"):
            try:
                p = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            anns = p.get("annotations", [])
            imgs = p.get("images", {})
            out.append({
                "project_id": p["project_id"], "name": p["name"],
                "created_at": p.get("created_at"), "updated_at": p.get("updated_at"),
                "images": len(imgs),
                "labels": len(p.get("labels", [])),
                "annotations": sum(a["approval_status"] == "approved" for a in anns),
                "pending": sum(a["approval_status"] in ("pending", "unresolved") for a in anns),
                "models": len(p.get("models", [])),
                "verified_images": sum((i.get("verification") or {}).get("status") == "verified" for i in imgs.values()),
                "open_requests": sum(r.get("status") == "open" for r in p.get("correction_requests", [])),
            })
        return sorted(out, key=lambda p: p["updated_at"] or "", reverse=True)

    def delete_project(self, pid: str) -> None:
        with self._lock:
            self.load(pid)
            shutil.rmtree(self.dir(pid))


# =====================================================================
# Label tree.  A label with parent_id None is a "label class" (top level).
# Labels under it share that class for training.
# =====================================================================
def label_by_id(project: dict, label_id) -> dict:
    for lab in project["labels"]:
        if lab["label_id"] == label_id:
            return lab
    raise NotFound(f"Label {label_id} was not found.")


def root_label(project: dict, label_id) -> dict:
    lab = label_by_id(project, label_id)
    return label_by_id(project, lab["parent_id"]) if lab["parent_id"] else lab


def _check_name(project: dict, name: str, ignore_id=None) -> str:
    name = (name or "").strip()
    if not name:
        raise Invalid("The label name cannot be empty.")
    if any(l["name"].lower() == name.lower() and l["label_id"] != ignore_id for l in project["labels"]):
        raise Invalid(f"A label named '{name}' already exists.")
    return name


def _check_parent(project: dict, parent_id, label_id=None):
    if parent_id is None:
        return None
    parent = label_by_id(project, parent_id)
    if parent["parent_id"] is not None:
        raise Invalid("Labels can only be placed under a top-level label class.")
    if label_id is not None:
        if parent_id == label_id:
            raise Invalid("A label cannot be placed under itself.")
        if any(l["parent_id"] == label_id for l in project["labels"]):
            raise Invalid("This label class still contains labels. Move or promote them first.")
    return parent_id


def add_label(project: dict, name: str, color: str | None = None, parent_id=None) -> dict:
    name = _check_name(project, name)
    parent_id = _check_parent(project, parent_id)
    next_id = max((l["label_id"] for l in project["labels"]), default=0) + 1
    lab = {"label_id": next_id, "name": name, "parent_id": parent_id,
           "color": color or DEFAULT_COLORS[(next_id - 1) % len(DEFAULT_COLORS)]}
    project["labels"].append(lab)
    return lab


def update_label(project: dict, label_id: int, changes: dict) -> dict:
    lab = label_by_id(project, label_id)
    if "name" in changes:
        lab["name"] = _check_name(project, changes["name"], ignore_id=label_id)
    if changes.get("color"):
        lab["color"] = str(changes["color"])
    if "parent_id" in changes:  # promote (None) or demote (id of a label class)
        lab["parent_id"] = _check_parent(project, changes["parent_id"], label_id)
    return lab


def delete_label(project: dict, label_id: int, force: bool = False) -> None:
    label_by_id(project, label_id)
    ids = {label_id} | {l["label_id"] for l in project["labels"] if l["parent_id"] == label_id}
    used = [a for a in project["annotations"] if a["label_id"] in ids]
    if used and not force:
        raise Invalid(f"{len(used)} annotation(s) use this label. Deleting it will delete them too.")
    project["labels"] = [l for l in project["labels"] if l["label_id"] not in ids]
    if used:
        project["annotations"] = [a for a in project["annotations"] if a["label_id"] not in ids]
        project["undo"], project["redo"] = [], []  # history may refer to deleted labels


# =====================================================================
# Annotations with undo / redo.
# An action is {"label": text, "ops": [op, ...]} where op is one of
#   {"op": "add", "ann": {...}}
#   {"op": "remove", "ann": {...}, "index": i}
#   {"op": "update", "before": {...}, "after": {...}}
# =====================================================================
def _find(project: dict, annotation_id: str) -> int:
    for i, a in enumerate(project["annotations"]):
        if a["annotation_id"] == annotation_id:
            return i
    raise NotFound(f"Annotation '{annotation_id}' was not found.")


def _push(project: dict, label: str, ops: list[dict]) -> None:
    if not ops:
        return
    project["undo"].append({"label": label, "ops": ops})
    del project["undo"][:-MAX_HISTORY]
    project["redo"] = []


def add_annotations(project: dict, anns: list[dict], label: str) -> None:
    project["annotations"].extend(anns)
    _push(project, label, [{"op": "add", "ann": a} for a in anns])


def remove_annotations(project: dict, ids: list[str], label: str | None = None) -> int:
    ops = []
    for aid in ids:
        i = _find(project, aid)
        ops.append({"op": "remove", "ann": project["annotations"].pop(i), "index": i})
    _push(project, label or (f"Delete {len(ops)} annotations" if len(ops) != 1 else "Delete annotation"), ops)
    return len(ops)


def update_annotations(project: dict, ids: list[str], changes: dict, label: str) -> None:
    if "approval_status" in changes and changes["approval_status"] not in STATUSES:
        raise Invalid("approval_status must be approved, pending, rejected or unresolved.")
    if "label_id" in changes:
        label_by_id(project, changes["label_id"])
    ops = []
    for aid in ids:
        i = _find(project, aid)
        before = project["annotations"][i]
        after = {**before, **changes}
        if after != before:
            project["annotations"][i] = after
            ops.append({"op": "update", "before": before, "after": after})
    _push(project, label, ops)


def _apply(project: dict, op: dict, forward: bool) -> None:
    anns = project["annotations"]
    kind = op["op"]
    if kind == "update":
        src, dst = (op["before"], op["after"]) if forward else (op["after"], op["before"])
        anns[_find(project, src["annotation_id"])] = dst
    elif (kind == "add") == forward:  # (re)insert
        idx = op.get("index", len(anns))
        anns.insert(min(idx, len(anns)), op["ann"])
    else:  # take out
        anns.pop(_find(project, op["ann"]["annotation_id"]))


def undo(project: dict) -> str:
    if not project["undo"]:
        raise Invalid("There is nothing to undo.")
    action = project["undo"].pop()
    for op in reversed(action["ops"]):
        _apply(project, op, forward=False)
    project["redo"].append(action)
    return f"Undid: {action['label']}"


def redo(project: dict) -> str:
    if not project["redo"]:
        raise Invalid("There is nothing to redo.")
    action = project["redo"].pop()
    for op in action["ops"]:
        _apply(project, op, forward=True)
    project["undo"].append(action)
    return f"Redid: {action['label']}"


def project_view(project: dict) -> dict:
    """What the browser gets: everything except the raw history stacks."""
    view = {k: v for k, v in project.items() if k not in ("undo", "redo")}
    view["can_undo"] = bool(project["undo"])
    view["can_redo"] = bool(project["redo"])
    view["undo_label"] = project["undo"][-1]["label"] if project["undo"] else None
    view["redo_label"] = project["redo"][-1]["label"] if project["redo"] else None
    return view
