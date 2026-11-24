import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HostMetrics, Limits, MetricsResult, ModelMetrics } from "@relayllm/protocol";
import type { ChatMessageRecord } from "../lib/db.ts";
import { estimateContext, fmtAgo, fmtBytes, fmtCompact, fmtInt, type ContextEstimate } from "../lib/metrics.ts";

/** What the indicator needs from a worker connection. */
export interface MetricsSource {
  metrics(opts: { model?: string; host?: boolean }): Promise<MetricsResult>;
}

export interface ContextIndicatorProps {
  source: MetricsSource | null;
  /** Relays connected and access approved. */
  ready: boolean;
  model: string;
  /** Changes when the worker's model list changes (re-read metadata). */
  modelsKey: string;
  messages: readonly ChatMessageRecord[];
  systemPrompt?: string;
  limits?: Limits;
}

const NA = <span className="muted">Unavailable</span>;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children ?? NA}</dd>
    </>
  );
}

const orNA = (v: number | null | undefined, f: (n: number) => ReactNode) => (v === null || v === undefined ? NA : f(v));

function Ring({ fraction, level }: { fraction: number | null; level: string }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className={`ring ${level}`}>
      <circle cx="9" cy="9" r={r} className="ring-track" strokeDasharray={fraction === null ? "2 2.4" : undefined} />
      {fraction !== null && <circle cx="9" cy="9" r={r} className="ring-fill" strokeDasharray={`${Math.max(0.02, Math.min(1, fraction)) * c} ${c}`} />}
    </svg>
  );
}

function Bar({ fraction, level }: { fraction: number; level: string }) {
  return (
    <div className={`meter ${level}`} role="presentation">
      <div style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }} />
    </div>
  );
}

const levelOf = (f: number | null) => (f === null ? "" : f >= 0.95 ? "danger" : f >= 0.8 ? "warn" : "");

const BASIS_TEXT: Record<ContextEstimate["basis"], string> = {
  measured: "measured by the engine on the last request",
  mixed: "last measured request plus estimated newer text",
  estimated: "estimated from text length (~4 characters per token)",
  none: "",
};

function HostSection({ host, enabled }: { host: HostMetrics | null; enabled: boolean | undefined }) {
  if (!enabled) {
    return (
      <p className="small muted">
        Machine monitoring is off on this worker. The owner can turn it on with <code>relayllm monitoring on</code>.
      </p>
    );
  }
  if (!host) return <p className="small muted">Machine statistics are unavailable right now.</p>;
  const used = host.memTotalBytes !== null && host.memAvailableBytes !== null ? host.memTotalBytes - host.memAvailableBytes : null;
  return (
    <>
      {host.memUsedPercent !== null && <Bar fraction={host.memUsedPercent / 100} level={levelOf(host.memUsedPercent / 100)} />}
      <dl className="metrics-grid">
        <Row label="Memory used">
          {used !== null && host.memTotalBytes !== null
            ? `${fmtBytes(used)} of ${fmtBytes(host.memTotalBytes)}${host.memUsedPercent !== null ? ` (${host.memUsedPercent.toFixed(0)}%)` : ""}`
            : null}
        </Row>
        <Row label="Available">{orNA(host.memAvailableBytes, fmtBytes)}</Row>
        <Row label="Swap">
          {host.swapTotalBytes === null ? null : host.swapTotalBytes === 0 ? "None configured" : `${fmtBytes(host.swapUsedBytes ?? 0)} of ${fmtBytes(host.swapTotalBytes)}`}
        </Row>
        <Row label="Memory pressure">
          {host.pressure ? <span className={`pressure ${host.pressure}`}>{host.pressure[0]!.toUpperCase() + host.pressure.slice(1)}</span> : null}
        </Row>
      </dl>
    </>
  );
}

function ModelSection({ m }: { m: ModelMetrics }) {
  const differs = m.maxContext !== null && m.loadedContext !== null && m.maxContext !== m.loadedContext;
  return (
    <dl className="metrics-grid">
      <Row label="Status">{m.state === "unknown" ? null : m.state === "loaded" ? "Loaded" : "Not loaded (loads on first use)"}</Row>
      <Row label="Loaded context">{orNA(m.loadedContext, (n) => `${fmtInt(n)} tokens`)}</Row>
      <Row label="Model maximum">{orNA(m.maxContext, (n) => `${fmtInt(n)} tokens${differs ? " (not all allocated)" : ""}`)}</Row>
      <Row label="Memory in use">
        {orNA(m.memoryBytes, (n) => `${fmtBytes(n)}${m.vramBytes !== null ? ` (${fmtBytes(m.vramBytes)} GPU)` : ""}`)}
      </Row>
      <Row label="Size on disk">{orNA(m.sizeBytes, fmtBytes)}</Row>
      <Row label="Details">{[m.parameters, m.architecture, m.quantization].filter(Boolean).join(" · ") || null}</Row>
    </dl>
  );
}

export function ContextIndicator(p: ContextIndicatorProps) {
  const [model, setModel] = useState<ModelMetrics | null>(null);
  const [result, setResult] = useState<MetricsResult | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  /** Local time of the last successful refresh (the worker's clock may differ). */
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const est = estimateContext(p.messages, p.systemPrompt, p.limits);
  const lastDone = [...p.messages].reverse().find((m) => m.role === "assistant" && m.status !== "streaming")?.id ?? "";

  // Model metadata: when the model or the worker's model list changes, and after each reply
  // (JIT loading can change what's loaded and how much context was allocated).
  useEffect(() => {
    if (!p.source || !p.ready || !p.model) return;
    let live = true;
    p.source
      .metrics({ model: p.model })
      .then((r) => {
        if (!live) return;
        setModel(r.model);
        setResult((prev) => ({ ...r, host: prev?.host ?? null }));
        setUnsupported(false);
      })
      .catch((e: { code?: string }) => {
        if (!live) return;
        setModel(null);
        if (e.code === "invalid_request") setUnsupported(true); // worker predates metrics
      });
    return () => {
      live = false;
    };
  }, [p.source, p.ready, p.model, p.modelsKey, lastDone]);

  // Live refresh only while the panel is open and connected; stops on close or disconnect.
  const refreshSec = result?.monitoring.refreshSec ?? 10;
  useEffect(() => {
    if (!open || !p.source || !p.ready || unsupported) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const r = await p.source!.metrics({ model: p.model || undefined, host: true });
        if (!live) return;
        setResult(r);
        setUpdatedAt(Date.now());
        if (r.model) setModel(r.model);
      } catch {
        /* keep the last values; they show their age */
      }
      if (live) timer = setTimeout(() => void poll(), refreshSec * 1000);
    };
    void poll();
    const ager = setInterval(() => tick((n) => n + 1), 5000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(ager);
    };
  }, [open, p.source, p.ready, p.model, unsupported, refreshSec]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!p.ready || !p.model) return null;

  const ctxWindow = model?.loadedContext ?? null; // never the theoretical maximum
  const fraction = ctxWindow ? est.tokens / ctxWindow : null;
  const level = levelOf(fraction);
  const label =
    fraction !== null ? `${Math.round(fraction * 100)}%` : est.tokens > 0 ? `~${fmtCompact(est.tokens)}` : "";
  const title =
    fraction !== null
      ? `Context: ~${fmtInt(est.tokens)} of ${fmtInt(ctxWindow!)} tokens`
      : `Context: ~${fmtInt(est.tokens)} tokens (window size unavailable)`;
  const u = est.last;

  return (
    <div className="ctx" ref={ref}>
      <button className={`ctx-btn ${level}`} onClick={() => setOpen((o) => !o)} aria-label="Context usage" aria-expanded={open} title={title}>
        <Ring fraction={fraction} level={level} />
        {label && <span className="ctx-label">{label}</span>}
      </button>
      {open && (
        <div className="ctx-panel card" role="dialog" aria-label="Context and model details">
          <section>
            <h4>Context</h4>
            {fraction !== null && <Bar fraction={fraction} level={level} />}
            <p className="ctx-headline">
              {est.basis === "none"
                ? "Nothing sent yet in this conversation."
                : `~${fmtInt(est.tokens)}${ctxWindow ? ` of ${fmtInt(ctxWindow)}` : ""} tokens${fraction !== null ? ` (${Math.round(fraction * 100)}%)` : ""}`}
            </p>
            {est.basis !== "none" && <p className="small muted">Next request, {BASIS_TEXT[est.basis]}.</p>}
            {ctxWindow === null && est.basis !== "none" && <p className="small muted">The loaded context window is unavailable, so no percentage is shown.</p>}
            <dl className="metrics-grid">
              <Row label="Last request">
                {u?.promptTokens !== undefined
                  ? `${fmtInt(u.promptTokens)} in · ${fmtInt(u.completionTokens ?? 0)} out${u.reasoningTokens ? ` (${fmtInt(u.reasoningTokens)} reasoning)` : ""} · ${u.source ?? "measured"}`
                  : null}
              </Row>
              <Row label="Speed">
                {u?.tokensPerSecond !== undefined
                  ? `${u.tokensPerSecond.toFixed(1)} tokens/s${u.firstTokenMs !== undefined ? ` · first token ${(u.firstTokenMs / 1000).toFixed(1)} s` : ""}${u.source === "estimated" ? " (estimated)" : ""}`
                  : null}
              </Row>
            </dl>
          </section>

          <section>
            <h4>Model</h4>
            {unsupported ? (
              <p className="small muted">This worker doesn’t report model details. Updating the worker adds them.</p>
            ) : model ? (
              <ModelSection m={model} />
            ) : (
              <p className="small muted">Model details are unavailable.</p>
            )}
            {result?.engine && (
              <dl className="metrics-grid">
                <Row label="KV cache">{orNA(result.engine.kvCacheUsage, (f) => `${Math.round(f * 100)}% in use`)}</Row>
                <Row label="Requests">
                  {result.engine.requestsRunning === null ? null : `${result.engine.requestsRunning} running · ${result.engine.requestsWaiting ?? "?"} waiting`}
                </Row>
              </dl>
            )}
          </section>

          {!unsupported && (
            <section>
              <h4>Machine</h4>
              <HostSection host={result?.host ?? null} enabled={result?.monitoring.host} />
            </section>
          )}
          {result && updatedAt && (
            <p className="small muted ctx-foot">
              Updated {fmtAgo(updatedAt)}
              {result.monitoring.host ? ` · refreshes every ${result.monitoring.refreshSec} s while open` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
