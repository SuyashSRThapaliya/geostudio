import io
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "sample_data"))

import records  # noqa: E402
from app import create_app  # noqa: E402
from make_sample_tiff import make  # noqa: E402

EXAMPLES = ROOT / "docs" / "examples"


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path / "data")
    app.testing = True
    return app.test_client()


@pytest.fixture()
def sample(tmp_path):
    return make(tmp_path / "sample.tif", 64, 48)


def upload(client, pid, path, name="sample.tif"):
    return client.post(f"/api/projects/{pid}/images",
                       data={"file": (io.BytesIO(path.read_bytes()), name)},
                       content_type="multipart/form-data")


def new_project(client):
    return client.post("/api/projects", json={"name": "Test"}).get_json()["project_id"]


def test_upload_shows_dimensions_and_bands(client, sample):
    pid = new_project(client)
    r = upload(client, pid, sample)
    assert r.status_code == 201
    img = r.get_json()
    assert (img["width"], img["height"], img["band_count"]) == (64, 48, 4)
    assert [b["name"] for b in img["bands"]] == ["Red", "Green", "Blue", "NIR"]
    assert img["crs"] == "EPSG:32615"


def test_unsupported_extension_has_clear_message(client):
    pid = new_project(client)
    r = client.post(f"/api/projects/{pid}/images",
                    data={"file": (io.BytesIO(b"hello"), "photo.jpg")},
                    content_type="multipart/form-data")
    assert r.status_code == 415
    assert "not supported" in r.get_json()["error"]


def test_corrupt_tiff_has_clear_message(client):
    pid = new_project(client)
    r = client.post(f"/api/projects/{pid}/images",
                    data={"file": (io.BytesIO(b"not really a tiff"), "broken.tif")},
                    content_type="multipart/form-data")
    assert r.status_code == 415
    assert "could not be read" in r.get_json()["error"]


@pytest.mark.parametrize("row,col", [(0, 0), (3, 7), (15, 15), (10, 2)])
def test_pixel_lookup_returns_the_exact_pixel(client, sample, row, col):
    """The Blue band in the top-left 16x16 block stores row*100+col."""
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    px = client.get(f"/api/images/{iid}/pixel?row={row}&col={col}").get_json()
    blue = next(b for b in px["bands"] if b["name"] == "Blue")["value"]
    assert blue == row * 100 + col
    assert px["pixel_id"] == row * 64 + col
    # pixel centre in UTM: origin (500000, 4650000), 10 m pixels
    assert px["map"]["x"] == pytest.approx(500000 + col * 10 + 5)
    assert px["map"]["y"] == pytest.approx(4650000 - row * 10 - 5)


def test_pixel_outside_image_is_rejected(client, sample):
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    r = client.get(f"/api/images/{iid}/pixel?row=48&col=0")
    assert r.status_code == 400 and "outside" in r.get_json()["error"]


def test_preview_png(client, sample):
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    r = client.get(f"/api/images/{iid}/preview.png?bands=4,3,2")
    assert r.status_code == 200 and r.data[:8] == b"\x89PNG\r\n\x1a\n"


def test_classes_points_remove_and_undo(client, sample):
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    veg = client.post(f"/api/projects/{pid}/classes", json={"name": "vegetation"}).get_json()
    assert veg["class_id"] == 1
    dup = client.post(f"/api/projects/{pid}/classes", json={"name": "Vegetation"})
    assert dup.status_code == 400

    p1 = client.post(f"/api/projects/{pid}/points",
                     json={"image_id": iid, "class_id": 1, "row": 2, "col": 3}).get_json()
    p2 = client.post(f"/api/projects/{pid}/points",
                     json={"image_id": iid, "class_id": 1, "row": 4, "col": 5}).get_json()
    assert p1["bands"][2]["value"] == 203  # identity block

    # remove a mistaken point, then undo the removal
    client.delete(f"/api/projects/{pid}/points/{p1['point_id']}")
    assert [p["point_id"] for p in client.get(f"/api/projects/{pid}").get_json()["points"]] == [p2["point_id"]]
    client.post(f"/api/projects/{pid}/undo")
    ids = [p["point_id"] for p in client.get(f"/api/projects/{pid}").get_json()["points"]]
    assert ids == [p1["point_id"], p2["point_id"]]

    # undo the last add (p2), then p1, then nothing left
    client.post(f"/api/projects/{pid}/undo")
    client.post(f"/api/projects/{pid}/undo")
    assert client.get(f"/api/projects/{pid}").get_json()["points"] == []
    assert client.post(f"/api/projects/{pid}/undo").status_code == 409


def test_point_requires_class(client, sample):
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    r = client.post(f"/api/projects/{pid}/points", json={"image_id": iid, "class_id": 9, "row": 1, "col": 1})
    assert r.status_code == 400


def test_training_set_export_is_valid(client, sample):
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    client.post(f"/api/projects/{pid}/classes", json={"name": "vegetation"})
    client.post(f"/api/projects/{pid}/points", json={"image_id": iid, "class_id": 1, "row": 30, "col": 5})
    ts = client.get(f"/api/projects/{pid}/images/{iid}/training-set").get_json()
    assert records.validation_errors("training_set.schema.json", ts) == []
    assert ts["examples"][0]["class"] == {"class_id": 1, "name": "vegetation"}


def test_shared_example_files_validate():
    ts = json.loads((EXAMPLES / "training_set.example.json").read_text())
    cr = json.loads((EXAMPLES / "correction_request.example.json").read_text())
    cr_poly = json.loads((EXAMPLES / "correction_request_polygon.example.json").read_text())
    assert records.validation_errors("training_set.schema.json", ts) == []
    assert records.validation_errors("correction_request.schema.json", cr) == []
    assert records.validation_errors("correction_request.schema.json", cr_poly) == []


def test_correction_request_round_trip(client, sample):
    pid = new_project(client)
    iid = upload(client, pid, sample).get_json()["image_id"]
    cr = json.loads((EXAMPLES / "correction_request.example.json").read_text())
    cr["project_id"], cr["image_id"] = pid, iid
    assert client.post(f"/api/projects/{pid}/correction-requests", json=cr).status_code == 201

    bad = dict(cr, explanation="")
    r = client.post(f"/api/projects/{pid}/correction-requests", json=bad)
    assert r.status_code == 422 and r.get_json()["details"]
