import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { hexToNpub } from "@relayllm/nostr-transport";
import type { ModelInfo } from "@relayllm/protocol";
import type { ChatMessageRecord, Conversation, WorkerProfile } from "../lib/db.ts";
import type { ConnectionState } from "../lib/connection.ts";
import { CopyButton, Markdown } from "./Markdown.tsx";
import { IconChevron, IconMenu, IconPlus, IconRefresh, IconSend, IconServer, IconSliders, IconStop } from "./icons.tsx";

export interface ChatViewProps {
  conversation: Conversation | null;
  workers: WorkerProfile[];
  worker: WorkerProfile | null;
  conn: ConnectionState | null;
  model: string;
  userPubkey: string;
  streaming: boolean;
  onSelectWorker: (id: string) => void;
  onAddWorker: () => void;
  onSelectModel: (id: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onRefresh: () => void;
  onRequestAccess: () => void;
  onToggleSidebar: () => void;
  /** Name of the open conversation's system prompt, if it has one. */
  systemPromptName?: string;
  /** Name of the prompt a new conversation would start with, if any. */
  draftPromptName?: string;
  onEditPrompt: () => void;
  /** Advanced settings for a new conversation (the system prompt editor). */
  newChatAdvanced: ReactNode;
}

function StatusDot({ conn }: { conn: ConnectionState | null }) {
  if (!conn) return null;
  let cls = "offline";
  let label = "Connecting to relays…";
  const open = conn.relays.filter((r) => r.state === "open").length;
  if (conn.online) {
    if (conn.access === "approved") {
      cls = "online";
      label = `Connected via ${open}/${conn.relays.length} relay${conn.relays.length === 1 ? "" : "s"}`;
    } else if (conn.access === "unreachable") {
      cls = "warn";
      label = "Relays connected, but the worker is not responding";
    } else if (conn.access === "unauthorized" || conn.access === "pending") {
      cls = "warn";
      label = "Access approval required";
    } else {
      cls = "warn";
      label = "Contacting worker…";
    }
  } else if (conn.relays.some((r) => r.state === "connecting")) {
    label = "Connecting to relays…";
  } else {
    label = "Relays unreachable — retrying";
  }
  return (
    <span className="status" title={`${label}\n${conn.relays.map((r) => `${r.url}: ${r.state}`).join("\n")}`}>
      <span className={`dot ${cls}`} />
      <span className="status-label">{label}</span>
    </span>
  );
}

function Selector<T extends { id: string; label: string }>({
  value,
  items,
  placeholder,
  onChange,
  extra,
  icon,
}: {
  value: string;
  items: T[];
  placeholder: string;
  onChange: (id: string) => void;
  extra?: { label: string; onClick: () => void };
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const current = items.find((i) => i.id === value);
  return (
    <div className="selector" ref={ref}>
      <button className="selector-btn" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        {icon}
        <span className="ellipsis">{current?.label ?? placeholder}</span>
        <IconChevron />
      </button>
      {open && (
        <div className="menu" role="listbox">
          {items.map((i) => (
            <button
              key={i.id}
              role="option"
              aria-selected={i.id === value}
              className={`menu-item ${i.id === value ? "active" : ""}`}
              onClick={() => {
                setOpen(false);
                onChange(i.id);
              }}
            >
              {i.label}
            </button>
          ))}
          {items.length === 0 && <div className="menu-empty">Nothing available</div>}
          {extra && (
            <button
              className="menu-item extra"
              onClick={() => {
                setOpen(false);
                extra.onClick();
              }}
            >
              <IconPlus /> {extra.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function modelLabel(m: ModelInfo): string {
  const flags = [!m.streaming ? "no streaming" : "", !m.cancel ? "no cancel" : ""].filter(Boolean);
  return flags.length ? `${m.id} (${flags.join(", ")})` : m.id;
}

function AccessPanel({ conn, userPubkey, worker, onRequestAccess, onRefresh }: { conn: ConnectionState; userPubkey: string; worker: WorkerProfile; onRequestAccess: () => void; onRefresh: () => void }) {
  const npub = hexToNpub(userPubkey);
  if (conn.access === "unreachable") {
    return (
      <div className="notice card">
        <h3>Can’t reach “{worker.name}”</h3>
        <p>
          The relays are connected, but the worker did not answer. Make sure <code>relayllm start</code> is running on the worker machine and that it uses at least one of
          these relays:
        </p>
        <ul className="mono small">
          {worker.relays.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <button className="btn" onClick={onRefresh}>
          <IconRefresh /> Try again
        </button>
      </div>
    );
  }
  return (
    <div className="notice card">
      <h3>{conn.access === "pending" ? "Waiting for approval" : "Access approval required"}</h3>
      <p>
        {conn.access === "pending"
          ? "Your request was sent. The worker owner can approve it with:"
          : "This worker only answers people its owner has approved. Request access, then ask the owner to run:"}
      </p>
      <div className="cmd">
        <code className="ellipsis">relayllm users approve {npub}</code>
        <CopyButton text={`relayllm users approve ${npub}`} label="Copy command" />
      </div>
      <div className="row">
        {conn.access !== "pending" && (
          <button className="btn primary" onClick={onRequestAccess}>
            Request access
          </button>
        )}
        <button className="btn" onClick={onRefresh}>
          <IconRefresh /> Check again
        </button>
      </div>
    </div>
  );
}

function Message({ m, isLast, streaming, onRegenerate }: { m: ChatMessageRecord; isLast: boolean; streaming: boolean; onRegenerate: () => void }) {
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
        <div className="msg-actions">
          <CopyButton text={m.content} />
        </div>
      </div>
    );
  }
  const live = m.status === "streaming";
  return (
    <div className="msg assistant">
      {m.omitted ? (
        <div className="context-note">
          {m.omitted} earlier message{m.omitted === 1 ? " was" : "s were"} not sent to the model to fit the worker’s limits.
        </div>
      ) : null}
      {m.reasoning && (
        <details className="reasoning" open={live && !m.content}>
          <summary>{live && !m.content ? "Thinking…" : "Reasoning"}</summary>
          <div className="reasoning-body">{m.reasoning}</div>
        </details>
      )}
      {m.content ? <Markdown text={m.content} /> : live && !m.reasoning ? <div className="typing"><span /><span /><span /></div> : null}
      {m.status === "error" && <div className="error-banner">{m.error ?? "Something went wrong."}</div>}
      {m.status === "cancelled" && <div className="meta-note">Stopped.</div>}
      {m.incomplete && <div className="meta-note">Parts of this response were lost in transit.</div>}
      {m.truncated && <div className="meta-note">The response reached the maximum length.</div>}
      {!live && (
        <div className="msg-actions">
          {m.content && <CopyButton text={m.content} />}
          {isLast && !streaming && (
            <button className="icon-btn small" title="Regenerate" aria-label="Regenerate" onClick={onRegenerate}>
              <IconRefresh />
            </button>
          )}
          {m.model && <span className="small muted">{m.model}</span>}
        </div>
      )}
    </div>
  );
}

export function ChatView(p: ChatViewProps) {
  const [text, setText] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const messages = p.conversation?.messages ?? [];
  const lastContent = messages.at(-1)?.content.length ?? 0;
  const lastReasoning = messages.at(-1)?.reasoning?.length ?? 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContent, lastReasoning, p.conversation?.id]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [text]);

  const approved = p.conn?.access === "approved";
  const models = p.conn?.models ?? [];
  const modelOk = models.some((m) => m.id === p.model);
  const canSend = !!p.worker && approved && modelOk && !p.streaming && text.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    p.onSend(text.trim());
    setText("");
    stick.current = true;
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const showAccess = p.worker && p.conn && p.conn.online && ["unauthorized", "pending", "unreachable"].includes(p.conn.access);
  const lastStreaming = messages.at(-1)?.status === "streaming";

  return (
    <main className="chat">
      <header className="chat-head">
        <button className="icon-btn mobile-only" onClick={p.onToggleSidebar} aria-label="Open sidebar">
          <IconMenu />
        </button>
        <Selector
          icon={<IconServer />}
          value={p.worker?.id ?? ""}
          placeholder="Add a worker"
          items={p.workers.map((w) => ({ id: w.id, label: w.name }))}
          onChange={p.onSelectWorker}
          extra={{ label: "Add worker", onClick: p.onAddWorker }}
        />
        {p.worker && approved && (
          <Selector value={p.model} placeholder="Choose model" items={models.map((m) => ({ id: m.id, label: modelLabel(m) }))} onChange={p.onSelectModel} />
        )}
        <div className="spacer" />
        {p.conversation && messages.length > 0 && (
          <button
            className={`icon-btn ${p.systemPromptName ? "accent" : ""}`}
            onClick={p.onEditPrompt}
            title={p.systemPromptName ? `System prompt: ${p.systemPromptName}` : "Add a system prompt"}
            aria-label="System prompt"
          >
            <IconSliders />
          </button>
        )}
        <StatusDot conn={p.conn} />
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="messages-inner">
          {!p.worker && (
            <div className="empty">
              <h2>Connect your first worker</h2>
              <p className="muted">
                Install the RelayLLM worker next to LM Studio, Ollama or vLLM, run <code>relayllm init</code>, then open its pairing link here or add it by npub.
              </p>
              <button className="btn primary" onClick={p.onAddWorker}>
                <IconPlus /> Add worker
              </button>
            </div>
          )}
          {showAccess && p.worker && p.conn && (
            <AccessPanel conn={p.conn} userPubkey={p.userPubkey} worker={p.worker} onRequestAccess={p.onRequestAccess} onRefresh={p.onRefresh} />
          )}
          {p.worker && approved && messages.length === 0 && (
            <div className="empty">
              <h2>How can I help?</h2>
              <p className="muted">
                Chatting with <strong>{p.model || "…"}</strong> on <strong>{p.worker.name}</strong>. Messages are end-to-end encrypted between this browser and your worker.
              </p>
              {models.length === 0 && <p className="error-text">This worker exposes no models to you.</p>}
              <details className="advanced">
                <summary>
                  <IconSliders /> Advanced settings
                  {p.draftPromptName && <span className="muted"> · System prompt: {p.draftPromptName}</span>}
                </summary>
                {p.newChatAdvanced}
              </details>
            </div>
          )}
          {p.conversation && p.systemPromptName && messages.length > 0 && (
            <button className="system-chip" onClick={p.onEditPrompt} title="View or edit the system prompt">
              <IconSliders /> <span className="ellipsis">System prompt: {p.systemPromptName}</span>
            </button>
          )}
          {messages.map((m, i) => (
            <Message key={m.id} m={m} isLast={i === messages.length - 1} streaming={p.streaming} onRegenerate={p.onRegenerate} />
          ))}
          {p.conversation && p.conversation.workerId !== p.worker?.id && (
            <p className="small muted center">This conversation belongs to a worker that is no longer configured.</p>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {p.conversation && p.conversation.model !== p.model && p.model && messages.length > 0 && (
          <div className="context-note">Next reply will use {p.model}; the conversation so far is sent as context.</div>
        )}
        <div className={`composer ${!approved ? "disabled" : ""}`}>
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            placeholder={!p.worker ? "Add a worker to start" : approved ? (modelOk ? "Message…" : "Choose a model") : "Waiting for worker…"}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            disabled={!p.worker || !approved}
            aria-label="Message"
          />
          {p.streaming ? (
            <button className="send-btn stop" onClick={p.onStop} aria-label="Stop generating" title="Stop">
              <IconStop />
            </button>
          ) : (
            <button className="send-btn" onClick={send} disabled={!canSend} aria-label="Send" title="Send (Enter)">
              <IconSend />
            </button>
          )}
        </div>
        <div className="composer-foot small muted">
          {lastStreaming && p.conn?.batchMs ? `Streaming through Nostr relays — text arrives in batches (~${p.conn.batchMs} ms).` : "Enter to send · Shift+Enter for a new line"}
        </div>
      </div>
    </main>
  );
}
