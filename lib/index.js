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
//
// Routes (unchanged):
//   GET /token-stats              the dashboard page (data injected)
//   GET /api/token-stats/refresh  delta-sync + read store → JSON
//   GET /api/token-stats/data     read store → JSON
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
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
  const zstd = entries.includes("session.jsonl.zstd");
  const plain = entries.includes("session.jsonl");
  if (zstd || plain) out.push(join(root, zstd ? "session.jsonl.zstd" : "session.jsonl"));
  return out;
}

/** Fold a committed usage event into `{turn, step, time, usage}` or null (token-meter's usageOf rule). */
function usageOfEvent(event) {
  if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage" && event.data.chunk.usage) {
    return { turn: event.data.turn, step: event.data.step, time: event.time, usage: event.data.chunk.usage };
  }
  if (event.type === "assistant/message" && event.data?.usage) {
    return { turn: event.data.turn, step: event.data.step, time: event.time, usage: event.data.usage };
  }
  return null;
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
// store.records: sessionId -> Map("turn:step" -> {t, uncachedInput, output, cacheRead, cacheWrite})
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

function rollupPath() {
  return join(dshHome(), "token-stats-rollup.json");
}

function upsertRecord(sessionId, turn, step, time, usage) {
  const key = `${turn}:${step}`;
  let bySession = store.records.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    store.records.set(sessionId, bySession);
  }
  const b = bucketsOf(usage);
  if (b.uncachedInput === 0 && b.output === 0 && b.cacheRead === 0 && b.cacheWrite === 0) return;
  bySession.set(key, { t: time, ...b });
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
  for (const event of session.events) {
    if (event.type === "session/title" && typeof event.data?.title === "string" && !meta.title) meta.title = event.data.title;
    const u = usageOfEvent(event);
    if (u !== null) byKey.set(`${u.turn}:${u.step}`, { t: u.time, ...bucketsOf(u.usage) });
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
  let pending = null;
  const flush = () => {
    if (pending === null) return;
    const b = bucketsOf(pending.usage);
    if (b.uncachedInput > 0 || b.output > 0 || b.cacheRead > 0 || b.cacheWrite > 0) {
      records.push({ key: pending.key, t: pending.t, ...b });
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
      case "assistant/chunk": {
        const chunk = o.data?.chunk;
        if (chunk?.type !== "usage" || !chunk.usage) break;
        const key = `${o.data?.turn}:${o.data?.step}`;
        if (pending !== null && pending.key !== key) flush();
        pending = { key, t: o.time, usage: chunk.usage };
        break;
      }
      case "assistant/message": {
        if (!o.data?.usage) break;
        const key = `${o.data?.turn}:${o.data?.step}`;
        if (pending !== null && pending.key !== key) flush();
        pending = { key, t: o.time, usage: o.data.usage };
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
  const path = rollupPath();
  if (!existsSync(path)) return false;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (!j || !Array.isArray(j.records) || !Array.isArray(j.sessions)) return false;
    const byKey = (id) => {
      let m = store.records.get(id);
      if (!m) {
        m = new Map();
        store.records.set(id, m);
      }
      return m;
    };
    for (const r of j.records) byKey(r.session).set(r.key, { t: r.t, uncachedInput: r.uncachedInput, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
    for (const s of j.sessions) store.sessions.set(s.id, { id: s.id, cwd: s.cwd ?? null, createdAt: s.createdAt ?? null, title: s.title ?? null });
    for (const [path, fp] of Object.entries(j.fingerprints ?? {})) store.fingerprints.set(path, fp);
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
        records.push({ session: sessionId, key, t: r.t, uncachedInput: r.uncachedInput, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
      }
    }
    const fingerprints = {};
    for (const [path, fp] of store.fingerprints) fingerprints[path] = fp;
    writeFileSync(rollupPath(), JSON.stringify({
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
    for (const r of bySession.values()) records.push({ t: r.t, session: sessionId, uncachedInput: r.uncachedInput, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite });
  }
  records.sort((a, b) => a.t - b.t);
  const sessions = [...store.sessions.values()]
    .map((s) => ({ id: s.id, cwd: s.cwd, createdAt: s.createdAt, title: s.title, calls: store.records.get(s.id)?.size ?? 0 }))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return { generatedAt: new Date().toISOString(), dshHome: dshHome(), sessions, records };
}

// The dashboard page (kept in sync with D:\work\dsh\token-stats\token-stats.html).
const HTML = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

// Small in-memory cache so concurrent /data hits share one build.
let cached = null;
let cachedAt = 0;
const MIN_REFRESH_MS = 1000;

function freshData() {
  const now = Date.now();
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
  // Live feed: the same session event stream dsh-token-meter folds. `global:
  // true` — like the harness's own invariant listeners — bypasses the
  // carrier-scope filter so we see every session's events (the dashboard
  // aggregates all sessions, matching the old full-scan coverage).
  ctx.on("session/event", (session, event) => {
    try {
      ensureSessionMeta(session.id, { cwd: session.header?.cwd, createdAt: session.header?.createdAt });
      const u = usageOfEvent(event);
      if (u !== null) upsertRecord(session.id, u.turn, u.step, u.time, u.usage);
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
    handler: (_req, res) => {
      try {
        const injected = JSON.stringify(freshData()).replace(/</g, "\\u003c");
        const html = HTML.replace("</head>", "<script>window.__DSH_DATA__ = " + injected + ";</script></head>");
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
    handler: (_req, res) => {
      try {
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
