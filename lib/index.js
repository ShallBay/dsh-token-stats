// @shallbay/dsh-token-stats — host plugin: harness-wide token usage dashboard.
//
// DATA SOURCE (v2, event-driven):
//   The live session event stream that @deepseek-ai/dsh-token-meter's
//   `tokenUsage` projection consumes (`session/event`) is now the primary
//   source — usage records are upserted incrementally as they happen, keyed by
//   `sessionId:turn:step` with last-sample-wins semantics identical to
//   token-meter's addReplacing fold. No log is re-scanned on refresh.
//
//   Cold history (sessions that never re-emit) is seeded ONCE: either from the
//   persisted rollup file (instant restart) or a one-time log scan; a stat-only
//   delta pass re-parses only files whose mtime/size changed since the rollup.
//   Session logs are matched as `session[.<version>].jsonl[.zstd]`, covering the
//   0.1.x plain name and the 0.2.x versioned ones (session.v3/v4.jsonl.zstd).
//
//   Attempts: 0.2.0 folds a retried attempt into the total instead of replacing
//   it, so the first attempt of a turn/step keeps the `turn:step` key and each
//   retry gets `turn:step#n`.
//
// Routes (unchanged):
//   GET /token-stats              the dashboard page (data injected)
//   GET /api/token-stats/refresh  delta-sync + read store → JSON
//   GET /api/token-stats/data     read store → JSON
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

/** Cordis plugin name. */
const name = "token-stats";
/** Required services: the webserver route registry and the session store. */
const inject = ["webServer", "sessions"];

const ZSTD_MAGIC = 4247762216;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return frames;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return frames;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved zstd block type at byte ${offset - 3}`);
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function decodeZstdFile(path) {
  const buf = readFileSync(path);
  const parts = scanZstdFrames(buf).map((f) => zstdDecompressSync(buf.subarray(f.start, f.end)));
  return Buffer.concat(parts).toString("utf8");
}

/** Session logs are `session[.<version>].jsonl[.zstd]` — the version infix is dsh's, not ours. */
const SESSION_LOG_RE = /^session(\.[^.]+)?\.jsonl(\.zstd)?$/u;

function findSessionFiles(root, out = []) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(root, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) findSessionFiles(p, out);
  }
  const logs = entries.filter((entry) => SESSION_LOG_RE.test(entry)).sort();
  // One log per session directory, preferring the compressed form.
  if (logs.length > 0) out.push(join(root, logs.find((entry) => entry.endsWith(".zstd")) ?? logs[0]));
  return out;
}

/** The last raw usage chunk of one durable Assistant settlement stream (dsh-llm's lastAssistantStreamChunk). */
function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === "chunk" && record.chunk?.type === "usage" && record.chunk.usage) return record.chunk.usage;
  }
  return null;
}

/**
* Fold a committed usage event into `{turn, step, time, usage}` or null
* (token-meter's usageOf rule, covering both the 0.1.x durable-chunk form and
* the 0.2.0 settlement form whose sample can hide inside `data.stream`).
*/
function usageOfEvent(event) {
  const data = event.data;
  if (event.type === "assistant/chunk") {
    const chunk = data?.chunk;
    if (chunk?.type !== "usage" || !chunk.usage) return null;
    return { turn: data.turn, step: data.step, time: event.time, usage: chunk.usage };
  }
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return null;
  const usage = data?.usage ?? lastStreamUsage(data?.stream);
  if (!usage) return null;
  return { turn: data.turn, step: data.step, time: event.time, usage };
}

/**
* The provider/model one request event names, or null when the event carries none.
* `request/header` is the request the assistant actually answered; `request/context`
* repeats the same pair. 0.1.x logs have neither, so their records stay unattributed.
*/
function modelOfEvent(event) {
  if (event.type === "request/header") {
    const config = event.data?.header?.config;
    if (typeof config?.model !== "string" || config.model === "") return null;
    return { provider: typeof config.provider === "string" && config.provider !== "" ? config.provider : null, model: config.model };
  }
  if (event.type === "request/context") {
    const model = event.data?.model;
    if (typeof model !== "string" || model === "") return null;
    const provider = event.data?.provider;
    return { provider: typeof provider === "string" && provider !== "" ? provider : null, model };
  }
  return null;
}

/**
* Billed attempt slots inside one turn/step. 0.2.0's projection opens a new
* attempt after `llm/retry-started` instead of replacing the previous one, so
* the first attempt keeps the legacy `turn:step` key and retries get `#n`.
*/
function createSlotTracker() {
  let turn = null;
  let step = null;
  let slot = 1;
  return {
    /** Advance the slot when a retry restarts the attempt currently in flight. */
    note(event) {
      if (event.type !== "llm/retry-started") return;
      const t = event.data?.turn;
      const s = event.data?.step;
      if (!Number.isInteger(t) || !Number.isInteger(s)) return;
      if (t === turn && s === step) slot += 1;
      else {
        turn = t;
        step = s;
        slot = 1;
      }
    },
    /** Record key for a usage sample at this turn/step. */
    key(t, s) {
      if (t !== turn || s !== step) {
        turn = t;
        step = s;
        slot = 1;
      }
      return slot > 1 ? `${t}:${s}#${slot}` : `${t}:${s}`;
    }
  };
}

/** Session events across dsh versions: 0.2.0 exposes log/snapshotEvents(), older ones `events`. */
function sessionEventsOf(session) {
  if (typeof session.snapshotEvents === "function") return session.snapshotEvents();
  if (Array.isArray(session.events)) return session.events;
  if (Array.isArray(session.log)) return session.log;
  return [];
}

function bucketsOf(usage) {
  return {
    uncachedInput: Number(usage.inputTokens ?? usage.uncachedInputTokens ?? 0) || 0,
    output: Number(usage.outputTokens ?? 0) || 0,
    cacheRead: Number(usage.cacheReadTokens ?? 0) || 0,
    cacheWrite: Number(usage.cacheWriteTokens ?? 0) || 0
  };
}

// ── In-memory store (authoritative while running; persisted to rollup) ──────
/** Rollup schema: 2 adds per-record `model`/`provider` (pricing is per model). */
const ROLLUP_FORMAT = 2;
// store.records: sessionId -> Map("turn:step" or "turn:step#attempt" -> {t, uncachedInput, output, cacheRead, cacheWrite, model, provider})
// store.sessions: sessionId -> {id, cwd, createdAt, title}
// store.fingerprints: logPath -> {mtimeMs, size}
const store = {
  records: new Map(),
  sessions: new Map(),
  fingerprints: new Map()
};
let bootstrapped = false;
let bootstrapping = false;
let dirty = false;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/** The profile this host runs, used to keep concurrently running runtimes off one rollup file. */
function profileName() {
  if (process.env.DSH_PROFILE) return process.env.DSH_PROFILE;
  if (process.env.DSH_PROFILE_DIR) return basename(process.env.DSH_PROFILE_DIR);
  for (const arg of process.argv) {
    const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]?$/u.exec(arg);
    if (match !== null) return match[1];
  }
  return null;
}

function rollupPath() {
  const profile = profileName();
  return join(dshHome(), profile === null ? "token-stats-rollup.json" : `token-stats-rollup.${profile}.json`);
}

/** Pre-isolation rollup location: read-only seeding, so a profile switch needs no full rescan. */
function seedRollupPath() {
  return join(dshHome(), "token-stats-rollup.json");
}

// ── Provider/model display names (the `llm` directory) ──────────────────────
// The pricing table shows the same two names Settings → Models shows: the provider's
// display name and the model's catalog name. Adapter routes without a directory entry
// still get a row keyed by their raw id, so a used model is never hidden.
const CATALOG_TTL_MS = 60 * 1000;
let catalogCache = { at: 0, items: [] };
let catalogRefresh = null;
let pluginContext = null;

function catalogIsStale() {
  return Date.now() - catalogCache.at > CATALOG_TTL_MS;
}

/**
* Rebuild the cached provider/model directory. Every field is best-effort: a failing
* adapter contributes its raw id instead of breaking the whole catalog.
* @param ctx - Host context that may provide the `llm` service.
*/
async function refreshCatalog(ctx) {
  if (ctx === null || typeof ctx.get !== "function") return;
  const llm = ctx.get("llm");
  if (!llm) return;
  if (catalogRefresh !== null) return catalogRefresh;
  catalogRefresh = (async () => {
    const items = [];
    try {
      for (const entry of llm.listConfigurableProviders?.() ?? []) {
        let models = [];
        try {
          models = (await llm.listModels(entry.provider)) ?? [];
        } catch (error) {
          ctx.logger?.warn?.(`token-stats: listModels(${entry.provider}) failed: ${String(error)}`);
        }
        items.push({
          id: entry.provider,
          name: entry.displayName || entry.provider,
          models: models.map((model) => ({ id: model.id, name: model.name || model.id }))
        });
      }
      for (const provider of llm.listProviders?.() ?? []) {
        if (!items.some((item) => item.id === provider.id)) items.push({ id: provider.id, name: provider.name || provider.id, models: [] });
      }
      catalogCache = { at: Date.now(), items };
    } catch (error) {
      ctx.logger?.warn?.(`token-stats: catalog refresh failed: ${String(error)}`);
    }
  })().finally(() => {
    catalogRefresh = null;
  });
  return catalogRefresh;
}

/** Kick a background catalog refresh when the cache aged out (never blocks a request). */
function ensureCatalog() {
  if (!catalogIsStale() || pluginContext === null) return;
  refreshCatalog(pluginContext).catch(() => {});
}

function upsertRecord(sessionId, key, time, usage, origin) {
  let bySession = store.records.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    store.records.set(sessionId, bySession);
  }
  const b = bucketsOf(usage);
  if (b.uncachedInput === 0 && b.output === 0 && b.cacheRead === 0 && b.cacheWrite === 0) return;
  const previous = bySession.get(key);
  bySession.set(key, {
    t: time,
    ...b,
    model: origin?.model ?? previous?.model ?? null,
    provider: origin?.provider ?? previous?.provider ?? null
  });
  dirty = true;
}

function ensureSessionMeta(sessionId, meta) {
  let s = store.sessions.get(sessionId);
  if (!s) {
    s = { id: sessionId, cwd: meta?.cwd ?? null, createdAt: meta?.createdAt ?? null, title: meta?.title ?? null };
    store.sessions.set(sessionId, s);
    dirty = true;
  } else if (meta?.title && !s.title) {
    s.title = meta.title;
    dirty = true;
  }
  return s;
}

/** Replay one live session's in-memory events (zero file I/O). */
function replaySessionEvents(session) {
  const id = session.id;
  let meta = { cwd: session.header?.cwd, createdAt: session.header?.createdAt };
  const byKey = new Map();
  const slots = createSlotTracker();
  let origin = null;
  for (const event of sessionEventsOf(session)) {
    if (event.type === "session/title" && typeof event.data?.title === "string" && !meta.title) meta.title = event.data.title;
    const named = modelOfEvent(event);
    if (named !== null) origin = named;
    slots.note(event);
    const u = usageOfEvent(event);
    if (u !== null) byKey.set(slots.key(u.turn, u.step), { t: u.time, ...bucketsOf(u.usage), model: origin?.model ?? null, provider: origin?.provider ?? null });
  }
  ensureSessionMeta(id, meta);
  if (byKey.size > 0) {
    store.records.set(id, byKey);
    dirty = true;
  }
}

// ── Bootstrap: rollup load or one-time scan + stat-only delta ───────────────
function parseSession(path) {
  const text = path.endsWith(".zstd") ? decodeZstdFile(path) : readFileSync(path, "utf8");
  const meta = { id: null, createdAt: null, cwd: null, title: null };
  const records = [];
  const slots = createSlotTracker();
  let pending = null;
  let origin = null;
  const flush = () => {
    if (pending === null) return;
    const b = bucketsOf(pending.usage);
    if (b.uncachedInput > 0 || b.output > 0 || b.cacheRead > 0 || b.cacheWrite > 0) {
      records.push({ key: pending.key, t: pending.t, ...b, model: pending.model, provider: pending.provider });
    }
    pending = null;
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    switch (o.type) {
      case "session":
        meta.id = o.id ?? null;
        meta.createdAt = o.createdAt ?? null;
        meta.cwd = o.cwd ?? null;
        break;
      case "session/title":
        if (meta.title === null && typeof o.data?.title === "string") meta.title = o.data.title;
        break;
      case "request/header":
      case "request/context": {
        const named = modelOfEvent(o);
        if (named !== null) origin = named;
        break;
      }
      case "llm/retry-started":
        slots.note(o);
        break;
      case "assistant/chunk":
      case "assistant/message":
      case "assistant/attempt": {
        const u = usageOfEvent(o);
        if (u === null) break;
        const key = slots.key(u.turn, u.step);
        if (pending !== null && pending.key !== key) flush();
        pending = { key, t: u.time, usage: u.usage, model: origin?.model ?? null, provider: origin?.provider ?? null };
        break;
      }
      default:
        break;
    }
  }
  flush();
  return { meta, records };
}

function tryLoadRollup() {
  // Merge the persisted rollup into the store. Records are keyed by
  // `session:turn:step` (last-wins), so merging is idempotent even when live
  // `session/event` records already populated the store (e.g. the current GUI
  // session is always live). The subsequent deltaScan re-parses only files
  // whose fingerprint changed since the rollup.
  //
  // Each profile persists to its own rollup so two runtimes sharing one
  // $DSH_HOME (e.g. the Desktop app and a `dsh web` service) cannot overwrite
  // each other's records; the pre-isolation shared file is read once as a seed.
  const own = rollupPath();
  const seed = seedRollupPath();
  const source = existsSync(own) ? own : own !== seed && existsSync(seed) ? seed : null;
  if (source === null) return false;
  try {
    const j = JSON.parse(readFileSync(source, "utf8"));
    if (!j || !Array.isArray(j.records) || !Array.isArray(j.sessions)) return false;
    const byKey = (id) => {
      let m = store.records.get(id);
      if (!m) {
        m = new Map();
        store.records.set(id, m);
      }
      return m;
    };
    for (const r of j.records) byKey(r.session).set(r.key, { t: r.t, uncachedInput: r.uncachedInput, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, model: r.model ?? null, provider: r.provider ?? null });
    for (const s of j.sessions) store.sessions.set(s.id, { id: s.id, cwd: s.cwd ?? null, createdAt: s.createdAt ?? null, title: s.title ?? null });
    for (const [path, fp] of Object.entries(j.fingerprints ?? {})) store.fingerprints.set(path, fp);
    // A rollup written before per-record model attribution re-reads its recent logs
    // once, so the pricing table can group by model without a full historical rescan.
    if (j.format !== ROLLUP_FORMAT) {
      const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
      for (const [file, fp] of store.fingerprints) if ((fp?.mtimeMs ?? 0) >= cutoff) store.fingerprints.delete(file);
    }
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function persistRollup() {
  if (!dirty) return;
  try {
    const records = [];
    for (const [sessionId, bySession] of store.records) {
      for (const [key, r] of bySession) {
        records.push({
          session: sessionId,
          key,
          t: r.t,
          uncachedInput: r.uncachedInput,
          output: r.output,
          cacheRead: r.cacheRead,
          cacheWrite: r.cacheWrite,
          ...r.model ? { model: r.model, provider: r.provider ?? null } : {}
        });
      }
    }
    const fingerprints = {};
    for (const [path, fp] of store.fingerprints) fingerprints[path] = fp;
    writeFileSync(rollupPath(), JSON.stringify({
      format: ROLLUP_FORMAT,
      generatedAt: new Date().toISOString(),
      sessions: [...store.sessions.values()],
      records,
      fingerprints
    }));
    dirty = false;
  } catch (error) {
    console.error("token-stats: rollup persist failed: " + error.message);
  }
}

/** Delta pass: stat every session log; re-parse only changed/new files. */
function deltaScan() {
  const files = findSessionFiles(sessionsRoot());
  let filesFailed = 0;
  for (const f of files) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue;
    }
    const fp = store.fingerprints.get(f);
    if (fp !== void 0 && fp.mtimeMs === st.mtimeMs && fp.size === st.size) continue;
    try {
      const { meta, records } = parseSession(f);
      const id = meta.id || f;
      ensureSessionMeta(id, meta);
      const merged = new Map();
      for (const r of records) merged.set(r.key, r);
      if (merged.size > 0) {
        const existing = store.records.get(id) ?? new Map();
        for (const [k, v] of merged) existing.set(k, v);
        store.records.set(id, existing);
        dirty = true;
      }
    } catch (error) {
      filesFailed += 1;
      console.error("  ! 解析失败 " + f + ": " + error.message);
    }
    store.fingerprints.set(f, { mtimeMs: st.mtimeMs, size: st.size });
  }
  return filesFailed;
}

function ensureBootstrapped() {
  if (bootstrapped) return;
  if (bootstrapping) return;
  bootstrapping = true;
  try {
    const loaded = tryLoadRollup();
    deltaScan();
    if (!loaded) dirty = true; // persist the fresh seed
    persistRollup();
  } finally {
    bootstrapping = false;
    bootstrapped = true;
  }
}

function buildData() {
  ensureBootstrapped();
  const records = [];
  for (const [sessionId, bySession] of store.records) {
    for (const r of bySession.values()) records.push({ t: r.t, session: sessionId, model: r.model ?? null, provider: r.provider ?? null, uncachedInput: r.uncachedInput, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
  }
  records.sort((a, b) => a.t - b.t);
  const sessions = [...store.sessions.values()]
    .map((s) => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt, title: s.title, calls: store.records.get(s.id)?.size ?? 0 }))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { generatedAt: new Date().toISOString(), dshHome: dshHome(), catalog: catalogCache.items, sessions, records };
}

// The dashboard page, re-read whenever its mtime changes: editing the page
// (or the copy this package links to) takes effect on the next page load
// instead of waiting for the host to re-import this module.
const DASHBOARD_PATH = new URL("./dashboard.html", import.meta.url);
let dashboardCache = { mtimeMs: -1, html: "" };

function dashboardHtml() {
  const stats = statSync(DASHBOARD_PATH);
  if (stats.mtimeMs !== dashboardCache.mtimeMs) {
    dashboardCache = { mtimeMs: stats.mtimeMs, html: readFileSync(DASHBOARD_PATH, "utf8") };
  }
  return dashboardCache.html;
}

// Small in-memory cache so concurrent /data hits share one build.
let cached = null;
let cachedAt = 0;
const MIN_REFRESH_MS = 1000;

function freshData() {
  const now = Date.now();
  ensureCatalog();
  if (cached && now - cachedAt < MIN_REFRESH_MS) return cached;
  cached = buildData();
  cachedAt = now;
  return cached;
}

function writeJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

/**
 * Register the dashboard page and its data endpoints.
 * @param ctx - Host context carrying the webserver route registry.
 */
function apply(ctx) {
  pluginContext = ctx;
  refreshCatalog(ctx).catch(() => {});
  // Live feed: the same session event stream dsh-token-meter folds. `global:
  // true` — like the harness's own invariant listeners — bypasses the
  // carrier-scope filter so we see every session's events (the dashboard
  // aggregates all sessions, matching the old full-scan coverage).
  const liveSlots = new Map();
  const liveOrigins = new Map();
  ctx.on("session/event", (session, event) => {
    try {
      ensureSessionMeta(session.id, { cwd: session.header?.cwd, createdAt: session.header?.createdAt });
      const named = modelOfEvent(event);
      if (named !== null) liveOrigins.set(session.id, named);
      let slots = liveSlots.get(session.id);
      if (slots === undefined) {
        slots = createSlotTracker();
        liveSlots.set(session.id, slots);
      }
      slots.note(event);
      const u = usageOfEvent(event);
      if (u !== null) upsertRecord(session.id, slots.key(u.turn, u.step), u.time, u.usage, liveOrigins.get(session.id) ?? null);
      if (event.type === "session/title" && typeof event.data?.title === "string") {
        const s = store.sessions.get(session.id);
        if (s && !s.title) {
          s.title = event.data.title;
          dirty = true;
        }
      }
    } catch (error) {
      ctx.logger?.warn?.(`token-stats: session/event failed: ${String(error)}`);
    }
  }, { global: true });
  // Replay a session's full in-memory history when it becomes live.
  ctx.on("session/created", (session) => {
    try {
      replaySessionEvents(session);
    } catch (error) {
      ctx.logger?.warn?.(`token-stats: session/created failed: ${String(error)}`);
    }
  }, { global: true });
  // Sessions already live at plugin load: their in-memory log may not be
  // flushed to disk yet, so replay from memory (zero file I/O).
  for (const session of ctx.sessions.list()) {
    try {
      replaySessionEvents(session);
    } catch (error) {
      ctx.logger?.warn?.(`token-stats: replay live session failed: ${String(error)}`);
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/token-stats",
    handler: async (_req, res) => {
      try {
        if (catalogIsStale()) await refreshCatalog(ctx); // 首次打开就能带上供应商/模型显示名
        const injected = JSON.stringify(freshData()).replace(/</g, "\\u003c");
        const html = dashboardHtml().replace("</head>", "<script>window.__DSH_DATA__ = " + injected + ";</script></head>");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("token-stats: collect failed: " + e.message);
      }
    }
  }), "token-stats: page");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/token-stats/refresh",
    handler: async (_req, res) => {
      try {
        if (catalogIsStale()) await refreshCatalog(ctx);
        deltaScan();
        persistRollup();
        cached = null; // delta may have added records; bypass the 1s cache
        writeJson(res, 200, freshData());
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("token-stats refresh failed: " + e.message);
      }
    }
  }), "token-stats: refresh");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/token-stats/data",
    handler: (_req, res) => {
      try {
        writeJson(res, 200, freshData());
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("token-stats data failed: " + e.message);
      }
    }
  }), "token-stats: data");
}

export { apply, inject, name };
