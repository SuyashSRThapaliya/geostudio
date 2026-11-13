"""Project storage: classes, labeled points and the undo history.

Projects are saved as one JSON file each (backend/data/projects/<project_id>.json).
That is deliberately simple for Sprint 2; it can be swapped for SQLite/Postgres
later without changing the API.
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_COLORS = ["#2e9e44", "#b5651d", "#1f6feb", "#c9302c", "#8e44ad", "#d4a017", "#16a2b8", "#e84393"]
SCHEMA_VERSION = "1.0"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


class ProjectStore:
    def __init__(self, root: Path):
        self.root = Path(root)
        (self.root / "projects").mkdir(parents=True, exist_ok=True)
        (self.root / "images").mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    # ---------- persistence ----------
    def _path(self, project_id: str) -> Path:
        safe = "".join(c for c in project_id if c.isalnum() or c in "_-")
        return self.root / "projects" / f"{safe}.json"

    def load(self, project_id: str) -> dict:
        p = self._path(project_id)
        if not p.exists():
            raise KeyError(f"Project '{project_id}' was not found.")
        return json.loads(p.read_text())

    def save(self, project: dict) -> None:
        project["updated_at"] = now()
        self._path(project["project_id"]).write_text(json.dumps(project, indent=2))

    def image_path(self, image_id: str) -> Path:
        safe = "".join(c for c in image_id if c.isalnum() or c in "_-")
        return self.root / "images" / f"{safe}.tif"

    # ---------- projects ----------
    def create_project(self, name: str) -> dict:
        project = {
            "schema_version": SCHEMA_VERSION,
            "project_id": new_id("prj"),
            "name": name or "Untitled project",
            "created_at": now(),
            "updated_at": now(),
            "images": {},
            "classes": [],
            "points": [],
            "history": [],
        }
        self.save(project)
        return project

    def list_projects(self) -> list[dict]:
        out = []
        for p in sorted((self.root / "projects").glob("*.json")):
            d = json.loads(p.read_text())
            out.append({"project_id": d["project_id"], "name": d["name"], "updated_at": d.get("updated_at")})
        return out

    # ---------- images ----------
    def add_image(self, project_id: str, image_id: str, filename: str, info: dict) -> dict:
        with self._lock:
            project = self.load(project_id)
            project["images"][image_id] = {"image_id": image_id, "filename": filename,
                                           "added_at": now(), **info}
            self.save(project)
            return project["images"][image_id]

    # ---------- classes ----------
    def add_class(self, project_id: str, name: str, color: str | None = None) -> dict:
        name = (name or "").strip()
        if not name:
            raise ValueError("Class name cannot be empty.")
        with self._lock:
            project = self.load(project_id)
            if any(c["name"].lower() == name.lower() for c in project["classes"]):
                raise ValueError(f"A class named '{name}' already exists.")
            next_id = max((c["class_id"] for c in project["classes"]), default=0) + 1
            cls = {"class_id": next_id, "name": name,
                   "color": color or DEFAULT_COLORS[(next_id - 1) % len(DEFAULT_COLORS)]}
            project["classes"].append(cls)
            self.save(project)
            return cls

    # ---------- points ----------
    def add_point(self, project_id: str, image_id: str, class_id: int, pixel: dict) -> dict:
        with self._lock:
            project = self.load(project_id)
            if image_id not in project["images"]:
                raise KeyError(f"Image '{image_id}' is not part of this project.")
            if not any(c["class_id"] == class_id for c in project["classes"]):
                raise ValueError("Select a class before labeling.")
            point = {
                "point_id": new_id("pt"),
                "image_id": image_id,
                "pixel_id": pixel["pixel_id"],
                "row": pixel["row"],
                "col": pixel["col"],
                "map": pixel["map"],
                "bands": pixel["bands"],
                "class_id": class_id,
                # A point the user placed by hand is approved; model suggestions start as "pending".
                "approval_status": "approved",
                "source": "manual_point",
                "created_at": now(),
            }
            project["points"].append(point)
            project["history"].append({"action": "add_point", "point": point})
            self.save(project)
            return point

    def remove_point(self, project_id: str, point_id: str) -> dict:
        with self._lock:
            project = self.load(project_id)
            for i, p in enumerate(project["points"]):
                if p["point_id"] == point_id:
                    project["points"].pop(i)
                    project["history"].append({"action": "remove_point", "point": p, "index": i})
                    self.save(project)
                    return p
            raise KeyError(f"Point '{point_id}' was not found.")

    def undo(self, project_id: str) -> dict:
        """Reverse the most recent labeling action (add or remove a point)."""
        with self._lock:
            project = self.load(project_id)
            if not project["history"]:
                raise LookupError("There is nothing to undo.")
            last = project["history"].pop()
            if last["action"] == "add_point":
                project["points"] = [p for p in project["points"] if p["point_id"] != last["point"]["point_id"]]
                undone = f"Removed the point you just added ({last['point']['point_id']})."
            else:  # remove_point
                idx = min(last["index"], len(project["points"]))
                project["points"].insert(idx, last["point"])
                undone = f"Restored point {last['point']['point_id']}."
            self.save(project)
            return {"undone": last["action"], "message": undone, "points": project["points"]}
