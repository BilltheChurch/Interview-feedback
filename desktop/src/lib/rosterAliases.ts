/**
 * rosterAliases.ts — parse "Name (alias1, alias2)" roster input (R6-roster).
 *
 * Setup lets the interviewer attach known aliases to a roster name inline:
 *   "Tina (Kenny Tan)"      → { name: "Tina", aliases: ["Kenny Tan"] }
 *   "Tina（Kenny Tan、KT）"  → full-width parens / separators accepted
 *   "Tina"                  → { name: "Tina" }
 *
 * The aliases ride the hello frame (teams_participants entries) to the worker, which
 * (a) biases the Speechmatics custom dictionary with them, (b) normalizes an alias
 * self-intro ("my name is Kenny Tan") to the primary roster name in the transcript,
 * and (c) feeds config.name_aliases so the LLM merges alias mentions.
 */
export function parseNameWithAliases(input: string): { name: string; aliases?: string[] } {
  const raw = (input ?? '').trim();
  // One trailing parenthesized group: "Name (a, b)" — half- or full-width parens.
  const match = raw.match(/^(.*?)[（(]([^()（）]+)[)）]\s*$/);
  if (!match) return { name: raw };

  const name = match[1].trim();
  const aliases = match[2]
    .split(/[,，、;；/]/)
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && alias.toLowerCase() !== name.toLowerCase());

  if (!name) return { name: raw }; // "(only parens)" — treat the whole input as the name
  return aliases.length > 0 ? { name, aliases } : { name };
}
