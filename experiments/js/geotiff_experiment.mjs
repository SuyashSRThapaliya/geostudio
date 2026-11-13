// Browser-side alternative: parse the GeoTIFF in JavaScript with geotiff.js.
// Run after the Python experiment has created experiments/_data/*.tif:
//   cd experiments/js && npm install && npm start
import { fromArrayBuffer } from "geotiff";
import { readFileSync, writeFileSync } from "node:fs";

const sizes = ["512x384", "2048x1536", "4096x4096"];
const results = [];
for (const s of sizes) {
  const buf = readFileSync(new URL(`../_data/test_${s}.tif`, import.meta.url));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let t = performance.now();
  const tiff = await fromArrayBuffer(ab);
  const img = await tiff.getImage();
  const meta = { width: img.getWidth(), height: img.getHeight(), bands: img.getSamplesPerPixel(),
                 epsg: img.getGeoKeys()?.ProjectedCSTypeGeoKey ?? null };
  const tMeta = performance.now() - t;
  t = performance.now();
  const rasters = await img.readRasters();
  const tRead = performance.now() - t;
  const blue = rasters[2][5 * meta.width + 7];
  const heapMb = Math.round(process.memoryUsage().heapUsed / 1e6 + process.memoryUsage().arrayBuffers / 1e6);
  results.push({ size: s, open_metadata_ms: +tMeta.toFixed(1), read_all_ms: +tRead.toFixed(1),
                 ...meta, pixel_check: blue === 507, approx_memory_mb: heapMb });
}
console.table(results);
writeFileSync(new URL("../results_geotiffjs.json", import.meta.url), JSON.stringify(results, null, 2));
