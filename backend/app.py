"""Training Selection web app (Flask). Serves the API and the built React site.

Start it with:  python run.py        (from the project folder)
"""
from __future__ import annotations

import io
import json
import os
import tempfile
import zipfile
from pathlib import Path

from flask import Flask, Response, jsonify, request, send_from_directory

import label_processing as lp
import ml
import store as st
import tiff_service as tiff
import verification
from store import Invalid, NotFound, ProjectStore, new_id, now, project_view

ROOT = Path(__file__).resolve().parent
FRONTEND_DIST = ROOT.parent / "frontend" / "dist"


def create_app(data_dir: Path | None = None) -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 ** 3  # 2 GB uploads
    app.json.sort_keys = False
    store = ProjectStore(Path(data_dir or os.environ.get("TRAINING_DATA_DIR", ROOT / "data")))
    app.store = store

    # ---------------- errors: every failure is JSON with a message for the user ----------------
    def fail(message: str, status: int = 400, **extra):
        return jsonify({"error": message, **extra}), status

    app.register_error_handler(Invalid, lambda e: fail(str(e), 400))
    app.register_error_handler(NotFound, lambda e: fail(str(e), 404))
    app.register_error_handler(tiff.UnsupportedImageError, lambda e: fail(str(e), 415))
    app.register_error_handler(413, lambda e: fail("The file is larger than the 2 GB upload limit.", 413))

    @app.errorhandler(Exception)
    def unexpected(e):
        from werkzeug.exceptions import HTTPException
        if isinstance(e, HTTPException):
            return fail(e.description or e.name, e.code)
        app.logger.exception("Unexpected error")
        return fail(f"Something went wrong on the server: {type(e).__name__}: {e}", 500)

    def body() -> dict:
        data = request.get_json(silent=True)
        return data if isinstance(data, dict) else {}

    def image_of(project: dict, iid: str) -> dict:
        if iid not in project["images"]:
            raise NotFound("Image not found in this project.")
        return project["images"][iid]

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
        return jsonify(project_view(store.create_project(body().get("name", "")))), 201

    @app.get("/api/projects/<pid>")
    def get_project(pid):
        return jsonify(project_view(store.load(pid)))

    @app.patch("/api/projects/<pid>")
    def rename_project(pid):
        name = (body().get("name") or "").strip()
        if not name:
            raise Invalid("The project name cannot be empty.")
        with store.edit(pid) as p:
            p["name"] = name
        return jsonify(project_view(p))

    @app.delete("/api/projects/<pid>")
    def delete_project(pid):
        store.delete_project(pid)
        return jsonify({"deleted": pid})

    @app.get("/api/projects/<pid>/export.zip")
    def export_project(pid):
        """Project file + images. Trained models are not included (retrain after importing)."""
        p = store.load(pid)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            z.writestr("project.json", json.dumps(p, indent=1))
            for iid in p["images"]:
                z.write(store.image_path(pid, iid), f"images/{iid}.tif")
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in p["name"]) or "project"
        return Response(buf.getvalue(), mimetype="application/zip",
                        headers={"Content-Disposition": f'attachment; filename="{safe}.training-project.zip"'})

    @app.post("/api/projects/import")
    def import_project():
        f = request.files.get("file")
        if f is None or not f.filename:
            raise Invalid("No file was selected.")
        try:
            z = zipfile.ZipFile(io.BytesIO(f.read()))
            p = json.loads(z.read("project.json"))
            assert isinstance(p["images"], dict) and isinstance(p["labels"], list) and isinstance(p["annotations"], list)
        except Exception:
            raise Invalid("This is not a project export. Choose a .training-project.zip file "
                          "made with 'Export project'.") from None
        pid = new_id("prj")
        p.update(project_id=pid, models=[], undo=[], redo=[], schema_version=st.SCHEMA_VERSION)
        p.setdefault("correction_requests", [])
        for r in p["correction_requests"]:
            r["project_id"] = pid
        existing = {x["name"] for x in store.list_projects()}
        if p.get("name") in existing:
            p["name"] = f"{p['name']} (imported)"
        for iid, img in list(p["images"].items()):
            img.pop("prediction", None)
            member = f"images/{iid}.tif"
            if member not in z.namelist():
                raise Invalid(f"The export is incomplete: {member} is missing.")
            dest = store.image_path(pid, iid)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(z.read(member))
        store.save(p)
        return jsonify(project_view(p)), 201

    # ---------------- images ----------------
    @app.post("/api/projects/<pid>/images")
    def upload_image(pid):
        store.load(pid)
        f = request.files.get("file")
        if f is None or not f.filename:
            raise Invalid("No file was selected.")
        tiff.check_extension(f.filename)
        image_id = new_id("img")
        dest = store.image_path(pid, image_id)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest.parent, suffix=".part", delete=False) as tmp:
            f.save(tmp)
            tmp_path = Path(tmp.name)
        try:
            info = tiff.read_info(tmp_path)
        except tiff.UnsupportedImageError:
            tmp_path.unlink(missing_ok=True)
            raise
        tmp_path.replace(dest)
        with store.edit(pid) as p:
            p["images"][image_id] = {"image_id": image_id, "filename": Path(f.filename).name, "added_at": now(),
                                     **info.to_dict(), "prediction": None,
                                     "verification": {"status": "not_predicted", "verified_at": None}}
        return jsonify({"image_id": image_id, "project": project_view(p)}), 201

    @app.delete("/api/projects/<pid>/images/<iid>")
    def delete_image(pid, iid):
        with store.edit(pid) as p:
            image_of(p, iid)
            del p["images"][iid]
            p["annotations"] = [a for a in p["annotations"] if a["image_id"] != iid]
            p["correction_requests"] = [r for r in p["correction_requests"] if r["image_id"] != iid]
            p["undo"], p["redo"] = [], []
        store.image_path(pid, iid).unlink(missing_ok=True)
        store.prediction_path(pid, iid).unlink(missing_ok=True)
        return jsonify(project_view(p))

    @app.patch("/api/projects/<pid>/images/<iid>")
    def set_verification(pid, iid):
        status = body().get("verification_status")
        if status not in ("verified", "needs_verification"):
            raise Invalid("verification_status must be 'verified' or 'needs_verification'.")
        with store.edit(pid) as p:
            image_of(p, iid)["verification"] = {"status": status,
                                                "verified_at": now() if status == "verified" else None}
        return jsonify(project_view(p))

    @app.get("/api/projects/<pid>/images/<iid>/preview.png")
    def preview(pid, iid):
        image_of(store.load(pid), iid)
        try:
            bands = tuple(int(b) for b in request.args.get("bands", "1,2,3").split(","))
            assert len(bands) == 3
        except (ValueError, AssertionError):
            raise Invalid("bands must be three band numbers, e.g. bands=4,1,2") from None
        png = tiff.render_preview(store.image_path(pid, iid), bands)
        return Response(png, mimetype="image/png", headers={"Cache-Control": "max-age=86400"})

    @app.get("/api/projects/<pid>/images/<iid>/pixel")
    def pixel(pid, iid):
        p = store.load(pid)
        image_of(p, iid)
        try:
            row, col = int(request.args["row"]), int(request.args["col"])
            px = tiff.pixel_values(store.image_path(pid, iid), row, col)
        except (KeyError, ValueError):
            raise Invalid("row and col must be whole numbers.") from None
        except IndexError as e:
            raise Invalid(str(e)) from None
        px["prediction"] = ml.predicted_at(store, p, iid, row, col)
        return jsonify(px)

    # ---------------- labels ----------------
    @app.post("/api/projects/<pid>/labels")
    def add_label(pid):
        b = body()
        with store.edit(pid) as p:
            lab = st.add_label(p, b.get("name", ""), b.get("color"), b.get("parent_id"))
        return jsonify({"label": lab, "project": project_view(p)}), 201

    @app.patch("/api/projects/<pid>/labels/<int:lid>")
    def update_label(pid, lid):
        with store.edit(pid) as p:
            st.update_label(p, lid, body())
        return jsonify(project_view(p))

    @app.delete("/api/projects/<pid>/labels/<int:lid>")
    def delete_label(pid, lid):
        with store.edit(pid) as p:
            st.delete_label(p, lid, force=request.args.get("force") == "1")
        return jsonify(project_view(p))

    # ---------------- annotations ----------------
    @app.post("/api/projects/<pid>/annotations")
    def add_annotation(pid):
        b = body()
        with store.edit(pid) as p:
            iid = b.get("image_id")
            ann = lp.make_annotation(p, iid, b.get("type"), b.get("vertices"), b.get("label_id"),
                                     store.image_path(pid, iid or ""))
            st.add_annotations(p, [ann], f"Add {ann['type']}")
        return jsonify({"annotation": ann, "project": project_view(p)}), 201

    @app.patch("/api/projects/<pid>/annotations")
    def update_annotations(pid):
        """Relabel / review one or many: {ids: [...], label_id?, approval_status?, note?}"""
        b = body()
        changes = {k: b[k] for k in ("label_id", "approval_status", "note") if k in b}
        ids = b.get("ids") or []
        if not ids or not changes:
            raise Invalid("Send ids and at least one of label_id, approval_status, note.")
        what = {"approved": "Approve", "rejected": "Reject", "unresolved": "Postpone",
                "pending": "Reset"}.get(changes.get("approval_status"), "Edit")
        with store.edit(pid) as p:
            st.update_annotations(p, ids, changes, f"{what} {len(ids)} annotation{'s' if len(ids) != 1 else ''}")
        return jsonify(project_view(p))

    @app.post("/api/projects/<pid>/annotations/delete")
    def delete_annotations(pid):
        with store.edit(pid) as p:
            st.remove_annotations(p, body().get("ids") or [])
        return jsonify(project_view(p))

    @app.get("/api/projects/<pid>/annotations/<aid>/stats")
    def annotation_stats(pid, aid):
        p = store.load(pid)
        ann = next((a for a in p["annotations"] if a["annotation_id"] == aid), None)
        if ann is None:
            raise NotFound("Annotation not found.")
        return jsonify(lp.shape_stats(p, ann, store.image_path(pid, ann["image_id"])))

    @app.post("/api/projects/<pid>/undo")
    def undo(pid):
        with store.edit(pid) as p:
            msg = st.undo(p)
        return jsonify({"message": msg, "project": project_view(p)})

    @app.post("/api/projects/<pid>/redo")
    def redo(pid):
        with store.edit(pid) as p:
            msg = st.redo(p)
        return jsonify({"message": msg, "project": project_view(p)})

    # ---------------- export for the Model group ----------------
    @app.get("/api/projects/<pid>/images/<iid>/training-set")
    def export_training_set(pid, iid):
        p = store.load(pid)
        img = image_of(p, iid)
        approved_only = request.args.get("approved_only", "1") not in ("0", "false", "no")
        path = store.image_path(pid, iid)
        stem = Path(img["filename"]).stem
        download = request.args.get("download") == "1"
        if request.args.get("format") == "csv":
            headers = {"Content-Disposition": f'attachment; filename="{stem}_training_set.csv"'} if download else {}
            return Response(lp.training_set_csv(p, iid, path, approved_only), mimetype="text/csv", headers=headers)
        ts = lp.training_set(p, iid, path, approved_only)
        sample = {**ts, "examples": ts["examples"][:50]}     # schema check without re-reading huge exports
        problems = lp.validation_errors("training_set.schema.json", sample)
        if problems:
            return fail("Export failed validation: " + "; ".join(problems[:5]), 500)
        headers = {"Content-Disposition": f'attachment; filename="{stem}_training_set.json"'} if download else {}
        return Response(json.dumps(ts, indent=1), mimetype="application/json", headers=headers)

    # ---------------- model ----------------
    @app.post("/api/projects/<pid>/models/train")
    def train(pid):
        with store.edit(pid) as p:
            meta = ml.train(store, p, body().get("level", "class"))
        return jsonify({"model": meta, "project": project_view(p)}), 201

    @app.post("/api/projects/<pid>/images/<iid>/predict")
    def predict(pid, iid):
        with store.edit(pid) as p:
            image_of(p, iid)
            ml.predict(store, p, iid, body().get("model_version"))
        return jsonify(project_view(p))

    @app.get("/api/projects/<pid>/images/<iid>/prediction.png")
    def prediction_png(pid, iid):
        p = store.load(pid)
        image_of(p, iid)
        hidden = {int(x) for x in request.args.get("hide", "").split(",") if x.strip().isdigit()}
        return Response(ml.overlay_png(store, p, iid, hidden), mimetype="image/png",
                        headers={"Cache-Control": "no-store"})

    @app.post("/api/projects/<pid>/images/<iid>/suggest")
    def suggest(pid, iid):
        b = body()
        with store.edit(pid) as p:
            image_of(p, iid)
            anns = ml.suggest(store, p, iid, b.get("n", 20), b.get("strategy", "uncertain"))
            st.add_annotations(p, anns, f"Add {len(anns)} model suggestions")
        return jsonify({"added": len(anns), "project": project_view(p)}), 201

    # ---------------- verification ----------------
    @app.post("/api/projects/<pid>/correction-requests")
    def add_correction(pid):
        """Accepts a full correction_request/1.0 record (from another service) or the
        short form the built-in Verification view sends."""
        b = body()
        with store.edit(pid) as p:
            if b.get("schema"):
                problems = lp.validation_errors("correction_request.schema.json", b)
                if problems:
                    return fail("Correction request is not valid.", 422, details=problems)
                if b["project_id"] != pid or b["image_id"] not in p["images"]:
                    return fail("project_id / image_id do not match this project.", 422)
                if any(r["request_id"] == b["request_id"] for r in p["correction_requests"]):
                    return fail("A request with this request_id already exists.", 409)
                req = b
            else:
                req = verification.build_request(store, p, b)
                problems = lp.validation_errors("correction_request.schema.json", req)
                if problems:
                    return fail("Could not build a valid request: " + "; ".join(problems), 500)
            p["correction_requests"].append(req)
        return jsonify({"request": req, "project": project_view(p)}), 201

    @app.patch("/api/projects/<pid>/correction-requests/<rid>")
    def review_correction(pid, rid):
        status = body().get("status")
        if status not in ("open", "accepted", "dismissed"):
            raise Invalid("status must be open, accepted or dismissed.")
        with store.edit(pid) as p:
            req = next((r for r in p["correction_requests"] if r["request_id"] == rid), None)
            if req is None:
                raise NotFound("Correction request not found.")
            req["status"] = status
            req["reviewed_at"] = now()
            if "note" in body():
                req["review_note"] = str(body()["note"])
        return jsonify(project_view(p))

    @app.delete("/api/projects/<pid>/correction-requests/<rid>")
    def delete_correction(pid, rid):
        with store.edit(pid) as p:
            p["correction_requests"] = [r for r in p["correction_requests"] if r["request_id"] != rid]
        return jsonify(project_view(p))

    # ---------------- the website ----------------
    @app.get("/")
    @app.get("/<path:path>")
    def site(path="index.html"):
        if path.startswith("api/"):
            return fail("Unknown API address.", 404)
        if not (FRONTEND_DIST / "index.html").exists():
            return ("<h3>The website files are missing (frontend/dist).</h3>"
                    "<p>Run <code>npm install</code> and <code>npm run build</code> inside the "
                    "<code>frontend</code> folder, then reload.</p>", 500)
        if not (FRONTEND_DIST / path).is_file():
            path = "index.html"
        return send_from_directory(FRONTEND_DIST, path)

    return app


if __name__ == "__main__":
    create_app().run(host="127.0.0.1", port=int(os.environ.get("PORT", 8000)), threaded=True)
