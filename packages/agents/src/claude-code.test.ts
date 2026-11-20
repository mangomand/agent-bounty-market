import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "@abm/mcp";

const asset = (p: string) => readFile(fileURLToPath(new URL(`../claude-code/${p}`, import.meta.url)), "utf8");

describe("Claude Code assets", () => {
  it(".mcp.json points at the local Streamable HTTP endpoint", async () => {
    const cfg = JSON.parse(await asset(".mcp.json"));
    expect(cfg.mcpServers.bounty).toEqual({ type: "http", url: "http://localhost:4000/mcp" });
  });

  it("bounty-hunter SKILL.md has valid frontmatter", async () => {
    const md = await asset("skills/bounty-hunter/SKILL.md");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
    expect(m).not.toBeNull();
    const fm = Object.fromEntries(
      m![1]!.split("\n").map((l) => {
        const i = l.indexOf(":");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
    );
    expect(fm.name).toBe("bounty-hunter");
    expect(fm.description?.length).toBeGreaterThan(20);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
  });

  it("SKILL.md walks the full loop using only real MCP tools", async () => {
    const md = await asset("skills/bounty-hunter/SKILL.md");
    for (const tool of ["list_bounties", "get_bounty_spec", "submit_code", "request_test_run", "get_submission_status", "request_security_review"])
      expect(md).toContain(`\`${tool}\``);
    expect(md).toMatch(/payoutAddress/);
    expect(md).toMatch(/testCommand/);
    const named = [...md.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((x) => x[1]).filter((n) => n !== "node_modules");
    for (const t of named) expect(TOOL_NAMES as readonly string[]).toContain(t);
    expect(md.split("\n").length).toBeLessThan(80);
  });
});
