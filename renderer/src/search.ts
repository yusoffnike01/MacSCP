// Matching names against what's typed in the search box. The same rules as
// the server-side search (ssh.ts): "report" finds names containing it, and
// with * or ?, like "*.php", the whole name must match. Upper and lower case
// don't matter.

export interface NameMatcher {
  matches: (name: string) => boolean;
  // The part of the name to highlight, if any.
  highlight: (name: string) => [start: number, end: number] | null;
}

export function nameMatcher(query: string): NameMatcher | null {
  const text = query.trim();
  if (!text) return null;
  if (!/[*?]/.test(text)) {
    const lower = text.toLowerCase();
    return {
      matches: (name) => name.toLowerCase().includes(lower),
      highlight: (name) => {
        const start = name.toLowerCase().indexOf(lower);
        return start === -1 ? null : [start, start + lower.length];
      },
    };
  }
  const source = Array.from(text, (c) =>
    c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("");
  const regex = new RegExp(`^${source}$`, "is");
  return { matches: (name) => regex.test(name), highlight: () => null };
}
