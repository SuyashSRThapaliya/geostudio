const fmt = (n) => (typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n);

export function ImageInfo({ image }) {
  if (!image) return null;
  return (
    <section className="panel">
      <h2>Image</h2>
      <dl className="kv">
        <dt>File</dt><dd title={image.filename}>{image.filename}</dd>
        <dt>Size</dt><dd>{fmt(image.width)} × {fmt(image.height)} px</dd>
        <dt>Bands</dt><dd>{image.band_count} ({image.bands.map((b) => b.name).join(", ")})</dd>
        <dt>Data type</dt><dd>{image.dtype}</dd>
        <dt>CRS</dt><dd>{image.crs || "not georeferenced"}</dd>
        {image.pixel_size && <><dt>Pixel size</dt><dd>{image.pixel_size[0]} × {image.pixel_size[1]} map units</dd></>}
      </dl>
      {image.preview_scale > 1 && (
        <p className="warn">
          Large image: the display is downsampled ×{image.preview_scale.toFixed(2)}. Zoom selects the nearest
          original pixel; exact pixel tiles are planned for Sprint 3.
        </p>
      )}
    </section>
  );
}

export function PixelDetails({ point, classes }) {
  if (!point) return (
    <section className="panel">
      <h2>Selected point</h2>
      <p className="hint">Click the image to label a pixel, or pick a point from the list.</p>
    </section>
  );
  const cls = classes.find((c) => c.class_id === point.class_id);
  return (
    <section className="panel">
      <h2>Selected point</h2>
      <dl className="kv">
        <dt>Point</dt><dd>{point.point_id}</dd>
        <dt>Class</dt><dd><span className="swatch" style={{ background: cls?.color }} /> {cls?.name}</dd>
        <dt>Pixel</dt><dd>row {point.row}, col {point.col}</dd>
        <dt>Pixel ID</dt><dd>{point.pixel_id}</dd>
        {point.map && <><dt>Map (centre)</dt><dd>{fmt(point.map.x)}, {fmt(point.map.y)}</dd></>}
        {point.bands.map((b) => (
          <FragmentRow key={b.index} label={`B${b.index} ${b.name}`} value={fmt(b.value)} />
        ))}
        <dt>Status</dt><dd>{point.approval_status}</dd>
      </dl>
    </section>
  );
}

const FragmentRow = ({ label, value }) => (<><dt>{label}</dt><dd>{value}</dd></>);

export function PointList({ points, classes, selectedPointId, onSelect, onRemove }) {
  const byId = Object.fromEntries(classes.map((c) => [c.class_id, c]));
  return (
    <section className="panel grow">
      <h2>Labeled points ({points.length})</h2>
      {points.length === 0 && <p className="hint">No points yet.</p>}
      <ul className="point-list">
        {[...points].reverse().map((p) => (
          <li key={p.point_id} className={p.point_id === selectedPointId ? "active" : ""}>
            <button className="link" onClick={() => onSelect(p.point_id)}>
              <span className="swatch" style={{ background: byId[p.class_id]?.color }} />
              {byId[p.class_id]?.name} · r{p.row} c{p.col}
            </button>
            <button className="remove" title="Remove this point" onClick={() => onRemove(p.point_id)}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
