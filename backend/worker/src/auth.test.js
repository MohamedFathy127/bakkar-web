import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const setupRequest = () => new Request("https://api.example/api/admin/setup", {
  method: "POST",
  headers: {
    origin: "https://api.example",
    "content-type": "application/json",
  },
  body: JSON.stringify({ email: "owner@example.test", setup_key: "synthetic", password: "synthetic-password" }),
});

test("owner setup reports missing configuration without touching owner data", async () => {
  for (const [env, expected] of [
    [{ DB: {} }, "Owner setup is not configured. Missing binding: ALLOWED_ORIGIN."],
    [{ DB: {}, ALLOWED_ORIGIN: "https://pages.example" }, "Owner setup is not configured. Missing bindings: OWNER_EMAIL, BOOTSTRAP_SECRET."],
    [{ DB: {}, ALLOWED_ORIGIN: "https://pages.example", OWNER_EMAIL: "owner@example.test" }, "Owner setup is not configured. Missing binding: BOOTSTRAP_SECRET."],
    [{ DB: {}, ALLOWED_ORIGIN: "https://pages.example", BOOTSTRAP_SECRET: "synthetic-only" }, "Owner setup is not configured. Missing binding: OWNER_EMAIL."],
  ]) {
    const response = await worker.fetch(setupRequest(), env);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: expected });
  }
});

test("owner setup checks same-origin and JSON before configuration diagnostics", async () => {
  const response = await worker.fetch(new Request("https://api.example/api/admin/setup", {
    method: "POST",
    headers: { origin: "https://attacker.example", "content-type": "application/json" },
    body: "{}",
  }), { DB: {}, ALLOWED_ORIGIN: "https://pages.example" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Invalid request origin." });
});

test("health and owner API report an absent D1 binding without exposing runtime errors", async () => {
  for (const path of ["/api/health", "/api/admin/status"]) {
    const response = await worker.fetch(new Request(`https://api.example${path}`), {});
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Database binding DB is not configured." });
  }
});
