// Shared formatting helpers for the panel.

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1e3);
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d " + Math.floor((s % 86400) / 3600) + "h";
}

export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m";
}

export function fmtTok(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

export function shortDir(d: string): string {
  const p = (d || "").replace(/\/+$/, "").split("/");
  return p.length > 2 ? "…/" + p.slice(-2).join("/") : d;
}

export function inTime(iso: string): string {
  const s = (new Date(iso).getTime() - Date.now()) / 1e3;
  if (s <= 0) return "now";
  if (s < 3600) return Math.ceil(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d";
}

export function firstln(s: string, max = 90): string {
  s = String(s).trim();
  const i = s.indexOf("\n");
  if (i >= 0) s = s.slice(0, i);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const escMap: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => escMap[c]);
}

/* Minimal, safe markdown: escape first, then only our own tags get in.
   Returned as an HTML string for dangerouslySetInnerHTML — safe because
   every character of user content passes through esc() before any tag
   is introduced. */
export function md(src: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const parts = String(src).split("```");
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      let body = parts[i];
      const nl = body.indexOf("\n");
      if (nl >= 0 && /^[\w+-]*\s*$/.test(body.slice(0, nl))) body = body.slice(nl + 1);
      html += "<pre><code>" + esc(body.replace(/\n+$/, "")) + "</code></pre>";
      continue;
    }
    const out: string[] = [];
    let list: { tag: string; items: string[] } | null = null;
    const flush = () => {
      if (list) {
        out.push("<" + list.tag + ">" + list.items.map((x) => "<li>" + x + "</li>").join("") + "</" + list.tag + ">");
        list = null;
      }
    };
    for (const raw of parts[i].split("\n")) {
      const t = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = t.match(/^(#{1,4})\s+(.*)/))) { flush(); out.push("<h" + m[1].length + ">" + inline(m[2]) + "</h" + m[1].length + ">"); }
      else if ((m = t.match(/^[-*•]\s+(.*)/))) { if (!list || list.tag !== "ul") { flush(); list = { tag: "ul", items: [] }; } list.items.push(inline(m[1])); }
      else if ((m = t.match(/^\d+[.)]\s+(.*)/))) { if (!list || list.tag !== "ol") { flush(); list = { tag: "ol", items: [] }; } list.items.push(inline(m[1])); }
      else if ((m = t.match(/^>\s?(.*)/))) { flush(); out.push("<blockquote>" + inline(m[1]) + "</blockquote>"); }
      else if (t === "") { flush(); out.push(""); }
      else { flush(); out.push(inline(raw)); }
    }
    flush();
    html += out.join("\n").split(/\n{2,}/).filter((x) => x.trim()).map((x) =>
      /^\s*<(h\d|ul|ol|blockquote|pre)/.test(x) ? x : "<p>" + x.trim().replace(/\n/g, "<br>") + "</p>").join("");
  }
  return html;
}
