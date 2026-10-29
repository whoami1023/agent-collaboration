/*!
 * Portions of this file are derived from OpenClaw (https://github.com/openclaw/openclaw),
 * MIT License, Copyright (c) OpenClaw contributors.
 * Source: ui/src/components/markdown-code-blocks.ts (.code-block-* structure, language chip,
 * copy via data-code, CODE_PREVIEW_LINE_COUNT collapse) and markdown-highlight-runtime.ts.
 * Adaptations: no highlight.js — OpenClaw lazily imports 14 grammars and offloads long blocks
 * to a worker; our agents emit short command/config snippets, so we keep the structure,
 * the collapse threshold and the copy affordance without the highlighting dependency.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** OpenClaw 的 CODE_PREVIEW_LINE_COUNT：超过 7 行的块默认折起来。 */
const CODE_PREVIEW_LINE_COUNT = 7;

export default function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const lines = code.replace(/\n$/, "").split("\n");
  const collapsible = lines.length > CODE_PREVIEW_LINE_COUNT;

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const area = document.createElement("textarea");
      area.value = code;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1600);
  }, [code]);

  return (
    <div
      className={`code-block${collapsible ? " is-collapsible" : ""}${collapsible && !expanded ? " is-collapsed" : ""}`}
      {...(lang === "block-art" ? { "data-block-art": "" } : {})}
    >
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <span className="code-block-meta">{lines.length} 行</span>
        <div className="code-block-actions">
          {collapsible && (
            <button
              type="button"
              className="code-block-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "收起" : "展开"}
            </button>
          )}
          <button type="button" className="code-block-copy" onClick={() => void copy()}>
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>
      <pre className="code-block-body">
        <code>{code.replace(/\n$/, "")}</code>
      </pre>
    </div>
  );
}
