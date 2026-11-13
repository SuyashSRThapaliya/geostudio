"""Training Selection backend (Flask).

Run:  python backend/app.py        -> http://localhost:5000
The React dev server (frontend/) proxies /api to this port.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

import records
import tiff_service as tiff
from store import ProjectStore, new_id, now

ROOT = Path(__file__).resolve().parent
FRONTEND_DIST = ROOT.parent / "frontend" / "dist"


def error(message: str, status: int = 400):
    return jsonify({"error": message}), status


def create_app(data_dir: Path | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB uploads
    app.json.sort_keys = False  # keep field order identical to the agreed record layout
    store = ProjectStore(Path(data_dir or os.environ.get("TRAINING_DATA_DIR", ROOT / "data")))
    app.store = store

    @app.errorhandler(413)
    def too_large(_):
        return error("The file is larger than the 1 GB upload limit.", 413)

    # ---------------- health ----------------
    @app.get("/api/health")
    def health():
        return {"status": "ok", "service": "training-selection", "time": now()}

    # ---------------- projects ----------------
    @app.get("/api/projects")
    def list_projects():
        return jsonify(store.list_projects())

    @app.post("/api/projects")
    def create_project():
        body = request.get_json(silent=True) or {}
        return jsonify(store.create_project(body.get("name", ""))), 201

    @app.get("/api/projects/<pid>")
    def get_project(pid):
        try:
            p = store.load(pid)
        except KeyError as e:
            return error(str(e.args[0]), 404)
        p.pop("history", None)
        p["can_undo"] = bool(store.load(pid)["history"])
        return jsonify(p)

    # ---------------- images ----------------
    @app.post("/api/projects/<pid>/images")
    def upload_image(pid):
        try:
            store.load(pid)
        except KeyError as e:
            return error(str(e.args[0]), 404)
        f = request.files.get("file")
        if f is None or not f.filename:
            return error("No file was selected.")
        try:
            tiff.check_extension(f.filename)
        except tiff.UnsupportedImageError as e:
            return error(str(e), 415)

        image_id = new_id("img")
        dest = store.image_path(image_id)
        with tempfile.NamedTemporaryFile(dir=dest.parent, suffix=".tif", delete=False) as tmp:
            f.save(tmp)
            tmp_path = Path(tmp.name)
        try:
            info = tiff.read_info(tmp_path)
        except tiff.UnsupportedImageError as e:
            tmp_path.unlink(missing_ok=True)
            return error(str(e), 415)
        tmp_path.replace(dest)
        img = store.add_image(pid, image_id, f.filename, info.to_dict())
        return jsonify(img), 201

    @app.get("/api/images/<iid>/preview.png")
    def preview(iid):
        path = store.image_path(iid)
        if not path.exists():
            return error("Image not found.", 404)
        try:
            bands = tuple(int(b) for b in request.args.get("bands", "1,2,3").split(","))[:3]
            if len(bands) == 1:
                bands = bands * 3
            if len(bands) != 3:
                raise ValueError
        except ValueError:
            return error("bands must be three comma-separated band numbers, e.g. bands=4,3,2")
        png = tiff.render_preview(path, bands)
        return Response(png, mimetype="image/png", headers={"Cache-Control": "max-age=3600"})

    @app.get("/api/images/<iid>/pixel")
    def pixel(iid):
        path = store.image_path(iid)
        if not path.exists():
            return error("Image not found.", 404)
        try:
            row, col = int(request.args["row"]), int(request.args["col"])
            return jsonify(tiff.pixel_values(path, row, col))
        except (KeyError, ValueError):
            return error("row and col must be whole numbers.")
        except IndexError as e:
            return error(str(e))

    # ---------------- classes ----------------
    @app.post("/api/projects/<pid>/classes")
    def add_class(pid):
        body = request.get_json(silent=True) or {}
        try:
            return jsonify(store.add_class(pid, body.get("name", ""), body.get("color"))), 201
        except KeyError as e:
            return error(str(e.args[0]), 404)
        except ValueError as e:
            return error(str(e))

    # ---------------- points ----------------
    @app.post("/api/projects/<pid>/points")
    def add_point(pid):
        body = request.get_json(silent=True) or {}
        try:
            image_id = body["image_id"]
            class_id = int(body["class_id"])
            row, col = int(body["row"]), int(body["col"])
        except (KeyError, TypeError, ValueError):
            return error("image_id, class_id, row and col are required.")
        path = store.image_path(image_id)
        if not path.exists():
            return error("Image not found.", 404)
        try:
            px = tiff.pixel_values(path, row, col)  # always read from the ORIGINAL file
            return jsonify(store.add_point(pid, image_id, class_id, px)), 201
        except IndexError as e:
            return error(str(e))
        except KeyError as e:
            return error(str(e.args[0]), 404)
        except ValueError as e:
            return error(str(e))

    @app.delete("/api/projects/<pid>/points/<point_id>")
    def remove_point(pid, point_id):
        try:
            return jsonify(store.remove_point(pid, point_id))
        except KeyError as e:
            return error(str(e.args[0]), 404)

    @app.post("/api/projects/<pid>/undo")
    def undo(pid):
        try:
            return jsonify(store.undo(pid))
        except KeyError as e:
            return error(str(e.args[0]), 404)
        except LookupError as e:
            return error(str(e), 409)

    # ---------------- data exchange ----------------
    @app.get("/api/projects/<pid>/images/<iid>/training-set")
    def export_training_set(pid, iid):
        try:
            project = store.load(pid)
        except KeyError as e:
            return error(str(e.args[0]), 404)
        if iid not in project["images"]:
            return error("Image not found in this project.", 404)
        approved_only = request.args.get("approved_only", "0") in ("1", "true", "yes")
        ts = records.training_set(project, iid, approved_only)
        problems = records.validation_errors("training_set.schema.json", ts)
        if problems:  # should never happen; guards against schema drift
            return error("Export failed validation: " + "; ".join(problems), 500)
        if request.args.get("format") == "csv":
            return Response(records.training_set_csv(ts), mimetype="text/csv",
                            headers={"Content-Disposition": f"attachment; filename={iid}_training_set.csv"})
        return jsonify(ts)

    @app.post("/api/projects/<pid>/correction-requests")
    def receive_correction(pid):
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            return error("Send a JSON correction request.")
        problems = records.validation_errors("correction_request.schema.json", body)
        if problems:
            return jsonify({"error": "Correction request is not valid.", "details": problems}), 422
        try:
            project = store.load(pid)
        except KeyError as e:
            return error(str(e.args[0]), 404)
        if body["project_id"] != pid or body["image_id"] not in project["images"]:
            return error("project_id / image_id do not match this project.", 422)
        project.setdefault("correction_requests", []).append(body)
        store.save(project)
        return jsonify({"accepted": body["request_id"]}), 201

    # ---------------- built frontend (production) ----------------
    @app.get("/")
    @app.get("/<path:path>")
    def frontend(path="index.html"):
        if not FRONTEND_DIST.exists():
            return ("Frontend not built. Run the React dev server (see README) "
                    "or `npm run build` in frontend/.", 404)
        target = FRONTEND_DIST / path
        if path != "index.html" and target.is_file():
            return send_from_directory(FRONTEND_DIST, path)
        return send_from_directory(FRONTEND_DIST, "index.html")

    return app


if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=True)
