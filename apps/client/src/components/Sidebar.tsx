import { useState } from "react";
import type { Conversation, WorkerProfile } from "../lib/db.ts";
import { IconEdit, IconPlus, IconSettings, IconTrash } from "./icons.tsx";

function group(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function Sidebar(props: {
  open: boolean;
  conversations: Conversation[];
  workers: WorkerProfile[];
  activeId: string | null;
  streamingIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const workerName = (id: string) => props.workers.find((w) => w.id === id)?.name ?? "Removed worker";

  const groups = new Map<string, Conversation[]>();
  for (const c of props.conversations) {
    const g = group(c.updatedAt);
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }

  return (
    <>
      <div className={`sidebar-scrim ${props.open ? "show" : ""}`} onClick={props.onClose} />
      <aside className={`sidebar ${props.open ? "open" : ""}`} aria-label="Conversations">
        <div className="sidebar-top">
          <div className="brand">
            <span className="logo-mark small" aria-hidden>
              R
            </span>
            RelayLLM
          </div>
          <button className="btn new-chat" onClick={props.onNew}>
            <IconPlus /> New chat
          </button>
        </div>
        <nav className="conv-list">
          {props.conversations.length === 0 && <p className="small muted pad">Your conversations will appear here. They are stored only on this device.</p>}
          {[...groups.entries()].map(([label, convs]) => (
            <div key={label} className="conv-group">
              <div className="conv-group-label">{label}</div>
              {convs.map((c) => (
                <div key={c.id} className={`conv-item ${c.id === props.activeId ? "active" : ""}`}>
                  {editing === c.id ? (
                    <input
                      autoFocus
                      className="conv-rename"
                      defaultValue={c.title}
                      maxLength={100}
                      onBlur={(e) => {
                        setEditing(null);
                        if (e.target.value.trim()) props.onRename(c.id, e.target.value.trim());
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setEditing(null);
                      }}
                    />
                  ) : (
                    <button className="conv-title" onClick={() => props.onSelect(c.id)} title={`${c.title}\n${workerName(c.workerId)} · ${c.model}`}>
                      {props.streamingIds.has(c.id) && <span className="dot pulsing" aria-label="generating" />}
                      <span className="ellipsis">{c.title}</span>
                    </button>
                  )}
                  <div className="conv-actions">
                    <button className="icon-btn small" aria-label="Rename" onClick={() => setEditing(c.id)}>
                      <IconEdit />
                    </button>
                    <button
                      className="icon-btn small"
                      aria-label="Delete"
                      onClick={() => {
                        if (confirm(`Delete “${c.title}”?`)) props.onDelete(c.id);
                      }}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="btn ghost wide left" onClick={props.onSettings}>
            <IconSettings /> Settings
          </button>
        </div>
      </aside>
    </>
  );
}
