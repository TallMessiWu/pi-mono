import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";
const root = fileURLToPath(new URL("../", import.meta.url));

test("the fork root declares only the compaction extension for Git installs", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi, {
    extensions: ["./packages/pi-codex-compaction/index.ts"],
    skills: [], prompts: [], themes: [],
  });
});

test("Pi loads the repository root as a package without enabling other workspaces", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network allowed"); });
  const dir = await mkdtemp(join(tmpdir(), "pi-git-compaction-root-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory({ packages: [root] }),
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension.path.endsWith("/packages/pi-codex-compaction/index.ts"));
    assert.deepEqual([...extension.commands.keys()], ["server-compaction"]);
    assert.match(extension.commands.get("server-compaction").description, /now/);
    assert.equal(loader.getSkills().skills.length, 0);
    assert.equal(loader.getPrompts().prompts.length, 0);
    assert.equal(loader.getThemes().themes.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
