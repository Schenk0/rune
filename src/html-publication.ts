import { readFile, writeFile } from "node:fs/promises";
import { defaultTreeAdapter, parse } from "parse5";
import { contentTypeForFilename, HTML_CONTENT_TYPE } from "./content.js";

function publicationTags(html: string) {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = document.childNodes.filter(defaultTreeAdapter.isElementNode).find(node => node.tagName === "html");
  const head = root?.childNodes.filter(defaultTreeAdapter.isElementNode).find(node => node.tagName === "head");
  const tags = head?.childNodes.filter(defaultTreeAdapter.isElementNode).filter(node =>
    node.tagName === "meta" && node.attrs.some(attr => attr.name === "name" && attr.value.toLowerCase() === "rune-url"),
  ) ?? [];
  return { document, root, head, tags };
}

export async function htmlPublicationUrl(path: string): Promise<string> {
  if (contentTypeForFilename(path) !== HTML_CONTENT_TYPE) {
    throw new Error("Use rune replace <id-or-url> <file> for non-HTML files");
  }
  const { tags } = publicationTags(await readFile(path, "utf8"));
  const url = tags[0]?.attrs.find(attr => attr.name === "content")?.value;
  if (tags.length !== 1 || !url) {
    throw new Error("Expected one rune-url meta tag with a URL; use rune replace <id-or-url> <file>");
  }
  return url;
}

/** Annotate local HTML after a successful upload, without rewriting the rest of the document. */
export async function saveHtmlPublicationUrl(path: string, url: string): Promise<void> {
  if (contentTypeForFilename(path) !== HTML_CONTENT_TYPE) return;
  const html = await readFile(path, "utf8");
  const { document, root, head, tags } = publicationTags(html);
  if (tags.length === 1 && tags[0]?.attrs.find(attr => attr.name === "content")?.value === url) return;

  const escaped = url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const tag = `<meta name="rune-url" content="${escaped}">`;
  let updated = html;
  if (tags.length) {
    // Work backward so offsets remain valid, keeping a single publication tag.
    for (let index = tags.length - 1; index >= 0; index--) {
      const location = tags[index]?.sourceCodeLocation;
      if (!location) throw new Error("Could not locate rune-url meta tag");
      updated = updated.slice(0, location.startOffset) + (index === 0 ? tag : "") + updated.slice(location.endOffset);
    }
  } else {
    const offset = head?.sourceCodeLocation?.endTag?.startOffset
      ?? head?.sourceCodeLocation?.endOffset
      ?? head?.childNodes.at(-1)?.sourceCodeLocation?.endOffset
      ?? root?.sourceCodeLocation?.startTag?.endOffset
      ?? document.childNodes.find(node => node.nodeName === "#documentType")?.sourceCodeLocation?.endOffset
      ?? 0;
    updated = html.slice(0, offset) + tag + html.slice(offset);
  }
  await writeFile(path, updated, "utf8");
}
