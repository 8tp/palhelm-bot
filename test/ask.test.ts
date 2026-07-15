import { describe, expect, it } from "vitest";
import { buildAskAnswerEmbed } from "../src/commands/ask.js";

describe("/ask response presentation", () => {
  it("keeps deterministic sources with a concise AI footer and no diagnostic bloat", () => {
    const source = "https://palworld.wiki.gg/wiki/Meteorite_Fragment";
    const embed = buildAskAnswerEmbed(`Meteorite Fragments are useful.\n\nSources: <${source}>`).toJSON();
    const rendered = JSON.stringify(embed);

    expect(embed.description).toContain(`Sources: <${source}>`);
    expect(embed.footer?.text).toBe("AI Generated");
    expect(rendered).not.toMatch(/tool calls?|grounded with|verify important details|web facts may be version-sensitive|stale cached web source/i);
  });
});
