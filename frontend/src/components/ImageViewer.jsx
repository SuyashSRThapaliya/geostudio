import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Canvas image viewer.
 *  - wheel = zoom around the cursor, drag = pan, click = label the pixel under the cursor
 *  - zooming enlarges pixels (no smoothing) so single pixels can be picked accurately
 *
 * Coordinate systems
 *   screen  : CSS pixels inside the canvas
 *   preview : pixels of the PNG sent by the backend (may be downsampled for huge images)
 *   original: row/col in the original TIFF   original = preview * previewScale
 */
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64; // screen px per preview px
const CLICK_TOLERANCE = 4; // px of movement before a click becomes a drag

export default function ImageViewer({
  imageUrl, info, points, classes, hiddenClasses, labelOpacity,
  selectedPointId, onPixelClick, onHover, onViewChange, labelingEnabled,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const view = useRef({ s: 1, ox: 0, oy: 0 });
  const drag = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [loaded, setLoaded] = useState(false);
  const [, force] = useState(0);
  const ps = info?.preview_scale || 1;

  // ---------- drawing ----------
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!img || !loaded) return;
    const { s, ox, oy } = view.current;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, img.naturalWidth * s, img.naturalHeight * s);

    const colorOf = Object.fromEntries(classes.map((c) => [c.class_id, c.color]));
    const pxOnScreen = s / ps; // size of one ORIGINAL pixel on screen
    ctx.globalAlpha = labelOpacity;
    for (const p of points) {
      if (hiddenClasses.has(p.class_id)) continue;
      const x = ox + (p.col / ps) * s;
      const y = oy + (p.row / ps) * s;
      const cx = x + pxOnScreen / 2;
      const cy = y + pxOnScreen / 2;
      if (cx < -20 || cy < -20 || cx > size.w + 20 || cy > size.h + 20) continue;
      const color = colorOf[p.class_id] || "#fff";
      if (pxOnScreen >= 6) {
        // zoomed in: outline the exact labeled pixel
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.strokeRect(x + 1, y + 1, pxOnScreen - 2, pxOnScreen - 2);
      }
      ctx.beginPath();
      ctx.arc(cx, cy, p.point_id === selectedPointId ? 7 : 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = p.point_id === selectedPointId ? 3 : 1.5;
      ctx.strokeStyle = p.point_id === selectedPointId ? "#ffeb3b" : "#000";
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [size, loaded, points, classes, hiddenClasses, labelOpacity, selectedPointId, ps]);

  useEffect(draw, [draw]);
  // Handlers created in earlier renders must always call the LATEST draw (fresh view/points/loaded).
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const redraw = () => drawRef.current();

  // ---------- sizing ----------
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    c.width = size.w * dpr;
    c.height = size.h * dpr;
    c.style.width = `${size.w}px`;
    c.style.height = `${size.h}px`;
    draw();
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = () => {
    onViewChange?.({ zoom: view.current.s / ps });
    force((n) => n + 1);
    redraw();
  };

  // ---------- fit / zoom ----------
  const fit = useCallback(() => {
    const img = imgRef.current;
    if (!img || !size.w) return;
    // longest dimension fits the window, image centred (Sprint 1 requirement 2.2)
    const s = Math.min(size.w / img.naturalWidth, size.h / img.naturalHeight) * 0.95;
    view.current = {
      s,
      ox: (size.w - img.naturalWidth * s) / 2,
      oy: (size.h - img.naturalHeight * s) / 2,
    };
    report();
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = (factor, mx = size.w / 2, my = size.h / 2) => {
    const v = view.current;
    const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.s * factor));
    view.current = { s, ox: mx - (mx - v.ox) * (s / v.s), oy: my - (my - v.oy) * (s / v.s) };
    report();
  };

  const actualPixels = () => {
    // 1 original pixel = 1 screen pixel, centred on the view centre
    const v = view.current;
    const target = ps; // screen px per preview px so that 1 original px = 1 screen px
    zoomAt(target / v.s);
  };

  // ---------- image loading ----------
  useEffect(() => {
    setLoaded(false);
    if (!imageUrl) return;
    let cancelled = false; // ignore a slower, older image (e.g. quick band switching)
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      setLoaded(true);
    };
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl]);

  // Fit only when a different image is opened; changing display bands keeps the current zoom/pan.
  const fittedFor = useRef(null);
  useEffect(() => {
    if (loaded && fittedFor.current !== info?.image_id) {
      fittedFor.current = info?.image_id;
      fit();
    }
  }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- pointer → original pixel ----------
  const toPixel = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const { s, ox, oy } = view.current;
    const col = Math.floor(((mx - ox) / s) * ps);
    const row = Math.floor(((my - oy) / s) * ps);
    const inside = info && row >= 0 && col >= 0 && row < info.height && col < info.width;
    return { mx, my, row, col, inside };
  };

  const onPointerDown = (e) => {
    if (!loaded) return;
    canvasRef.current.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: view.current.ox, oy: view.current.oy, moved: false };
  };

  const onPointerMove = (e) => {
    if (!loaded) return;
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) > CLICK_TOLERANCE) d.moved = true;
      if (d.moved) {
        view.current = { ...view.current, ox: d.ox + dx, oy: d.oy + dy };
        redraw();
      }
    }
    const p = toPixel(e);
    onHover?.(p.inside ? { row: p.row, col: p.col } : null);
  };

  const onPointerUp = (e) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const p = toPixel(e);
    if (p.inside) onPixelClick?.(p.row, p.col);
  };

  const onWheel = (e) => {
    if (!loaded) return;
    const rect = canvasRef.current.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - rect.left, e.clientY - rect.top);
  };

  // React attaches wheel listeners as passive; attach our own so we can preventDefault.
  useEffect(() => {
    const c = canvasRef.current;
    const stop = (e) => e.preventDefault();
    c.addEventListener("wheel", stop, { passive: false });
    return () => c.removeEventListener("wheel", stop);
  }, []);

  return (
    <div className="viewer" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={labelingEnabled ? "cursor-label" : "cursor-pan"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => onHover?.(null)}
        onWheel={onWheel}
      />
      {!imageUrl && <div className="viewer-empty">Open a GeoTIFF (.tif / .tiff) to begin.</div>}
      {imageUrl && !loaded && <div className="viewer-empty">Loading image…</div>}
      {loaded && (
        <div className="zoom-controls">
          <button onClick={() => zoomAt(1.5)} title="Zoom in">+</button>
          <button onClick={() => zoomAt(1 / 1.5)} title="Zoom out">−</button>
          <button onClick={fit} title="Fit image to window">Fit</button>
          <button onClick={actualPixels} title="1 image pixel = 1 screen pixel">1:1</button>
        </div>
      )}
    </div>
  );
}
