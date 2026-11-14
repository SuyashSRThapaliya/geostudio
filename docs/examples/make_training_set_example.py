"""Regenerates the shared examples by running a real labeling session through the API.

    python docs/examples/make_training_set_example.py
"""
import io
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app import create_app  # noqa: E402

c = create_app(Path(tempfile.mkdtemp())).test_client()
pid = c.post("/api/projects", json={"name": "Ag fields demo"}).get_json()["project_id"]
tif = (ROOT / "sample_data" / "sample_4band.tif").read_bytes()
iid = c.post(f"/api/projects/{pid}/images", data={"file": (io.BytesIO(tif), "sample_4band.tif")},
             content_type="multipart/form-data").get_json()["image_id"]


def label(name, parent=None):
    return c.post(f"/api/projects/{pid}/labels", json={"name": name, "parent_id": parent}).get_json()["label"]["label_id"]


def draw(kind, vertices, label_id):
    c.post(f"/api/projects/{pid}/annotations", json={"image_id": iid, "type": kind, "vertices": vertices, "label_id": label_id})


veg, soil, water = label("vegetation"), label("exposed_soil"), label("water")
grass = label("grass", parent=veg)                      # a label inside the class "vegetation"
draw("point", [[120, 60]], veg)
draw("point", [[90, 400]], soil)
draw("polygon", [[150, 30], [150, 32], [151, 32], [151, 30]], grass)   # 2 x 3 pixels
draw("line", [[300, 100], [300, 103]], water)                         # 4 pixels

base = f"/api/projects/{pid}/images/{iid}/training-set"
text = c.get(base).get_data(as_text=True)
csv = c.get(base + "?format=csv").get_data(as_text=True)
ann_ids = sorted({e["annotation_id"] for e in json.loads(text)["examples"]})
# replace random ids with readable, stable ones for the shared example
swaps = {pid: "prj_demo01", iid: "img_demo01", **{a: f"{a.split('_')[0]}_demo{i:02d}" for i, a in enumerate(ann_ids, 1)}}
for old, new in swaps.items():
    text, csv = text.replace(old, new), csv.replace(old, new)
ts = json.loads(text)
ts["exported_at"] = "2026-11-14T18:00:00+00:00"
for e in ts["examples"]:
    e["created_at"] = "2026-11-14T17:50:00+00:00"
here = Path(__file__).parent
(here / "training_set.example.json").write_text(json.dumps(ts, indent=2) + "\n")
(here / "training_set.example.csv").write_text(csv)
print("wrote training_set.example.json and .csv:", ts["summary"])
