import { describe, expect, it } from "vitest";
import { cleanWikitext } from "../src/knowledge/wikitext.js";

describe("cleanWikitext", () => {
  it("preserves inline Pal and element labels while removing structural templates", () => {
    const raw = `{{Item
|description = Material obtainable from Fire Pals.
|type = Material
}}
'''Flame Organ''' is obtained from {{i|Fire}} Pals.
* Possible drop from {{I|Flambelle}} when assigned to a [[ranch]].
* Possible drop from {{I|Kelpsea Ignis}} when assigned to a [[ranch]].
{{Navbox Materials}}`;

    const text = cleanWikitext(raw);
    expect(text).toContain("Flame Organ is obtained from Fire Pals.");
    expect(text).toContain("Possible drop from Flambelle when assigned to a ranch.");
    expect(text).toContain("Possible drop from Kelpsea Ignis when assigned to a ranch.");
    expect(text).not.toContain("description =");
    expect(text).not.toContain("Navbox");
  });
});
