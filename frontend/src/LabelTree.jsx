import { Fragment, useState } from "react";

const PALETTE = ["#2e9e44", "#b5651d", "#1f6feb", "#c9302c", "#8e44ad", "#d4a017", "#16a2b8", "#e84393", "#7cb342", "#5d4037", "#00897b", "#f4511e"];

/**
 * Label tree.  Top level = label classes; indented = labels inside a class.
 * Checkbox = show/hide. A class checkbox controls everything under it.
 */
export default function LabelTree({ labels, counts, activeId, hidden, onActivate, onToggle, onAdd, onUpdate, onDelete }) {
  const [adding, setAdding] = useState(null);      // null | "top" | parent label id
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[labels.length % PALETTE.length]);
  const [editing, setEditing] = useState(null);    // {id, name}
  const [moving, setMoving] = useState(null);      // label id being demoted

  const tops = labels.filter((l) => l.parent_id == null);
  const childrenOf = (id) => labels.filter((l) => l.parent_id === id);
  const order = tops.flatMap((t) => [t, ...childrenOf(t.label_id)]);
  const shortcut = (l) => { const i = order.indexOf(l); return i < 9 ? i + 1 : null; };

  const startAdd = (where) => { setAdding(where); setName(""); setColor(PALETTE[labels.length % PALETTE.length]); };
  const submitAdd = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (await onAdd(name.trim(), color, adding === "top" ? null : adding)) setAdding(null);
  };
  const submitRename = async (e) => {
    e.preventDefault();
    if (await onUpdate(editing.id, { name: editing.name })) setEditing(null);
  };

  const addForm = (
    <form className="label-form" onSubmit={submitAdd}>
      <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Label colour" />
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="New label name"
             placeholder={adding === "top" ? "Label / class name" : "Label name"} onKeyDown={(e) => e.key === "Escape" && setAdding(null)} />
      <button type="submit" disabled={!name.trim()}>Add</button>
      <button type="button" onClick={() => setAdding(null)} title="Cancel">✕</button>
    </form>
  );

  const row = (l, isChild) => {
    const kids = childrenOf(l.label_id);
    const parentHidden = isChild && hidden.has(l.parent_id);
    const n = (counts[l.label_id] || 0) + kids.reduce((s, k) => s + (counts[k.label_id] || 0), 0);
    return (
      <li key={l.label_id} className={`label-row${isChild ? " child" : ""}${l.label_id === activeId ? " active" : ""}`}>
        <input type="checkbox" checked={!hidden.has(l.label_id) && !parentHidden} disabled={parentHidden}
               title={kids.length ? "Show / hide this class and its labels" : "Show / hide"}
               onChange={() => onToggle(l.label_id, kids.map((k) => k.label_id))} />
        <input type="color" className="swatch-input" value={l.color} title="Change colour"
               onChange={(e) => onUpdate(l.label_id, { color: e.target.value })} />
        {editing?.id === l.label_id ? (
          <form className="rename" onSubmit={submitRename}>
            <input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                   onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
          </form>
        ) : (
          <button className="label-name" onClick={() => onActivate(l.label_id)} onDoubleClick={() => setEditing({ id: l.label_id, name: l.name })}
                  title="Click to label with this · double-click to rename">
            <span>{l.name}</span>
            <small>{shortcut(l) ? `${shortcut(l)} · ` : ""}{n}</small>
          </button>
        )}
        <span className="label-actions">
          {!isChild && <button title="Add a label inside this class" onClick={() => startAdd(l.label_id)}>＋</button>}
          {isChild && <button title="Promote: make this its own label class" onClick={() => onUpdate(l.label_id, { parent_id: null })}>⇤</button>}
          {!isChild && kids.length === 0 && tops.length > 1 && (
            <button title="Demote: move this label inside another class" onClick={() => setMoving(moving === l.label_id ? null : l.label_id)}>⇥</button>
          )}
          <button title="Rename" onClick={() => setEditing({ id: l.label_id, name: l.name })}>✎</button>
          <button title="Delete" className="danger-text" onClick={() => onDelete(l)}>🗑</button>
        </span>
        {moving === l.label_id && (
          <select className="move-select" autoFocus defaultValue="" onBlur={() => setMoving(null)}
                  onChange={(e) => { onUpdate(l.label_id, { parent_id: Number(e.target.value) }); setMoving(null); }}>
            <option value="" disabled>Move inside…</option>
            {tops.filter((t) => t.label_id !== l.label_id).map((t) => <option key={t.label_id} value={t.label_id}>{t.name}</option>)}
          </select>
        )}
      </li>
    );
  };

  return (
    <section className="panel">
      <h2>Labels <button className="mini" onClick={() => startAdd("top")} title="Add a label class">＋ Add</button></h2>
      {labels.length === 0 && adding == null && <p className="hint">Add a label (for example “vegetation”) to start labeling.</p>}
      <ul className="label-tree">
        {tops.map((t) => (
          <Fragment key={t.label_id}>
            {row(t, false)}
            {childrenOf(t.label_id).map((c) => row(c, true))}
            {adding === t.label_id && <li className="label-row child">{addForm}</li>}
          </Fragment>
        ))}
      </ul>
      {adding === "top" && addForm}
    </section>
  );
}
