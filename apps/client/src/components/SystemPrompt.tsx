import { useId, useState } from "react";
import type { ReasoningSetting } from "@relayllm/protocol";
import type { ReasoningPref } from "../lib/generation.ts";
import { describePrompt, sortLibrary, TEMPLATES, type SavedPrompt } from "../lib/prompts.ts";
import { Modal } from "./Dialogs.tsx";
import { IconPlus, IconTrash } from "./icons.tsx";
import { ReasoningSelector } from "./Reasoning.tsx";

/** Options for "insert a prompt" pickers: none, default, templates, saved. */
function PromptPicker({
  library,
  defaultPrompt,
  label,
  onPick,
}: {
  library: SavedPrompt[];
  defaultPrompt?: string;
  label: string;
  onPick: (content: string) => void;
}) {
  return (
    <select
      className="prompt-picker"
      aria-label={label}
      value=""
      onChange={(e) => {
        const v = e.target.value;
        if (v === "none") onPick("");
        else if (v === "default") onPick(defaultPrompt ?? "");
        else {
          const found = TEMPLATES.find((t) => t.id === v) ?? library.find((p) => p.id === v);
          if (found) onPick(found.content);
        }
      }}
    >
      <option value="" disabled>
        {label}
      </option>
      <option value="none">None (empty)</option>
      {defaultPrompt?.trim() && <option value="default">Default: {describePrompt(defaultPrompt, library)}</option>}
      <optgroup label="Templates">
        {TEMPLATES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </optgroup>
      {library.length > 0 && (
        <optgroup label="Your prompts">
          {sortLibrary(library).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export interface PromptEditorProps {
  value: string;
  onChange: (v: string) => void;
  library: SavedPrompt[];
  defaultPrompt?: string;
  maxChars: number;
  onSaveToLibrary: (content: string) => void;
  onManage: () => void;
  autoFocus?: boolean;
}

/** Textarea plus template/library picker. Used for new chats and in the edit dialog. */
export function SystemPromptEditor(p: PromptEditorProps) {
  const id = useId();
  const content = p.value.trim();
  const known = !content || TEMPLATES.some((t) => t.content.trim() === content) || p.library.some((x) => x.content.trim() === content);
  const over = p.value.length > p.maxChars;
  return (
    <div className="prompt-editor stack">
      <div className="row prompt-editor-head">
        <label htmlFor={id} className="small">
          System prompt
        </label>
        <div className="spacer" />
        <PromptPicker library={p.library} defaultPrompt={p.defaultPrompt} label="Insert a prompt…" onPick={p.onChange} />
      </div>
      <textarea
        id={id}
        rows={5}
        autoFocus={p.autoFocus}
        value={p.value}
        placeholder="Optional instructions the model follows for this whole conversation, e.g. “Answer briefly, in Spanish.”"
        onChange={(e) => p.onChange(e.target.value)}
      />
      <div className="row small muted">
        <span className={over ? "error-text" : ""}>
          {over ? `Too long for this worker: ${p.value.length.toLocaleString()} / ${p.maxChars.toLocaleString()} characters` : content ? `${p.value.length.toLocaleString()} characters` : "No system prompt"}
        </span>
        <div className="spacer" />
        {!known && (
          <button type="button" className="btn small ghost" onClick={() => p.onSaveToLibrary(p.value)}>
            Save to my prompts
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={p.onManage}>
          Manage prompts…
        </button>
      </div>
    </div>
  );
}

/** Edit the prompt of an existing conversation. */
export function SystemPromptDialog(
  props: Omit<PromptEditorProps, "value" | "onChange"> & {
    initial: string;
    reasoning: ReasoningPref;
    reasoningOptions: readonly ReasoningSetting[];
    onSave: (v: string, reasoning: ReasoningPref) => void;
    onClose: () => void;
  },
) {
  const [value, setValue] = useState(props.initial);
  const [reasoning, setReasoning] = useState(props.reasoning);
  const changed = value.trim() !== props.initial.trim() || reasoning !== props.reasoning;
  return (
    <Modal title="Conversation settings" onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.length <= props.maxChars) props.onSave(value, reasoning);
        }}
      >
        <SystemPromptEditor {...props} value={value} onChange={setValue} autoFocus />
        <ReasoningSelector value={reasoning} options={props.reasoningOptions} onChange={setReasoning} />
        <p className="small muted">Changes apply to the next replies in this conversation. Earlier messages are not changed.</p>
        <div className="row end">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!changed || value.length > props.maxChars}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SavedPromptRow({ prompt, onSave, onDelete, open }: { prompt: SavedPrompt; onSave: (p: SavedPrompt) => void; onDelete: () => void; open?: boolean }) {
  const [name, setName] = useState(prompt.name);
  const [content, setContent] = useState(prompt.content);
  const dirty = name.trim() !== prompt.name || content !== prompt.content;
  return (
    <details className="prompt-row" open={open}>
      <summary>
        <span className="ellipsis">{prompt.name}</span>
        <span className="small muted">{prompt.lastUsedAt ? `used ${new Date(prompt.lastUsedAt).toLocaleDateString()}` : "not used yet"}</span>
      </summary>
      <div className="stack">
        <input aria-label="Prompt name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        <textarea aria-label="Prompt text" rows={6} value={content} onChange={(e) => setContent(e.target.value)} />
        <div className="row end">
          <button type="button" className="btn small ghost danger-text" onClick={onDelete}>
            <IconTrash /> Delete
          </button>
          <button
            type="button"
            className="btn small primary"
            disabled={!dirty || !content.trim()}
            onClick={() => onSave({ ...prompt, name: name.trim() || prompt.name, content, updatedAt: Date.now() })}
          >
            Save
          </button>
        </div>
      </div>
    </details>
  );
}

/** Default prompt, templates, and the user's saved/used prompts. */
export function PromptLibraryDialog(props: {
  library: SavedPrompt[];
  defaultPrompt: string;
  onDefault: (content: string) => void;
  onSave: (p: SavedPrompt) => void;
  onCreate: () => SavedPrompt;
  onDelete: (p: SavedPrompt) => void;
  onClose: () => void;
}) {
  const [justCreated, setJustCreated] = useState<string | null>(null);
  return (
    <Modal title="System prompts" onClose={props.onClose}>
      <div className="stack settings">
        <section>
          <h3>Default for new chats</h3>
          <div className="row">
            <span className="ellipsis">{describePrompt(props.defaultPrompt, props.library)}</span>
            <div className="spacer" />
            <PromptPicker library={props.library} label="Change…" onPick={props.onDefault} />
          </div>
          <p className="small muted">Pre-filled in a new conversation’s advanced settings, where you can still change it before the first message.</p>
        </section>

        <section>
          <h3>Templates</h3>
          {TEMPLATES.map((t) => (
            <details key={t.id} className="prompt-row">
              <summary>
                <span className="ellipsis">{t.name}</span>
              </summary>
              <div className="prompt-preview small">{t.content}</div>
            </details>
          ))}
        </section>

        <section>
          <div className="row">
            <h3>Your prompts</h3>
            <div className="spacer" />
            <button
              type="button"
              className="btn small"
              onClick={() => setJustCreated(props.onCreate().id)}
            >
              <IconPlus /> New prompt
            </button>
          </div>
          {props.library.length === 0 && (
            <p className="small muted">Prompts you use in conversations appear here automatically, so you can reuse, rename or delete them.</p>
          )}
          {sortLibrary(props.library).map((p) => (
            <SavedPromptRow
              key={`${p.id}:${p.updatedAt}`}
              prompt={p}
              open={p.id === justCreated}
              onSave={props.onSave}
              onDelete={() => props.onDelete(p)}
            />
          ))}
          <p className="small muted">Stored only in this browser, encrypted like your conversations.</p>
        </section>
      </div>
    </Modal>
  );
}
