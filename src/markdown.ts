import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

export const MAX_MARKDOWN_BYTES = 64 * 1024;

/** Only authenticated publishing invokes the parser. Dense/large input stays plain text. */
export function renderMarkdown(source: string): string | undefined {
  if (new TextEncoder().encode(source).byteLength > MAX_MARKDOWN_BYTES) return;
  // Bound constructs as well as bytes before allocating parser tokens, including nested lists/tables.
  let syntax = 0;
  for (const character of source) {
    if (/[^\p{L}\p{N} ]/u.test(character) && ++syntax > 2048) return;
  }
  try {
    const html = micromark(source, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
    return new TextEncoder().encode(html).byteLength <= 512 * 1024 ? html : undefined;
  } catch {
    return;
  }
}
