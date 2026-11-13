"""Sprint 2 platform experiment: which library should read our GeoTIFFs?

Compares, on the same synthetic 4-band uint16 UTM GeoTIFF at three sizes:
  * rasterio  (GDAL)         - server side, Python
  * tifffile                 - server side, Python, pure-python TIFF reader
  * Pillow                   - what a simple "image" library does with satellite TIFFs
and times the operations the Training tool actually needs:
  open+metadata, read all bands, render screen preview, look up one pixel.

The browser-side alternative (geotiff.js) is measured by experiments/js/geotiff_experiment.mjs.

Run:  python experiments/tiff_loading_experiment.py   (writes experiments/results.json)
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "sample_data"))

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
import tifffile  # noqa: E402
from PIL import Image  # noqa: E402

import tiff_service  # noqa: E402
from make_sample_tiff import make  # noqa: E402

SIZES = [(512, 384), (2048, 1536), (4096, 4096)]
OUT_DIR = ROOT / "experiments" / "_data"


def timed(fn, repeat=3):
    best, result = float("inf"), None
    for _ in range(repeat):
        t = time.perf_counter()
        result = fn()
        best = min(best, time.perf_counter() - t)
    return round(best * 1000, 1), result


def run_rasterio(path):
    def meta():
        with rasterio.open(path) as ds:
            return {"bands": ds.count, "crs": str(ds.crs), "dtype": ds.dtypes[0],
                    "band_names": list(ds.descriptions)}
    def read_all():
        with rasterio.open(path) as ds:
            return ds.read().shape
    t_meta, m = timed(meta)
    t_read, shape = timed(read_all)
    t_prev, png = timed(lambda: tiff_service.render_preview(path, (1, 2, 3)))
    t_px, px = timed(lambda: tiff_service.pixel_values(path, 5, 7), repeat=20)
    return {"ok": True, "open_metadata_ms": t_meta, "read_all_ms": t_read, "preview_png_ms": t_prev,
            "preview_png_kb": round(len(png) / 1024), "pixel_lookup_ms": t_px,
            "reads_crs": m["crs"] != "None", "band_names": m["band_names"], "shape": list(shape),
            "pixel_check": px["bands"][2]["value"] == 507}


def run_tifffile(path):
    def meta():
        with tifffile.TiffFile(path) as tf:
            geo = tf.geotiff_metadata or {}
            return {"crs_key": geo.get("ProjectedCSTypeGeoKey"), "shape": tf.series[0].shape}
    t_meta, m = timed(meta)
    t_read, arr = timed(lambda: tifffile.imread(path))
    return {"ok": True, "open_metadata_ms": t_meta, "read_all_ms": t_read, "shape": list(arr.shape),
            "reads_crs": m["crs_key"] is not None,
            "crs_note": "raw GeoKey only (e.g. EPSG code); no pixel<->map transform helpers",
            "layout": "rows,cols,bands (pixel-interleaved) - band axis differs from rasterio",
            "pixel_check": int(arr[5, 7, 2] if arr.shape[-1] == 4 else arr[2, 5, 7]) == 507}


def run_pillow(path):
    try:
        t, img = timed(lambda: Image.open(path).load(), repeat=1)
        return {"ok": True, "read_all_ms": t}
    except Exception as e:  # expected: Pillow cannot decode 4-band uint16
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    for w, h in SIZES:
        path = OUT_DIR / f"test_{w}x{h}.tif"
        if not path.exists():
            make(path, w, h)
        entry = {"size": f"{w}x{h}", "file_mb": round(path.stat().st_size / 1e6, 1),
                 "raw_mb": round(w * h * 4 * 2 / 1e6, 1)}
        entry["rasterio"] = run_rasterio(path)
        entry["tifffile"] = run_tifffile(path)
        entry["pillow"] = run_pillow(path)
        results.append(entry)
        print(json.dumps(entry, indent=1))
    (ROOT / "experiments" / "results.json").write_text(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
