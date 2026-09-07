import { posix } from "node:path";

// Explicit root/relative paths, then exact vault path, unique suffix, unique stem.
// Ambiguity is reported, not guessed. Directories never imply a README note.
export type ResolveResult = string | null | "ambiguous";
function push(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key); if (arr) arr.push(value); else map.set(key, [value]);
}
export function buildResolver(relPaths: string[]): (target: string, sourcePath?: string) => ResolveResult {
  const suffixIndex = new Map<string, string[]>();
  const stemIndex = new Map<string, string[]>();
  const exactPathIndex = new Map<string, string>();
  for (const rel of new Set(relPaths)) {
    const noExt = rel.replace(/\.md$/i, ""); exactPathIndex.set(noExt, rel);
    const parts = noExt.split("/");
    for (let i = 0; i < parts.length; i++) push(suffixIndex, parts.slice(i).join("/"), rel);
    push(stemIndex, parts[parts.length - 1], rel);
  }
  return (targetRaw: string, sourcePath?: string): ResolveResult => {
    let target = targetRaw.split("#")[0].split("|")[0].trim();
    target = target.replace(/\.md$/i, "");
    if (!target) return null;
    if (target.startsWith("/")) return exactPathIndex.get(target.slice(1)) ?? null;
    if (target.startsWith("./") || target.startsWith("../")) {
      if (!sourcePath) return null;
      const relativeTarget = posix.normalize(posix.join(posix.dirname(sourcePath), target));
      if (relativeTarget === ".." || relativeTarget.startsWith("../")) return null;
      return exactPathIndex.get(relativeTarget) ?? null;
    }
    const exact = exactPathIndex.get(target); if (exact) return exact;
    const bySuffix = suffixIndex.get(target);
    if (bySuffix) return bySuffix.length === 1 ? bySuffix[0] : "ambiguous";
    const byStem = stemIndex.get(target.split("/").pop() ?? target);
    return byStem ? byStem.length === 1 ? byStem[0] : "ambiguous" : null;
  };
}
