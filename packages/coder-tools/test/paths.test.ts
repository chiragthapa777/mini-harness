import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { display, resolveInProject } from "../src/paths.js";
import { tempProject } from "./helpers.js";

test("relative and absolute paths inside the project resolve", async () => {
  const root = await tempProject();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "");

  assert.equal(await resolveInProject(root, "src/a.ts"), join(root, "src/a.ts"));
  assert.equal(await resolveInProject(root, join(root, "src/a.ts")), join(root, "src/a.ts"));
  assert.equal(await resolveInProject(root, "./src/../src/a.ts"), join(root, "src/a.ts"));
  // A file that does not exist yet still resolves (edit targets, future write_file).
  assert.equal(await resolveInProject(root, "src/new/deep.ts"), join(root, "src/new/deep.ts"));
});

test("anything outside the project is refused", async () => {
  const root = await tempProject();
  for (const path of ["../outside.txt", "/etc/passwd", join(root, "..")]) {
    await assert.rejects(resolveInProject(root, path), /outside the project/, path);
  }
});

test("a symlink pointing out of the project does not get a file out", async () => {
  const root = await tempProject();
  const elsewhere = await tempProject();
  await writeFile(join(elsewhere, "secret.txt"), "s");
  await symlink(elsewhere, join(root, "escape"));

  await assert.rejects(resolveInProject(root, "escape/secret.txt"), /outside the project/);
  // Not even a file that would be created through the link.
  await assert.rejects(resolveInProject(root, "escape/new.txt"), /outside the project/);
});

test("secrets and the harness's own settings are off limits", async () => {
  const root = await tempProject();
  for (const path of [".env", ".env.local", "config/.env.production", ".mini-coder/settings.json", ".mini-coder/settings.local.json"]) {
    await assert.rejects(resolveInProject(root, path), /off limits/, path);
  }
  // The committed example and the project's skills are fine.
  await resolveInProject(root, ".env.example");
  await resolveInProject(root, ".mini-coder/skills/review/SKILL.md");
});

test("~/.ssh and ~/.mini-coder are off limits even when the project is home", async () => {
  const home = homedir();
  await assert.rejects(resolveInProject(home, ".ssh/id_ed25519"), /off limits/);
  await assert.rejects(resolveInProject(home, ".mini-coder/MEMORY.md"), /off limits/);
});

test("display shows project-relative paths", async () => {
  assert.equal(display("/work/app", "/work/app/src/a.ts"), "src/a.ts");
  assert.equal(display("/work/app", "/elsewhere/b.ts"), "/elsewhere/b.ts");
});
