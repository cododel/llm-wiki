import { expect, test } from "bun:test";
import { buildResolver } from "./resolver.ts";
const FILES = ["README.md", "concepts/topic-a/README.md", "concepts/topic-b/README.md", "concepts/topic-b/data-layer.md", "other/data-layer.md", "entities/example-tool.md", "ideas/example/README.md", "concepts/example-pattern.md"];
test("specific path suffix resolves", () => {
  const r = buildResolver(FILES); expect(r("topic-a/README")).toBe("concepts/topic-a/README.md"); expect(r("topic-b/data-layer")).toBe("concepts/topic-b/data-layer.md");
});
test("directory names never imply README", () => { const r = buildResolver(FILES); expect(r("topic-b")).toBeNull(); expect(r("topic-b/README")).toBe("concepts/topic-b/README.md"); });
test("exact root note wins before stem collisions", () => {
  const r = buildResolver(FILES); expect(r("README")).toBe("README.md"); expect(r("README", "concepts/topic-b/data-layer.md")).toBe("README.md"); expect(r("/README")).toBe("README.md");
});
test("relative paths resolve from source note, and cannot escape root", () => {
  const r = buildResolver(FILES); const src = "concepts/topic-b/README.md";
  expect(r("./data-layer", src)).toBe("concepts/topic-b/data-layer.md"); expect(r("../topic-a/README", src)).toBe("concepts/topic-a/README.md");
  expect(r("../README", src)).toBeNull(); expect(r("../../../README", src)).toBeNull(); expect(r("./README")).toBeNull();
});
test("unique stems and duplicate stem ambiguity", () => {
  const r = buildResolver(FILES); expect(r("example-tool")).toBe("entities/example-tool.md"); expect(r("example-pattern")).toBe("concepts/example-pattern.md"); expect(r("data-layer")).toBe("ambiguous");
});
test("extensions, heading anchors, and aliases are stripped", () => {
  const r = buildResolver(FILES); for (const target of ["example-tool.md", "example-tool#facts", "example-tool|Example tool"]) expect(r(target)).toBe("entities/example-tool.md");
});
test("missing/empty targets are not guessed", () => { const r = buildResolver(FILES); expect(r("does-not-exist")).toBeNull(); expect(r("")).toBeNull(); });
