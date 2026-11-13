"""Generate the agreed sample GeoTIFF used by every group for testing.

The image is synthetic but realistic in structure:
  * 4 bands in this order: Red, Green, Blue, NIR (uint16, like Sentinel-2 / Landsat L2 reflectance)
  * Georeferenced in UTM zone 15N (EPSG:32615), 10 m pixels
  * Four "land cover" regions (vegetation, exposed soil, water, roof/developed)
    so labeling and NDVI behave sensibly
  * A pixel-identity trick for accuracy checks: in the top-left 16x16 block the
    Blue band stores (row * 100 + col).  Clicking a pixel there and reading the
    Blue value tells you immediately whether the viewer picked the right pixel.

Usage:
    python sample_data/make_sample_tiff.py                 # writes sample_data/sample_4band.tif
    python sample_data/make_sample_tiff.py out.tif 2048 1536  # custom size (for the speed experiment)
"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

BAND_NAMES = ["Red", "Green", "Blue", "NIR"]

# Typical surface reflectance (x10000) for each cover type: R, G, B, NIR
COVER = {
    "vegetation": (400, 900, 500, 4200),
    "exposed_soil": (2600, 2200, 1700, 3000),
    "water": (300, 500, 800, 150),
    "roof": (3200, 3100, 3000, 3300),
}


def make(path: Path, width: int = 512, height: int = 384, seed: int = 7) -> Path:
    rng = np.random.default_rng(seed)
    data = np.zeros((4, height, width), dtype=np.uint16)

    rows, cols = np.mgrid[0:height, 0:width]
    region = np.full((height, width), "vegetation", dtype=object)
    region[(cols >= width // 2) & (rows < height // 2)] = "exposed_soil"
    region[(cols < width // 2) & (rows >= height // 2)] = "water"
    region[(cols >= width // 2) & (rows >= height // 2)] = "roof"
    # a winding river-ish strip of water through the vegetation
    river = np.abs(rows - (height * 0.25 + 20 * np.sin(cols / 25.0))) < 4
    region[river & (cols < width // 2)] = "water"

    for name, refl in COVER.items():
        mask = region == name
        for b in range(4):
            noise = rng.normal(0, refl[b] * 0.06, mask.sum())
            data[b][mask] = np.clip(refl[b] + noise, 1, 10000).astype(np.uint16)

    # pixel-identity block (Blue band) for click-accuracy checks
    blk = min(16, height, width)
    data[2, :blk, :blk] = (rows[:blk, :blk] * 100 + cols[:blk, :blk]).astype(np.uint16)

    transform = from_origin(500000.0, 4650000.0, 10.0, 10.0)  # UTM 15N, 10 m pixels
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path, "w", driver="GTiff", width=width, height=height, count=4,
        dtype="uint16", crs="EPSG:32615", transform=transform,
        compress="deflate", tiled=True, blockxsize=256, blockysize=256,
    ) as dst:
        dst.write(data)
        for i, name in enumerate(BAND_NAMES, start=1):
            dst.set_band_description(i, name)
    return path


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "sample_4band.tif"
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 512
    h = int(sys.argv[3]) if len(sys.argv) > 3 else 384
    print("wrote", make(out, w, h))
