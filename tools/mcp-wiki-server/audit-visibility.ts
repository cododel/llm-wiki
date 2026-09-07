#!/usr/bin/env bun
// Report only; reuse the server's actual gate, never a parallel visibility rule.
import { listServable } from "./access.ts";
import { resolveWikiDir } from "../lib/paths.ts";
const wikiDir = resolveWikiDir();
const pub = listServable({ wikiDir, scope: "public" });
const adm = listServable({ wikiDir, scope: "admin" });
const byLayer: Record<string, number> = {};
for (const page of pub) {
  const layer = page.path.includes("/") ? page.path.split("/")[0] : "(root)";
  byLayer[layer] = (byLayer[layer] ?? 0) + 1;
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ wikiDir, public: pub.length, admin: adm.length, hidden: adm.length - pub.length, byLayer,
    exposed: pub.map(({ path, type }) => ({ path, type })).sort((a, b) => a.path.localeCompare(b.path)) }, null, 2));
} else {
  console.log(`MCP explicit-public exposure — ${wikiDir}\npublic: ${pub.length}; admin: ${adm.length}; hidden: ${adm.length - pub.length}`);
  for (const layer of Object.keys(byLayer).sort()) console.log(`${layer}/: ${byLayer[layer]}`);
  if (process.argv.includes("--list")) for (const page of pub.map((p) => p.path).sort()) console.log(page);
  console.log("Only explicit visibility: public publishes content. Review metadata, references, and body before opting in.");
}
