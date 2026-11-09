import type { Env } from "./types.js";

function trigrams(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const characters = [...normalized];
  const result = new Set<string>();
  for (let index = 0; index <= characters.length - 3; index++) result.add(characters.slice(index, index + 3).join(""));
  if (!result.size && normalized) result.add(normalized);
  return result;
}
export function overlap(left: string, right: string): number {
  const a = trigrams(left); const b = trigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared++;
  return shared / Math.min(a.size, b.size);
}
export async function isDuplicate(text: string, env: Env): Promise<boolean> {
  // Bounded memory; compare every issuing or successful application in pages, not only recent ones.
  let after = "";
  while (true) {
    const rows = await env.DB.prepare("SELECT id, application_text FROM nw_applications WHERE status IN ('creating','uncertain','succeeded') AND id > ? ORDER BY id LIMIT 100")
      .bind(after).all<{ id: string; application_text: string }>();
    if (rows.results.some((row) => overlap(text, row.application_text) > 0.3)) return true;
    if (rows.results.length < 100) return false;
    after = rows.results[rows.results.length - 1].id;
  }
}
