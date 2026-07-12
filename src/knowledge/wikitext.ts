/** Convert MediaWiki article prose to searchable text without templates/media. */
export function cleanWikitext(value: string): string {
  let text = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, " ")
    .replace(/<ref\b[^>]*\/\s*>/gi, " ")
    .replace(/\{\|[\s\S]*?\|\}/g, " ");

  // Preserve the visible value from small inline display templates such as
  // {{I|Flambelle}}, while multiline infoboxes, tables, navboxes, and behavior
  // templates remain non-prose and are removed below.
  text = text.replace(
    /\{\{\s*(?:i|icon|pal|pal\s*icon|item\s*icon|element|work(?:\s*suitability)?|skill)\s*\|\s*([^|{}\n]+)(?:\|[^{}\n]*)?\}\}/gi,
    (_, label: string) => label.trim(),
  );
  text = removeBalanced(text, "{{", "}}");
  text = text
    .replace(/\[\[(?:File|Image|Category):[^\]]+\]\]/gi, " ")
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(?:https?:\/\/)[^\s\]]+\s+([^\]]+)\]/gi, "$1")
    .replace(/\[(?:https?:\/\/)[^\]]+\]/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/'{2,}/g, "")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  return cleanText(text);
}

function cleanText(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
}

function removeBalanced(value: string, open: string, close: string): string {
  let output = "";
  let depth = 0;
  for (let index = 0; index < value.length;) {
    if (value.startsWith(open, index)) {
      depth++;
      index += open.length;
    } else if (depth > 0 && value.startsWith(close, index)) {
      depth--;
      index += close.length;
      if (depth === 0) output += " ";
    } else {
      if (depth === 0) output += value[index];
      index++;
    }
  }
  return depth === 0 ? output : output + " ";
}
