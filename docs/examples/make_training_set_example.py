"""Regenerates training_set.example.json by running a real labeling session through the API.

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
for name in ["vegetation", "exposed_soil", "water", "roof"]:
    c.post(f"/api/projects/{pid}/classes", json={"name": name})
for cls, (row, col) in [(1, (120, 60)), (2, (90, 400)), (3, (300, 100)), (4, (320, 420))]:
    c.post(f"/api/projects/{pid}/points", json={"image_id": iid, "class_id": cls, "row": row, "col": col})

ts = c.get(f"/api/projects/{pid}/images/{iid}/training-set").get_json()
# replace random ids with readable, stable ones for the shared example
ts["project_id"], ts["image"]["image_id"], ts["exported_at"] = "prj_demo01", "img_demo01", "2026-11-13T18:00:00+00:00"
for i, e in enumerate(ts["examples"], 1):
    e.update(project_id="prj_demo01", image_id="img_demo01", point_id=f"pt_demo0{i}",
             created_at=f"2026-11-13T17:5{i}:00+00:00", created_by="lumu")
out = Path(__file__).parent / "training_set.example.json"
out.write_text(json.dumps(ts, indent=2) + "\n")
print("wrote", out)

import records  # noqa: E402
csv_out = Path(__file__).parent / "training_set.example.csv"
csv_out.write_text(records.training_set_csv(ts))
print("wrote", csv_out)
