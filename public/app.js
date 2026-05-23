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
let state = {
  user: null,
  projects: [],
  activeProjectId: null,
};

const $ = (id) => document.getElementById(id);

const uid = () =>
  (crypto?.randomUUID && crypto.randomUUID()) ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

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
    data: row.data,
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

async function signIn(email) {
  if (!db) return;
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  const msg = $("signin-msg");
  if (error) {
    msg.textContent = error.message;
    msg.className = "signin-msg error";
  } else {
    msg.textContent = `Check ${email} for a sign-in link.`;
    msg.className = "signin-msg success";
  }
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
  const { error } = await db.from("conversations").update(fields).eq("id", id);
  if (error) throw error;
}

async function dbDeleteConversation(id) {
  const { error } = await db.from("conversations").delete().eq("id", id);
  if (error) throw error;
}

async function dbCreateFile(projectId, file) {
  const { data, error } = await db.from("files").insert({
    project_id: projectId,
    user_id: state.user.id,
    name: file.name,
    kind: file.kind,
    media_type: file.mediaType,
    size: file.size,
    data: file.data,
  }).select().single();
  if (error) throw error;
  return rowToFile(data);
}

async function dbDeleteFile(id) {
  const { error } = await db.from("files").delete().eq("id", id);
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
  try {
    await dbUpdateConversation(conv.id, {
      messages: conv.messages.map(stripTransient),
      active_file_ids: conv.activeFileIds,
    });
  } catch (e) { console.error("Conversation persist failed:", e); }
}

// ---------- File ops ----------

function fileKind(file) {
  if (file.type === "application/pdf") return "pdf";
  if (file.type.startsWith("image/"))  return "image";
  return "text";
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const kind = fileKind(file);
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
  if (!project || !conv) return;
  for (const f of fileList) {
    try {
      const parsed = await readFile(f);
      const stored = await dbCreateFile(project.id, parsed);
      project.files.push(stored);
      conv.activeFileIds.push(stored.id);
    } catch (e) {
      alert(`Couldn't read ${f.name}: ${e.message}`);
    }
  }
  await persistConversation(conv);
  render();
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

function buildApiMessages(project, messages) {
  const out = messages.map(msg => {
    if (msg.role === "user") {
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
          content.push({
            type: "image",
            source: { type: "base64", media_type: f.mediaType, data: f.data },
          });
        } else {
          content.push({
            type: "text",
            text: `<file name="${f.name}">\n${f.data}\n</file>`,
          });
        }
      }
      content.push({ type: "text", text: msg.text });
      return { role: "user", content };
    }
    // Defensive: Anthropic rejects empty AND whitespace-only text. The
    // cleanup pass above should remove failed turns, but if anything slips
    // through we use a real word so the API doesn't 400.
    return { role: "assistant", content: msg.text || "(no response)" };
  });

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

async function streamChat(payload, onEvent) {
  const { data: { session } } = await db.auth.getSession();
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
        system: project.systemPrompt || DEFAULT_SYSTEM,
        messages: buildApiMessages(project, cleanMessagesForApi(conv.messages)).slice(0, -1),
        useWebSearch: !!project.webSearch,
        useWhisper: !!project.whisper,
        useSignal: !!project.signal,
        useMemory: !!project.memory,
        thinking: !!project.thinking,
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
          assistantMsg.toolEvents.push({ name: event.name, query: event.query });
          updateAssistantBubble(assistantMsg);
        } else if (event.type === "notice") {
          // A server-side heads-up (e.g. an MCP connection was skipped).
          assistantMsg.toolEvents.push({ notice: true, text: event.text });
          updateAssistantBubble(assistantMsg);
        } else if (event.type === "memory_saved") {
          // He wrote to his own memory. Show it inline, and refresh the
          // Memories panel if it's open so it appears live.
          assistantMsg.toolEvents.push({
            name: event.tool, memory: true, ok: event.ok, summary: event.summary,
          });
          updateAssistantBubble(assistantMsg);
          if (typeof refreshMemoriesIfOpen === "function") refreshMemoriesIfOpen();
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
  await persistConversation(conv);
  await generateAssistant();
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
    md += `## ${m.role === "user" ? "You" : "Claude"}\n\n`;
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

function renderSidebar() {
  const list = $("project-list");
  list.innerHTML = "";
  for (const p of state.projects) {
    const isActive = p.id === state.activeProjectId;

    const item = document.createElement("div");
    item.className = "project-item" + (isActive ? " active" : "");

    const headRow = document.createElement("div");
    headRow.className = "project-head-row";

    const head = document.createElement("button");
    head.className = "project-head";
    head.innerHTML = `<span class="caret">${isActive ? "▾" : "▸"}</span><span class="name"></span>`;
    head.querySelector(".name").textContent = p.name || "Untitled";
    head.addEventListener("click", () => selectProject(p.id));
    head.addEventListener("dblclick", (e) => { e.preventDefault(); renameProject(p.id); });
    headRow.appendChild(head);

    const renameBtn = document.createElement("button");
    renameBtn.className = "row-action";
    renameBtn.textContent = "✏️";
    renameBtn.title = "Rename project";
    renameBtn.addEventListener("click", (e) => { e.stopPropagation(); renameProject(p.id); });
    headRow.appendChild(renameBtn);

    item.appendChild(headRow);

    if (isActive) {
      const subList = document.createElement("div");
      subList.className = "conv-list";

      const newBtn = document.createElement("button");
      newBtn.className = "conv-new";
      newBtn.textContent = "+ New chat";
      newBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        createConversation();
      });
      subList.appendChild(newBtn);

      for (const c of p.conversations) {
        const row = document.createElement("div");
        row.className = "conv-row";

        const ci = document.createElement("button");
        ci.className = "conv-item" + (c.id === p.activeConversationId ? " active" : "");
        ci.textContent = c.name || "Untitled";
        ci.addEventListener("click", (e) => {
          e.stopPropagation();
          selectConversation(c.id);
        });
        ci.addEventListener("dblclick", (e) => { e.preventDefault(); renameConversation(c.id); });
        row.appendChild(ci);

        const rename = document.createElement("button");
        rename.className = "row-action";
        rename.textContent = "✏️";
        rename.title = "Rename conversation";
        rename.addEventListener("click", (e) => { e.stopPropagation(); renameConversation(c.id); });
        row.appendChild(rename);

        subList.appendChild(row);
      }
      item.appendChild(subList);
    }

    list.appendChild(item);
  }
}

function renderProject() {
  const project = getActiveProject();
  $("empty-state").hidden = !!project;
  $("project-view").hidden = !project;
  if (!project) return;

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
  head.querySelector(".role").textContent = msg.role === "user" ? "You" : "Claude";
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
  if (msg.toolEvents?.length) {
    for (const ev of msg.toolEvents) {
      const note = document.createElement("div");
      note.className = "tool-event";
      if (ev.notice) {
        note.textContent = `ℹ️ ${ev.text}`;
      } else if (ev.memory) {
        const what = ev.name === "save_memory_entity" ? "entity" : "memory";
        note.textContent = ev.ok
          ? `🪶 Saved a ${what}: ${ev.summary}`
          : `⚠️ Couldn't save ${what}: ${ev.summary}`;
      } else {
        note.textContent = ev.name === "web_search" && ev.query
          ? `🌐 Searching the web for "${ev.query}"…`
          : `🔧 Used tool: ${ev.name}`;
      }
      body.appendChild(note);
    }
  }
  if (msg.text) {
    const text = document.createElement("div");
    text.className = "msg-text";
    if (msg._typing) {
      // Mid-reveal: plain text (any asterisks show until the turn finishes,
      // then it re-renders with formatting).
      text.textContent = msg.text.slice(0, msg._shown || 0);
    } else {
      // Finished/committed: render *italics* and **bold**.
      text.innerHTML = renderInline(msg.text);
    }
    body.appendChild(text);
  } else if (msg.role === "assistant" && !msg.error) {
    const cursor = document.createElement("div");
    cursor.className = "tool-event";
    cursor.textContent = "…";
    body.appendChild(cursor);
  }
  if (msg.error) {
    const err = document.createElement("div");
    err.className = "error";
    err.textContent = msg.error;
    body.appendChild(err);
  }
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
    const name = document.createElement("span");
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

async function openMemoriesDialog() {
  closeSidebar();
  fillSelectOnce($("mem-type"), MEMORY_TYPES);
  fillSelectOnce($("entity-type"), ENTITY_TYPES);
  await loadIdentityAndPrefs();
  await renderMemoryList();
  await renderEntityList();
  $("memories-dialog").showModal();
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
    const email = $("signin-email").value.trim();
    if (!email) return;
    signIn(email);
  });
}

function wireApp() {
  $("signout-btn").addEventListener("click", signOut);

  $("menu-btn").addEventListener("click", () => {
    const open = !document.body.classList.contains("sidebar-open");
    document.body.classList.toggle("sidebar-open", open);
    $("sidebar-backdrop").hidden = !open;
  });
  $("sidebar-backdrop").addEventListener("click", closeSidebar);

  $("new-project-btn").addEventListener("click", () => createProject());

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

  $("settings-btn").addEventListener("click", () => $("settings-dialog").showModal());

  $("memories-btn").addEventListener("click", openMemoriesDialog);
  $("self-state-save-btn").addEventListener("click", saveSelfState);
  $("user-prefs-save-btn").addEventListener("click", saveUserPreferences);
  $("mem-add-btn").addEventListener("click", addCoreMemory);
  $("entity-add-btn").addEventListener("click", addMemoryEntity);

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

  $("attach-btn").addEventListener("click", () => $("file-input").click());
  $("file-input").addEventListener("change", async (e) => {
    if (e.target.files.length) await attachFiles(Array.from(e.target.files));
    e.target.value = "";
  });

  const prompt = $("prompt");
  prompt.addEventListener("input", () => autosizeTextarea(prompt));
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
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

function init() {
  wireSignIn();
  wireApp();
  initSupabase();
}

document.addEventListener("DOMContentLoaded", init);
