import io
import json
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "sample_data"))

import label_processing as lp  # noqa: E402
from app import create_app  # noqa: E402
from make_sample_tiff import make  # noqa: E402

EXAMPLES = ROOT / "docs" / "examples"
W, H = 96, 64   # sample: vegetation top-left, soil top-right, water bottom-left, roof bottom-right


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path / "data")
    app.testing = True
    return app.test_client()


@pytest.fixture()
def sample(tmp_path):
    return make(tmp_path / "sample.tif", W, H)


def upload(client, pid, path, name="sample.tif"):
    return client.post(f"/api/projects/{pid}/images",
                       data={"file": (io.BytesIO(path.read_bytes()), name)},
                       content_type="multipart/form-data")


def setup(client, sample, labels=("vegetation", "exposed_soil")):
    pid = client.post("/api/projects", json={"name": "Test"}).get_json()["project_id"]
    iid = upload(client, pid, sample).get_json()["image_id"]
    ids = [client.post(f"/api/projects/{pid}/labels", json={"name": n}).get_json()["label"]["label_id"]
           for n in labels]
    return pid, iid, ids


def draw(client, pid, iid, kind, vertices, label_id):
    return client.post(f"/api/projects/{pid}/annotations",
                       json={"image_id": iid, "type": kind, "vertices": vertices, "label_id": label_id})


def anns(client, pid):
    return client.get(f"/api/projects/{pid}").get_json()["annotations"]


# ---------------------------------------------------------------- images
def test_upload_shows_dimensions_and_bands(client, sample):
    pid, iid, _ = setup(client, sample, labels=())
    img = client.get(f"/api/projects/{pid}").get_json()["images"][iid]
    assert (img["width"], img["height"], img["band_count"]) == (W, H, 4)
    assert [b["name"] for b in img["bands"]] == ["Red", "Green", "Blue", "NIR"]
    assert img["crs"] == "EPSG:32615"


@pytest.mark.parametrize("name,data,text", [("photo.jpg", b"hello", "not supported"),
                                           ("broken.tif", b"not really a tiff", "could not be read")])
def test_bad_files_get_clear_messages(client, name, data, text):
    pid = client.post("/api/projects", json={"name": "T"}).get_json()["project_id"]
    r = client.post(f"/api/projects/{pid}/images", data={"file": (io.BytesIO(data), name)},
                    content_type="multipart/form-data")
    assert r.status_code == 415 and text in r.get_json()["error"]


@pytest.mark.parametrize("row,col", [(0, 0), (3, 7), (15, 15)])
def test_pixel_lookup_returns_the_exact_pixel(client, sample, row, col):
    """The Blue band in the top-left 16x16 block stores row*100+col."""
    pid, iid, _ = setup(client, sample, labels=())
    px = client.get(f"/api/projects/{pid}/images/{iid}/pixel?row={row}&col={col}").get_json()
    assert next(b for b in px["bands"] if b["name"] == "Blue")["value"] == row * 100 + col
    assert px["pixel_id"] == row * W + col
    assert px["map"]["x"] == pytest.approx(500000 + col * 10 + 5)
    assert px["map"]["y"] == pytest.approx(4650000 - row * 10 - 5)


def test_preview_png(client, sample):
    pid, iid, _ = setup(client, sample, labels=())
    r = client.get(f"/api/projects/{pid}/images/{iid}/preview.png?bands=4,1,2")
    assert r.status_code == 200 and r.data[:8] == b"\x89PNG\r\n\x1a\n"


# ---------------------------------------------------------------- label tree
def test_label_tree_promote_demote_delete(client, sample):
    pid, iid, (veg, soil) = setup(client, sample)
    grass = client.post(f"/api/projects/{pid}/labels", json={"name": "grass", "parent_id": veg}).get_json()["label"]
    assert grass["parent_id"] == veg
    assert client.post(f"/api/projects/{pid}/labels", json={"name": "Grass"}).status_code == 400  # duplicate
    # a class that still has labels cannot be demoted; a sub-label cannot be a parent
    assert client.patch(f"/api/projects/{pid}/labels/{veg}", json={"parent_id": soil}).status_code == 400
    assert client.post(f"/api/projects/{pid}/labels", json={"name": "x", "parent_id": grass["label_id"]}).status_code == 400
    # promote grass, then demote it under soil
    client.patch(f"/api/projects/{pid}/labels/{grass['label_id']}", json={"parent_id": None})
    p = client.patch(f"/api/projects/{pid}/labels/{grass['label_id']}", json={"parent_id": soil}).get_json()
    assert next(l for l in p["labels"] if l["name"] == "grass")["parent_id"] == soil
    # deleting a used label needs force and removes its annotations
    draw(client, pid, iid, "point", [[5, 5]], grass["label_id"])
    assert client.delete(f"/api/projects/{pid}/labels/{soil}").status_code == 400
    p = client.delete(f"/api/projects/{pid}/labels/{soil}?force=1").get_json()
    assert [l["name"] for l in p["labels"]] == ["vegetation"] and p["annotations"] == []


# ---------------------------------------------------------------- label processing
def test_line_and_polygon_become_the_right_pixels():
    r, c = lp.shape_pixels("line", [[2, 2], [2, 6], [5, 6]], 20, 20)
    assert sorted(zip(r.tolist(), c.tolist())) == [(2, 2), (2, 3), (2, 4), (2, 5), (2, 6), (3, 6), (4, 6), (5, 6)]
    r, c = lp.shape_pixels("polygon", [[2, 2], [2, 6], [6, 6], [6, 2]], 20, 20)
    assert r.size == 25 and r.min() == 2 and r.max() == 6 and c.min() == 2 and c.max() == 6
    r, c = lp.shape_pixels("polygon", [[0, 0], [0, 8], [8, 0]], 20, 20)      # triangle incl. its outline
    assert r.size == 45 and (r + c).max() == 8
    r, c = lp.shape_pixels("line", [[0, 0], [3, 3]], 3, 3)                   # clipped to the image
    assert r.size == 3


def test_draw_undo_redo_remove(client, sample):
    pid, iid, (veg, soil) = setup(client, sample)
    a1 = draw(client, pid, iid, "point", [[2, 3]], veg).get_json()["annotation"]
    assert a1["bands"][2]["value"] == 203 and a1["approval_status"] == "approved"
    a2 = draw(client, pid, iid, "polygon", [[20, 5], [20, 15], [28, 15], [28, 5]], veg).get_json()["annotation"]
    assert a2["pixel_count"] == 9 * 11
    assert draw(client, pid, iid, "polygon", [[1, 1], [1, 2]], veg).status_code == 400
    assert draw(client, pid, iid, "point", [[H, 0]], veg).status_code == 400
    assert draw(client, pid, iid, "point", [[1, 1]], 99).status_code == 400

    client.post(f"/api/projects/{pid}/annotations/delete", json={"ids": [a1["annotation_id"]]})
    assert [a["annotation_id"] for a in anns(client, pid)] == [a2["annotation_id"]]
    client.post(f"/api/projects/{pid}/undo")                       # removal undone, original order kept
    assert [a["annotation_id"] for a in anns(client, pid)] == [a1["annotation_id"], a2["annotation_id"]]
    client.patch(f"/api/projects/{pid}/annotations", json={"ids": [a1["annotation_id"]], "label_id": soil})
    assert anns(client, pid)[0]["label_id"] == soil
    client.post(f"/api/projects/{pid}/undo")
    assert anns(client, pid)[0]["label_id"] == veg
    client.post(f"/api/projects/{pid}/redo")
    assert anns(client, pid)[0]["label_id"] == soil
    for _ in range(3):
        client.post(f"/api/projects/{pid}/undo")
    assert anns(client, pid) == []
    assert client.post(f"/api/projects/{pid}/undo").status_code == 400
    p = client.post(f"/api/projects/{pid}/redo").get_json()["project"]
    assert len(p["annotations"]) == 1 and p["can_redo"] and p["can_undo"]
    draw(client, pid, iid, "point", [[9, 9]], veg)                 # a new action clears redo
    assert not client.get(f"/api/projects/{pid}").get_json()["can_redo"]


def test_export_one_row_per_pixel_and_conflicts(client, sample):
    pid, iid, (veg, soil) = setup(client, sample)
    grass = client.post(f"/api/projects/{pid}/labels", json={"name": "grass", "parent_id": veg}).get_json()["label"]["label_id"]
    draw(client, pid, iid, "polygon", [[0, 0], [0, 3], [3, 3], [3, 0]], grass)       # 16 px
    draw(client, pid, iid, "point", [[1, 1]], veg)                                    # same class: kept once
    draw(client, pid, iid, "line", [[3, 3], [3, 6]], soil)                            # (3,3) conflicts
    ts = client.get(f"/api/projects/{pid}/images/{iid}/training-set").get_json()
    assert lp.validation_errors("training_set.schema.json", ts) == []
    assert ts["summary"] == {"examples": 18, "conflicting_pixels_excluded": 1}
    by_pixel = {(e["pixel"]["row"], e["pixel"]["col"]): e for e in ts["examples"]}
    assert (3, 3) not in by_pixel
    e = by_pixel[(2, 3)]
    assert e["class"] == {"class_id": veg, "name": "vegetation"} and e["label"]["name"] == "grass"
    assert e["source"] == "polygon" and e["bands"][2]["value"] == 203 and ":" in e["point_id"]
    csv = client.get(f"/api/projects/{pid}/images/{iid}/training-set?format=csv").get_data(as_text=True)
    lines = csv.strip().split("\n")
    assert len(lines) == 19 and lines[0].startswith("project_id,image_id,point_id") and "Red,Green,Blue,NIR" in lines[0]


def test_shape_stats(client, sample):
    pid, iid, (veg, _) = setup(client, sample)
    a = draw(client, pid, iid, "polygon", [[0, 0], [0, 1], [1, 1], [1, 0]], veg).get_json()["annotation"]
    s = client.get(f"/api/projects/{pid}/annotations/{a['annotation_id']}/stats").get_json()
    assert s["pixel_count"] == 4 and s["bands"][2]["mean"] == pytest.approx((0 + 1 + 100 + 101) / 4)


# ---------------------------------------------------------------- model + verification loop
def labeled_project(client, sample):
    pid, iid, (veg, soil) = setup(client, sample)
    draw(client, pid, iid, "polygon", [[18, 4], [18, 20], [28, 20], [28, 4]], veg)
    draw(client, pid, iid, "polygon", [[20, 26], [20, 40], [30, 40], [30, 26]], veg)
    draw(client, pid, iid, "polygon", [[4, 54], [4, 70], [14, 70], [14, 54]], soil)
    draw(client, pid, iid, "polygon", [[18, 74], [18, 90], [28, 90], [28, 74]], soil)
    return pid, iid, veg, soil


def test_train_predict_suggest_review(client, sample):
    pid, iid, veg, soil = labeled_project(client, sample)
    assert client.post(f"/api/projects/{pid}/images/{iid}/predict").status_code == 400   # no model yet
    model = client.post(f"/api/projects/{pid}/models/train").get_json()["model"]
    assert model["model_version"] == "v1" and model["metrics"]["accuracy"] > 0.95
    assert "NDVI" in model["features"]
    p = client.post(f"/api/projects/{pid}/images/{iid}/predict").get_json()
    assert p["images"][iid]["prediction"]["model_version"] == "v1"
    px = client.get(f"/api/projects/{pid}/images/{iid}/pixel?row=10&col=80").get_json()
    assert px["prediction"]["class_name"] == "exposed_soil"
    png = client.get(f"/api/projects/{pid}/images/{iid}/prediction.png")
    assert png.data[:4] == b"\x89PNG"

    r = client.post(f"/api/projects/{pid}/images/{iid}/suggest", json={"n": 6}).get_json()
    sug = [a for a in r["project"]["annotations"] if a["source"] == "model_suggestion"]
    assert r["added"] == 6 and all(a["approval_status"] == "pending" for a in sug)
    # pending suggestions are never exported for training
    n_before = client.get(f"/api/projects/{pid}/images/{iid}/training-set").get_json()["summary"]["examples"]
    ids = [a["annotation_id"] for a in sug]
    client.patch(f"/api/projects/{pid}/annotations", json={"ids": ids[:1], "approval_status": "approved"})
    client.patch(f"/api/projects/{pid}/annotations", json={"ids": ids[1:2], "approval_status": "approved",
                                                            "label_id": soil if sug[1]["label_id"] == veg else veg})
    client.patch(f"/api/projects/{pid}/annotations", json={"ids": ids[2:3], "approval_status": "rejected"})
    ts = client.get(f"/api/projects/{pid}/images/{iid}/training-set").get_json()
    assert ts["summary"]["examples"] + ts["summary"]["conflicting_pixels_excluded"] == n_before + 2
    corrected = next(a for a in anns(client, pid) if a["annotation_id"] == ids[1])
    assert corrected["suggestion"]["predicted_label_id"] != corrected["label_id"]      # history kept
    assert client.post(f"/api/projects/{pid}/models/train").get_json()["model"]["model_version"] == "v2"


def test_model_refuses_image_without_required_band(client, sample, tmp_path):
    import rasterio
    pid, iid, veg, soil = labeled_project(client, sample)
    client.post(f"/api/projects/{pid}/models/train")
    rgb = tmp_path / "rgb.tif"
    with rasterio.open(sample) as src, rasterio.open(rgb, "w", driver="GTiff", width=W, height=H, count=3,
                                                    dtype="uint16") as dst:
        dst.write(src.read([1, 2, 3]))
    iid2 = upload(client, pid, rgb, "rgb.tif").get_json()["image_id"]
    r = client.post(f"/api/projects/{pid}/images/{iid2}/predict")
    assert r.status_code == 400 and "NIR" in r.get_json()["error"]


def test_correction_requests(client, sample):
    pid, iid, veg, soil = labeled_project(client, sample)
    body = {"image_id": iid, "location": {"type": "point", "row": 10, "col": 80},
            "requested_action": "relabel", "suggested_label_id": veg, "explanation": "looks like sparse plants"}
    assert client.post(f"/api/projects/{pid}/correction-requests", json=body).status_code == 400  # no prediction
    client.post(f"/api/projects/{pid}/models/train")
    client.post(f"/api/projects/{pid}/images/{iid}/predict")
    req = client.post(f"/api/projects/{pid}/correction-requests", json=body).get_json()["request"]
    assert lp.validation_errors("correction_request.schema.json", req) == []
    assert req["original_prediction"]["class_name"] == "exposed_soil" and req["model"]["model_version"] == "v1"
    poly = dict(body, location={"type": "polygon", "pixel_vertices": [[40, 10], [40, 30], [55, 30], [55, 10]]},
                requested_action="add_points")
    assert client.post(f"/api/projects/{pid}/correction-requests", json=poly).status_code == 201
    assert client.post(f"/api/projects/{pid}/correction-requests", json=dict(body, explanation="")).status_code == 400
    p = client.patch(f"/api/projects/{pid}/correction-requests/{req['request_id']}", json={"status": "accepted"}).get_json()
    assert [r["status"] for r in p["correction_requests"]] == ["accepted", "open"]
    # a full record sent by another service
    ext = json.loads((EXAMPLES / "correction_request.example.json").read_text())
    ext.update(project_id=pid, image_id=iid)
    assert client.post(f"/api/projects/{pid}/correction-requests", json=ext).status_code == 201
    assert client.post(f"/api/projects/{pid}/correction-requests", json=dict(ext, status="maybe")).status_code == 422
    p = client.patch(f"/api/projects/{pid}/images/{iid}", json={"verification_status": "verified"}).get_json()
    assert p["images"][iid]["verification"]["status"] == "verified"


# ---------------------------------------------------------------- projects
def test_project_rename_export_import_delete(client, sample):
    pid, iid, (veg, _) = setup(client, sample)
    draw(client, pid, iid, "point", [[2, 3]], veg)
    client.patch(f"/api/projects/{pid}", json={"name": "Fields"})
    z = client.get(f"/api/projects/{pid}/export.zip").data
    r = client.post("/api/projects/import", data={"file": (io.BytesIO(z), "x.zip")}, content_type="multipart/form-data")
    p2 = r.get_json()
    assert r.status_code == 201 and p2["project_id"] != pid and p2["name"] == "Fields (imported)"
    assert len(p2["annotations"]) == 1
    px = client.get(f"/api/projects/{p2['project_id']}/images/{iid}/pixel?row=2&col=3").get_json()
    assert px["bands"][2]["value"] == 203
    bad = client.post("/api/projects/import", data={"file": (io.BytesIO(b"zzz"), "x.zip")}, content_type="multipart/form-data")
    assert bad.status_code == 400
    listing = client.get("/api/projects").get_json()
    assert {x["name"] for x in listing} == {"Fields", "Fields (imported)"} and listing[0]["annotations"] == 1
    client.delete(f"/api/projects/{pid}")
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_shared_example_files_validate():
    for name, schema in [("training_set.example.json", "training_set.schema.json"),
                         ("correction_request.example.json", "correction_request.schema.json"),
                         ("correction_request_polygon.example.json", "correction_request.schema.json")]:
        assert lp.validation_errors(schema, json.loads((EXAMPLES / name).read_text())) == []
