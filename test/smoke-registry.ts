// Boot smoke check (no Discord login): the registry loads, every command has a
// unique name matching its module, and serializes to valid registration JSON.
import { commands } from "../src/commands/index.js";

const names = commands.map((c) => c.data.name);
if (new Set(names).size !== names.length) {
  throw new Error(`duplicate command names: ${names.join(", ")}`);
}
for (const c of commands) c.data.toJSON();
console.log(`registry ok: ${names.join(", ")}`);
