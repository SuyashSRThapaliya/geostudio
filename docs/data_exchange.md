# Data exchanged between groups — DRAFT for Model and Verification to review

Training examples and verification feedback must refer to **the same image, the same pixel
and the same class**. This page defines the conventions and the two records. Machine-checkable
versions live in `backend/schemas/*.schema.json`; real examples are in `docs/examples/`.

## 1. Shared conventions (please confirm)

| Thing | Convention | Why |
|---|---|---|
| `project_id`, `image_id` | Strings created by Training (`prj_…`, `img_…`). Every group passes them through unchanged. | One image, one ID everywhere. |
| Pixel position | `row`, `col`, **0-based**, origin at the **top-left** pixel. `row` goes down, `col` goes right. A position means the whole pixel. | Avoids 0/1-based and x/y swap bugs. |
| `pixel_id` | `row * image_width + col` | Matches the Learning & Tools `pixelID` column; any group can recompute it. |
| Map coordinates | `x`, `y` of the pixel **centre** in the image's CRS (e.g. `EPSG:32615` = UTM 15N). `null` if the image has no georeference. | Learning & Tools planned to convert coordinates; we send both pixel and map so nobody has to. |
| Bands | 1-based `index` as stored in the TIFF + `name` (`Red`, `Green`, `Blue`, `NIR`, …). Values are the **original** numbers from the file, never display-stretched values. | The model must train on real reflectance. |
| Classes | Integer `class_id` (1, 2, 3…) + `name`. Training owns the class list and sends it with every export. | Learning & Tools wants numeric labels (`1 = grass, 2 = tree…`). |
| `approval_status` | `approved`, `pending`, `rejected`, `unresolved`. **Only `approved` is used for training.** | User story 1. |
| `source` | `manual_point`, `polygon`, `model_suggestion`, `field_observation` | Lets us trace where a label came from. |

Polygons are split into individual pixels before export. Each pixel inside becomes one example
with `source: "polygon"`. This answers the Learning & Tools question about who densifies polygons:
**Training does**, so the Model group always receives one row per pixel.

## 2. Training example (Training → Model)

Sent as a **training set** for one image: image info + class dictionary + examples.

```json
{
  "schema": "training_example/1.0",
  "project_id": "prj_demo01",
  "image_id": "img_demo01",
  "point_id": "pt_demo02",
  "pixel_id": 46480,
  "pixel": { "row": 90, "col": 400 },
  "map": { "x": 504005.0, "y": 4649095.0, "crs": "EPSG:32615" },
  "class": { "class_id": 2, "name": "exposed_soil" },
  "bands": [
    { "index": 1, "name": "Red",   "value": 2671 },
    { "index": 2, "name": "Green", "value": 2175 },
    { "index": 3, "name": "Blue",  "value": 1466 },
    { "index": 4, "name": "NIR",   "value": 2823 }
  ],
  "approval_status": "approved",
  "source": "manual_point",
  "created_at": "2026-11-13T17:52:00+00:00"
}
```

Full file: `docs/examples/training_set.example.json`.
**For pandas:** the same data flattened to one row per pixel is in
`docs/examples/training_set.example.csv`, and the API serves it with
`GET /api/projects/<pid>/images/<iid>/training-set?format=csv`:

```
project_id,image_id,point_id,pixel_id,row,col,x,y,crs,class_id,class_name,Red,Green,Blue,NIR,approval_status,source
```

The CSV covers the dataframe Learning & Tools planned (`imageID, pixelID, (x,y), R, G, B, NIR, label`).
Grayscale and NDVI are left out on purpose: they can be computed from the bands, e.g.
`NDVI = (NIR − Red) / (NIR + Red)`.

## 3. Correction request (Verification → Training)

Verification never moves or deletes training points. It sends a request; Training decides.

```json
{
  "schema": "correction_request/1.0",
  "request_id": "cr_demo01",
  "project_id": "prj_demo01",
  "image_id": "img_demo01",
  "location": {
    "type": "point",
    "pixel": { "row": 200, "col": 150 },
    "pixel_id": 102550,
    "map": { "x": 501505.0, "y": 4647995.0, "crs": "EPSG:32615" },
    "point_id": null
  },
  "original_prediction": { "class_id": 1, "class_name": "vegetation", "confidence": 0.58 },
  "model": { "model_id": "rf_prj_demo01", "model_version": "v2", "trained_at": "2026-11-12T21:10:00+00:00" },
  "requested_action": "relabel",
  "suggested_class": { "class_id": 2, "class_name": "exposed_soil" },
  "explanation": "Predicted vegetation but the pixel sits on bare soil next to the field boundary; NIR is low compared with nearby vegetation.",
  "created_by": "verification:cesar",
  "created_at": "2026-11-13T19:05:00+00:00",
  "status": "open"
}
```

* `location.type` can also be `"polygon"` with `pixel_vertices` for a highlighted area. See
  `docs/examples/correction_request_polygon.example.json`.
* `requested_action` matches Verification's two highlight colours: `add_points` / `remove_points`,
  plus `relabel` for a single wrong class.
* `confidence` is `null` when the model gives none. **Never invent one** (user story 1).
* Send it with `POST /api/projects/<pid>/correction-requests`. Invalid requests are rejected
  with a list of what is wrong (HTTP 422).

## 4. Questions for the other groups (please reply by next class)

**Model / Learning & Tools**
1. Can you load `training_set.example.csv` (or the JSON) straight into your pandas dataframe?
2. Is a `model_id` + `model_version` string OK for identifying a trained model?
3. Will your prediction output use the same `row`/`col`/`pixel_id` and `class_id`? We suggest
   `{image_id, pixel_id, row, col, class_id, confidence|null, model_id, model_version}`.
4. Any extra band (e.g. SWIR) or derived value you need us to include?

**Verification**
1. Does the correction request contain everything your highlight tool produces?
2. Do you need `polygon` locations in map coordinates as well as pixel coordinates?
3. Who sets `status` to `accepted` / `dismissed` — Training (our assumption) or you?

## 5. Checking a record

```bash
cd backend
python -c "import json,records; print(records.validation_errors('correction_request.schema.json', json.load(open('../docs/examples/correction_request.example.json'))) or 'valid')"
```
