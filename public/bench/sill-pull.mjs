#!/usr/bin/env node
// sill-pull — brings Sill's record from Petrichor onto his bench as files.
//
//   node sill-pull.mjs login <petrichor-url> <email>   (once: signs in with your email code)
//   node sill-pull.mjs                                   (any time: refreshes ~/sill/house)
//
// It holds only YOUR login (a refresh token, in ~/.config/sill-bench, readable
// by you alone). No API keys ever come to this machine. ~/sill/house is a
// read-only mirror, rewritten on every pull; nothing else under ~/sill is
// touched. No dependencies: plain Node 18+.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const HOME = os.homedir();
const CONF_DIR = path.join(HOME, ".config", "sill-bench");
const CONF = path.join(CONF_DIR, "session.json");
const HOUSE = path.join(HOME, "sill", "house");

function die(msg) { console.error("✗ " + msg); process.exit(1); }

function loadSession() {
  try { return JSON.parse(fs.readFileSync(CONF, "utf8")); }
  catch { die("Not signed in yet. Run: node sill-pull.mjs login <petrichor-url> <email>"); }
}

function saveSession(s) {
  fs.mkdirSync(CONF_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONF, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(CONF, 0o600);
}

async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const why = data.error_description || data.msg || data.error || `HTTP ${r.status}`;
    throw new Error(typeof why === "string" ? why : JSON.stringify(why));
  }
  return data;
}

async function login(base, email) {
  if (!base || !email) die("Usage: node sill-pull.mjs login <petrichor-url> <email>");
  base = base.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) base = "https://" + base;
  const cfg = await (await fetch(base + "/api/config")).json().catch(() => ({}));
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) die("Couldn't read " + base + "/api/config — is that the Petrichor address?");
  const auth = { apikey: cfg.supabaseAnonKey };
  await postJson(cfg.supabaseUrl + "/auth/v1/otp", { email, create_user: false }, auth);
  console.log("A code is on its way to " + email + ".");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = (await rl.question("Code: ")).trim();
  rl.close();
  const s = await postJson(cfg.supabaseUrl + "/auth/v1/verify", { type: "email", email, token: code }, auth);
  if (!s.refresh_token) die("Signed in, but no session came back.");
  saveSession({ base, supabaseUrl: cfg.supabaseUrl, anon: cfg.supabaseAnonKey, email, refresh_token: s.refresh_token });
  console.log("✓ Signed in. Now run: node sill-pull.mjs");
}

function safeJoin(root, rel) {
  const p = path.resolve(root, rel);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("refusing path outside house: " + rel);
  return p;
}

async function pull() {
  const s = loadSession();
  // Refresh the login (tokens rotate; keep the new one).
  const t = await postJson(s.supabaseUrl + "/auth/v1/token?grant_type=refresh_token",
    { refresh_token: s.refresh_token }, { apikey: s.anon })
    .catch((e) => die("Login expired (" + e.message + "). Run login again."));
  saveSession({ ...s, refresh_token: t.refresh_token });

  const bundle = await postJson(s.base + "/api/bench", { action: "pull" },
    { Authorization: "Bearer " + t.access_token });
  const files = bundle.files || {};
  const names = Object.keys(files);
  if (!names.length) die("The house sent nothing back. Nothing was changed.");

  // Replace ONLY ~/sill/house, and only once the new copy is in hand.
  if (path.basename(HOUSE) !== "house" || !HOUSE.startsWith(path.join(HOME, "sill"))) die("Unexpected house path.");
  const plan = names.map((rel) => [rel, safeJoin(HOUSE, rel)]);   // all checked first
  fs.rmSync(HOUSE, { recursive: true, force: true });
  for (const [rel, dest] of plan) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[rel]);
  }
  const diary = names.filter((n) => n.startsWith("diary/")).length;
  console.log(`✓ ${names.length} files in ~/sill/house (${diary} diary days), as of ${bundle.generated_at}`);
}

const [cmd, a, b] = process.argv.slice(2);
(cmd === "login" ? login(a, b) : pull()).catch((e) => die(e.message || String(e)));
