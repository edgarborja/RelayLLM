import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { IconCheck, IconCopy } from "./icons.tsx";

/**
 * Safe Markdown rendering for untrusted model output:
 *  - raw HTML is never rendered (react-markdown escapes it; no rehype-raw)
 *  - URLs pass react-markdown's sanitizer (no javascript:/data: links)
 *  - images are NOT loaded; they render as plain links, so a prompt-injected
 *    response cannot exfiltrate conversation data via image URLs
 *  - links open in a new tab without referrer or opener
 */

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="icon-btn small"
      title={label}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ src, alt }) => {
    const safe = typeof src === "string" ? defaultUrlTransform(src) : "";
    return safe ? (
      <a href={safe} target="_blank" rel="noopener noreferrer nofollow" className="img-link" title="Image not loaded automatically">
        🖼 {alt || "image"}
      </a>
    ) : (
      <span>[image: {alt}]</span>
    );
  },
  pre: ({ children }) => {
    const code = textOf(children).replace(/\n$/, "");
    const child = (Array.isArray(children) ? children[0] : children) as { props?: { className?: string } } | undefined;
    const lang = (child?.props?.className ?? "").match(/language-([\w-]+)/)?.[1];
    return (
      <div className="code-block">
        <div className="code-head">
          <span>{lang || "code"}</span>
          <CopyButton text={code} label="Copy code" />
        </div>
        <pre>{children}</pre>
      </div>
    );
  },
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
