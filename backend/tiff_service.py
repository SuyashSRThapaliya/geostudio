"""Reading GeoTIFFs: metadata, display previews and exact pixel lookup.

Design rule (from the user stories): display adjustments never change the
original measurements.  Previews are 8-bit renderings for the screen only;
band values that go into training records are always read from the original file.
"""
from __future__ import annotations

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.errors import RasterioIOError

SUPPORTED_EXTENSIONS = {".tif", ".tiff"}
MAX_PREVIEW_SIDE = 2048  # larger images are downsampled for display only (see experiments/RESULTS.md)


class UnsupportedImageError(ValueError):
    """Raised with a message that is safe to show to the user."""


@dataclass
class ImageInfo:
    width: int
    height: int
    band_count: int
    bands: list[dict]
    dtype: str
    crs: str | None
    transform: list[float] | None
    pixel_size: list[float] | None
    preview_scale: float  # original pixels per preview pixel (1.0 = full resolution)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


def check_extension(filename: str) -> None:
    ext = Path(filename or "").suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise UnsupportedImageError(
            f"'{filename}' is not supported. Please choose a GeoTIFF file (.tif or .tiff)."
        )


def _guess_band_name(index: int, count: int, description: str | None) -> str:
    if description:
        return description
    if count >= 4:
        return ["Red", "Green", "Blue", "NIR"][index] if index < 4 else f"Band {index + 1}"
    if count == 3:
        return ["Red", "Green", "Blue"][index]
    return f"Band {index + 1}"


def read_info(path: Path) -> ImageInfo:
    try:
        with rasterio.open(path) as ds:
            bands = [
                {"index": i + 1, "name": _guess_band_name(i, ds.count, ds.descriptions[i])}
                for i in range(ds.count)
            ]
            t = ds.transform
            georef = ds.crs is not None
            scale = max(1.0, max(ds.width, ds.height) / MAX_PREVIEW_SIDE)
            return ImageInfo(
                width=ds.width,
                height=ds.height,
                band_count=ds.count,
                bands=bands,
                dtype=ds.dtypes[0],
                crs=ds.crs.to_string() if georef else None,
                transform=[t.a, t.b, t.c, t.d, t.e, t.f] if georef else None,
                pixel_size=[abs(t.a), abs(t.e)] if georef else None,
                preview_scale=round(scale, 6),
            )
    except RasterioIOError as exc:
        raise UnsupportedImageError(
            "This file could not be read as a GeoTIFF. It may be damaged or use an "
            "unsupported compression. Details: " + str(exc).split(":")[-1].strip()
        ) from exc


def _stretch(band: np.ndarray, nodata_mask: np.ndarray | None) -> np.ndarray:
    """2-98 % percentile stretch to 0-255 (display only)."""
    valid = band[~nodata_mask] if nodata_mask is not None else band.ravel()
    if valid.size == 0:
        return np.zeros(band.shape, dtype=np.uint8)
    lo, hi = np.percentile(valid, (2, 98))
    if hi <= lo:
        hi = lo + 1
    out = (band.astype(np.float32) - lo) / (hi - lo)
    return (np.clip(out, 0, 1) * 255).astype(np.uint8)


def render_preview(path: Path, rgb: tuple[int, int, int] = (1, 2, 3)) -> bytes:
    """Return a PNG for the screen using the chosen bands as R, G, B (1-based)."""
    with rasterio.open(path) as ds:
        rgb = tuple(min(max(1, b), ds.count) for b in rgb)
        scale = max(1.0, max(ds.width, ds.height) / MAX_PREVIEW_SIDE)
        out_shape = (3, round(ds.height / scale), round(ds.width / scale))
        arr = ds.read(list(rgb), out_shape=out_shape)
        mask = None
        if ds.nodata is not None:
            mask = arr[0] == ds.nodata
        channels = [_stretch(arr[i], mask) for i in range(3)]
    img = Image.fromarray(np.dstack(channels), mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", compress_level=1)
    return buf.getvalue()


def pixel_values(path: Path, row: int, col: int) -> dict:
    """Exact original values for one pixel plus its map coordinates (pixel centre)."""
    with rasterio.open(path) as ds:
        if not (0 <= row < ds.height and 0 <= col < ds.width):
            raise IndexError(f"Pixel (row={row}, col={col}) is outside the {ds.width}x{ds.height} image.")
        window = rasterio.windows.Window(col, row, 1, 1)
        values = ds.read(window=window)[:, 0, 0]
        result = {
            "row": row,
            "col": col,
            "pixel_id": row * ds.width + col,
            "bands": [
                {"index": i + 1, "name": _guess_band_name(i, ds.count, ds.descriptions[i]),
                 "value": values[i].item()}
                for i in range(ds.count)
            ],
            "map": None,
        }
        if ds.crs is not None:
            x, y = ds.xy(row, col, offset="center")
            result["map"] = {"x": x, "y": y, "crs": ds.crs.to_string()}
        return result
