import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

function checkModule(source, extension = ".mjs") {
  const directory = mkdtempSync(join(tmpdir(), "bakkar-js-check-"));
  const file = join(directory, `script${extension}`);
  try {
    writeFileSync(file, source, "utf8");
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("public site loads only API catalog data and its module script parses", () => {
  const file = fileURLToPath(new URL("../../../index.html", import.meta.url));
  const html = readFileSync(file, "utf8");
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.match(html, /name="bakkar-api-base" content="https:\/\/bakkar-inventory-api\./);
  assert.doesNotMatch(script, /const P\s*=\s*\[/);
  assert.match(script, /\/api\/catalog\/meta/);
  assert.match(script, /\/api\/catalog\?/);
  checkModule(script);
});

test("the deployed admin HTML escaping fix is preserved and its nested script parses", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.js", import.meta.url)), "utf8");
  const label = "const ADMIN_HTML = ";
  const start = source.indexOf(label) + label.length;
  const end = source.indexOf("function json(data", start);
  assert.ok(start >= label.length && end > start);
  const html = vm.runInNewContext(source.slice(start, end).trim().replace(/;\s*$/, ""));
  assert.match(html, /\\u064B-\\u065F\\u0670/);
  assert.match(html, /\\s\\u200f\\u200e/);
  assert.match(html, /القرارات؟\\n\\n/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  checkModule(script, ".js");
});
