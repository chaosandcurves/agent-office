/**
 * Two defects this file pins, both reachable from the HTTP surface:
 *
 *   1. `installSkill("..")` resolved `dest` to AGENTS_DIR and rmSync'd it —
 *      one request deleted every agent definition the user owned.
 *   2. Saving a skill rebuilt its frontmatter from name/description/tags, so
 *      any other key (`license`, `allowed-tools`, …) was dropped on each edit.
 *
 *   pnpm --filter @agent-office/domain test src/services/skills/skills.test.ts
 */
import assert from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_DIR, SKILLS_DIR } from "../infra/paths";
import { importPastedSkill, installSkill, readInstalledSkill, writeLocalSkill } from "./skills";

function freshSkill(name: string, content: string): string {
  const dir = join(SKILLS_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
  return dir;
}

test("installSkill refuses a traversing name before it can delete anything", async () => {
  mkdirSync(AGENTS_DIR, { recursive: true });
  const bystander = join(AGENTS_DIR, "keep-me.md");
  writeFileSync(bystander, "an agent definition");

  for (const name of ["..", ".", "../_skills", "a/b", ".hidden"]) {
    await assert.rejects(
      () => installSkill("owner/repo", "main", "skills/x", name),
      /invalid skill name/,
      `installSkill must reject ${JSON.stringify(name)}`,
    );
  }

  assert.equal(existsSync(bystander), true, "AGENTS_DIR must survive the traversal attempt");
  assert.equal(existsSync(AGENTS_DIR), true);
});

test("installSkill rejects before any network call", async () => {
  // A name check after fetchTree would still be a live SSRF-ish round trip on
  // every hostile request; assert it throws synchronously-fast, not after I/O.
  const before = Date.now();
  await assert.rejects(() => installSkill("owner/repo", "main", "p", ".."), /invalid skill name/);
  assert.ok(Date.now() - before < 1000, "must fail on validation, not after a GitHub fetch");
});

test("editing a skill keeps frontmatter keys the editor does not model", () => {
  freshSkill(
    "carry-test",
    [
      "---",
      "name: carry-test",
      "description: original",
      "license: Apache-2.0",
      "allowed-tools: Read, Bash",
      "---",
      "",
      "original body",
      "",
    ].join("\n"),
  );

  writeLocalSkill(
    { name: "carry-test", description: "edited", tags: ["t"], body: "new body" },
    { overwrite: true },
  );

  const md = readFileSync(join(SKILLS_DIR, "carry-test", "SKILL.md"), "utf8");
  assert.match(md, /license: Apache-2\.0/, "license survived the edit");
  // Quoted on the way out: stringifyYaml quotes a scalar holding a comma.
  assert.match(md, /allowed-tools: "Read, Bash"/, "allowed-tools survived the edit");
  assert.match(md, /description: edited/, "the edited field won");
  assert.doesNotMatch(md, /description: original/);
  assert.equal(readInstalledSkill("carry-test")?.body, "new body");
});

test("a managed field is never shadowed by the carried copy", () => {
  freshSkill(
    "shadow-test",
    ["---", "name: shadow-test", "description: stale", "tags:", "  - old", "---", "", "body"].join("\n"),
  );

  writeLocalSkill(
    { name: "shadow-test", description: "fresh", tags: ["new"], body: "body" },
    { overwrite: true },
  );

  const md = readFileSync(join(SKILLS_DIR, "shadow-test", "SKILL.md"), "utf8");
  assert.match(md, /description: fresh/);
  assert.doesNotMatch(md, /stale/);
  assert.doesNotMatch(md, /old/, "the previous tag list must not come back");
  assert.match(md, /tags: \[new\]/);
});

test("a forged skill with no file on disk carries nothing and still writes", () => {
  rmSync(join(SKILLS_DIR, "forged-test"), { recursive: true, force: true });
  const saved = writeLocalSkill({ name: "forged-test", description: "d", body: "b" });
  assert.equal(saved.name, "forged-test");
  assert.equal(saved.description, "d");
  assert.equal(saved.body, "b");
});

test("importing pasted text keeps the pasted frontmatter's extra keys", () => {
  rmSync(join(SKILLS_DIR, "pasted-test"), { recursive: true, force: true });
  importPastedSkill(
    ["---", "name: pasted-test", "description: pasted", "license: MIT", "---", "", "pasted body", ""].join("\n"),
  );

  const md = readFileSync(join(SKILLS_DIR, "pasted-test", "SKILL.md"), "utf8");
  assert.match(md, /license: MIT/, "a key the user pasted must not be dropped on the way in");
  assert.equal(readInstalledSkill("pasted-test")?.body, "pasted body");
});

test("unreadable frontmatter degrades to carrying nothing, not to a throw", () => {
  freshSkill("broken-fm-test", "no frontmatter block at all\n");
  const saved = writeLocalSkill(
    { name: "broken-fm-test", description: "d", body: "b" },
    { overwrite: true },
  );
  assert.equal(saved.description, "d");
});

test("writeLocalSkill still refuses a traversing name", () => {
  for (const name of ["..", "../escape", "a/b", ".hidden"]) {
    assert.throws(
      () => writeLocalSkill({ name, body: "x" }, { overwrite: true }),
      /invalid skill name/,
    );
  }
});
