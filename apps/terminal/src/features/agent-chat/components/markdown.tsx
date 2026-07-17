"use client";

/**
 * Full markdown renderer for finished assistant messages. Applied only once a
 * response has stopped streaming (see AssistantMessage) — during streaming we
 * keep the cheap inline renderer to avoid re-parsing on every token and the
 * flicker of half-parsed markdown.
 *
 * No Tailwind typography plugin here: every element is styled by hand with the
 * design-system theme tokens so it matches the rest of the panel. Inline `code`
 * mirrors the streaming renderer's style exactly.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="text-foreground mb-1.5 mt-3 text-base font-semibold first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-foreground mb-1.5 mt-3 text-sm font-semibold first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-foreground mb-1 mt-2.5 text-sm font-semibold first:mt-0">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-0.5 pl-4 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-0.5 pl-4 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-chart-2 underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="text-foreground font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="border-border text-muted-foreground my-2 border-l-2 pl-3">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-border my-3" />,
  code: ({ className, children }) => {
    // react-markdown tags fenced/block code with a language- class; inline code
    // has none. Only inline code is styled here — block code is handled by pre.
    const isBlock = /\blanguage-/.test(className ?? "");
    if (isBlock) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="bg-secondary/60 rounded-xs px-1 font-mono text-[0.85em]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="bg-secondary/60 my-2 overflow-x-auto rounded-sm p-2.5 font-mono text-[0.85em] first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-border w-full border-collapse border text-[0.9em]">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-border bg-secondary/40 border px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-border border px-2 py-1">{children}</td>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
