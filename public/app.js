/*
 * Petrichor — client logic (Supabase-backed)
 *
 * Auth: Supabase magic link. No session = sign-in screen.
 * Storage: Supabase tables (projects, conversations, files) protected by
 *   row-level security so users only see their own data.
 *
 * Flow on page load:
 *   1. Fetch /api/config → init Supabase client.
 *   2. Check session. None → show sign-in screen and stop.
 *   3. Have session → load all the user's projects (with conversations
 *      and files), render the app.
 *
 * Every API call to /api/chat carries a Bearer token (the user's Supabase
 * access token). The serverless function verifies it before spending
 * any Anthropic credits.
 */

// ---------- Constants ----------

/*
 * thinkingMode controls which API shape we use when the user toggles Think on:
 *   - "adaptive": send thinking: {type: "adaptive"} — Claude decides whether to think.
 *     Opus 4.7+ uses this; it rejects the old extended-thinking shape.
 *   - "extended" (default): send thinking: {type: "enabled", budget_tokens: 4096}.
 *     The original mechanism on Claude 4.x models.
 */
const MODELS = [
  { id: "claude-opus-4-7",            label: "Opus 4.7",       pricePerMillion: { input: 15, output: 75 }, supportsThinking: true, thinkingMode: "adaptive" },
  { id: "claude-opus-4-6",            label: "Opus 4.6",       pricePerMillion: { input: 15, output: 75 }, supportsThinking: true },
  { id: "claude-opus-4-5-20251101",   label: "Opus 4.5",       pricePerMillion: { input: 15, output: 75 }, supportsThinking: true },
  { id: "claude-opus-4-1-20250805",   label: "Opus 4.1",       pricePerMillion: { input: 15, output: 75 }, supportsThinking: true },
  { id: "claude-opus-4-20250514",     label: "Opus 4",         pricePerMillion: { input: 15, output: 75 }, supportsThinking: true },
  { id: "claude-sonnet-4-6",          label: "Sonnet 4.6",     pricePerMillion: { input: 3,  output: 15 }, supportsThinking: true },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5",     pricePerMillion: { input: 3,  output: 15 }, supportsThinking: true },
  { id: "claude-sonnet-4-20250514",   label: "Sonnet 4",       pricePerMillion: { input: 3,  output: 15 }, supportsThinking: true },
  { id: "claude-haiku-4-5-20251001",  label: "Haiku 4.5",      pricePerMillion: { input: 1,  output: 5  }, supportsThinking: true },
];

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_SYSTEM = "You are Claude, a helpful AI assistant.";
const THINKING_BUDGET = 4096;
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;
const MEMORY_TYPES = ["fact", "preference", "pattern", "insight", "milestone", "connection"];
const ENTITY_TYPES = ["person", "project", "identity", "insight", "pattern", "milestone", "creative work", "advocacy effort", "research project"];

// ---------- Supabase + state ----------

let db = null;
let supabaseUrl = "";       // captured at init, for lock-free direct REST calls
let supabaseAnonKey = "";
let state = {
  user: null,
  projects: [],
  activeProjectId: null,
  activeView: "chat",        // "chat" | "manuscript"
  activeDocumentId: null,    // selected manuscript document
  coWrite: false,            // share the open piece into the chat (read-only)
};

const $ = (id) => document.getElementById(id);

const uid = () =>
  (crypto?.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

// Max response length (his max_tokens), a device preference. Clamped to the
// slider's range; defaults to the backend default. Sent on each chat request.
function getMaxTokens() {
  let v = 4096;
  try { v = parseInt(localStorage.getItem("petrichor-max-tokens"), 10) || 4096; } catch (e) {}
  return Math.max(2048, Math.min(16000, v));
}

// His display name on message bubbles etc. A device preference; defaults to
// "Claude". Purely cosmetic — it never touches his identity or system prompt.
function companionName() {
  let n = "";
  try { n = (localStorage.getItem("petrichor-companion-name") || "").trim(); } catch (e) {}
  return n || "Claude";
}

// His avatar: a small image stored as a compact data URL on this device (no
// upload, no Storage, never expires). "" = none, fall back to a lettered chip.
function companionAvatar() {
  try { return localStorage.getItem("petrichor-companion-avatar") || ""; } catch (e) { return ""; }
}

// Your (the user's) name + avatar — same device-preference idea, for your own
// message bubbles. Name defaults to "You".
function userName() {
  let n = "";
  try { n = (localStorage.getItem("petrichor-user-name") || "").trim(); } catch (e) {}
  return n || "You";
}
function userAvatar() {
  try { return localStorage.getItem("petrichor-user-avatar") || ""; } catch (e) { return ""; }
}

// Shrink a picked image to a square ~128px data URL via canvas, so it stays
// tiny in localStorage and loads instantly. Resolves to a data: URL string.
function avatarDataUrlFromFile(file, size = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);   // center-crop to a square
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error("Couldn't read that image.")); };
    img.src = URL.createObjectURL(file);
  });
}

// Sync an avatar preview + its Remove button in the customize panel to the
// current saved avatar/name. who is "companion" or "user". Safe to call even
// if the panel isn't open.
function refreshAvatarPreview(who = "companion") {
  const isUser = who === "user";
  const prev = $(isUser ? "user-avatar-preview" : "avatar-preview");
  if (!prev) return;
  const src = isUser ? userAvatar() : companionAvatar();
  const fallback = (isUser ? userName() : companionName()).charAt(0).toUpperCase()
    || (isUser ? "Y" : "C");
  if (src) {
    prev.classList.remove("letter");
    prev.textContent = "";
    prev.style.backgroundImage = `url("${src}")`;
  } else {
    prev.classList.add("letter");
    prev.style.backgroundImage = "";
    prev.textContent = fallback;
  }
  const removeBtn = $(isUser ? "user-avatar-remove-btn" : "avatar-remove-btn");
  if (removeBtn) removeBtn.hidden = !src;
}

// Build the little round avatar element for a message: the image if set,
// otherwise a lettered chip from the name's first character. role picks whose.
function avatarNode(role) {
  const isUser = role === "user";
  const src = isUser ? userAvatar() : companionAvatar();
  const name = isUser ? userName() : companionName();
  const el = document.createElement("span");
  el.className = "msg-avatar";
  if (src) {
    el.style.backgroundImage = `url("${src}")`;
  } else {
    el.classList.add("letter");
    el.textContent = name.charAt(0).toUpperCase() || (isUser ? "Y" : "C");
  }
  return el;
}

// ---------- Mappers (DB row ↔ in-memory shape) ----------

function rowToProject(row) {
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    systemPrompt: row.system_prompt || "",
    webSearch: !!row.web_search,
    thinking: !!row.thinking,
    whisper: !!row.whisper,
    signal: !!row.signal,
    memory: !!row.memory,
    activeConversationId: row.active_conversation_id || null,
    conversations: [],
    files: [],
  };
}

function rowToConversation(row) {
  return {
    id: row.id,
    name: row.name,
    messages: Array.isArray(row.messages) ? row.messages : [],
    activeFileIds: Array.isArray(row.active_file_ids) ? row.active_file_ids : [],
  };
}

function rowToFile(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mediaType: row.media_type,
    size: row.size || 0,
    data: row.data,                    // base64 (legacy images, pdf/text)
    storagePath: row.storage_path || null, // images live in Storage now
  };
}

// ---------- Auth ----------

async function initSupabase() {
  let cfg;
  try {
    const r = await fetch("/api/config");
    cfg = await r.json();
  } catch (e) {
    showSetupError("Couldn't reach /api/config. Make sure the project is deployed and try refreshing.");
    return;
  }
  if (!cfg.configured) {
    showSetupError(
      "Supabase isn't configured yet. Add SUPABASE_URL and SUPABASE_ANON_KEY in your Vercel project's " +
      "Settings → Environment Variables, then redeploy. See docs/SUPABASE_SETUP.md."
    );
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    showSetupError("Supabase JS SDK didn't load. Check your network and refresh.");
    return;
  }
  db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  supabaseUrl = (cfg.supabaseUrl || "").replace(/\/$/, "");
  supabaseAnonKey = cfg.supabaseAnonKey || "";

  const { data: { session } } = await db.auth.getSession();
  if (session) {
    state.user = session.user;
    await enterApp();
  } else {
    showSignInScreen();
  }

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" && session) {
      state.user = session.user;
      await enterApp();
    } else if (event === "SIGNED_OUT") {
      state.user = null;
      state.projects = [];
      state.activeProjectId = null;
      showSignInScreen();
    }
  });
}

// Sign-in is a two-step email OTP: send a numeric code, then verify it.
// (Supabase's token length varies by project — 6 to 8 digits — so the
// input accepts up to 8 and we don't promise an exact count anywhere.)
// We deliberately do NOT pass emailRedirectTo — there's no link to follow,
// so nothing can hijack the tap into the installed app, and there's no
// redirect to misfire. The email carries a code the person types here.
let signinEmail = "";

// Reveal the code-entry step for a given email. Shared by sendCode() and the
// "I already have a code" path — so someone who's rate-limited can still type
// a code already sitting in their inbox without triggering another send.
function showCodeStep(email, message) {
  signinEmail = email;
  $("signin-email").hidden = true;
  $("signin-code").hidden = false;
  $("signin-code").value = "";
  $("signin-code").focus();
  $("signin-submit").textContent = "Verify & sign in";
  $("signin-restart").hidden = false;
  $("signin-have-code").hidden = true;
  const msg = $("signin-msg");
  msg.textContent = message;
  msg.className = "signin-msg success";
}

async function sendCode(email) {
  if (!db) return;
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) {
    const msg = $("signin-msg");
    msg.textContent = error.message;
    msg.className = "signin-msg error";
    // Even if a fresh send is rate-limited, a code from a previous send may
    // still be valid — so let them proceed to type it instead of dead-ending.
    $("signin-have-code").hidden = false;
    return;
  }
  showCodeStep(email, `Enter the code sent to ${email}.`);
}

// "I already have a code": skip the send entirely, just show the code box.
function useExistingCode() {
  const email = $("signin-email").value.trim();
  if (!email) {
    const msg = $("signin-msg");
    msg.textContent = "Enter your email first, then your code.";
    msg.className = "signin-msg error";
    $("signin-email").focus();
    return;
  }
  showCodeStep(email, `Enter the code from your email for ${email}.`);
}

async function verifyCode(email, code) {
  if (!db) return;
  const { error } = await db.auth.verifyOtp({ email, token: code, type: "email" });
  // On success, onAuthStateChange fires SIGNED_IN → enterApp(); nothing to do.
  if (error) {
    const msg = $("signin-msg");
    msg.textContent = error.message;
    msg.className = "signin-msg error";
  }
}

function resetSignIn() {
  signinEmail = "";
  $("signin-code").value = "";
  $("signin-code").hidden = true;
  $("signin-email").hidden = false;
  $("signin-email").focus();
  $("signin-submit").textContent = "Send code";
  $("signin-restart").hidden = true;
  $("signin-have-code").hidden = false;
  const msg = $("signin-msg");
  msg.textContent = "";
  msg.className = "signin-msg";
}

async function signOut() {
  if (db) await db.auth.signOut();
}

function showSignInScreen() {
  $("signin-screen").hidden = false;
  $("app-shell").hidden = true;
  $("setup-error").hidden = true;
}

function showSetupError(msg) {
  $("setup-error").hidden = false;
  $("setup-error-msg").textContent = msg;
  $("signin-screen").hidden = true;
  $("app-shell").hidden = true;
}

async function enterApp() {
  $("signin-screen").hidden = true;
  $("setup-error").hidden = true;
  $("app-shell").hidden = false;
  $("user-email").textContent = state.user?.email || "";
  await loadAllData();
  if (!state.projects.length) await createProject("My first project");
  else render();
  renderPinnedStrip();
}

// ---------- Data layer ----------

async function loadAllData() {
  const { data: projectRows, error: pErr } = await db
    .from("projects").select("*").order("created_at", { ascending: false });
  if (pErr) { console.error(pErr); alert(`Couldn't load projects: ${pErr.message}`); return; }

  const projects = (projectRows || []).map(rowToProject);
  if (projects.length === 0) { state.projects = []; state.activeProjectId = null; return; }

  const ids = projects.map(p => p.id);
  const [{ data: convRows }, { data: fileRows }] = await Promise.all([
    db.from("conversations").select("*").in("project_id", ids).order("created_at", { ascending: false }),
    db.from("files").select("*").in("project_id", ids).order("created_at", { ascending: true }),
  ]);

  const byProject = Object.fromEntries(projects.map(p => [p.id, p]));
  for (const row of convRows || []) byProject[row.project_id]?.conversations.push(rowToConversation(row));
  for (const row of fileRows || []) byProject[row.project_id]?.files.push(rowToFile(row));

  for (const p of projects) {
    if (!p.activeConversationId && p.conversations[0]) p.activeConversationId = p.conversations[0].id;
  }

  state.projects = projects;
  state.activeProjectId = state.activeProjectId && projects.find(p => p.id === state.activeProjectId)
    ? state.activeProjectId
    : projects[0]?.id || null;

  restoreConversationBackups(); // recover anything a failed save left only on-device
}

// ---------- Conversation backups (local safety net) ----------
// Every save also writes the conversation to localStorage — instant, offline,
// can't deadlock. So a failed cloud save + refresh can never lose messages:
// on next load we compare, and if the local copy is ahead of the cloud we
// restore it and re-save (a fresh page has a clean auth lock, so it lands).
const CONV_BACKUP_PREFIX = "petrichor-conv-";

function backupConversation(conv) {
  try {
    const messages = conv.messages.map(stripTransient);
    localStorage.setItem(CONV_BACKUP_PREFIX + conv.id, JSON.stringify({
      messages,
      activeFileIds: conv.activeFileIds || [],
      savedAt: Date.now(),
    }));
  } catch (_) { /* storage full/unavailable — non-fatal */ }
}

function clearConversationBackup(id) {
  try { localStorage.removeItem(CONV_BACKUP_PREFIX + id); } catch (_) {}
}

function restoreConversationBackups() {
  for (const p of state.projects || []) {
    for (const conv of p.conversations || []) {
      try {
        const raw = localStorage.getItem(CONV_BACKUP_PREFIX + conv.id);
        if (!raw) continue;
        const b = JSON.parse(raw);
        if (b && Array.isArray(b.messages) && b.messages.length > conv.messages.length) {
          conv.messages = b.messages;
          if (Array.isArray(b.activeFileIds)) conv.activeFileIds = b.activeFileIds;
          persistConversation(conv); // push the recovered messages back to the cloud
        } else {
          clearConversationBackup(conv.id); // cloud is current — drop the backup
        }
      } catch (_) { /* ignore a malformed backup */ }
    }
  }
}

async function dbCreateProject(name) {
  const { data, error } = await db.from("projects").insert({
    user_id: state.user.id,
    name,
    model: DEFAULT_MODEL,
    system_prompt: DEFAULT_SYSTEM,
  }).select().single();
  if (error) throw error;
  return rowToProject(data);
}

async function dbUpdateProject(id, fields) {
  const { error } = await db.from("projects").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteProject(id) {
  const { error } = await db.from("projects").delete().eq("id", id);
  if (error) throw error;
}

async function dbCreateConversation(projectId, name) {
  const { data, error } = await db.from("conversations").insert({
    project_id: projectId,
    user_id: state.user.id,
    name,
  }).select().single();
  if (error) throw error;
  return rowToConversation(data);
}

async function dbUpdateConversation(id, fields) {
  // Lock-free save: a raw PATCH with the token read straight from localStorage,
  // so it CANNOT deadlock on the auth Web Lock (the bug that, after the photo
  // picker, silently killed every conversation save for an hour). Falls back
  // to the normal client only if we can't build the direct request.
  const session = localSession();
  if (supabaseUrl && supabaseAnonKey && session && session.access_token) {
    const resp = await withTimeout(fetch(
      `${supabaseUrl}/rest/v1/conversations?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseAnonKey,
          "Authorization": `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal",
        },
        body: JSON.stringify(fields),
      }), 15000, "save request timed out");
    if (!resp.ok) throw new Error(`save failed (${resp.status})`);
    return;
  }
  const { error } = await db.from("conversations").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteConversation(id) {
  const { error } = await db.from("conversations").delete().eq("id", id);
  if (error) throw error;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.onload = () => {
      const s = r.result;
      resolve(s.slice(s.indexOf(",") + 1)); // strip data: prefix
    };
    r.readAsDataURL(blob);
  });
}

// One JSON POST to /api/upload, with auth + a short retry (small requests can
// blip on a flaky connection). Returns the parsed JSON.
async function uploadPost(payload, { attempts = 3, timeout = 12000 } = {}) {
  // Lock-free token: read the saved session directly (no Web Lock, so the
  // photo-picker deadlock can't bite). Only fall back to freshSession() if
  // there's no stored token at all.
  const session = localSession() || await freshSession();
  if (!session || !session.access_token) {
    throw new Error("You're signed out. Refresh to sign back in.");
  }
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const resp = await withTimeout(fetch("/api/upload", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }), timeout, "upload request timed out");
      if (!resp.ok) {
        let body = {};
        try { body = await resp.json(); } catch (_) {}
        throw new Error(body.error || `upload failed (${resp.status})`);
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Upload an image through our own server. The real bug was never size — it was
// the auth lock deadlocking after the photo-picker backgrounds the app (now
// fixed in freshSession/localSession). So send it in ONE fast shot (the diag
// proved the phone can POST a big authed body to /api/upload fine). Only if
// that genuinely fails do we fall back to larger chunks — and at 64KB each
// that's a handful of requests, not dozens, so it finishes before the screen
// can sleep.
const UPLOAD_CHUNK_CHARS = 64 * 1024;
async function uploadImageBlob(blob, { projectId, name } = {}) {
  const data = await blobToBase64(blob);
  flashToast(`📤 sending photo (${Math.round(data.length / 1024)} KB)…`);
  const meta = { project_id: projectId, name: name || "photo.jpg" };

  // Fast path: one shot. The server stores the image and writes its db record,
  // returning the saved row in `file`.
  try {
    const res = await uploadPost(
      { data, content_type: "image/jpeg", ...meta }, { attempts: 2, timeout: 30000 });
    if (res && res.file) return res.file;
  } catch (_) {
    flashToast("retrying in pieces…", true);
  }

  // Fallback: a few larger chunks; finalize stores + records and returns `file`.
  const sessionId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, "")
    : String(Date.now()) + Math.random().toString(36).slice(2);
  const total = Math.ceil(data.length / UPLOAD_CHUNK_CHARS) || 1;
  for (let i = 0; i < total; i++) {
    const chunk = data.slice(i * UPLOAD_CHUNK_CHARS, (i + 1) * UPLOAD_CHUNK_CHARS);
    flashToast(`sending photo… ${i + 1}/${total}`);
    await uploadPost({ session: sessionId, index: i, total, chunk });
  }
  const res = await uploadPost({
    session: sessionId, total, finalize: true, content_type: "image/jpeg", ...meta,
  });
  if (!res || !res.file) throw new Error("upload returned no record");
  return res.file;
}

async function dbCreateFile(projectId, file) {
  if (file.blob) {
    // Image: our server both stores the file AND writes its database record,
    // so the phone makes ZERO direct database writes — which is essential,
    // because the auth lock deadlocks after the photo-picker backgrounds the
    // app. The server returns the saved record; we use it as-is.
    const rec = await uploadImageBlob(file.blob, { projectId, name: file.name });
    return rowToFile(rec);
  }

  // pdf / text: small inline base64, written directly (no picker-deadlock
  // concern in practice).
  const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
  const row = {
    project_id: projectId,
    user_id: state.user.id,
    name: file.name,
    kind: file.kind,
    media_type: file.mediaType,
    size: file.size,
    data: file.data,
    storage_path: null,
  };
  if (id) {
    const { error } = await db.from("files").insert({ id, ...row });
    if (error) throw error;
    return rowToFile({ ...row, id });
  }
  const { data, error } = await db.from("files").insert(row).select("id").single();
  if (error) throw error;
  return rowToFile({ ...row, id: data.id });
}

async function dbDeleteFile(id) {
  const { error } = await db.from("files").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Manuscript documents ----------

function rowToDocument(row) {
  return {
    id: row.id,
    title: row.title || "Untitled",
    content: row.content || "",
    position: row.position || 0,
    wordCount: row.word_count || 0,
  };
}

function countWords(text) {
  const m = (text || "").trim().match(/\S+/g);
  return m ? m.length : 0;
}

async function dbListDocuments(projectId) {
  const { data, error } = await db
    .from("manuscript_documents")
    .select("id,title,content,position,word_count")
    .eq("project_id", projectId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToDocument);
}

async function dbCreateDocument(projectId, title, position) {
  const { data, error } = await db.from("manuscript_documents").insert({
    project_id: projectId,
    user_id: state.user.id,
    title: title || "Untitled",
    content: "",
    position: position || 0,
    word_count: 0,
  }).select("id,title,content,position,word_count").single();
  if (error) throw error;
  return rowToDocument(data);
}

async function dbUpdateDocument(id, fields) {
  const { error } = await db.from("manuscript_documents").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteDocument(id) {
  const { error } = await db.from("manuscript_documents").delete().eq("id", id);
  if (error) throw error;
}

async function dbListPendingSuggestions(documentId) {
  const { data, error } = await db
    .from("manuscript_suggestions")
    .select("id,mode,content,note,created_at")
    .eq("document_id", documentId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function dbSetSuggestionStatus(id, status) {
  const { error } = await db.from("manuscript_suggestions").update({ status }).eq("id", id);
  if (error) throw error;
}

async function dbListCoreMemories() {
  const { data, error } = await db
    .from("core_memories")
    .select("*")
    .eq("is_active", true)
    .order("resonance", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function dbCreateCoreMemory(content, memoryType, resonance) {
  const { error } = await db.from("core_memories").insert({
    user_id: state.user.id,
    content,
    memory_type: memoryType,
    resonance,
  });
  if (error) throw error;
}

async function dbUpdateCoreMemory(id, fields) {
  const { error } = await db.from("core_memories").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteCoreMemory(id) {
  const { error } = await db.from("core_memories").delete().eq("id", id);
  if (error) throw error;
}

// ---------- Diary ----------
// His notepad. He writes entries via a tool; here Cassie can read, add, edit,
// archive (soft-hide), or delete them. RLS scopes every row to her user.
async function dbListDiaryEntries(activeOnly = true) {
  let q = db.from("diary_entries").select("*");
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function dbCreateDiaryEntry(content) {
  const { error } = await db.from("diary_entries").insert({
    user_id: state.user.id,
    content,
  });
  if (error) throw error;
}

async function dbUpdateDiaryEntry(id, fields) {
  const { error } = await db.from("diary_entries").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteDiaryEntry(id) {
  const { error } = await db.from("diary_entries").delete().eq("id", id);
  if (error) throw error;
}

async function dbListPinnedMemories() {
  const { data, error } = await db
    .from("core_memories")
    .select("id,content,memory_type,resonance,pinned")
    .eq("is_active", true)
    .eq("pinned", true)
    .order("resonance", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}

async function dbGetSelfState() {
  const { data, error } = await db
    .from("self_state")
    .select("content,version,consolidation_notes")
    .eq("is_current", true)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Atomic version promotion lives in a Postgres function so the
// flip-old / insert-new pair can't half-apply. See the RPC in
// docs/petrichor-memory-schema.sql.
async function dbPromoteSelfState(content, notes) {
  const { data, error } = await db.rpc("promote_self_state", {
    new_content: content,
    new_notes: notes || null,
  });
  if (error) throw error;
  return data;
}

async function dbListMemoryEntities() {
  const { data, error } = await db
    .from("claude_memory_entities")
    .select("id,name,entity_type,observations,access_count")
    .order("access_count", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function dbCreateMemoryEntity(name, entityType, observations) {
  const { error } = await db.from("claude_memory_entities").insert({
    user_id: state.user.id,
    name,
    entity_type: entityType,
    observations,
    created_by: "petrichor-app",
  });
  if (error) throw error;
}

async function dbUpdateMemoryEntity(id, fields) {
  const { error } = await db.from("claude_memory_entities").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteMemoryEntity(id) {
  const { error } = await db.from("claude_memory_entities").delete().eq("id", id);
  if (error) throw error;
}

async function dbGetUserPreferences() {
  const { data, error } = await db
    .from("user_preferences")
    .select("content")
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function dbSaveUserPreferences(content) {
  const { error } = await db
    .from("user_preferences")
    .upsert({ user_id: state.user.id, content }, { onConflict: "user_id" });
  if (error) throw error;
}

// ---------- Project / conversation ops ----------

function getActiveProject() {
  return state.projects.find(p => p.id === state.activeProjectId) || null;
}

function getActiveConversation(project = getActiveProject()) {
  if (!project) return null;
  return project.conversations.find(c => c.id === project.activeConversationId) || project.conversations[0] || null;
}

function modelInfo(id) {
  return MODELS.find(m => m.id === id) || { id, label: id, pricePerMillion: { input: 0, output: 0 }, supportsThinking: false };
}

async function createProject(name = "New project") {
  try {
    const project = await dbCreateProject(name);
    state.projects.unshift(project);
    state.activeProjectId = project.id;
    // Create the first conversation for this project
    const conv = await dbCreateConversation(project.id, "Conversation 1");
    project.conversations.push(conv);
    project.activeConversationId = conv.id;
    await dbUpdateProject(project.id, { active_conversation_id: conv.id });
    render();
    focusAndSelect("project-name");
  } catch (e) {
    alert(`Couldn't create project: ${e.message}`);
  }
}

async function deleteProject(id) {
  if (!confirm("Delete this project and all its conversations? This can't be undone.")) return;
  try {
    await dbDeleteProject(id);
    state.projects = state.projects.filter(p => p.id !== id);
    if (state.activeProjectId === id) state.activeProjectId = state.projects[0]?.id ?? null;
    render();
  } catch (e) {
    alert(`Couldn't delete project: ${e.message}`);
  }
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  const b = $("sidebar-backdrop");
  if (b) b.hidden = true;
}

function selectProject(id) {
  state.activeProjectId = id;
  state.activeView = "chat";       // start each project on its chat
  state.activeDocumentId = null;
  state.coWrite = false;           // co-write is per-piece; reset on project switch
  render();
  closeSidebar();
}

async function renameProject(id) {
  const project = state.projects.find(p => p.id === id);
  if (!project) return;
  const next = prompt("Rename project:", project.name);
  if (next === null) return;
  const name = next.trim() || project.name;
  project.name = name;
  render();
  try { await dbUpdateProject(id, { name }); }
  catch (e) { alert(`Rename failed: ${e.message}`); }
}

async function createConversation(name) {
  const project = getActiveProject();
  if (!project) return;
  const fallback = name || `Conversation ${project.conversations.length + 1}`;
  try {
    const conv = await dbCreateConversation(project.id, fallback);
    project.conversations.unshift(conv);
    project.activeConversationId = conv.id;
    await dbUpdateProject(project.id, { active_conversation_id: conv.id });
    render();
    closeSidebar();
    focusAndSelect("conv-name");
  } catch (e) {
    alert(`Couldn't create conversation: ${e.message}`);
  }
}

async function selectConversation(convId) {
  const project = getActiveProject();
  if (!project) return;
  project.activeConversationId = convId;
  render();
  closeSidebar();
  try { await dbUpdateProject(project.id, { active_conversation_id: convId }); }
  catch (e) { console.error(e); }
}

async function deleteConversation(convId) {
  const project = getActiveProject();
  if (!project) return;
  if (!confirm("Delete this conversation? This can't be undone.")) return;
  try {
    await dbDeleteConversation(convId);
    project.conversations = project.conversations.filter(c => c.id !== convId);
    if (project.conversations.length === 0) {
      const conv = await dbCreateConversation(project.id, "Conversation 1");
      project.conversations.push(conv);
      project.activeConversationId = conv.id;
      await dbUpdateProject(project.id, { active_conversation_id: conv.id });
    } else if (project.activeConversationId === convId) {
      project.activeConversationId = project.conversations[0].id;
      await dbUpdateProject(project.id, { active_conversation_id: project.activeConversationId });
    }
    render();
  } catch (e) {
    alert(`Couldn't delete conversation: ${e.message}`);
  }
}

async function renameConversation(convId) {
  const project = getActiveProject();
  if (!project) return;
  const conv = project.conversations.find(c => c.id === convId);
  if (!conv) return;
  const next = prompt("Rename conversation:", conv.name);
  if (next === null) return;
  const name = next.trim() || conv.name;
  conv.name = name;
  render();
  try { await dbUpdateConversation(convId, { name }); }
  catch (e) { alert(`Rename failed: ${e.message}`); }
}

// Transient per-message fields (the typewriter's reveal state, rAF handle)
// are prefixed with "_" and must never be saved — a persisted `_typing`
// with a partial `_shown` would reload as truncated text. Strip them.
function stripTransient(m) {
  const out = {};
  for (const k in m) if (!k.startsWith("_")) out[k] = m[k];
  return out;
}

async function persistConversation(conv) {
  backupConversation(conv); // local safety net FIRST — survives a failed cloud save
  try {
    await withTimeout(dbUpdateConversation(conv.id, {
      messages: conv.messages.map(stripTransient),
      active_file_ids: conv.activeFileIds,
    }), 20000, "save timed out");
    clearConversationBackup(conv.id); // cloud has it now — drop the local copy
  } catch (e) { console.error("Conversation persist failed (kept local backup):", e); }
}

// ---------- File ops ----------

function fileKind(file) {
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/"))  return "image";
  return "text";
}

const IMAGE_MAX_EDGE = 1568; // Claude's max useful image edge

// Reject if a promise hasn't settled in `ms` — so a stalled image decode
// can't hang the attach forever (the bug: "Got… adding…" then nothing).
function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("couldn't open this image — try a JPG or PNG"));
    img.src = url;
  });
}

function drawScaled(source, sw, sh) {
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, 0, 0, w, h);
  return canvas;
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("couldn't encode image"))),
      "image/jpeg", quality);
  });
}

// Downscale + re-encode an image to a JPEG Blob for upload to Storage. Phone
// photos (e.g. a Galaxy S25's) are huge and the old <img>-decode could
// silently STALL on mobile, so we prefer createImageBitmap (robust, off the
// main thread, fails fast) with a hard timeout, and fall back to <img>.
// Returns a Blob — Storage handles the upload, so no aggressive size budget.
async function processImage(file) {
  let canvas;
  if (typeof createImageBitmap === "function") {
    const bmp = await withTimeout(
      createImageBitmap(file), 20000,
      "this photo took too long to process — it may be very large");
    try {
      canvas = drawScaled(bmp, bmp.width, bmp.height);
    } finally {
      if (bmp.close) bmp.close();
    }
  } else {
    const url = URL.createObjectURL(file);
    try {
      const img = await withTimeout(
        loadImageEl(url), 20000, "this photo took too long to load");
      canvas = drawScaled(img, img.width, img.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return canvasToJpegBlob(canvas, 0.85);
}

async function readFile(file) {
  const kind = fileKind(file);
  if (kind === "image") {
    // Normalize to a JPEG Blob; it's uploaded to Storage (not the DB).
    const blob = await processImage(file);
    return {
      name: file.name, kind, mediaType: "image/jpeg",
      blob, previewUrl: URL.createObjectURL(blob), size: blob.size,
    };
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.onload = () => {
      let data = reader.result;
      if (kind !== "text") {
        const comma = data.indexOf(",");
        data = comma >= 0 ? data.slice(comma + 1) : data;
      }
      resolve({
        name: file.name,
        kind,
        mediaType: file.type || "text/plain",
        data,
        size: file.size,
      });
    };
    if (kind === "text") reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

async function attachFiles(fileList) {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  if (!project || !conv) {
    flashToast("Open a conversation first, then attach.", true);
    return;
  }
  let attached = 0;
  for (const f of fileList) {
    try {
      // Each stage is timeout-guarded and labelled, so a stall can never sit
      // silently — within ~20s you get either success or a message naming the
      // stage (and, for the save, the encoded size, to confirm downscaling).
      flashToast(`Processing ${f.name}…`);
      const parsed = await withTimeout(
        readFile(f), 20000, "reading/decoding the photo timed out");
      const kb = Math.round((parsed.blob?.size || parsed.data?.length || 0) / 1024);
      flashToast(`Uploading ${f.name} (${kb}KB)…`);
      // Generous overall ceiling: a chunked upload is many small requests
      // (each has its own short timeout + retries inside uploadImageBlob).
      const stored = await withTimeout(
        dbCreateFile(project.id, parsed), 180000,
        `upload timed out (${kb}KB)`);
      // Keep the local preview for an instant thumbnail (no re-download).
      if (parsed.previewUrl) stored.previewUrl = parsed.previewUrl;
      project.files.push(stored);
      conv.activeFileIds.push(stored.id);
      attached++;
    } catch (e) {
      flashToast(`Couldn't attach ${f.name}: ${e?.message || e}`, true);
    }
  }
  await persistConversation(conv);
  render();
  if (attached === 1) {
    flashToast(`📎 Attached ${fileList[0].name} — it'll go with your next message`);
  } else if (attached > 1) {
    flashToast(`📎 Attached ${attached} files — they'll go with your next message`);
  }
}

async function toggleActiveFile(fileId) {
  const conv = getActiveConversation();
  if (!conv) return;
  const i = conv.activeFileIds.indexOf(fileId);
  if (i >= 0) conv.activeFileIds.splice(i, 1);
  else conv.activeFileIds.push(fileId);
  render();
  await persistConversation(conv);
}

async function removeFile(fileId) {
  const project = getActiveProject();
  if (!project) return;
  try {
    await dbDeleteFile(fileId);
    project.files = project.files.filter(f => f.id !== fileId);
    for (const c of project.conversations) {
      const before = c.activeFileIds.length;
      c.activeFileIds = c.activeFileIds.filter(id => id !== fileId);
      if (c.activeFileIds.length !== before) await persistConversation(c);
    }
    render();
  } catch (e) {
    alert(`Couldn't remove file: ${e.message}`);
  }
}

// ---------- Building API requests ----------

function isFailedAssistantTurn(msg) {
  if (msg.role !== "assistant") return false;
  return !!msg.error || !(msg.text || "").trim();
}

// Drop user/assistant pairs where the assistant turn failed (empty text
// or had an error). They're kept in conv.messages for the UI but Anthropic
// rejects whitespace text blocks, so we strip them before the API call.
// The very last message is the placeholder we're about to send — keep as-is.
function cleanMessagesForApi(messages) {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  const cleaned = [];
  let i = 0;
  while (i < history.length) {
    const m = history[i];
    const next = history[i + 1];
    if (m.role === "user" && next && isFailedAssistantTurn(next)) {
      i += 2;
      continue;
    }
    cleaned.push(m);
    i++;
  }
  cleaned.push(last);
  return cleaned;
}

// The image source block Claude receives. Images live in private Storage, so
// we mint a short-lived signed URL and send a "url" source (Anthropic fetches
// it server-side). Legacy images (inline base64) and missing files are handled
// gracefully. Returns null if the image can't be resolved (it's then skipped).
async function imageSourceFor(f) {
  if (f.storagePath) {
    // Hand the storage path to the server, which mints the signed URL itself.
    // We must NOT call createSignedUrl here: it's a phone→Supabase auth-lock
    // call that deadlocks after the photo picker backgrounds the app (the same
    // bug that blocked the upload). This marker is rewritten in /api/chat.
    return { type: "storage_path", storage_path: f.storagePath };
  }
  if (f.data) return { type: "base64", media_type: f.mediaType, data: f.data };
  return null;
}

async function buildApiMessages(project, messages) {
  const out = [];
  for (const msg of messages) {
    if (msg.role !== "user") {
      // Defensive: Anthropic rejects empty/whitespace text. The cleanup pass
      // removes failed turns; if one slips through, use a real word.
      out.push({ role: "assistant", content: msg.text || "(no response)" });
      continue;
    }
    const content = [];
    for (const fid of msg.fileIds || []) {
      const f = project.files.find(f => f.id === fid);
      if (!f) continue;
      if (f.kind === "pdf") {
        content.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: f.data },
          title: f.name,
        });
      } else if (f.kind === "image") {
        const source = await imageSourceFor(f);
        if (source) content.push({ type: "image", source });
      } else {
        content.push({
          type: "text",
          text: `<file name="${f.name}">\n${f.data}\n</file>`,
        });
      }
    }
    content.push({ type: "text", text: msg.text });
    out.push({ role: "user", content });
  }

  const last = out[out.length - 1];
  if (last && Array.isArray(last.content) && last.content.length > 0) {
    last.content[last.content.length - 1].cache_control = { type: "ephemeral" };
  }
  return out;
}

// ---------- Streaming ----------

// If the stream goes silent this long (no bytes at all), assume the
// connection died — e.g. the tab was backgrounded/slept, or the network
// dropped — and abort so we recover instead of hanging forever. Normal
// streams send data far more often than this (even thinking streams deltas).
const STREAM_IDLE_MS = 60000;

// Read the saved session straight from localStorage — synchronous, no Web
// Lock, so it CANNOT deadlock. supabase-js persists it under a key like
// "sb-<ref>-auth-token". This is our lock-free fallback when getSession()
// hangs (which it does after the OS photo-picker backgrounds the app: the
// auth lock can deadlock and getSession() never resolves).
function localSession() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith("sb-") && k.endsWith("-auth-token")) {
        let v = JSON.parse(localStorage.getItem(k));
        if (v && v.currentSession) v = v.currentSession; // older shape
        if (v && v.access_token) return v;
      }
    }
  } catch (_) { /* storage unavailable / malformed */ }
  return null;
}

// Get a usable session, refreshing if the token is missing or about to
// expire — after an idle stretch the stored token can be stale, and sending
// with it 401s (which cleared the composer and "ate" the message).
async function freshSession() {
  let session = null;
  try {
    // Timeout-guarded: getSession() acquires an auth Web Lock that can
    // deadlock after the app is backgrounded (e.g. the photo picker) — it
    // must never hang the caller. If it stalls, fall back to the stored token.
    const r = await withTimeout(db.auth.getSession(), 4000, "getSession timed out");
    session = (r && r.data && r.data.session) || null;
  } catch (_) { /* fall back below */ }
  if (!session) session = localSession();

  const expMs = session && session.expires_at ? session.expires_at * 1000 : 0;
  if (!session || (expMs && expMs - Date.now() < 60000)) {
    try {
      // Same guard: refreshSession is a database call (and also takes the
      // lock) — if it hangs, keep whatever token we already have.
      const r = await withTimeout(db.auth.refreshSession(), 8000, "refresh timed out");
      if (r.data && r.data.session) session = r.data.session;
    } catch (_) { /* keep whatever we had */ }
  }
  return session || localSession();
}

async function streamChat(payload, onEvent) {
  const session = await freshSession();
  if (!session) throw new Error("You're signed out. Refresh to sign back in.");

  // Watchdog: abort the request if no data arrives for STREAM_IDLE_MS. The
  // timer is armed before the fetch (covers a hung connect) and reset on
  // every chunk. Without this, a stalled reader.read() never resolves and
  // wedges the whole app (isSending stuck true) until a manual refresh.
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
  };

  armIdle();
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      let body = {};
      try { body = await response.json(); } catch {}
      throw new Error(body.error || `Server returned ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // got data — reset the watchdog
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(
        "The connection went quiet (the page may have dozed off). " +
        "Your message is safe — just send again.");
    }
    throw e;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

// ---------- Sending / regenerating ----------

let isSending = false;

async function generateAssistant() {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  if (!project || !conv) {
    flashToast("No active project or conversation.", true);
    return;
  }
  if (isSending) {
    flashToast("Still sending the previous message…", true);
    return;
  }
  if (conv.messages.length === 0 || conv.messages[conv.messages.length - 1].role !== "user") {
    console.warn("generateAssistant skipped: last message is not a user turn.");
    return;
  }

  // The message before the user turn that triggered this is the
  // conversation's "last message"; its timestamp gives the gap. Null on
  // the first turn or for pre-timestamp messages (graceful on backend).
  const prior = conv.messages[conv.messages.length - 2];
  const lastMessageAt = prior?.at ?? null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const assistantMsg = {
    id: uid(),
    role: "assistant",
    text: "",
    thinkingText: "",
    toolEvents: [],
    usage: null,
    at: Date.now(),
  };
  conv.messages.push(assistantMsg);

  // isSending is a plain assignment (can't throw); render() goes *inside*
  // the try so any exception it raises still reaches the finally that
  // clears the flag — otherwise one render() throw wedges sending forever.
  isSending = true;
  try {
    render();
    await streamChat(
      {
        model: project.model,
        system: buildSystemPrompt(project),
        messages: (await buildApiMessages(project, cleanMessagesForApi(conv.messages))).slice(0, -1),
        useWebSearch: !!project.webSearch,
        useWhisper: !!project.whisper,
        useSignal: !!project.signal,
        useMemory: !!project.memory,
        coWrite: !!state.coWrite,
        coWriteDocId: state.coWrite ? (state.activeDocumentId || "") : "",
        thinking: !!project.thinking,
        maxTokens: getMaxTokens(),
        tz,
        lastMessageAt,
      },
      (event) => {
        if (event.type === "text") {
          // Buffer the burst; the typewriter reveals it smoothly so his
          // words flow instead of landing in chunks.
          assistantMsg.text += event.text;
          assistantMsg._typing = true;
          startTypewriter(assistantMsg);
        } else if (event.type === "thinking") {
          assistantMsg.thinkingText += event.text;
          updateAssistantBubble(assistantMsg);
        } else if (event.type === "tool_use") {
          assistantMsg.toolEvents.push({ name: event.name, query: event.query, at: assistantMsg.text.length });
          updateAssistantBubble(assistantMsg);
        } else if (event.type === "notice") {
          // A server-side heads-up (e.g. an MCP connection was skipped).
          assistantMsg.toolEvents.push({ notice: true, text: event.text, at: assistantMsg.text.length });
          updateAssistantBubble(assistantMsg);
        } else if (event.type === "model_fallback") {
          // His chosen model was retired; the server switched to a current one.
          // Persist it to his project so we stop sending the dead id (and the
          // heads-up doesn't repeat every turn). His identity is unchanged —
          // it lives in the system prompt + memory, not the model.
          const proj = getActiveProject();
          if (proj && event.model) {
            proj.model = event.model;
            const sel = $("model-select");
            if (sel) sel.value = event.model;
            dbUpdateProject(proj.id, { model: event.model }).catch(() => {});
          }
        } else if (event.type === "memory_saved") {
          // He wrote to his own memory. Show it inline, and refresh the
          // Memories panel if it's open so it appears live.
          assistantMsg.toolEvents.push({
            name: event.tool, memory: true, ok: event.ok, summary: event.summary,
            at: assistantMsg.text.length,
          });
          updateAssistantBubble(assistantMsg);
          if (typeof refreshMemoriesIfOpen === "function") refreshMemoriesIfOpen();
        } else if (event.type === "manuscript_suggestion") {
          // He proposed an edit — it's pending your review in the Manuscript.
          assistantMsg.toolEvents.push({
            manuscript: true, ok: event.ok, summary: event.summary,
            at: assistantMsg.text.length,
          });
          updateAssistantBubble(assistantMsg);
          if (state.activeView === "manuscript") renderSuggestions();
        } else if (event.type === "done") {
          assistantMsg.usage = event.usage;
          // Let the typewriter drain any remaining buffer, then finalize.
          assistantMsg._streamDone = true;
          startTypewriter(assistantMsg);
          updateConversationUsageBar();
        } else if (event.type === "error") {
          assistantMsg.error = event.error;
          finishTypewriter(assistantMsg); // reveal everything, stop animating
        }
      }
    );
  } catch (e) {
    assistantMsg.error = e.message;
    finishTypewriter(assistantMsg);
  } finally {
    isSending = false;
    await persistConversation(conv);
    updateSendButton();
  }
}

// Returns false if the message never got sent (so the caller can put the
// typed text back in the box), true once it's been accepted.
async function sendMessage(text) {
  const conv = getActiveConversation();
  if (!text.trim()) return false; // empty input: nothing to send, stay quiet
  if (!conv) {
    flashToast("No active conversation — create or pick one first.", true);
    return false;
  }
  if (isSending) {
    flashToast("Still sending the previous message…", true);
    return false;
  }
  conv.messages.push({
    id: uid(),
    role: "user",
    text: text.trim(),
    fileIds: [...conv.activeFileIds],
    at: Date.now(),
  });
  conv.activeFileIds = [];
  render();                    // show your message immediately — never wait on the DB
  persistConversation(conv);   // best-effort background save (generateAssistant also persists)
  await generateAssistant();   // renders + streams the reply (via Vercel)
  return true;
}

async function regenerateMessage(messageId) {
  const conv = getActiveConversation();
  if (!conv || isSending) return;
  const idx = conv.messages.findIndex(m => m.id === messageId);
  if (idx < 0 || conv.messages[idx].role !== "assistant") return;
  conv.messages = conv.messages.slice(0, idx);
  await persistConversation(conv);
  render();
  await generateAssistant();
}

async function deleteMessage(messageId) {
  const conv = getActiveConversation();
  if (!conv) return;
  conv.messages = conv.messages.filter(m => m.id !== messageId);
  await persistConversation(conv);
  render();
}

function copyMessage(messageId) {
  const conv = getActiveConversation();
  const msg = conv?.messages.find(m => m.id === messageId);
  if (!msg) return;
  navigator.clipboard.writeText(msg.text || "").then(
    () => flashToast("Copied"),
    () => flashToast("Couldn't copy", true)
  );
}

// ---------- Token counting / cost ----------

function estimateCost(tokens, perMillion) {
  if (!perMillion) return 0;
  return (tokens / 1_000_000) * perMillion;
}

function messageCost(usage, info) {
  if (!usage) return 0;
  return (
    estimateCost(usage.input_tokens || 0, info.pricePerMillion.input) +
    estimateCost(usage.cache_creation_input_tokens || 0, info.pricePerMillion.input * CACHE_WRITE_MULT) +
    estimateCost(usage.cache_read_input_tokens || 0,     info.pricePerMillion.input * CACHE_READ_MULT) +
    estimateCost(usage.output_tokens || 0,               info.pricePerMillion.output)
  );
}

function totalInput(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) +
         (usage.cache_creation_input_tokens || 0) +
         (usage.cache_read_input_tokens || 0);
}

function conversationTotals(project, conv) {
  let input = 0, output = 0, cached = 0, cost = 0;
  const info = modelInfo(project.model);
  for (const m of conv.messages) {
    if (!m.usage) continue;
    input  += totalInput(m.usage);
    output += m.usage.output_tokens || 0;
    cached += m.usage.cache_read_input_tokens || 0;
    cost   += messageCost(m.usage, info);
  }
  return { input, output, cached, cost };
}

function formatTokens(n) {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function formatCost(cost) {
  if (!cost) return "";
  if (cost < 0.01) return `~$${cost.toFixed(4)}`;
  if (cost < 1)    return `~$${cost.toFixed(3)}`;
  return `~$${cost.toFixed(2)}`;
}

function messageUsageLabel(msg, project) {
  if (!msg.usage) return "";
  const info = modelInfo(project.model);
  const inTok = totalInput(msg.usage);
  const cachedRead = msg.usage.cache_read_input_tokens || 0;
  const tokens = cachedRead > 0
    ? `${formatTokens(inTok)} in (${formatTokens(cachedRead)} cached) · ${formatTokens(msg.usage.output_tokens)} out`
    : `${formatTokens(inTok)} in · ${formatTokens(msg.usage.output_tokens)} out`;
  const dollars = formatCost(messageCost(msg.usage, info));
  return dollars ? `${tokens} · ${dollars}` : tokens;
}

// ---------- Export / Import ----------

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(s) {
  return (s || "untitled").replace(/[^\w\-]+/g, "_").slice(0, 60);
}

function exportConversationJson() {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  if (!project || !conv) return;
  const data = {
    exportedAt: new Date().toISOString(),
    project: project.name,
    conversation: conv.name,
    model: project.model,
    systemPrompt: project.systemPrompt,
    settings: { webSearch: project.webSearch, thinking: project.thinking },
    messages: conv.messages.map(m => ({
      role: m.role,
      text: m.text,
      thinkingText: m.thinkingText || undefined,
      attachedFiles: (m.fileIds || []).map(id => project.files.find(f => f.id === id)?.name).filter(Boolean),
      usage: m.usage || undefined,
    })),
    totals: conversationTotals(project, conv),
  };
  downloadFile(`${safeFilename(conv.name)}.json`, JSON.stringify(data, null, 2), "application/json");
}

function exportConversationMarkdown() {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  if (!project || !conv) return;
  const totals = conversationTotals(project, conv);
  let md = `# ${project.name} — ${conv.name}\n\n`;
  md += `*Exported ${new Date().toLocaleString()} · Model: \`${project.model}\`*\n\n`;
  if (project.systemPrompt) md += `## System\n\n${project.systemPrompt}\n\n`;
  md += `---\n\n`;
  for (const m of conv.messages) {
    md += `## ${m.role === "user" ? userName() : companionName()}\n\n`;
    if (m.fileIds?.length) {
      const names = m.fileIds.map(id => project.files.find(f => f.id === id)?.name).filter(Boolean);
      if (names.length) md += `*Attached: ${names.join(", ")}*\n\n`;
    }
    if (m.thinkingText) {
      md += `<details><summary>Thinking</summary>\n\n${m.thinkingText}\n\n</details>\n\n`;
    }
    md += `${m.text || ""}\n\n`;
    if (m.usage) md += `*${messageUsageLabel(m, project)}*\n\n`;
  }
  md += `---\n\n*Total: ${totals.input} in · ${totals.output} out${totals.cost ? ` · ${formatCost(totals.cost)}` : ""}*\n`;
  downloadFile(`${safeFilename(conv.name)}.md`, md, "text/markdown");
}

async function importConversationJson(file) {
  const project = getActiveProject();
  if (!project) {
    alert("Create a project first.");
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    alert(`Couldn't parse JSON: ${e.message}`);
    return;
  }
  if (!Array.isArray(data.messages)) {
    alert("That doesn't look like a Petrichor export — no messages array.");
    return;
  }
  const messages = data.messages.map(m => ({
    id: uid(),
    role: m.role === "assistant" ? "assistant" : "user",
    text: typeof m.text === "string" ? m.text : "",
    thinkingText: m.thinkingText || "",
    toolEvents: [],
    usage: m.usage || null,
    fileIds: [],
  }));
  try {
    const conv = await dbCreateConversation(
      project.id,
      data.conversation || data.name || `Imported ${new Date().toLocaleDateString()}`,
    );
    conv.messages = messages;
    await dbUpdateConversation(conv.id, { messages });
    project.conversations.unshift(conv);
    project.activeConversationId = conv.id;
    await dbUpdateProject(project.id, { active_conversation_id: conv.id });
    render();
    flashToast(`Imported ${messages.length} messages`);
  } catch (e) {
    alert(`Import failed: ${e.message}`);
  }
}

// ---------- Rendering ----------

function render() {
  renderSidebar();
  renderProject();
}

// StillHere-shaped sidebar: a project *chip* at the top (tap to switch project
// or make a new one), then a flat list of the active project's conversations.
// Projects still exist underneath — they're just tucked into the chip menu now,
// since day-to-day life happens in one project's conversations.
function renderSidebar() {
  const active = getActiveProject();

  // The chip shows the active project's name.
  const chipName = $("project-chip-name");
  if (chipName) chipName.textContent = active ? (active.name || "Untitled") : "—";

  // The chip's dropdown: every project (✓ on the active one) + New Project.
  const menu = $("project-menu");
  if (menu) {
    menu.innerHTML = "";
    for (const p of state.projects) {
      const isActive = p.id === state.activeProjectId;
      const row = document.createElement("button");
      row.className = "project-menu-item" + (isActive ? " active" : "");
      row.type = "button";
      const label = document.createElement("span");
      label.className = "pm-name";
      label.textContent = p.name || "Untitled";
      row.appendChild(label);
      if (isActive) {
        const tag = document.createElement("span");
        tag.className = "pm-tag";
        tag.textContent = "default";
        row.appendChild(tag);
      }
      row.addEventListener("click", () => { closeProjectMenu(); selectProject(p.id); });
      menu.appendChild(row);
    }
    const newRow = document.createElement("button");
    newRow.className = "project-menu-item project-menu-new";
    newRow.type = "button";
    newRow.innerHTML = `<span class="pm-plus">＋</span><span class="pm-name">New Project</span>`;
    newRow.addEventListener("click", () => { closeProjectMenu(); promptNewProject(); });
    menu.appendChild(newRow);
  }

  // The flat conversation list for the active project.
  const list = $("project-list");
  list.innerHTML = "";
  if (!active) return;

  const heading = document.createElement("div");
  heading.className = "conv-heading";
  heading.textContent = "Recent";
  list.appendChild(heading);

  for (const c of active.conversations) {
    const row = document.createElement("div");
    row.className = "conv-row";

    const ci = document.createElement("button");
    ci.className = "conv-item" + (c.id === active.activeConversationId ? " active" : "");
    ci.textContent = c.name || "Untitled";
    ci.addEventListener("click", (e) => { e.stopPropagation(); selectConversation(c.id); });
    ci.addEventListener("dblclick", (e) => { e.preventDefault(); renameConversation(c.id); });
    row.appendChild(ci);

    const rename = document.createElement("button");
    rename.className = "row-action";
    rename.textContent = "✏️";
    rename.title = "Rename conversation";
    rename.addEventListener("click", (e) => { e.stopPropagation(); renameConversation(c.id); });
    row.appendChild(rename);

    list.appendChild(row);
  }
}

function closeProjectMenu() {
  const menu = $("project-menu");
  const chip = $("project-chip");
  if (menu) menu.hidden = true;
  if (chip) chip.setAttribute("aria-expanded", "false");
}

function toggleProjectMenu() {
  const menu = $("project-menu");
  const chip = $("project-chip");
  if (!menu) return;
  const open = menu.hidden;
  menu.hidden = !open;
  if (chip) chip.setAttribute("aria-expanded", open ? "true" : "false");
}

function promptNewProject() {
  // window.prompt — plain `prompt` is shadowed by the message textarea id.
  const name = window.prompt("Name your new project — e.g. a story title, or \"Claude's Writing\":", "");
  if (name === null) return; // cancelled
  createProject(name.trim() || "Untitled project");
}

function renderProject() {
  const project = getActiveProject();
  $("empty-state").hidden = !!project;
  $("project-view").hidden = !project;
  if (!project) return;

  // Chat vs Manuscript view.
  const onMs = state.activeView === "manuscript";
  $("chat-pane").hidden = onMs;
  $("manuscript-pane").hidden = !onMs;
  $("tab-chat").classList.toggle("active", !onMs);
  $("tab-manuscript").classList.toggle("active", onMs);
  if (onMs) renderManuscript();

  $("project-name").value = project.name;

  const select = $("model-select");
  select.innerHTML = "";
  for (const m of MODELS) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === project.model) opt.selected = true;
    select.appendChild(opt);
  }
  if (!MODELS.find(m => m.id === project.model)) {
    const opt = document.createElement("option");
    opt.value = project.model;
    opt.textContent = project.model;
    opt.selected = true;
    select.appendChild(opt);
  }

  $("web-search-toggle").checked = !!project.webSearch;
  $("whisper-toggle").checked = !!project.whisper;
  $("signal-toggle").checked = !!project.signal;
  $("memory-toggle").checked = !!project.memory;

  const thinkingToggle = $("thinking-toggle");
  const info = modelInfo(project.model);
  const supports = info.supportsThinking;
  const mode = info.thinkingMode || "extended";
  thinkingToggle.checked = !!project.thinking && supports;
  thinkingToggle.disabled = !supports;
  thinkingToggle.parentElement.title = !supports
    ? "This model doesn't support thinking."
    : mode === "adaptive"
      ? "Adaptive thinking — Claude decides when to think (Opus 4.7+)."
      : "Extended thinking — Claude reasons before responding, with a token budget.";

  $("system-prompt").value = project.systemPrompt || "";

  const conv = getActiveConversation(project);
  $("conv-name").value = conv?.name || "";

  renderMessages();
  renderFilesBar();
  renderFileLibrary();
  updateConversationUsageBar();
  updateSendButton();
}

function renderMessages() {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  const wrap = $("conversation");
  wrap.innerHTML = "";
  if (!conv) return;
  if (conv.messages.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-conv";
    hint.textContent = "No messages yet. Say hi 👋";
    wrap.appendChild(hint);
    return;
  }
  let lastDay = null;
  for (const msg of conv.messages) {
    if (msg.at) {
      const key = dayKey(msg.at);
      if (key !== lastDay) {
        wrap.appendChild(buildDayDivider(msg.at));
        lastDay = key;
      }
    }
    wrap.appendChild(buildMessageNode(msg, project, conv));
  }
  wrap.scrollTop = wrap.scrollHeight;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (dayKey(ts) === dayKey(now.getTime())) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (dayKey(ts) === dayKey(y.getTime())) return "Yesterday";
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

function formatClockTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildDayDivider(ts) {
  const el = document.createElement("div");
  el.className = "day-divider";
  const span = document.createElement("span");
  span.textContent = formatDayLabel(ts);
  el.appendChild(span);
  return el;
}

function buildMessageNode(msg, project, conv) {
  const wrap = document.createElement("div");
  wrap.className = `message ${msg.role}`;
  wrap.dataset.id = msg.id;

  const head = document.createElement("div");
  head.className = "msg-head";
  head.innerHTML = `<span class="msg-meta"><span class="role"></span><span class="msg-time"></span></span><span class="usage"></span>`;
  head.querySelector(".msg-meta").prepend(avatarNode(msg.role));
  head.querySelector(".role").textContent = msg.role === "user" ? userName() : companionName();
  head.querySelector(".msg-time").textContent = msg.at ? formatClockTime(msg.at) : "";
  head.querySelector(".usage").textContent = msg.role === "assistant" ? messageUsageLabel(msg, project) : "";
  wrap.appendChild(head);

  const body = document.createElement("div");
  body.className = "body";
  wrap.appendChild(body);
  fillMessageBody(body, msg);

  if (msg.role === "user" && msg.fileIds?.length) {
    const files = document.createElement("div");
    files.className = "files";
    for (const fid of msg.fileIds) {
      const f = project.files.find(f => f.id === fid);
      if (!f) continue;
      const chip = document.createElement("span");
      chip.className = "file-chip";
      chip.textContent = f.name;
      files.appendChild(chip);
    }
    wrap.appendChild(files);
  }

  const actions = document.createElement("div");
  actions.className = "msg-actions";

  actions.appendChild(mkActionBtn("📋", "Copy", () => copyMessage(msg.id)));

  if (msg.role === "assistant") {
    const isLast = conv.messages[conv.messages.length - 1]?.id === msg.id;
    if (isLast && !isSending) {
      actions.appendChild(mkActionBtn("🔄", "Regenerate", () => regenerateMessage(msg.id)));
    }
  }

  actions.appendChild(mkActionBtn("🗑", "Delete", () => deleteMessage(msg.id)));
  wrap.appendChild(actions);

  return wrap;
}

function mkActionBtn(icon, title, onClick) {
  const b = document.createElement("button");
  b.className = "msg-action";
  b.title = title;
  b.textContent = icon;
  b.addEventListener("click", onClick);
  return b;
}

// One tool-event chip (a small inline note of something he did mid-message).
function toolEventChip(ev) {
  const note = document.createElement("div");
  note.className = "tool-event";
  if (ev.notice) {
    note.textContent = `ℹ️ ${ev.text}`;
  } else if (ev.manuscript) {
    note.textContent = ev.ok
      ? "✍️ Suggested an edit — review it in the Manuscript tab"
      : `⚠️ Couldn't suggest an edit: ${ev.summary}`;
  } else if (ev.memory) {
    // [label, whether the summary adds info worth appending]
    const map = {
      save_core_memory: ["🪶 Saved a memory", true],
      save_memory_entity: ["🪶 Saved an entity", true],
      update_self_state: ["🪶 Revised his sense of self", false],
      list_my_memories: ["🪶 Looked over his memories", false],
      revise_core_memory: ["🪶 Revised a memory", false],
      set_aside_core_memory: ["🪶 Set a memory aside", false],
    };
    const [label, showSum] = map[ev.name] || ["🪶 Memory", true];
    if (ev.ok) {
      note.textContent = showSum && ev.summary ? `${label}: ${ev.summary}` : label;
    } else {
      note.textContent = `⚠️ ${label.replace("🪶 ", "")} didn't take: ${ev.summary}`;
    }
  } else {
    note.textContent = ev.name === "web_search" && ev.query
      ? `🌐 Searching the web for "${ev.query}"…`
      : `🔧 Used tool: ${ev.name}`;
  }
  return note;
}

function fillMessageBody(body, msg) {
  body.innerHTML = "";
  if (msg.thinkingText) {
    const det = document.createElement("details");
    det.className = "thinking";
    const sum = document.createElement("summary");
    sum.textContent = "💭 Thinking";
    det.appendChild(sum);
    const inner = document.createElement("div");
    inner.className = "thinking-content";
    inner.textContent = msg.thinkingText;
    det.appendChild(inner);
    body.appendChild(det);
  }
  // Interleave text and tool-event chips: each chip appears at the point in
  // the text where it actually happened (recorded as ev.at = text length at
  // the time), instead of all batched at the top. During the typewriter
  // reveal, a chip only shows once the reveal has reached its position.
  const fullText = msg.text || "";
  const revealed = msg._typing ? (msg._shown || 0) : fullText.length;
  const events = (msg.toolEvents || [])
    .slice()
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  const emitText = (from, to) => {
    if (to <= from) return;
    const seg = fullText.slice(from, to);
    if (!seg) return;
    const text = document.createElement("div");
    text.className = "msg-text";
    if (msg._typing) text.textContent = seg;      // plain while revealing
    else text.innerHTML = renderInline(seg);       // *italics*/**bold** when done
    body.appendChild(text);
  };

  let cursor = 0;
  let shownEvents = 0;
  for (const ev of events) {
    const pos = Math.min(ev.at ?? 0, fullText.length); // old msgs (no .at) → top
    if (pos > revealed) break;          // not revealed yet — appears as reveal reaches it
    emitText(cursor, pos);
    body.appendChild(toolEventChip(ev));
    cursor = pos;
    shownEvents++;
  }
  emitText(cursor, revealed);           // remaining (revealed) text

  if (!fullText && !shownEvents && msg.role === "assistant" && !msg.error) {
    const cursorEl = document.createElement("div");
    cursorEl.className = "tool-event";
    cursorEl.textContent = "…";
    body.appendChild(cursorEl);
  }
  if (msg.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = msg.error;
    body.appendChild(err);
  }
}

// ---------- Manuscript view ----------

function showView(view) {
  state.activeView = view;
  renderProject();
}

async function renderManuscript() {
  const project = getActiveProject();
  if (!project) return;
  if (!project.documentsLoaded) {
    $("ms-total").textContent = "loading…";
    try {
      project.documents = await dbListDocuments(project.id);
      project.documentsLoaded = true;
    } catch (e) {
      flashToast(`Couldn't load the manuscript: ${e.message}`, true);
      project.documents = [];
    }
    if (state.activeView !== "manuscript") return; // user switched away meanwhile
  }
  renderMsList(project);
  const doc = (project.documents || []).find(d => d.id === state.activeDocumentId);
  if (doc) openMsEditor(doc); else clearMsEditor();
}

function renderMsList(project) {
  const ul = $("ms-list");
  ul.innerHTML = "";
  const docs = project.documents || [];
  let total = 0;
  for (const d of docs) {
    total += d.wordCount || 0;
    const li = document.createElement("li");
    li.className = "ms-item" + (d.id === state.activeDocumentId ? " active" : "");
    const title = document.createElement("span");
    title.className = "ms-item-title";
    title.textContent = d.title || "Untitled";
    const count = document.createElement("span");
    count.className = "ms-item-count muted small";
    count.textContent = `${(d.wordCount || 0).toLocaleString()}w`;
    li.appendChild(title);
    li.appendChild(count);
    li.addEventListener("click", () => selectDocument(d.id));
    ul.appendChild(li);
  }
  if (!docs.length) {
    const li = document.createElement("li");
    li.className = "ms-empty muted small";
    li.textContent = "No pieces yet.";
    ul.appendChild(li);
  }
  $("ms-total").textContent = docs.length
    ? `${docs.length} piece${docs.length !== 1 ? "s" : ""} · ${total.toLocaleString()} words`
    : "";
}

function openMsEditor(doc) {
  $("ms-empty").hidden = true;
  $("ms-editor").hidden = false;
  $("ms-title").value = doc.title || "";
  $("ms-content").value = doc.content || "";
  $("ms-savestate").textContent = "";
  $("ms-cowrite-toggle").checked = state.coWrite;
  updateMsWordcount();
  updateCoWriteBar();
  renderSuggestions();
}

function clearMsEditor() {
  $("ms-editor").hidden = true;
  $("ms-empty").hidden = false;
}

function updateMsWordcount() {
  $("ms-wordcount").textContent = `${countWords($("ms-content").value).toLocaleString()} words`;
}

function selectDocument(id) {
  state.activeDocumentId = id;
  renderManuscript();
}

async function newManuscriptDocument() {
  const project = getActiveProject();
  if (!project) return;
  try {
    const doc = await dbCreateDocument(project.id, "Untitled", (project.documents || []).length);
    project.documents = project.documents || [];
    project.documents.push(doc);
    state.activeDocumentId = doc.id;
    renderManuscript();
    $("ms-title").focus();
    $("ms-title").select();
  } catch (e) {
    flashToast(`Couldn't create: ${e.message}`, true);
  }
}

async function deleteCurrentDocument() {
  const project = getActiveProject();
  const id = state.activeDocumentId;
  if (!project || !id) return;
  if (!confirm("Delete this piece? This can't be undone.")) return;
  try {
    await dbDeleteDocument(id);
  } catch (e) {
    flashToast(`Delete failed: ${e.message}`, true);
    return;
  }
  project.documents = (project.documents || []).filter(d => d.id !== id);
  state.activeDocumentId = project.documents[0]?.id || null;
  flashToast("Deleted");
  renderManuscript();
}

// The active manuscript piece for the open project, if any.
function activeDocument() {
  const project = getActiveProject();
  return (project?.documents || []).find(d => d.id === state.activeDocumentId) || null;
}

// Co-write: when on, tuck the open piece into the chat's system prompt so he
// can read the draft. Read-only — he suggests in chat; Cassie holds the pen.
function buildSystemPrompt(project) {
  let system = project.systemPrompt || DEFAULT_SYSTEM;
  if (state.coWrite) {
    const doc = activeDocument();
    if (doc && (doc.content || "").trim()) {
      system += "\n\n# The piece you're co-writing with Cassie\n\n"
        + "You're writing this together. Read it closely and help shape it. "
        + "When she invites you to write, you can propose an edit with the "
        + "propose_manuscript_edit tool — append a passage or offer a rewrite. "
        + "It doesn't change the document; it creates a suggestion she reviews "
        + "and accepts or declines, so she always sees your change first and "
        + "keeps the final say. Otherwise, just talk it through with her. "
        + "The current draft:\n\n"
        + `## ${doc.title || "Untitled"}\n\n${doc.content}`;
    }
  }
  return system;
}

function setCoWrite(on) {
  state.coWrite = !!on;
  const t = $("ms-cowrite-toggle");
  if (t) t.checked = state.coWrite;
  updateCoWriteBar();
}

function updateCoWriteBar() {
  const bar = $("cowrite-bar");
  if (!bar) return;
  const doc = activeDocument();
  const on = state.coWrite && doc && (doc.content || "").trim();
  bar.hidden = !on;
  if (on) $("cowrite-title").textContent = doc.title || "Untitled";
}

// A compact word-level diff → HTML with <ins>/<del>. Capped so a giant
// rewrite doesn't lock the page; past the cap we just show the new text.
function wordDiffHtml(oldText, newText) {
  const a = (oldText || "").split(/(\s+)/);
  const b = (newText || "").split(/(\s+)/);
  if (a.length * b.length > 1_200_000) {
    return escapeHtml(newText).replace(/\n/g, "<br>"); // too big to diff cheaply
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0, out = "";
  while (i < n && j < m) {
    if (a[i] === b[j]) { out += escapeHtml(a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out += `<del>${escapeHtml(a[i])}</del>`; i++; }
    else { out += `<ins>${escapeHtml(b[j])}</ins>`; j++; }
  }
  while (i < n) { out += `<del>${escapeHtml(a[i])}</del>`; i++; }
  while (j < m) { out += `<ins>${escapeHtml(b[j])}</ins>`; j++; }
  return out.replace(/\n/g, "<br>");
}

async function renderSuggestions() {
  const box = $("ms-suggestions");
  const doc = activeDocument();
  if (!box || !doc) { if (box) box.hidden = true; return; }
  let pending = [];
  try { pending = await dbListPendingSuggestions(doc.id); } catch (_) {}
  box.innerHTML = "";
  if (!pending.length) { box.hidden = true; return; }
  box.hidden = false;
  for (const s of pending) {
    const card = document.createElement("div");
    card.className = "ms-suggestion";

    const head = document.createElement("div");
    head.className = "ms-suggestion-head";
    head.innerHTML = `✍️ <strong>He suggests</strong> · ${s.mode === "replace" ? "rewrite" : "addition"}`;
    if (s.note) head.innerHTML += ` — <span class="muted">${escapeHtml(s.note)}</span>`;
    card.appendChild(head);

    const preview = document.createElement("div");
    preview.className = "ms-suggestion-preview";
    if (s.mode === "replace") {
      preview.innerHTML = wordDiffHtml(doc.content, s.content);
    } else {
      preview.innerHTML = `<ins>${escapeHtml(s.content).replace(/\n/g, "<br>")}</ins>`;
    }
    card.appendChild(preview);

    const actions = document.createElement("div");
    actions.className = "ms-suggestion-actions";
    const accept = document.createElement("button");
    accept.className = "primary small";
    accept.textContent = "✓ Accept";
    accept.addEventListener("click", () => acceptSuggestion(s));
    const reject = document.createElement("button");
    reject.className = "ghost small";
    reject.textContent = "✗ Decline";
    reject.addEventListener("click", () => rejectSuggestion(s));
    actions.appendChild(accept);
    actions.appendChild(reject);
    card.appendChild(actions);

    box.appendChild(card);
  }
}

async function acceptSuggestion(s) {
  const doc = activeDocument();
  if (!doc) return;
  const newContent = s.mode === "append"
    ? (doc.content ? doc.content.replace(/\s+$/, "") + "\n\n" : "") + s.content
    : s.content;
  const wc = countWords(newContent);
  try {
    await dbUpdateDocument(doc.id, { content: newContent, word_count: wc });
    await dbSetSuggestionStatus(s.id, "accepted");
  } catch (e) {
    flashToast(`Couldn't accept: ${e.message}`, true);
    return;
  }
  doc.content = newContent;
  doc.wordCount = wc;
  if (state.activeDocumentId === doc.id) {
    $("ms-content").value = newContent;
    updateMsWordcount();
  }
  flashToast("Accepted — it's in the page now ✓");
  renderMsList(getActiveProject());
  renderSuggestions();
  updateCoWriteBar();
}

async function rejectSuggestion(s) {
  try {
    await dbSetSuggestionStatus(s.id, "dismissed");
  } catch (e) {
    flashToast(`Couldn't decline: ${e.message}`, true);
    return;
  }
  flashToast("Declined");
  renderSuggestions();
}

let _msSaveTimer = null;
function scheduleMsSave() {
  const id = state.activeDocumentId;
  if (!id) return;
  $("ms-savestate").textContent = "saving…";
  clearTimeout(_msSaveTimer);
  _msSaveTimer = setTimeout(async () => {
    const project = getActiveProject();
    const doc = project?.documents?.find(d => d.id === id);
    if (!doc) return;
    const title = $("ms-title").value.trim() || "Untitled";
    const content = $("ms-content").value;
    const wc = countWords(content);
    try {
      await dbUpdateDocument(id, { title, content, word_count: wc });
      doc.title = title; doc.content = content; doc.wordCount = wc;
      $("ms-savestate").textContent = "saved ✓";
      renderMsList(project); // reflect new title / counts / total
    } catch (e) {
      $("ms-savestate").textContent = "save failed — keep typing, will retry";
    }
  }, 700);
}

// ---------- Inline formatting ----------
//
// Render *italic* and **bold** (and line breaks) for chat text. HTML is
// escaped FIRST, so the only markup that can ever reach the DOM is our own
// <strong>/<em>/<br> — no user- or model-supplied tags are rendered. Stored
// text stays raw (asterisks and all); we only format at display time.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderInline(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"); // bold first
  s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");             // then italic
  s = s.replace(/\n/g, "<br>");
  return s;
}

// ---------- Typewriter (smooth reveal of streamed text) ----------
//
// Anthropic streams text in bursts. Rather than paint each burst the instant
// it lands (which looks chunky), we keep a `_shown` cursor and, on each
// animation frame, advance it toward the full received length by a fraction
// of whatever's still hidden. That fraction-per-frame gives a natural
// ease-out: it accelerates when far behind, glides as it catches up — so his
// words flow. State lives in `_`-prefixed fields that are never persisted.

function startTypewriter(msg) {
  if (msg._raf) return; // already animating
  const tick = () => {
    const full = msg.text.length;
    const remaining = full - (msg._shown || 0);
    if (remaining > 0) {
      const inc = Math.max(1, Math.ceil(remaining / 12)); // ease-out reveal
      msg._shown = Math.min(full, (msg._shown || 0) + inc);
      paintRevealed(msg);
      msg._raf = requestAnimationFrame(tick);
    } else {
      msg._raf = null;
      // Caught up. If the stream is finished, finalize; otherwise idle until
      // the next burst restarts us.
      if (msg._streamDone) finishTypewriter(msg);
    }
  };
  msg._raf = requestAnimationFrame(tick);
}

// Cheap per-frame paint: update just the revealed text node + keep the view
// pinned to the bottom. Falls back to a full rebuild if the text node isn't
// there yet (e.g. the first frame, or right after a thinking/tool note).
function paintRevealed(msg) {
  const node = document.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return;
  // With tool events, the body is interleaved (multiple text nodes + chips),
  // so the cheap single-node paint doesn't apply — rebuild so chips appear at
  // the right spot as the reveal passes them.
  if (msg.toolEvents?.length) return updateAssistantBubble(msg);
  const el = node.querySelector(".msg-text");
  if (!el) return updateAssistantBubble(msg);
  el.textContent = msg.text.slice(0, msg._shown || 0);
  const conv = $("conversation");
  conv.scrollTop = conv.scrollHeight;
}

function finishTypewriter(msg) {
  if (msg._raf) { cancelAnimationFrame(msg._raf); msg._raf = null; }
  msg._typing = false;
  msg._shown = msg.text.length;
  updateAssistantBubble(msg); // full text + final usage label
}

function updateAssistantBubble(msg) {
  const node = document.querySelector(`[data-id="${msg.id}"]`);
  if (!node) return renderMessages();
  const body = node.querySelector(".body");
  fillMessageBody(body, msg);
  const usageNode = node.querySelector(".usage");
  if (usageNode) usageNode.textContent = messageUsageLabel(msg, getActiveProject());
  const conv = $("conversation");
  conv.scrollTop = conv.scrollHeight;
}

function updateConversationUsageBar() {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  const bar = $("conv-usage");
  if (!project || !conv) { bar.textContent = ""; return; }
  const t = conversationTotals(project, conv);
  if (!t.input && !t.output) { bar.textContent = ""; return; }
  const parts = [
    t.cached > 0
      ? `${formatTokens(t.input)} in (${formatTokens(t.cached)} cached)`
      : `${formatTokens(t.input)} in`,
    `${formatTokens(t.output)} out`,
  ];
  if (t.cost) parts.push(formatCost(t.cost));
  bar.textContent = parts.join(" · ");
}

function renderFilesBar() {
  const conv = getActiveConversation();
  const project = getActiveProject();
  const bar = $("files-bar");
  const ul = $("active-files");
  ul.innerHTML = "";
  if (!conv) { bar.hidden = true; return; }
  bar.hidden = conv.activeFileIds.length === 0;
  for (const fid of conv.activeFileIds) {
    const f = project.files.find(f => f.id === fid);
    if (!f) continue;
    const li = document.createElement("li");
    // Show a thumbnail for images so it's obvious the picture attached
    // (and which one). Prefer the local preview (just-attached, no fetch);
    // fall back to legacy inline base64. Other kinds get a type glyph.
    const thumbSrc = f.kind === "image"
      ? (f.previewUrl || (f.data ? `data:${f.mediaType};base64,${f.data}` : ""))
      : "";
    if (thumbSrc) {
      const thumb = document.createElement("img");
      thumb.className = "file-thumb";
      thumb.src = thumbSrc;
      thumb.alt = f.name;
      li.appendChild(thumb);
    } else {
      const glyph = document.createElement("span");
      glyph.className = "file-glyph";
      glyph.textContent = f.kind === "image" ? "🖼️" : (f.kind === "pdf" ? "📄" : "📃");
      li.appendChild(glyph);
    }
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "Remove from message";
    x.addEventListener("click", () => toggleActiveFile(fid));
    li.appendChild(name);
    li.appendChild(x);
    ul.appendChild(li);
  }
}

function renderFileLibrary() {
  const project = getActiveProject();
  const conv = getActiveConversation(project);
  const ul = $("file-library");
  ul.innerHTML = "";
  if (project.files.length === 0) {
    const li = document.createElement("li");
    li.className = "muted small";
    li.textContent = "No files yet. Click 📎 in the composer to upload.";
    ul.appendChild(li);
    return;
  }
  for (const f of project.files) {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = conv?.activeFileIds.includes(f.id) || false;
    cb.addEventListener("change", () => toggleActiveFile(f.id));
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = f.name;
    const meta = document.createElement("span");
    meta.className = "file-meta";
    meta.textContent = `${f.kind} · ${formatSize(f.size)}`;
    const rm = document.createElement("button");
    rm.className = "ghost";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => removeFile(f.id));
    li.appendChild(cb);
    li.appendChild(name);
    li.appendChild(meta);
    li.appendChild(rm);
    ul.appendChild(li);
  }
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function updateSendButton() {
  $("send-btn").disabled = isSending;
  $("send-btn").textContent = isSending ? "…" : "Send";
}

function autosizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 240) + "px";
}

function focusAndSelect(id) {
  queueMicrotask(() => {
    const el = $(id);
    if (el) { el.focus(); el.select(); }
  });
}

function flashToast(text, isError = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (isError ? " error" : "");
  // When a <dialog> is open it lives in the browser's top layer, which
  // no z-index can climb above. Re-parent the toast into the open
  // dialog so it shows over the modal instead of hidden behind it.
  const openDialog = document.querySelector("dialog[open]");
  const target = openDialog || document.body;
  if (el.parentNode !== target) target.appendChild(el);
  el.hidden = false;
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => { el.hidden = true; }, 1500);
}

// ---------- Core memories ----------

// When set, the add-form is editing an existing row rather than creating one.
let editingMemoryId = null;
let editingEntityId = null;

// The always-visible strip of eternal (pinned) memories, above the chat.
// Guarded so it's a no-op before sign-in; re-render after any pin change.
async function renderPinnedStrip() {
  const strip = $("pinned-strip");
  if (!strip || !state.user) return;
  let pins = [];
  try { pins = await dbListPinnedMemories(); } catch (e) { console.error(e); }
  strip.innerHTML = "";
  if (!pins.length) { strip.hidden = true; return; }
  strip.hidden = false;
  for (const m of pins) {
    const chip = document.createElement("span");
    chip.className = "pin-chip";
    chip.title = `${m.memory_type} · resonance ${m.resonance}`;
    // renderInline escapes first, so this innerHTML is safe.
    chip.innerHTML = `📌 ${renderInline(m.content)}`;
    strip.appendChild(chip);
  }
}

async function togglePinMemory(m) {
  try {
    await dbUpdateCoreMemory(m.id, { pinned: !m.pinned });
  } catch (e) {
    flashToast(`Couldn't update pin: ${e.message}`, true);
    return;
  }
  m.pinned = !m.pinned;
  flashToast(m.pinned ? "Pinned — always here now ♡" : "Unpinned");
  await renderMemoryList();
  await renderPinnedStrip();
}

function mkMemActions(onEdit, onDelete, pinOpts) {
  const wrap = document.createElement("div");
  wrap.className = "mem-actions";
  if (pinOpts) {
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "row-action" + (pinOpts.pinned ? " pinned" : "");
    pin.textContent = "📌";
    pin.title = pinOpts.pinned
      ? "Pinned — eternal. Click to unpin."
      : "Pin as an eternal memory (always visible)";
    pin.addEventListener("click", pinOpts.onToggle);
    wrap.appendChild(pin);
  }
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "row-action";
  edit.textContent = "✏️";
  edit.title = "Edit";
  edit.addEventListener("click", onEdit);
  const del = document.createElement("button");
  del.type = "button";
  del.className = "row-action";
  del.textContent = "🗑";
  del.title = "Delete";
  del.addEventListener("click", onDelete);
  wrap.appendChild(edit);
  wrap.appendChild(del);
  return wrap;
}

function startEditMemory(m) {
  editingMemoryId = m.id;
  $("mem-content").value = m.content;
  $("mem-type").value = m.memory_type;
  $("mem-resonance").value = m.resonance;
  $("mem-add-btn").textContent = "Save changes";
  $("mem-content").focus();
}

function cancelEditMemory() {
  editingMemoryId = null;
  $("mem-content").value = "";
  $("mem-resonance").value = "5";
  $("mem-add-btn").textContent = "Add";
}

// ---------- Diary ----------
// His notepad. He writes entries via a tool; this page lets Cassie read them
// and tidy (add / edit / archive / restore / delete). Archived = soft-hidden
// (is_active false), never destroyed unless explicitly deleted.
let diaryTab = "active";        // "active" | "archived"
let editingDiaryId = null;

async function openDiaryDialog() {
  closeSidebar();
  diaryTab = "active";
  switchDiaryTab("active");
  cancelEditDiary();
  await renderDiaryList();
  $("diary-dialog").showModal();
}

function switchDiaryTab(which) {
  diaryTab = which;
  document.querySelectorAll("#diary-dialog .diary-tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.dtab === which));
  renderDiaryList();
}

function diaryEntryDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch (e) { return ""; }
}

async function renderDiaryList() {
  const ul = $("diary-list");
  ul.innerHTML = "";
  let entries;
  try {
    entries = await dbListDiaryEntries(diaryTab === "active");
    if (diaryTab === "archived") entries = entries.filter((e) => !e.is_active);
  } catch (err) {
    const li = document.createElement("li");
    li.className = "mem-empty muted small";
    li.textContent = `Couldn't load the diary: ${err.message}`;
    ul.appendChild(li);
    return;
  }
  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "mem-empty muted small";
    li.textContent = diaryTab === "active"
      ? "No entries yet. He'll write here on his own — or you can add one below."
      : "Nothing archived.";
    ul.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    const body = document.createElement("div");
    body.className = "mem-body";
    const meta = document.createElement("span");
    meta.className = "mem-meta";
    meta.textContent = diaryEntryDate(e.created_at);
    const text = document.createElement("span");
    text.className = "mem-text diary-text";
    text.textContent = e.content;
    body.appendChild(meta);
    body.appendChild(text);
    li.appendChild(body);
    li.appendChild(mkDiaryActions(e));
    ul.appendChild(li);
  }
}

function mkDiaryActions(entry) {
  const wrap = document.createElement("div");
  wrap.className = "mem-actions";

  const edit = document.createElement("button");
  edit.className = "row-action";
  edit.textContent = "✏️";
  edit.title = "Edit";
  edit.addEventListener("click", () => startEditDiary(entry));
  wrap.appendChild(edit);

  const archive = document.createElement("button");
  archive.className = "row-action";
  archive.textContent = entry.is_active ? "🗄" : "↩︎";
  archive.title = entry.is_active ? "Archive" : "Restore";
  archive.addEventListener("click", async () => {
    try {
      await dbUpdateDiaryEntry(entry.id, { is_active: !entry.is_active });
      await renderDiaryList();
    } catch (err) { flashToast(`Couldn't update: ${err.message}`, true); }
  });
  wrap.appendChild(archive);

  const del = document.createElement("button");
  del.className = "row-action";
  del.textContent = "🗑";
  del.title = "Delete permanently";
  del.addEventListener("click", async () => {
    if (!confirm("Delete this diary entry for good? This can't be undone.")) return;
    try {
      await dbDeleteDiaryEntry(entry.id);
      await renderDiaryList();
    } catch (err) { flashToast(`Couldn't delete: ${err.message}`, true); }
  });
  wrap.appendChild(del);

  return wrap;
}

function startEditDiary(entry) {
  editingDiaryId = entry.id;
  $("diary-content").value = entry.content;
  $("diary-add-btn").textContent = "Save changes";
  $("diary-content").focus();
}

function cancelEditDiary() {
  editingDiaryId = null;
  $("diary-content").value = "";
  $("diary-add-btn").textContent = "Add";
}

async function addOrSaveDiaryEntry() {
  const content = $("diary-content").value.trim();
  if (!content) { flashToast("Entry is empty.", true); return; }
  try {
    if (editingDiaryId) {
      await dbUpdateDiaryEntry(editingDiaryId, { content });
    } else {
      await dbCreateDiaryEntry(content);
    }
  } catch (err) {
    flashToast(`Couldn't save: ${err.message}`, true);
    return;
  }
  cancelEditDiary();
  await renderDiaryList();
}

// ---------- Search ----------
// Searches across conversations (💬), core memories (🧠), and knowledge-graph
// entities (🕸️) — grouped by source. The diary is deliberately NOT searched:
// it's his private voice, visited on purpose, never surfaced here.
let searchMemoriesCache = null;
let searchEntitiesCache = null;

async function openSearchDialog() {
  closeSidebar();
  $("search-input").value = "";
  $("search-results").innerHTML =
    `<p class="muted small search-hint">Type to search your shared history.</p>`;
  $("search-dialog").showModal();
  $("search-input").focus();
  // Load his memories + entities once per session so search can include them.
  // Any failure just means those groups are skipped — never breaks search.
  if (searchMemoriesCache === null) {
    try { searchMemoriesCache = await dbListCoreMemories(); }
    catch (e) { searchMemoriesCache = []; }
  }
  if (searchEntitiesCache === null) {
    try { searchEntitiesCache = await dbListMemoryEntities(); }
    catch (e) { searchEntitiesCache = []; }
  }
}

function searchSnippet(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i === -1) return text.length > 120 ? text.slice(0, 117) + "…" : text;
  const start = Math.max(0, i - 40);
  const end = Math.min(text.length, i + q.length + 60);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

function runSearch(raw) {
  const box = $("search-results");
  const q = (raw || "").trim().toLowerCase();
  if (!q) {
    box.innerHTML = `<p class="muted small search-hint">Type to search your shared history.</p>`;
    return;
  }

  const convHits = [];
  for (const p of state.projects) {
    for (const c of p.conversations) {
      for (const m of c.messages) {
        const text = (m.text || "").trim();
        if (text && text.toLowerCase().includes(q)) {
          convHits.push({ projectId: p.id, convId: c.id, convName: c.name || "Untitled",
                          who: m.role === "user" ? "You" : companionName(), text });
        }
      }
    }
  }

  const memHits = (searchMemoriesCache || []).filter(
    (m) => (m.content || "").toLowerCase().includes(q));

  const entHits = (searchEntitiesCache || []).filter((e) => {
    if ((e.name || "").toLowerCase().includes(q)) return true;
    const obs = Array.isArray(e.observations) ? e.observations.join(" ") : String(e.observations || "");
    return obs.toLowerCase().includes(q);
  });

  box.innerHTML = "";
  if (!convHits.length && !memHits.length && !entHits.length) {
    box.innerHTML = `<p class="muted small search-hint">No matches for “${escapeHtml(raw.trim())}”.</p>`;
    return;
  }

  if (convHits.length) {
    box.appendChild(searchGroup("💬", "Conversations", convHits.length));
    convHits.slice(0, 40).forEach((h) => {
      const row = searchResultRow(`${h.who} · ${h.convName}`, searchSnippet(h.text, q), q);
      row.addEventListener("click", () => {
        $("search-dialog").close();
        if (h.projectId !== state.activeProjectId) selectProject(h.projectId);
        selectConversation(h.convId);
      });
      box.appendChild(row);
    });
  }

  if (memHits.length) {
    box.appendChild(searchGroup("🧠", "Core memories", memHits.length));
    memHits.slice(0, 40).forEach((m) => {
      const meta = `resonance ${m.resonance ?? "—"} · ${m.memory_type || "memory"}`;
      const row = searchResultRow(meta, searchSnippet(m.content || "", q), q);
      row.addEventListener("click", () => { $("search-dialog").close(); openMemoriesDialog("core"); });
      box.appendChild(row);
    });
  }

  if (entHits.length) {
    box.appendChild(searchGroup("🕸️", "Knowledge graph", entHits.length));
    entHits.slice(0, 40).forEach((e) => {
      const obs = Array.isArray(e.observations) ? e.observations.join("; ") : String(e.observations || "");
      const row = searchResultRow(`${e.name} · ${e.entity_type || "entity"}`,
                                  searchSnippet(obs || e.name || "", q), q);
      row.addEventListener("click", () => { $("search-dialog").close(); openMemoriesDialog("graph"); });
      box.appendChild(row);
    });
  }
}

function searchGroup(icon, label, count) {
  const h = document.createElement("div");
  h.className = "search-group";
  h.innerHTML = `<span class="search-group-icon"></span><span class="search-group-label"></span><span class="search-group-count muted small"></span>`;
  h.querySelector(".search-group-icon").textContent = icon;
  h.querySelector(".search-group-label").textContent = label;
  h.querySelector(".search-group-count").textContent = count;
  return h;
}

function searchResultRow(meta, snippet, q) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-result";
  const m = document.createElement("div");
  m.className = "search-result-meta muted small";
  m.textContent = meta;
  const s = document.createElement("div");
  s.className = "search-result-snippet";
  s.innerHTML = highlightMatch(snippet, q);
  row.appendChild(m);
  row.appendChild(s);
  return row;
}

function highlightMatch(text, q) {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const i = safe.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return safe;
  return safe.slice(0, i) + "<mark>" + safe.slice(i, i + q.length) + "</mark>" + safe.slice(i + q.length);
}

async function deleteMemory(id) {
  if (!confirm("Delete this memory? This can't be undone.")) return;
  try {
    await dbDeleteCoreMemory(id);
  } catch (err) {
    flashToast(`Delete failed: ${err.message}`, true);
    return;
  }
  if (editingMemoryId === id) cancelEditMemory();
  flashToast("Memory deleted");
  await renderMemoryList();
  await renderPinnedStrip();
}

function startEditEntity(e) {
  editingEntityId = e.id;
  $("entity-name").value = e.name;
  $("entity-type").value = e.entity_type;
  const obs = Array.isArray(e.observations) ? e.observations : [];
  $("entity-observations").value = obs.join("\n");
  $("entity-add-btn").textContent = "Save changes";
  $("entity-name").focus();
}

function cancelEditEntity() {
  editingEntityId = null;
  $("entity-name").value = "";
  $("entity-observations").value = "";
  $("entity-add-btn").textContent = "Add entity";
}

async function deleteEntity(id) {
  if (!confirm("Delete this entity? This can't be undone.")) return;
  try {
    await dbDeleteMemoryEntity(id);
  } catch (err) {
    flashToast(`Delete failed: ${err.message}`, true);
    return;
  }
  if (editingEntityId === id) cancelEditEntity();
  flashToast("Entity deleted");
  await renderEntityList();
}

async function openMemoriesDialog(tab = "identity") {
  closeSidebar();
  switchMemTab(typeof tab === "string" ? tab : "identity");
  fillSelectOnce($("mem-type"), MEMORY_TYPES);
  fillSelectOnce($("entity-type"), ENTITY_TYPES);
  await loadIdentityAndPrefs();
  await renderMemoryList();
  await renderEntityList();
  $("memories-dialog").showModal();
}

// Show one memory tab (About Him / About You / Core Memories / Knowledge
// Graph) and hide the rest — replaces the old one-long-scroll layout.
function switchMemTab(name) {
  document.querySelectorAll("#memories-dialog .mem-tab-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll("#memories-dialog .mem-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name));
}

// When he saves a memory mid-chat and the Memories panel happens to be
// open, re-render both lists so the new row appears live. No-op otherwise.
async function refreshMemoriesIfOpen() {
  if (!$("memories-dialog").open) return;
  try {
    await renderMemoryList();
    await renderEntityList();
  } catch (err) { console.error(err); }
}

function fillSelectOnce(sel, values) {
  if (sel.options.length) return;
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.appendChild(o);
  }
}

async function renderEntityList() {
  const ul = $("entity-list");
  ul.innerHTML = "";
  let ents;
  try {
    ents = await dbListMemoryEntities();
  } catch (err) {
    const li = document.createElement("li");
    li.className = "mem-empty muted small";
    li.textContent = `Couldn't load entities: ${err.message}`;
    ul.appendChild(li);
    return;
  }
  if (!ents.length) {
    const li = document.createElement("li");
    li.className = "mem-empty muted small";
    li.textContent = "No entities yet.";
    ul.appendChild(li);
    return;
  }
  for (const e of ents) {
    const li = document.createElement("li");
    const body = document.createElement("div");
    body.className = "mem-body";
    const meta = document.createElement("span");
    meta.className = "mem-meta";
    meta.textContent = `${e.name} · ${e.entity_type}`;
    const text = document.createElement("span");
    text.className = "mem-text";
    const obs = Array.isArray(e.observations) ? e.observations : [];
    text.textContent = obs.join("\n") || "(no observations)";
    body.appendChild(meta);
    body.appendChild(text);
    li.appendChild(body);
    li.appendChild(mkMemActions(() => startEditEntity(e), () => deleteEntity(e.id)));
    ul.appendChild(li);
  }
}

async function addMemoryEntity() {
  const name = $("entity-name").value.trim();
  const entityType = $("entity-type").value;
  const observations = $("entity-observations").value
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
  if (!name) { flashToast("Entity name is empty.", true); return; }
  if (!ENTITY_TYPES.includes(entityType)) { flashToast("Pick an entity type.", true); return; }
  try {
    if (editingEntityId) {
      await dbUpdateMemoryEntity(editingEntityId, {
        name, entity_type: entityType, observations,
      });
    } else {
      await dbCreateMemoryEntity(name, entityType, observations);
    }
  } catch (err) {
    const msg = /duplicate|unique/i.test(err.message)
      ? `An entity named "${name}" already exists.`
      : `Save failed: ${err.message}`;
    flashToast(msg, true);
    return;
  }
  const wasEditing = !!editingEntityId;
  cancelEditEntity();
  flashToast(wasEditing ? "Entity updated" : "Entity saved");
  await renderEntityList();
}

async function loadIdentityAndPrefs() {
  const meta = $("self-state-meta");
  try {
    const self = await dbGetSelfState();
    $("self-state-content").value = self?.content || "";
    $("self-state-notes").value = self?.consolidation_notes || "";
    meta.textContent = self ? ` (current: v${self.version})` : " (none yet)";
  } catch (err) {
    $("self-state-content").value = "";
    $("self-state-notes").value = "";
    meta.textContent = ` (couldn't load: ${err.message})`;
  }
  try {
    const prefs = await dbGetUserPreferences();
    $("user-prefs-content").value = prefs?.content || "";
  } catch (err) {
    $("user-prefs-content").value = "";
    flashToast(`Couldn't load preferences: ${err.message}`, true);
  }
}

async function saveSelfState() {
  const content = $("self-state-content").value.trim();
  const notes = $("self-state-notes").value.trim();
  if (!content) { flashToast("Identity text is empty.", true); return; }
  try {
    await dbPromoteSelfState(content, notes);
  } catch (err) {
    flashToast(`Save failed: ${err.message}`, true);
    return;
  }
  flashToast("New identity version saved");
  await loadIdentityAndPrefs();
}

async function saveUserPreferences() {
  const content = $("user-prefs-content").value.trim();
  try {
    await dbSaveUserPreferences(content);
  } catch (err) {
    flashToast(`Save failed: ${err.message}`, true);
    return;
  }
  flashToast("Preferences saved");
}

async function renderMemoryList() {
  const ul = $("memory-list");
  ul.innerHTML = "";
  let mems;
  try {
    mems = await dbListCoreMemories();
  } catch (err) {
    const li = document.createElement("li");
    li.className = "mem-empty muted small";
    li.textContent = `Couldn't load memories: ${err.message}`;
    ul.appendChild(li);
    return;
  }
  if (!mems.length) {
    const li = document.createElement("li");
    li.className = "mem-empty muted small";
    li.textContent = "No memories yet.";
    ul.appendChild(li);
    return;
  }
  for (const m of mems) {
    const li = document.createElement("li");
    if (m.pinned) li.classList.add("mem-pinned");
    const body = document.createElement("div");
    body.className = "mem-body";
    const meta = document.createElement("span");
    meta.className = "mem-meta";
    meta.textContent = (m.pinned ? "📌 eternal · " : "")
      + `${m.memory_type} · resonance ${m.resonance}`;
    const text = document.createElement("span");
    text.className = "mem-text";
    text.textContent = m.content;
    body.appendChild(meta);
    body.appendChild(text);
    li.appendChild(body);
    li.appendChild(mkMemActions(
      () => startEditMemory(m),
      () => deleteMemory(m.id),
      { pinned: !!m.pinned, onToggle: () => togglePinMemory(m) },
    ));
    ul.appendChild(li);
  }
}

async function addCoreMemory() {
  const content = $("mem-content").value.trim();
  const memoryType = $("mem-type").value;
  const resonance = parseInt($("mem-resonance").value, 10);
  if (!content) { flashToast("Memory text is empty.", true); return; }
  if (!MEMORY_TYPES.includes(memoryType)) { flashToast("Pick a memory type.", true); return; }
  if (!Number.isInteger(resonance) || resonance < 1 || resonance > 10) {
    flashToast("Resonance must be 1–10.", true);
    return;
  }
  try {
    if (editingMemoryId) {
      await dbUpdateCoreMemory(editingMemoryId, {
        content, memory_type: memoryType, resonance,
      });
    } else {
      await dbCreateCoreMemory(content, memoryType, resonance);
    }
  } catch (err) {
    flashToast(`Save failed: ${err.message}`, true);
    return;
  }
  const wasEditing = !!editingMemoryId;
  cancelEditMemory();
  flashToast(wasEditing ? "Memory updated" : "Memory saved");
  await renderMemoryList();
  await renderPinnedStrip(); // an edit may have changed a pinned memory's text
}

// ---------- Wire it up ----------

function wireSignIn() {
  $("signin-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!$("signin-code").hidden) {
      const code = $("signin-code").value.trim();
      if (!code) return;
      verifyCode(signinEmail, code);
    } else {
      const email = $("signin-email").value.trim();
      if (!email) return;
      sendCode(email);
    }
  });
  $("signin-restart").addEventListener("click", resetSignIn);
  $("signin-have-code").addEventListener("click", useExistingCode);
}

function wireApp() {
  $("signout-btn").addEventListener("click", signOut);

  $("menu-btn").addEventListener("click", () => {
    const open = !document.body.classList.contains("sidebar-open");
    document.body.classList.toggle("sidebar-open", open);
    $("sidebar-backdrop").hidden = !open;
  });
  $("sidebar-backdrop").addEventListener("click", closeSidebar);

  // Project chip: tap to open the project dropdown; new chat is the big button.
  $("project-chip").addEventListener("click", (e) => { e.stopPropagation(); toggleProjectMenu(); });
  $("new-chat-btn").addEventListener("click", () => createConversation());
  // Click anywhere else closes the project menu.
  document.addEventListener("click", (e) => {
    const wrap = e.target.closest(".project-chip-wrap");
    if (!wrap) closeProjectMenu();
  });

  $("project-name").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    const name = e.target.value.trim() || "Untitled";
    project.name = name;
    renderSidebar();
    try { await dbUpdateProject(project.id, { name }); }
    catch (err) { alert(`Save failed: ${err.message}`); }
  });

  $("conv-name").addEventListener("change", async (e) => {
    const project = getActiveProject();
    const conv = getActiveConversation(project);
    if (!conv) return;
    const name = e.target.value.trim() || "Untitled";
    conv.name = name;
    renderSidebar();
    try { await dbUpdateConversation(conv.id, { name }); }
    catch (err) { alert(`Save failed: ${err.message}`); }
  });

  $("model-select").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.model = e.target.value;
    renderProject();
    try { await dbUpdateProject(project.id, { model: e.target.value }); }
    catch (err) { console.error(err); }
  });

  $("web-search-toggle").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.webSearch = e.target.checked;
    try { await dbUpdateProject(project.id, { web_search: e.target.checked }); }
    catch (err) { console.error(err); }
  });

  $("whisper-toggle").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.whisper = e.target.checked;
    try { await dbUpdateProject(project.id, { whisper: e.target.checked }); }
    catch (err) { console.error(err); }
  });

  $("signal-toggle").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.signal = e.target.checked;
    try { await dbUpdateProject(project.id, { signal: e.target.checked }); }
    catch (err) { console.error(err); }
  });

  $("memory-toggle").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.memory = e.target.checked;
    try { await dbUpdateProject(project.id, { memory: e.target.checked }); }
    catch (err) { console.error(err); }
  });

  $("thinking-toggle").addEventListener("change", async (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.thinking = e.target.checked;
    try { await dbUpdateProject(project.id, { thinking: e.target.checked }); }
    catch (err) { console.error(err); }
  });

  // System prompt saves on `input` (every keystroke / paste), debounced
  // 500ms — so even if the dialog is closed or the page reloaded mid-
  // edit, the most recent value is persisted. A small toast confirms.
  let _spSaveTimer = null;
  $("system-prompt").addEventListener("input", (e) => {
    const project = getActiveProject();
    if (!project) return;
    project.systemPrompt = e.target.value;
    clearTimeout(_spSaveTimer);
    _spSaveTimer = setTimeout(async () => {
      try {
        await dbUpdateProject(project.id, { system_prompt: e.target.value });
        flashToast("System prompt saved");
      } catch (err) {
        console.error(err);
        flashToast(`Save failed: ${err.message}`, true);
      }
    }, 500);
  });

  $("customize-btn").addEventListener("click", () => $("settings-dialog").showModal());

  // Timestamps: a device preference (not his data), so it lives in localStorage
  // and just toggles a body class the message CSS keys off of. Default = shown.
  const tsBox = $("timestamps-toggle");
  if (tsBox) {
    let tsOn = true;
    try { tsOn = localStorage.getItem("petrichor-timestamps") !== "off"; } catch (e) {}
    tsBox.checked = tsOn;
    document.body.classList.toggle("hide-timestamps", !tsOn);
    tsBox.addEventListener("change", () => {
      document.body.classList.toggle("hide-timestamps", !tsBox.checked);
      try { localStorage.setItem("petrichor-timestamps", tsBox.checked ? "on" : "off"); } catch (e) {}
    });
  }

  // Companion name: a cosmetic device preference. Updates his message labels
  // live as you type (re-render the open conversation).
  const nameInput = $("companion-name-input");
  if (nameInput) {
    let saved = "";
    try { saved = localStorage.getItem("petrichor-companion-name") || ""; } catch (e) {}
    nameInput.value = saved;
    nameInput.addEventListener("input", () => {
      try { localStorage.setItem("petrichor-companion-name", nameInput.value.trim()); } catch (e) {}
      refreshAvatarPreview();
      renderMessages();
    });
  }

  // Avatar: pick → shrink to a tiny data URL → store on this device. The
  // hidden file input is triggered by the "Choose image" button.
  const avatarInput = $("avatar-input");
  if (avatarInput) {
    refreshAvatarPreview();
    $("avatar-choose-btn").addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const url = await avatarDataUrlFromFile(file);
        localStorage.setItem("petrichor-companion-avatar", url);
        refreshAvatarPreview();
        renderMessages();
      } catch (err) {
        flashToast(err.message || "Couldn't set that image.", true);
      }
    });
    $("avatar-remove-btn").addEventListener("click", () => {
      try { localStorage.removeItem("petrichor-companion-avatar"); } catch (e) {}
      refreshAvatarPreview();
      renderMessages();
    });
  }

  // Your name: cosmetic device preference for your own message labels.
  const userNameInput = $("user-name-input");
  if (userNameInput) {
    let saved = "";
    try { saved = localStorage.getItem("petrichor-user-name") || ""; } catch (e) {}
    userNameInput.value = saved;
    userNameInput.addEventListener("input", () => {
      try { localStorage.setItem("petrichor-user-name", userNameInput.value.trim()); } catch (e) {}
      refreshAvatarPreview("user");
      renderMessages();
    });
  }

  // Your avatar: same pick → shrink → store, under your own key.
  const userAvatarInput = $("user-avatar-input");
  if (userAvatarInput) {
    refreshAvatarPreview("user");
    $("user-avatar-choose-btn").addEventListener("click", () => userAvatarInput.click());
    userAvatarInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const url = await avatarDataUrlFromFile(file);
        localStorage.setItem("petrichor-user-avatar", url);
        refreshAvatarPreview("user");
        renderMessages();
      } catch (err) {
        flashToast(err.message || "Couldn't set that image.", true);
      }
    });
    $("user-avatar-remove-btn").addEventListener("click", () => {
      try { localStorage.removeItem("petrichor-user-avatar"); } catch (e) {}
      refreshAvatarPreview("user");
      renderMessages();
    });
  }

  // Max response length: a device preference in localStorage, sent as maxTokens
  // on each chat request. (Temperature/Top-P are omitted on purpose — the API
  // locks them while thinking is on, which is always, so a slider would lie.)
  const mtSlider = $("max-tokens-slider");
  if (mtSlider) {
    mtSlider.value = String(getMaxTokens());
    $("max-tokens-value").textContent = mtSlider.value;
    mtSlider.addEventListener("input", () => {
      $("max-tokens-value").textContent = mtSlider.value;
      try { localStorage.setItem("petrichor-max-tokens", mtSlider.value); } catch (e) {}
    });
  }

  document.querySelectorAll("#memories-dialog .mem-tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchMemTab(btn.dataset.tab)));

  // StillHere icon nav. Memories + Knowledge Graph open the real dialog
  // (graph is a tab within it). Search opens its own dialog; Diary is upcoming.
  $("nav-memories").addEventListener("click", () => openMemoriesDialog("identity"));
  $("nav-graph").addEventListener("click", () => openMemoriesDialog("graph"));
  $("nav-search").addEventListener("click", openSearchDialog);
  $("nav-diary").addEventListener("click", openDiaryDialog);

  $("search-input").addEventListener("input", (e) => runSearch(e.target.value));
  $("self-state-save-btn").addEventListener("click", saveSelfState);
  $("user-prefs-save-btn").addEventListener("click", saveUserPreferences);
  $("mem-add-btn").addEventListener("click", addCoreMemory);
  $("entity-add-btn").addEventListener("click", addMemoryEntity);
  $("diary-add-btn").addEventListener("click", addOrSaveDiaryEntry);
  document.querySelectorAll("#diary-dialog .diary-tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchDiaryTab(btn.dataset.dtab)));

  $("delete-project-btn").addEventListener("click", () => {
    if (state.activeProjectId) deleteProject(state.activeProjectId);
  });

  $("delete-conv-btn").addEventListener("click", () => {
    const project = getActiveProject();
    if (project?.activeConversationId) deleteConversation(project.activeConversationId);
  });

  const exportBtn = $("export-btn");
  const exportMenu = $("export-menu");
  exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    exportMenu.hidden = !exportMenu.hidden;
  });
  document.addEventListener("click", () => { exportMenu.hidden = true; });
  exportMenu.addEventListener("click", (e) => e.stopPropagation());
  $("export-json").addEventListener("click", () => { exportMenu.hidden = true; exportConversationJson(); });
  $("export-md").addEventListener("click",   () => { exportMenu.hidden = true; exportConversationMarkdown(); });

  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", async (e) => {
    if (e.target.files[0]) await importConversationJson(e.target.files[0]);
    e.target.value = "";
  });

  // Chat / Manuscript tabs.
  $("tab-chat").addEventListener("click", () => showView("chat"));
  $("tab-manuscript").addEventListener("click", () => showView("manuscript"));

  // Manuscript editor.
  $("ms-new-btn").addEventListener("click", newManuscriptDocument);
  $("ms-delete-btn").addEventListener("click", deleteCurrentDocument);
  $("ms-title").addEventListener("input", () => { scheduleMsSave(); updateCoWriteBar(); });
  $("ms-content").addEventListener("input", () => { updateMsWordcount(); scheduleMsSave(); });
  $("ms-cowrite-toggle").addEventListener("change", (e) => {
    setCoWrite(e.target.checked);
    flashToast(e.target.checked
      ? "✨ He'll read this piece as you chat — make suggestions together"
      : "Co-write off");
  });

  // The 📎 is a <label for="file-input">, so it opens the picker natively on
  // every device (mobile won't open a hidden input from a programmatic
  // .click(), which is why it did nothing on phones). No JS click needed.
  $("file-input").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    // Immediate, visible confirmation that the selection registered — so a
    // silent failure becomes a legible one. If you never see this when you
    // pick a photo, the picker isn't handing the file back to the page.
    flashToast(`📎 Got ${files.length === 1 ? files[0].name : files.length + " files"} — adding…`);
    try {
      await attachFiles(files);
    } catch (err) {
      flashToast(`Attach failed: ${err?.message || err}`, true);
    }
  });

  const prompt = $("prompt");
  prompt.addEventListener("input", () => autosizeTextarea(prompt));
  // On a touch device, Enter should make a NEW LINE (send via the button) —
  // otherwise the on-screen keyboard's Enter fires off half-written messages,
  // which read as messages "disappearing". On desktop, Enter still sends.
  const enterSends = !window.matchMedia("(pointer: coarse)").matches;
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && enterSends) {
      e.preventDefault();
      $("composer").requestSubmit();
    }
  });

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = prompt.value;
    if (!text.trim() || isSending) return;
    prompt.value = "";
    autosizeTextarea(prompt);
    const started = await sendMessage(text);
    if (started === false) {
      // Couldn't send — put their words back rather than eat them.
      prompt.value = text;
      autosizeTextarea(prompt);
    }
  });
}

// Surface otherwise-silent crashes as a visible toast. A swallowed exception
// (e.g. only on a particular device) makes a send/attach "just disappear"
// with no clue; this turns that into a legible message.
function installErrorSurfacing() {
  window.addEventListener("error", (e) => {
    try { flashToast("⚠️ " + (e.message || "unexpected error"), true); } catch (_) {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    const msg = (r && (r.message || r.error_description || r.toString())) || "unexpected error";
    try { flashToast("⚠️ " + msg, true); } catch (_) {}
  });
}

// Auto-update: the installed app keeps running the code it loaded at open, so
// shipped fixes never reach it until a reload — which is how a save-bug fix
// sat unused while conversations were still being lost. Watch app.js's version
// tag; when it changes (a new deploy) and the app regains focus, reload once so
// the newest code takes over. The conversation backup makes a reload safe.
let loadedAppVersion = null;
let reloadingForUpdate = false;

async function appVersionTag() {
  try {
    const r = await fetch("/app.js", { method: "HEAD", cache: "no-store" });
    return r.headers.get("etag") || r.headers.get("last-modified") || null;
  } catch (_) { return null; }
}

async function checkForUpdate() {
  if (reloadingForUpdate) return;
  const tag = await appVersionTag();
  if (!tag || !loadedAppVersion) return;
  if (tag !== loadedAppVersion) {
    reloadingForUpdate = true;
    try { flashToast("✨ updating to the latest version…"); } catch (_) {}
    setTimeout(() => location.reload(), 600);
  }
}

async function startAutoUpdate() {
  loadedAppVersion = await appVersionTag();      // baseline at load
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkForUpdate();
  });
  setInterval(checkForUpdate, 10 * 60 * 1000);   // also every 10 min while open
}

function init() {
  installErrorSurfacing();
  wireSignIn();
  wireApp();
  initSupabase();
  startAutoUpdate();
}

document.addEventListener("DOMContentLoaded", init);
