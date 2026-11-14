import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * Image viewer and drawing surface.
 *
 * Two stacked canvases: the image (brightness/contrast are CSS filters, so they
 * only change what you see) and an overlay with predictions, labels and tools.
 *
 * Coordinates
 *   screen   CSS pixels inside the viewer
 *   preview  pixels of the display PNG (downsampled for very large images)
 *   original row/col in the TIFF:  original = preview * preview_scale
 * Vertices are always stored as original [row, col].
 */
const MIN_ZOOM = 0.02;
const MAX_PX = 80;          // largest size of one original pixel on screen
const CLICK_TOLERANCE = 4;  // movement (px) before a click becomes a drag
export const REQUEST_COLORS = { add_points: "#22c55e", remove_points: "#ef4444", relabel: "#facc15" };
const DRAFT_TOOLS = { line: "line", polygon: "polygon", "flag-polygon": "polygon" };

const Viewer = forwardRef(function Viewer(props, ref) {
  const P = useRef(props);
  P.current = props;
  const wrap = useRef(null);
  const imgCanvas = useRef(null);
  const ovlCanvas = useRef(null);
  const miniCanvas = useRef(null);
  const S = useRef({ view: { s: 1, ox: 0, oy: 0 }, w: 0, h: 0, img: null, imgFor: null, overlay: null,
                     draft: [], cursor: null, drag: null, box: null, fittedFor: null, raf: 0 }).current;

  const ps = () => P.current.image?.preview_scale || 1;
  const pxSize = () => S.view.s / ps();                           // one original pixel, in screen px
  const toScreen = (row, col) => [S.view.ox + (col + 0.5) * pxSize(), S.view.oy + (row + 0.5) * pxSize()];
  const toPixel = (mx, my) => {
    const im = P.current.image;
    const col = Math.floor((mx - S.view.ox) / pxSize());
    const row = Math.floor((my - S.view.oy) / pxSize());
    return { row, col, inside: !!im && row >= 0 && col >= 0 && row < im.height && col < im.width };
  };

  // ------------------------------------------------------------ drawing
  const schedule = () => {
    if (S.raf) return;
    S.raf = requestAnimationFrame(() => { S.raf = 0; draw(); });
  };

  function draw() {
    if (!imgCanvas.current) return;   // unmounted
    const p = P.current;
    const dpr = window.devicePixelRatio || 1;
    const { s, ox, oy } = S.view;
    const ictx = imgCanvas.current.getContext("2d");
    ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ictx.clearRect(0, 0, S.w, S.h);
    const ctx = ovlCanvas.current.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S.w, S.h);
    drawMinimap();
    if (!S.img || !p.image) return;
    const iw = S.img.naturalWidth * s, ih = S.img.naturalHeight * s;
    ictx.imageSmoothingEnabled = s < 1;     // zooming in enlarges pixels, never blurs them
    ictx.drawImage(S.img, ox, oy, iw, ih);

    if (S.overlay && p.overlayOpacity > 0) {
      ctx.globalAlpha = p.overlayOpacity;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(S.overlay, ox, oy, iw, ih);
      ctx.globalAlpha = 1;
    }
    const px = pxSize();
    if (p.showGrid && px >= 8) drawGrid(ctx, px);
    for (const a of p.annotations) drawAnnotation(ctx, a, px);
    for (const r of p.requests || []) drawRequest(ctx, r);
    drawDraft(ctx, px);
    if (S.box) {
      ctx.setLineDash([6, 4]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.strokeRect(S.box.x, S.box.y, S.box.w, S.box.h); ctx.setLineDash([]);
    }
    if (p.lens && S.cursor && !S.drag) drawLens(ctx);
  }

  function drawGrid(ctx, px) {
    const im = P.current.image;
    const c0 = Math.max(0, Math.floor(-S.view.ox / px)), c1 = Math.min(im.width, Math.ceil((S.w - S.view.ox) / px));
    const r0 = Math.max(0, Math.floor(-S.view.oy / px)), r1 = Math.min(im.height, Math.ceil((S.h - S.view.oy) / px));
    ctx.beginPath();
    for (let c = c0; c <= c1; c++) { const x = Math.round(S.view.ox + c * px) + 0.5; ctx.moveTo(x, S.view.oy + r0 * px); ctx.lineTo(x, S.view.oy + r1 * px); }
    for (let r = r0; r <= r1; r++) { const y = Math.round(S.view.oy + r * px) + 0.5; ctx.moveTo(S.view.ox + c0 * px, y); ctx.lineTo(S.view.ox + c1 * px, y); }
    ctx.strokeStyle = "rgba(255,255,255,.13)"; ctx.lineWidth = 1; ctx.stroke();
  }

  function trace(ctx, vertices, close) {
    ctx.beginPath();
    vertices.forEach(([r, c], i) => { const [x, y] = toScreen(r, c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    if (close) ctx.closePath();
  }

  function drawAnnotation(ctx, a, px) {
    const p = P.current;
    const selected = a.annotation_id === p.selectedId;
    if (p.hiddenIds.has(a.label_id) && !selected) return;
    if (a.approval_status === "rejected" && !selected && !p.showRejected) return;
    const color = p.labelsById.get(a.label_id)?.color || "#fff";
    const reviewed = a.approval_status === "approved";
    ctx.globalAlpha = p.alpha;
    if (a.type === "polygon") {
      trace(ctx, a.vertices, true);
      ctx.globalAlpha = p.alpha * 0.35; ctx.fillStyle = color; ctx.fill();
      ctx.globalAlpha = p.alpha; ctx.lineWidth = selected ? 3 : 2; ctx.strokeStyle = color; ctx.stroke();
    } else if (a.type === "line") {
      trace(ctx, a.vertices, false);
      ctx.lineWidth = selected ? 5 : 3; ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = color; ctx.stroke();
    } else {
      const [x, y] = toScreen(a.vertices[0][0], a.vertices[0][1]);
      if (x < -20 || y < -20 || x > S.w + 20 || y > S.h + 20) { ctx.globalAlpha = 1; return; }
      if (px >= 6) { ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.strokeRect(x - px / 2 + 1, y - px / 2 + 1, px - 2, px - 2); }
      const r = selected ? 7 : 5;
      ctx.beginPath();
      if (reviewed) ctx.arc(x, y, r, 0, Math.PI * 2);
      else { ctx.moveTo(x, y - r - 2); ctx.lineTo(x + r + 2, y); ctx.lineTo(x, y + r + 2); ctx.lineTo(x - r - 2, y); ctx.closePath(); } // suggestion = diamond
      ctx.fillStyle = a.approval_status === "rejected" ? "#555" : color; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = reviewed ? "#000" : "#fff";
      if (!reviewed) ctx.setLineDash([3, 2]);
      ctx.stroke(); ctx.setLineDash([]);
      if (a.approval_status === "unresolved") { ctx.fillStyle = "#000"; ctx.font = "bold 10px system-ui"; ctx.textAlign = "center"; ctx.fillText("?", x, y + 3.5); }
    }
    if (selected) {   // selection halo
      ctx.globalAlpha = 1; ctx.strokeStyle = "#ffeb3b"; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
      if (a.type === "point") { const [x, y] = toScreen(a.vertices[0][0], a.vertices[0][1]); ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); }
      else trace(ctx, a.vertices, a.type === "polygon");
      ctx.stroke(); ctx.setLineDash([]);
      if (a.type !== "point") for (const [r, c] of a.vertices) { const [x, y] = toScreen(r, c); ctx.fillStyle = "#ffeb3b"; ctx.fillRect(x - 3, y - 3, 6, 6); }
    }
    ctx.globalAlpha = 1;
  }

  function drawRequest(ctx, r) {
    const p = P.current;
    const color = REQUEST_COLORS[r.requested_action] || "#fff";
    const selected = r.request_id === p.selectedRequestId;
    ctx.globalAlpha = r.status === "open" ? 1 : 0.4;
    ctx.strokeStyle = color; ctx.lineWidth = selected ? 4 : 2.5; ctx.setLineDash([8, 4]);
    if (r.location.type === "polygon") {
      trace(ctx, r.location.pixel_vertices, true);
      ctx.fillStyle = color; ctx.globalAlpha *= 0.18; ctx.fill();
      ctx.globalAlpha = r.status === "open" ? 1 : 0.4; ctx.stroke();
    } else {
      const [x, y] = toScreen(r.location.pixel.row, r.location.pixel.col);
      ctx.beginPath(); ctx.arc(x, y, selected ? 13 : 10, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y); ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  function drawDraft(ctx, px) {
    const p = P.current;
    const kind = DRAFT_TOOLS[p.tool];
    const hover = S.cursor && toPixel(S.cursor.x, S.cursor.y);
    const color = p.tool === "flag-polygon" ? "#facc15" : p.activeColor || "#fff";
    if (hover?.inside && p.tool !== "pan" && p.tool !== "zoombox" && px >= 4 && !S.drag) {   // pixel under the cursor
      const [x, y] = toScreen(hover.row, hover.col);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.strokeRect(x - px / 2 + 0.5, y - px / 2 + 0.5, px - 1, px - 1);
    }
    if (!kind || S.draft.length === 0) return;
    const pts = hover?.inside ? [...S.draft, [hover.row, hover.col]] : S.draft;
    trace(ctx, pts, false);
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    if (kind === "polygon" && pts.length > 2) {
      const [x0, y0] = toScreen(pts[0][0], pts[0][1]); const [x1, y1] = toScreen(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x0, y0); ctx.stroke(); ctx.setLineDash([]);
    }
    S.draft.forEach(([r, c], i) => {
      const [x, y] = toScreen(r, c);
      ctx.fillStyle = i === 0 ? "#fff" : color; ctx.strokeStyle = "#000"; ctx.lineWidth = 1;
      ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4, y - 4, 8, 8);
    });
  }

  function drawLens(ctx) {
    const p = P.current;
    const { x, y } = S.cursor;
    const R = 85;
    const s2 = Math.max(S.view.s * 3, 10 * ps());      // at least 10 screen px per original pixel
    const k = s2 / S.view.s;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "#111"; ctx.fillRect(x - R, y - R, 2 * R, 2 * R);
    ctx.imageSmoothingEnabled = false;
    ctx.filter = `brightness(${p.brightness}%) contrast(${p.contrast}%)`;
    const ox = x - (x - S.view.ox) * k, oy = y - (y - S.view.oy) * k;
    ctx.drawImage(S.img, ox, oy, S.img.naturalWidth * s2, S.img.naturalHeight * s2);
    ctx.filter = "none";
    const hover = toPixel(x, y);
    if (hover.inside) {      // the exact pixel a click would label
      const big = s2 / ps();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + hover.col * big, oy + hover.row * big, big, big);
    }
    ctx.restore();
    ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawMinimap() {
    const c = miniCanvas.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!S.img) return;
    const k = Math.min(c.width / S.img.naturalWidth, c.height / S.img.naturalHeight);
    const w = S.img.naturalWidth * k, h = S.img.naturalHeight * k;
    const x0 = (c.width - w) / 2, y0 = (c.height - h) / 2;
    ctx.drawImage(S.img, x0, y0, w, h);
    S.mini = { k, x0, y0 };
    const { s, ox, oy } = S.view;
    ctx.strokeStyle = "#ffeb3b"; ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + Math.max(0, -ox / s) * k, y0 + Math.max(0, -oy / s) * k,
                   Math.min(S.img.naturalWidth, S.w / s) * k, Math.min(S.img.naturalHeight, S.h / s) * k);
  }

  // ------------------------------------------------------------ view control
  const report = () => { P.current.onView?.(pxSize()); schedule(); };

  const fit = () => {
    if (!S.img || !S.w) return;
    // longest dimension fits the window, image centred
    const s = Math.min(S.w / S.img.naturalWidth, S.h / S.img.naturalHeight) * 0.94;
    S.view = { s, ox: (S.w - S.img.naturalWidth * s) / 2, oy: (S.h - S.img.naturalHeight * s) / 2 };
    S.fitted = true;      // stays fitted when the window is resized, until the user zooms or pans
    report();
  };
  const zoomAt = (factor, mx = S.w / 2, my = S.h / 2) => {
    const v = S.view;
    S.fitted = false;
    const s = Math.min(MAX_PX * ps(), Math.max(MIN_ZOOM, v.s * factor));
    S.view = { s, ox: mx - (mx - v.ox) * (s / v.s), oy: my - (my - v.oy) * (s / v.s) };
    report();
  };
  const centerOn = (row, col) => {
    if (pxSize() < 2) zoomAt(2 / pxSize());
    const [x, y] = toScreen(row, col);
    S.view = { ...S.view, ox: S.view.ox + S.w / 2 - x, oy: S.view.oy + S.h / 2 - y };
    S.fitted = false;
    report();
  };

  useImperativeHandle(ref, () => ({
    fit, zoomIn: () => zoomAt(1.5), zoomOut: () => zoomAt(1 / 1.5),
    actualSize: () => zoomAt(ps() / S.view.s),      // 1 image pixel = 1 screen pixel
    centerOn,
    hasDraft: () => S.draft.length > 0,
  }));

  // ------------------------------------------------------------ loading
  useEffect(() => {
    const id = props.image?.image_id || null;
    if (S.imgFor !== id) { S.img = null; S.imgFor = id; S.draft = []; schedule(); }
    if (!props.previewUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      S.img = img;
      if (S.fittedFor !== id) { S.fittedFor = id; fit(); }   // band changes keep the current view
      P.current.onLoaded?.();
      schedule();
    };
    img.onerror = () => { if (!cancelled) P.current.onError?.("The image could not be displayed."); };
    img.src = props.previewUrl;
    return () => { cancelled = true; };
  }, [props.previewUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    S.overlay = null; schedule();
    if (!props.overlayUrl) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => { if (!cancelled) { S.overlay = img; schedule(); } };
    img.src = props.overlayUrl;
    return () => { cancelled = true; };
  }, [props.overlayUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { S.draft = []; S.box = null; schedule(); }, [props.tool]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(schedule);   // any prop change -> repaint

  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => {
      const dpr = window.devicePixelRatio || 1;
      const first = !S.w;
      S.w = Math.floor(entry.contentRect.width); S.h = Math.floor(entry.contentRect.height);
      for (const c of [imgCanvas.current, ovlCanvas.current]) {
        c.width = S.w * dpr; c.height = S.h * dpr; c.style.width = `${S.w}px`; c.style.height = `${S.h}px`;
      }
      if ((first || S.fitted) && S.img) fit(); else draw();
    });
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------ tools
  const finishDraft = () => {
    const p = P.current;
    const kind = DRAFT_TOOLS[p.tool];
    if (!kind) return;
    const v = S.draft.filter((pt, i) => i === 0 || pt[0] !== S.draft[i - 1][0] || pt[1] !== S.draft[i - 1][1]);
    const need = kind === "line" ? 2 : 3;
    if (v.length < need) { p.onHint?.(`A ${kind} needs at least ${need} points. Keep clicking, or press Esc to cancel.`); return; }
    S.draft = [];
    if (p.tool === "flag-polygon") p.onFlag?.({ type: "polygon", pixel_vertices: v });
    else p.onCreate?.(kind, v);
    schedule();
  };

  const distToSegment = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const hitTest = (mx, my) => {
    const p = P.current;
    const visible = p.annotations.filter((a) => !p.hiddenIds.has(a.label_id) && (a.approval_status !== "rejected" || p.showRejected));
    for (const pass of ["point", "line", "polygon"]) {
      for (let i = visible.length - 1; i >= 0; i--) {
        const a = visible[i];
        if (a.type !== pass) continue;
        const pts = a.vertices.map(([r, c]) => toScreen(r, c));
        if (pass === "point" && Math.hypot(pts[0][0] - mx, pts[0][1] - my) <= 9) return a.annotation_id;
        if (pass === "line") for (let k = 1; k < pts.length; k++) if (distToSegment(mx, my, ...pts[k - 1], ...pts[k]) <= 6) return a.annotation_id;
        if (pass === "polygon") {
          let inside = false;
          for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
            const [xi, yi] = pts[k], [xj, yj] = pts[j];
            if ((yi > my) !== (yj > my) && mx < ((xj - xi) * (my - yi)) / (yj - yi) + xi) inside = !inside;
          }
          if (inside) return a.annotation_id;
        }
      }
    }
    return null;
  };

  const pos = (e) => { const r = ovlCanvas.current.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const showHover = (pt) => {
    const el = P.current.hoverRef?.current;
    if (!el) return;
    const im = P.current.image;
    const h = pt && toPixel(pt.x, pt.y);
    if (!h?.inside) { el.textContent = ""; return; }
    let text = `row ${h.row}, col ${h.col} · pixel ID ${h.row * im.width + h.col}`;
    if (im.transform) {
      const [a, b, c, d, e, f] = im.transform;
      text += ` · x ${(a * (h.col + 0.5) + b * (h.row + 0.5) + c).toFixed(1)}, y ${(d * (h.col + 0.5) + e * (h.row + 0.5) + f).toFixed(1)}`;
    }
    el.textContent = text;
  };

  const onPointerDown = (e) => {
    if (!S.img) return;
    ovlCanvas.current.setPointerCapture(e.pointerId);
    const { x, y } = pos(e);
    S.drag = { x, y, ox: S.view.ox, oy: S.view.oy, moved: false, button: e.button,
               mode: P.current.tool === "zoombox" && e.button === 0 ? "box" : "pan" };
  };
  const onPointerMove = (e) => {
    if (!S.img) return;
    const pt = pos(e);
    S.cursor = pt;
    const d = S.drag;
    if (d) {
      const dx = pt.x - d.x, dy = pt.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) > CLICK_TOLERANCE) d.moved = true;
      if (d.moved && d.mode === "pan") S.fitted = false;
      if (d.moved && d.mode === "pan") S.view = { ...S.view, ox: d.ox + dx, oy: d.oy + dy };
      if (d.moved && d.mode === "box") {      // same aspect ratio as the viewing window
        const w = Math.abs(dx), h = w * (S.h / S.w);
        S.box = { x: dx < 0 ? d.x - w : d.x, y: dy < 0 ? d.y - h : d.y, w, h };
      }
    }
    showHover(pt);
    schedule();
  };
  const onPointerUp = (e) => {
    const d = S.drag;
    S.drag = null;
    if (!d) return;
    const p = P.current;
    if (d.moved) {
      if (d.mode === "box" && S.box && S.box.w > 8) {
        const k = S.w / S.box.w;
        S.view = { s: S.view.s, ox: S.view.ox - S.box.x, oy: S.view.oy - S.box.y };
        S.box = null;
        zoomAt(k, 0, 0);
      }
      S.box = null; schedule();
      return;
    }
    if (d.button !== 0) return;
    const { x, y } = pos(e);
    const h = toPixel(x, y);
    if (p.tool === "pan") { p.onSelect?.(hitTest(x, y)); if (h.inside) p.onInspect?.(h.row, h.col); return; }
    if (!h.inside || p.tool === "zoombox") return;
    if (p.tool === "point") p.onCreate?.("point", [[h.row, h.col]]);
    else if (p.tool === "flag-point") p.onFlag?.({ type: "point", row: h.row, col: h.col });
    else if (DRAFT_TOOLS[p.tool]) {
      if (DRAFT_TOOLS[p.tool] === "polygon" && S.draft.length >= 3) {     // click the first point to close
        const [fx, fy] = toScreen(S.draft[0][0], S.draft[0][1]);
        if (Math.hypot(fx - x, fy - y) <= 9) { finishDraft(); return; }
      }
      if (e.detail > 1) return;        // second click of a double-click: handled by onDoubleClick
      S.draft.push([h.row, h.col]);
      schedule();
    }
  };
  const onWheel = (e) => { if (S.img) { const { x, y } = pos(e); zoomAt(e.deltaY < 0 ? 1.2 : 1 / 1.2, x, y); } };

  useEffect(() => {
    const c = ovlCanvas.current;
    const stop = (e) => e.preventDefault();          // keep the page from scrolling while zooming
    c.addEventListener("wheel", stop, { passive: false });
    const onKey = (e) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || !S.draft.length) return;
      if (e.key === "Enter") { e.preventDefault(); finishDraft(); }
      if (e.key === "Escape") { S.draft = []; schedule(); }
      if (e.key === "Backspace") { e.preventDefault(); S.draft.pop(); schedule(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { c.removeEventListener("wheel", stop); window.removeEventListener("keydown", onKey); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onMini = (e) => {
    if (!S.mini || (e.type === "pointermove" && !(e.buttons & 1))) return;
    const r = miniCanvas.current.getBoundingClientRect();
    const px = (e.clientX - r.left - S.mini.x0) / S.mini.k, py = (e.clientY - r.top - S.mini.y0) / S.mini.k;
    S.view = { ...S.view, ox: S.w / 2 - px * S.view.s, oy: S.h / 2 - py * S.view.s };
    S.fitted = false;
    schedule();
  };

  const cursor = { pan: "grab", zoombox: "zoom-in" }[props.tool] || "crosshair";
  return (
    <div className="viewer" ref={wrap}>
      <canvas ref={imgCanvas} className="layer" style={{ filter: `brightness(${props.brightness}%) contrast(${props.contrast}%)` }} />
      <canvas ref={ovlCanvas} className="layer" style={{ cursor: props.lens ? "none" : cursor }} data-testid="canvas"
              onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
              onPointerLeave={() => { S.cursor = null; showHover(null); schedule(); }}
              onDoubleClick={finishDraft} onWheel={onWheel} onContextMenu={(e) => e.preventDefault()} />
      {props.image && props.minimap && (
        <canvas ref={miniCanvas} className="minimap" width={170} height={120} title="Overview: click to move the view"
                onPointerDown={onMini} onPointerMove={onMini} />
      )}
      {props.children}
    </div>
  );
});

export default Viewer;
