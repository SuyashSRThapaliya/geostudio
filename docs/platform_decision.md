# Platform decision — Training Selection group (Sprint 2)

**Decision:** a web application with a **React** frontend (built with Vite) and a **Python Flask**
backend that reads GeoTIFFs with **rasterio**. Docker packaging is planned for Sprint 3
(see the last section).

## What the platform must support (from our user stories and Sprint 1 features)

| # | Requirement | Source |
|---|---|---|
| R1 | Open multi-band GeoTIFFs (e.g. R, G, B, NIR; 16-bit) and show size + bands | Sprint 1 §2.1–2.2, user stories |
| R2 | Zoom so pixels get bigger, pan, fit-to-window, pick a **single exact pixel** | Sprint 1 §2.1, 2.3 |
| R3 | Display changes (band combination, contrast) never change the stored values | User story 1 |
| R4 | Classes, points (later lines/polygons), remove, undo/redo | Sprint 1 §2.4–2.5 |
| R5 | Share records with Model (Python / pandas / scikit-learn) and Verification | Learning & Tools retrospective, Verification retrospective |
| R6 | Each group can work as a separate service (the "microservices" idea from Sprint 1) | Sprint 1 notes |
| R7 | Save a project and keep working on it later | User stories |
| R8 | Runs on a student laptop and is easy for 3 groups to install | Team constraint |

## Options compared

Scores: ✅ good · ⚠️ possible with extra work · ❌ poor fit

| | **React + Flask (chosen)** | React + FastAPI | Streamlit | Desktop: PyQt / napari plugin | QGIS plugin |
|---|---|---|---|---|---|
| R1 multi-band TIFF | ✅ rasterio on server | ✅ same | ✅ | ✅ | ✅ built in |
| R2 pixel-exact canvas, custom tools | ✅ full control of canvas | ✅ | ❌ limited custom mouse handling | ✅ | ⚠️ must follow QGIS UI model |
| R3 display ≠ data | ✅ preview PNG vs original values | ✅ | ⚠️ | ✅ | ✅ |
| R4 custom labeling UI | ✅ | ✅ | ❌ reruns script on every click | ✅ | ⚠️ |
| R5 Python for the Model group | ✅ same language as scikit-learn | ✅ | ✅ | ✅ | ⚠️ QGIS's bundled Python |
| R6 separate services / Docker | ✅ REST API | ✅ | ⚠️ | ❌ single desktop app | ❌ |
| R7 save / reload | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| R8 easy install for 3 groups | ✅ `pip` + `npm`, later one `docker compose up` | ✅ | ✅ | ⚠️ Qt install issues on some laptops | ❌ everybody installs QGIS |
| Team familiarity | Flask & React were proposed in Sprint 1 *(each member to confirm)* | async + type hints are new to most | easy, but we outgrow it | new | new |

**Why Flask over FastAPI:** they are equally capable for this project. We picked Flask because
the team already named it and it has the simpler learning curve. FastAPI's main advantage
(automatic API docs) is covered by the JSON Schemas in `backend/schemas/`. Switching later
only affects `backend/app.py`.

## Evidence from the image-loading experiment

See `experiments/RESULTS.md`. In short:

* Pillow (an ordinary image library) **cannot open** 4-band 16-bit TIFFs, so "just show the TIFF in
  an `<img>` tag" is not an option.
* Server-side **rasterio** was the fastest reader we tested and the only one that gave us CRS +
  pixel↔map transforms easily. A one-pixel lookup took ~3 ms at every image size.
* Parsing in the browser (**geotiff.js**) was 4–7× slower and used ~600 MB of browser memory for
  a 4096 × 4096 image.

## How the pieces work together

```
Browser (React)                     Flask backend (Python)                 Disk
───────────────                     ──────────────────────                 ────
Open TIFF…  ── POST file ─────────▶ validate .tif/.tiff, open w/ rasterio ─▶ data/images/<id>.tif
            ◀── size, bands, CRS ── (clear message if unsupported)
<canvas>    ── GET preview.png ───▶ 3 chosen bands → 8-bit PNG (display only)
click(x,y)  → row/col in browser
            ── POST point ────────▶ read ORIGINAL band values at row/col ──▶ data/projects/<id>.json
            ◀── point + values ────
Export      ── GET training-set ──▶ JSON / CSV in the agreed shared format  ──▶ Model group
            ◀── correction-request ─ (POST from Verification, schema-checked)
```

## Still to decide (Sprint 3)

* **Docker:** one `docker-compose.yml` with `training`, `model` and `verification` services,
  once the other groups have a runnable service.
* **Database:** JSON files per project are enough for now; move to SQLite if projects get large
  or several users edit at once.
* **Large images:** add tiling (only fetch the visible part at the current zoom) for scenes
  bigger than ~4000 px.
