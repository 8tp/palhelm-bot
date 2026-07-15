import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { commands } from "../src/commands/index.js";
import { commandHelpFields } from "../src/commands/help.js";

describe("command help catalog", () => {
  it("includes every registered command exactly once", () => {
    const registered = commands.map((command) => command.data.name).sort();
    const documented = commandHelpFields(commands)
      .flatMap((field) => [...field.value.matchAll(/\*\*\/([^*]+)\*\*/g)].map((match) => match[1]!))
      .sort();

    expect(documented).toEqual(registered);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it("rejects duplicate command registrations", () => {
    expect(() => commandHelpFields([commands[0]!, commands[0]!])).toThrow(
      `Duplicate registered command: /${commands[0]!.data.name}`,
    );
  });

  it("leaves admin command visibility to the configured runtime role gate", () => {
    const adminCommands = commands.filter((command) => command.adminOnly);
    expect(adminCommands.length).toBeGreaterThan(0);
    for (const command of adminCommands) {
      expect(command.data.toJSON().default_member_permissions ?? null).toBeNull();
    }
  });

  it("keeps the README command table in sync with the registry", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const documented = [...readme.matchAll(/^\| `\/([a-z]+)(?:\s[^`]*)?` \|/gm)]
      .map((match) => match[1]!)
      .sort();
    const registered = commands.map((command) => command.data.name).sort();
    expect(documented).toEqual(registered);
  });
});
