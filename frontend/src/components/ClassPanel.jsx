import { useState } from "react";

const PALETTE = ["#2e9e44", "#b5651d", "#1f6feb", "#c9302c", "#8e44ad", "#d4a017", "#16a2b8", "#e84393"];

export default function ClassPanel({
  classes, points, selectedClassId, onSelect, onAdd, hiddenClasses, onToggleVisible,
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[classes.length % PALETTE.length]);
  const [busy, setBusy] = useState(false);

  const counts = points.reduce((acc, p) => ({ ...acc, [p.class_id]: (acc[p.class_id] || 0) + 1 }), {});

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const ok = await onAdd(name.trim(), color);
    setBusy(false);
    if (ok) {
      setName("");
      setColor(PALETTE[(classes.length + 1) % PALETTE.length]);
    }
  };

  return (
    <section className="panel">
      <h2>Classes</h2>
      {classes.length === 0 && <p className="hint">Create a class (e.g. vegetation) before labeling.</p>}
      <ul className="class-list" role="radiogroup" aria-label="Active class">
        {classes.map((c, i) => (
          <li key={c.class_id} className={c.class_id === selectedClassId ? "active" : ""}>
            <input
              type="checkbox"
              title="Show / hide this class"
              checked={!hiddenClasses.has(c.class_id)}
              onChange={() => onToggleVisible(c.class_id)}
            />
            <button className="class-btn" role="radio" aria-checked={c.class_id === selectedClassId}
                    onClick={() => onSelect(c.class_id)}>
              <span className="swatch" style={{ background: c.color }} />
              <span className="class-name">{c.name}</span>
              <span className="class-meta">{i < 9 ? `key ${i + 1} · ` : ""}{counts[c.class_id] || 0} pts</span>
            </button>
          </li>
        ))}
      </ul>
      <form className="add-class" onSubmit={submit}>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Class colour" />
        <input placeholder="New class name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy || !name.trim()}>Add</button>
      </form>
    </section>
  );
}
