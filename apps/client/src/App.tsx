import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parsePairingUrl, type ChatHandle, type PairingInfo } from "@relayllm/nostr-transport";
import { ERROR_TEXT, newId, type ErrorCode } from "@relayllm/protocol";
import { ChatView } from "./components/ChatView.tsx";
import { ContextIndicator } from "./components/ContextIndicator.tsx";
import { AddWorkerDialog, SettingsDialog, type ThemePref } from "./components/Dialogs.tsx";
import { Onboarding } from "./components/Onboarding.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { PromptLibraryDialog, SystemPromptDialog, SystemPromptEditor } from "./components/SystemPrompt.tsx";
import { ConnectionManager, type ConnectionState } from "./lib/connection.ts";
import { buildContext, titleFrom } from "./lib/context.ts";
import { LocalDB, type ChatMessageRecord, type Conversation, type WorkerProfile } from "./lib/db.ts";
import { forgetIdentity, loadStoredIdentity, type UnlockedIdentity } from "./lib/identity.ts";
import { autoName, DEFAULT_MAX_PROMPT_CHARS, describePrompt, MAX_LIBRARY, rememberPrompt, sortLibrary, type SavedPrompt } from "./lib/prompts.ts";

// ---------------------------------------------------------------- prefs (non-secret)

interface Prefs {
  theme: ThemePref;
  lastWorker?: string;
  /**
   * Legacy: older versions kept one global system prompt here, in plaintext.
   * It is kept only until it has been moved into the encrypted store.
   */
  systemPrompt?: string;
}
const PREFS_KEY = "relayllm.prefs.v1";
function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      theme: p.theme === "light" || p.theme === "dark" ? p.theme : "system",
      lastWorker: typeof p.lastWorker === "string" ? p.lastWorker : undefined,
      systemPrompt: typeof p.systemPrompt === "string" && p.systemPrompt.trim() ? p.systemPrompt.trim() : undefined,
    };
  } catch {
    return { theme: "system" };
  }
}


// ---------------------------------------------------------------- pairing link

/** Read pairing params once, then strip them from the address bar/history. */
function takePairingFromUrl(): PairingInfo | null {
  const info = parsePairingUrl(location.href);
  if (location.search || location.hash) history.replaceState(null, "", location.pathname);
  return info;
}
const initialPairing = takePairingFromUrl();

function describeError(code?: ErrorCode): string {
  return code ? ERROR_TEXT[code] : "The response failed.";
}

// ---------------------------------------------------------------- app

interface Session {
  identity: UnlockedIdentity;
  db: LocalDB;
  conns: ConnectionManager;
}

export function App() {
  const [stored] = useState(loadStoredIdentity);
  const [session, setSession] = useState<Session | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    const root = document.documentElement;
    if (prefs.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", prefs.theme);
  }, [prefs]);

  const onUnlocked = useCallback(async (u: UnlockedIdentity) => {
    const db = await LocalDB.open(u.stored.pubkey, u.dataKey);
    setSession({ identity: u, db, conns: new ConnectionManager(u.signer) });
  }, []);

  if (!session) {
    return <Onboarding stored={stored} onUnlocked={(u) => void onUnlocked(u)} pairingName={initialPairing?.name} />;
  }
  return (
    <Main
      session={session}
      prefs={prefs}
      setPrefs={setPrefs}
      onLock={() => {
        session.conns.closeAll();
        session.db.close();
        location.reload();
      }}
      onForget={async () => {
        if (!confirm("Sign out and remove this identity and all local conversations from this browser?")) return;
        session.conns.closeAll();
        await session.db.destroy();
        forgetIdentity();
        location.reload();
      }}
    />
  );
}

function Main({
  session,
  prefs,
  setPrefs,
  onLock,
  onForget,
}: {
  session: Session;
  prefs: Prefs;
  setPrefs: (fn: (p: Prefs) => Prefs) => void;
  onLock: () => void;
  onForget: () => void;
}) {
  const { db, conns, identity } = session;
  const [workers, setWorkers] = useState<WorkerProfile[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const convsRef = useRef<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [activeWorkerId, setActiveWorkerId] = useState<string | null>(prefs.lastWorker ?? null);
  const [model, setModel] = useState("");
  const [connState, setConnState] = useState<ConnectionState | null>(null);
  const [pairing, setPairing] = useState<PairingInfo | null>(initialPairing);
  const [showAdd, setShowAdd] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [library, setLibrary] = useState<SavedPrompt[]>([]);
  const [defaultPrompt, setDefaultPrompt] = useState("");
  /** System prompt for the next new conversation (advanced settings). */
  const [draftPrompt, setDraftPrompt] = useState("");
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const handles = useRef(new Map<string, ChatHandle>());
  const [streamingIds, setStreamingIds] = useState<Set<string>>(new Set());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // initial load
  useEffect(() => {
    void (async () => {
      const [ws, cs] = await Promise.all([db.listWorkers(), db.listConversations()]);
      setWorkers(ws);
      convsRef.current = cs;
      setConversations(cs);
      setActiveWorkerId((cur) => (cur && ws.some((w) => w.id === cur) ? cur : (ws[0]?.id ?? null)));

      const [lib, settings] = await Promise.all([db.listPrompts(), db.getSettings()]);
      let def = settings.defaultPrompt ?? "";
      const legacy = prefs.systemPrompt;
      if (legacy) {
        // One-time move of the old global prompt into the encrypted store.
        const saved = rememberPrompt(lib, legacy);
        if (saved) {
          saved.name = "My default prompt";
          delete saved.lastUsedAt;
          await db.savePrompt(saved);
          lib.push(saved);
        }
        if (!def) {
          def = legacy;
          await db.saveSettings({ ...settings, defaultPrompt: def });
        }
      }
      setLibrary(lib);
      setDefaultPrompt(def);
      if (legacy) setPrefs(({ systemPrompt: _, ...rest }) => rest);
    })();
    // Runs once per unlocked database.
  }, [db]);

  // A new chat starts from the default prompt (before paint, so the previous draft never flashes).
  useLayoutEffect(() => {
    if (!activeConvId) setDraftPrompt(defaultPrompt);
  }, [activeConvId, defaultPrompt]);

  const worker = workers.find((w) => w.id === activeWorkerId) ?? null;
  const conversation = conversations.find((c) => c.id === activeConvId) ?? null;

  // connection for the active worker
  useEffect(() => {
    if (!worker) {
      setConnState(null);
      return;
    }
    const conn = conns.get(worker);
    const unsub = conn.subscribe(setConnState);
    if (conn.state.online && conn.state.access !== "approved") void conn.refresh();
    return unsub;
  }, [worker, conns]);

  // choose a valid model when the model list arrives
  useEffect(() => {
    const models = connState?.models ?? [];
    if (!models.length) return;
    setModel((cur) => {
      if (models.some((m) => m.id === cur)) return cur;
      const preferred = conversation?.model ?? worker?.lastModel;
      return models.find((m) => m.id === preferred)?.id ?? models[0]!.id;
    });
  }, [connState?.models, conversation?.model, worker?.lastModel]);

  useEffect(() => {
    if (activeWorkerId) setPrefs((p) => ({ ...p, lastWorker: activeWorkerId }));
  }, [activeWorkerId, setPrefs]);

  // ---------------- conversation state helpers

  const commit = useCallback((next: Conversation[]) => {
    convsRef.current = next;
    setConversations(next);
  }, []);

  const persist = useCallback(
    (id: string, immediate = false) => {
      const t = saveTimers.current.get(id);
      if (t) clearTimeout(t);
      const run = () => {
        saveTimers.current.delete(id);
        const c = convsRef.current.find((x) => x.id === id);
        if (c) void db.saveConversation(c);
      };
      if (immediate) run();
      else saveTimers.current.set(id, setTimeout(run, 1500));
    },
    [db],
  );

  const upsert = useCallback(
    (conv: Conversation) => {
      const rest = convsRef.current.filter((c) => c.id !== conv.id);
      commit([conv, ...rest]);
    },
    [commit],
  );

  const patchMessage = useCallback(
    (convId: string, msgId: string, patch: Partial<ChatMessageRecord>) => {
      commit(
        convsRef.current.map((c) =>
          c.id !== convId ? c : { ...c, updatedAt: Date.now(), messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) },
        ),
      );
    },
    [commit],
  );

  // ---------------- system prompts

  const savePromptEntry = useCallback(
    (p: SavedPrompt) => {
      setLibrary((lib) => {
        let next = [...lib.filter((x) => x.id !== p.id), p];
        if (next.length > MAX_LIBRARY) {
          const drop = sortLibrary(next).slice(MAX_LIBRARY);
          for (const d of drop) void db.deletePrompt(d.id);
          next = next.filter((x) => !drop.includes(x));
        }
        return next;
      });
      void db.savePrompt(p);
    },
    [db],
  );

  const notePromptUsed = useCallback(
    (content: string | undefined) => {
      const entry = content ? rememberPrompt(library, content) : null;
      if (entry) savePromptEntry(entry);
    },
    [library, savePromptEntry],
  );

  const setDefault = (content: string) => {
    const def = content.trim();
    setDefaultPrompt(def);
    void db.getSettings().then((s) => db.saveSettings({ ...s, defaultPrompt: def || undefined }));
  };

  const saveToLibrary = (content: string) => {
    const entry = rememberPrompt(library, content);
    if (entry) savePromptEntry({ ...entry, lastUsedAt: undefined });
  };

  const setConversationPrompt = (convId: string, content: string) => {
    const systemPrompt = content.trim() ? content : undefined;
    commit(convsRef.current.map((c) => (c.id === convId ? { ...c, systemPrompt } : c)));
    persist(convId, true);
    notePromptUsed(systemPrompt);
  };

  const maxPromptChars = connState?.limits?.maxSystemPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;

  // ---------------- chat

  const runCompletion = useCallback(
    async (base: Conversation) => {
      if (!worker || !connState) return;
      const conn = conns.get(worker);
      // The conversation's own prompt, as it is now: edits apply from the next request on.
      const ctx = buildContext(base.messages, connState.limits, base.systemPrompt);
      const asst: ChatMessageRecord = {
        id: newId(),
        role: "assistant",
        content: "",
        status: "streaming",
        model,
        createdAt: Date.now(),
        omitted: ctx.omitted || undefined,
      };
      const conv: Conversation = { ...base, model, updatedAt: Date.now(), messages: [...base.messages, asst] };
      upsert(conv);
      setActiveConvId(conv.id);
      persist(conv.id, true);
      const promptLimit = connState.limits?.maxSystemPromptChars;
      if (promptLimit !== undefined && (base.systemPrompt?.trim().length ?? 0) > promptLimit) {
        patchMessage(conv.id, asst.id, {
          status: "error",
          error: `The system prompt is longer than this worker allows (${promptLimit.toLocaleString()} characters). Edit it and try again.`,
        });
        persist(conv.id, true);
        return;
      }
      if (ctx.tooLarge) {
        patchMessage(conv.id, asst.id, {
          status: "error",
          error: `This message is larger than the worker accepts (${Math.round((connState.limits?.maxRequestBytes ?? 0) / 1000)} KB). Shorten it or start a new conversation.`,
        });
        persist(conv.id, true);
        return;
      }

      const handle = conn.chat(
        { model, messages: ctx.messages },
        {
          onUpdate: (s) => {
            patchMessage(conv.id, asst.id, { content: s.content, reasoning: s.reasoning || undefined });
            persist(conv.id);
          },
        },
      );
      handles.current.set(conv.id, handle);
      setStreamingIds(new Set(handles.current.keys()));
      try {
        const r = await handle.result;
        const failed = r.finishReason === "error" || r.finishReason === "timeout";
        patchMessage(conv.id, asst.id, {
          content: r.content,
          reasoning: r.reasoning || undefined,
          status: r.finishReason === "cancelled" ? "cancelled" : failed ? "error" : "done",
          error: failed ? describeError(r.errorCode) : undefined,
          truncated: r.finishReason === "length" || undefined,
          incomplete: r.incomplete || undefined,
          usage: r.usage,
        });
      } catch (e) {
        const code = (e as { code?: string }).code;
        patchMessage(conv.id, asst.id, { status: "error", error: (e as Error).message });
        if (code === "unauthorized" || code === "pending_approval" || code === "model_unavailable") void conn.refresh();
      } finally {
        handles.current.delete(conv.id);
        setStreamingIds(new Set(handles.current.keys()));
        persist(conv.id, true);
      }
    },
    [worker, connState, conns, model, upsert, persist, patchMessage],
  );

  const send = (text: string) => {
    if (!worker) return;
    const now = Date.now();
    const user: ChatMessageRecord = { id: newId(), role: "user", content: text, createdAt: now };
    const base: Conversation =
      conversation && conversation.workerId === worker.id
        ? { ...conversation, messages: [...conversation.messages, user] }
        : {
            id: newId(),
            title: titleFrom(text),
            workerId: worker.id,
            model,
            createdAt: now,
            updatedAt: now,
            messages: [user],
            systemPrompt: draftPrompt.trim() ? draftPrompt : undefined,
          };
    if (base.messages.length === 1) notePromptUsed(base.systemPrompt);
    if (worker.lastModel !== model) {
      const w = { ...worker, lastModel: model };
      setWorkers((ws) => ws.map((x) => (x.id === w.id ? w : x)));
      void db.saveWorker(w);
    }
    void runCompletion(base);
  };

  const regenerate = () => {
    if (!conversation) return;
    const msgs = [...conversation.messages];
    while (msgs.length && msgs.at(-1)!.role === "assistant") msgs.pop();
    if (!msgs.length) return;
    void runCompletion({ ...conversation, messages: msgs });
  };

  const stop = () => {
    if (activeConvId) void handles.current.get(activeConvId)?.cancel();
  };

  // ---------------- workers

  const addWorker = async (profile: WorkerProfile, invite?: string) => {
    const existing = workers.find((w) => w.id === profile.id);
    const merged = existing ? { ...existing, name: profile.name || existing.name, relays: profile.relays } : profile;
    await db.saveWorker(merged);
    setWorkers((ws) => [...ws.filter((w) => w.id !== merged.id), merged]);
    setActiveWorkerId(merged.id);
    setActiveConvId(null);
    setShowAdd(false);
    setPairing(null);
    const conn = conns.get(merged);
    // Wait for a relay connection before sending the pairing request.
    const go = () => (invite ? void conn.requestAccess(invite, "web client") : void conn.refresh());
    if (conn.state.online) go();
    else {
      const unsub = conn.subscribe((s) => {
        if (s.online) {
          unsub();
          setTimeout(go, 300);
        }
      });
    }
  };

  const selectConversation = (id: string) => {
    const c = conversations.find((x) => x.id === id);
    setActiveConvId(id);
    setSidebarOpen(false);
    if (c) {
      if (workers.some((w) => w.id === c.workerId)) setActiveWorkerId(c.workerId);
      setModel(c.model);
    }
  };

  const activeStreaming = activeConvId ? streamingIds.has(activeConvId) : false;
  const sortedConvs = useMemo(() => conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt), [conversations]);

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        conversations={sortedConvs}
        workers={workers}
        activeId={activeConvId}
        streamingIds={streamingIds}
        onSelect={selectConversation}
        onNew={() => {
          setActiveConvId(null);
          setSidebarOpen(false);
        }}
        onRename={(id, title) => {
          commit(convsRef.current.map((c) => (c.id === id ? { ...c, title } : c)));
          persist(id, true);
        }}
        onDelete={(id) => {
          void handles.current.get(id)?.cancel();
          commit(convsRef.current.filter((c) => c.id !== id));
          void db.deleteConversation(id);
          if (activeConvId === id) setActiveConvId(null);
        }}
        onSettings={() => setShowSettings(true)}
        onClose={() => setSidebarOpen(false)}
      />
      <ChatView
        conversation={conversation}
        workers={workers}
        worker={worker}
        conn={connState}
        model={model}
        userPubkey={identity.stored.pubkey}
        streaming={activeStreaming}
        onSelectWorker={(id) => {
          if (id === activeWorkerId) return;
          setActiveWorkerId(id);
          // A conversation belongs to one worker: switching starts a new chat.
          setActiveConvId(null);
          setModel(workers.find((w) => w.id === id)?.lastModel ?? "");
        }}
        onAddWorker={() => setShowAdd(true)}
        onSelectModel={setModel}
        onSend={send}
        onStop={stop}
        onRegenerate={regenerate}
        onRefresh={() => worker && void conns.get(worker).refresh()}
        onRequestAccess={() => worker && void conns.get(worker).requestAccess(undefined, "web client")}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        systemPromptName={conversation?.systemPrompt ? describePrompt(conversation.systemPrompt, library) : undefined}
        draftPromptName={draftPrompt.trim() ? describePrompt(draftPrompt, library) : undefined}
        onEditPrompt={() => setEditingPrompt(true)}
        contextIndicator={
          <ContextIndicator
            source={worker ? conns.get(worker) : null}
            ready={!!connState?.online && connState.access === "approved"}
            model={model}
            modelsKey={(connState?.models ?? []).map((m) => m.id).join("\n")}
            messages={conversation && conversation.workerId === worker?.id ? conversation.messages : []}
            systemPrompt={conversation ? conversation.systemPrompt : draftPrompt}
            limits={connState?.limits}
          />
        }
        newChatAdvanced={
          <SystemPromptEditor
            value={draftPrompt}
            onChange={setDraftPrompt}
            library={library}
            defaultPrompt={defaultPrompt}
            maxChars={maxPromptChars}
            onSaveToLibrary={saveToLibrary}
            onManage={() => setShowLibrary(true)}
          />
        }
      />
      {editingPrompt && conversation && (
        <SystemPromptDialog
          initial={conversation.systemPrompt ?? ""}
          library={library}
          defaultPrompt={defaultPrompt}
          maxChars={maxPromptChars}
          onSaveToLibrary={saveToLibrary}
          onManage={() => setShowLibrary(true)}
          onSave={(v) => {
            setConversationPrompt(conversation.id, v);
            setEditingPrompt(false);
          }}
          onClose={() => setEditingPrompt(false)}
        />
      )}
      {(showAdd || pairing) && (
        <AddWorkerDialog
          initial={pairing ?? undefined}
          onAdd={(p, invite) => void addWorker(p, invite)}
          onClose={() => {
            setShowAdd(false);
            setPairing(null);
          }}
        />
      )}
      {showSettings && (
        <SettingsDialog
          identity={identity.stored}
          workers={workers}
          theme={prefs.theme}
          defaultPromptName={describePrompt(defaultPrompt, library)}
          onTheme={(theme) => setPrefs((p) => ({ ...p, theme }))}
          onManagePrompts={() => setShowLibrary(true)}
          onRenameWorker={(w, name) => {
            const nw = { ...w, name };
            setWorkers((ws) => ws.map((x) => (x.id === w.id ? nw : x)));
            void db.saveWorker(nw);
          }}
          onRemoveWorker={(w) => {
            if (!confirm(`Remove “${w.name}”? Its conversations stay on this device.`)) return;
            conns.remove(w.id);
            void db.deleteWorker(w.id);
            setWorkers((ws) => ws.filter((x) => x.id !== w.id));
            if (activeWorkerId === w.id) setActiveWorkerId(null);
          }}
          onDeleteHistory={() => {
            if (!confirm("Delete all conversations stored in this browser? This cannot be undone.")) return;
            for (const h of handles.current.values()) void h.cancel();
            void db.deleteAllConversations();
            commit([]);
            setActiveConvId(null);
          }}
          onLock={onLock}
          onForget={onForget}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showLibrary && (
        <PromptLibraryDialog
          library={library}
          defaultPrompt={defaultPrompt}
          onDefault={setDefault}
          onSave={savePromptEntry}
          onCreate={() => {
            const now = Date.now();
            const p: SavedPrompt = { id: newId(), name: autoName(""), content: "", createdAt: now, updatedAt: now };
            setLibrary((lib) => [...lib, p]);
            return p;
          }}
          onDelete={(p) => {
            if (p.content.trim() && !confirm(`Delete “${p.name}” from your prompts? Conversations that used it keep their copy.`)) return;
            setLibrary((lib) => lib.filter((x) => x.id !== p.id));
            void db.deletePrompt(p.id);
          }}
          onClose={() => {
            // Drop "New prompt" entries that were never filled in (never saved to the DB).
            setLibrary((lib) => lib.filter((x) => x.content.trim()));
            setShowLibrary(false);
          }}
        />
      )}
    </div>
  );
}
