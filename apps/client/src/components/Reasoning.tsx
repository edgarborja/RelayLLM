import { useEffect, useState } from "react";
import type { ReasoningSetting } from "@relayllm/protocol";
import type { ChatMessageRecord } from "../lib/db.ts";
import { describeLive, fmtDuration, type LiveGeneration, type ReasoningPref } from "../lib/generation.ts";

const LABEL: Record<ReasoningPref, string> = { off: "Off", auto: "Auto", on: "On", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high" };
const ORDER: ReasoningPref[] = ["off", "auto", "on", "minimal", "low", "medium", "high", "xhigh"];

/** Off / Auto / On, plus effort levels when the model has them. */
export function ReasoningSelector({ value, options, onChange }: { value: ReasoningPref; options: readonly ReasoningSetting[]; onChange: (v: ReasoningPref) => void }) {
  const supported = (p: ReasoningPref) => p === "auto" || options.includes(p);
  // Off/Auto/On are always listed (disabled when unsupported); effort levels only if offered.
  const shown = ORDER.filter((p) => p === "off" || p === "auto" || p === "on" || supported(p));
  const note =
    options.length === 0
      ? "This model doesn't offer reasoning control."
      : !supported(value)
        ? `This model doesn't support "${LABEL[value]}", so Auto is used.`
        : value === "auto"
          ? "The model decides."
          : "";
  return (
    <div className="reasoning-select">
      <div className="row">
        <span className="small">Reasoning</span>
        <div className="spacer" />
        <div className="segmented small" role="radiogroup" aria-label="Reasoning">
          {shown.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={value === p} className={value === p ? "active" : ""} disabled={!supported(p)} onClick={() => onChange(p)}>
              {LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      {note && <p className="small muted">{note}</p>}
    </div>
  );
}

/** Compact live status under a reply that is being generated. */
export function GenerationStatus({ live, message, online }: { live: LiveGeneration; message: ChatMessageRecord; online: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const d = describeLive(live, message, online, performance.now());
  return (
    <div className="gen-status small muted">
      <div>
        <span className="dot pulsing" /> <strong className="gen-state" role="status">{d.label}</strong>
        {[fmtDuration(d.elapsedMs), d.tokens, d.speed].filter(Boolean).map((x) => (
          <span key={x}> · {x}</span>
        ))}
      </div>
      {d.note && <div>{d.note}</div>}
    </div>
  );
}
