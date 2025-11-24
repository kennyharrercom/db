/**
 * buffer-style-ndjson-db-2pc-indexes-metrics.js
 *
 * Buffer-style NDJSON DB with:
 *  - Path-keyed documents and collection listing
 *  - ACID across shards via global 2PC (PREPARE/COMMIT)
 *  - Per-shard append-only NDJSON WAL + group commit (with backpressure)
 *  - Online checkpoint/compaction → per-collection revisions & segments
 *  - Primary index files (binary) per segment (keyHash → offset/len)
 *  - In-memory directory index for O(1) collection listings
 *  - Versioned snapshots (optimistic concurrency via versions)
 *  - Secondary indexes configured by /<collection>/settings.json
 *      • modes: eq | contains | objValue | objHasKey
 *      • optional case-folding: { mode:"eq", fold:"lower" }
 *  - HTTP caching & concurrency:
 *      • GET document exposes ETag: "v<version>"
 *      • GET collection exposes ETag of listing digest
 *      • If-None-Match supported for 304
 *      • PUT/DELETE honor If-Match (or ?expectVersion=)
 *  - Admin metrics (JSON endpoint) + periodic console logs
 *  - Graceful drain on SIGINT/SIGTERM
 *  - Shard-serialized checkpointing
 *  - JSON body size cap + max nesting depth validation
 *
 * Node.js ≥ 18. External dep: xxhashjs
 *   npm i xxhashjs
 */

import http from "node:http";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import XXH from "xxhashjs";

// -------------------------------- Configuration --------------------------------
const DATA_DIR = process.env.DATA_DIR || path.resolve("./data");
const LOCK_FILE = path.join(DATA_DIR, ".lock");
const PORT = Number(process.env.PORT || 8080);

// Sharding
const SEED = 0xabcd1234; // fixed seed
const VIRTUAL_SHARDS = 65_536n; // 0..65535

// Group-commit window (ms)
const GROUP_COMMIT_WINDOW_MS = Number(process.env.GROUP_COMMIT_WINDOW_MS || 2);
const MAX_GROUP_QUEUE = Number(process.env.MAX_GROUP_QUEUE || 50_000);

// Checkpoint / compaction policy
const CHECKPOINT_MAX_WAL_BYTES = Number(
  process.env.CHECKPOINT_MAX_WAL_BYTES || 64 * 1024 * 1024
);
const CHECKPOINT_INTERVAL_MS = Number(
  process.env.CHECKPOINT_INTERVAL_MS || 5 * 60 * 1000
);
const CHECKPOINT_IDLE_GRACE_MS = Number(
  process.env.CHECKPOINT_IDLE_GRACE_MS || 5 * 1000
);
const SEGMENT_TARGET_BYTES = Number(
  process.env.SEGMENT_TARGET_BYTES || 128 * 1024 * 1024
);

// GC policy
const GC_KEEP_REVISIONS = Number(process.env.GC_KEEP_REVISIONS || 2);
const GC_KEEP_ROTATED_WALS = Number(process.env.GC_KEEP_ROTATED_WALS || 1);

// HTTP limits
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024);
const MAX_JSON_DEPTH = Number(process.env.MAX_JSON_DEPTH || 5);

// -------------------------------- Utilities ------------------------------------
function getVirtualShardId(key) {
  const h64 = BigInt("0x" + XXH.h64(key, SEED).toString(16));
  return Number(h64 % VIRTUAL_SHARDS);
}

const isCollection = (p) => p.endsWith("/");
const normalize = (p) => {
  if (!p.startsWith("/")) p = "/" + p;
  p = p.replace(/\/+/g, "/"); // collapse all duplicate slashes
  return isCollection(p) ? p : p.replace(/\/+$/, "");
};
function parentCollection(p) {
  p = normalize(p);
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i + 1);
}
function immediateChild(baseCollection, childPath) {
  const base = normalize(baseCollection);
  const child = normalize(childPath);
  if (!child.startsWith(base)) return child; // guard
  const rest = child.slice(base.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash + 1);
}
function topLevelCollectionOf(pathKey) {
  const parent = parentCollection(pathKey);
  const parts = parent.split("/").filter(Boolean);
  return parts.length ? parts[0] : "_root";
}

class Mutex {
  #p = Promise.resolve();
  lock(fn) {
    const run = this.#p.then(fn, fn);
    this.#p = run.then(
      () => {},
      () => {}
    );
    return run;
  }
}

// fsync a directory to persist metadata updates (renames, links)
async function fsyncDir(dirPath) {
  try {
    const fh = await fsp.open(dirPath, fs.constants.O_RDONLY);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // best-effort: some platforms may not allow opening directories
  }
}

// ------------------------------- Metrics ---------------------------------------
const metrics = {
  startTime: new Date().toISOString(),
  http: {
    requests: 0,
    byMethod: { GET: 0, PUT: 0, POST: 0, DELETE: 0, HEAD: 0 },
    statuses: {},
  },
  tx: { begun: 0, committed: 0, rolledBack: 0, conflicts: 0 },
  twopc: { prepares: 0, commits: 0 },
  wal: {
    appends: 0,
    bytes: 0,
    groupFlushes: 0,
    batches: 0,
    backpressureRejects: 0,
  },
  checkpoint: { runs: 0, totalMs: 0, lastRunAt: null, skippedDueToBusy: 0 },
  index: { rebuilds: 0, lastRebuildMs: 0 },
  data: { docs: 0, collections: 0, shardsTouched: 0 },
  latency: {
    commitMs_p50: 0,
    commitMs_p95: 0,
    commitMs_p99: 0,
  },
  _commitSamples: [],
};

function recordHttp(method, status) {
  metrics.http.requests++;
  metrics.http.byMethod[method] = (metrics.http.byMethod[method] || 0) + 1;
  metrics.http.statuses[status] = (metrics.http.statuses[status] || 0) + 1;
}
function recordCommitLatency(ms) {
  const arr = metrics._commitSamples;
  arr.push(ms);
  if (arr.length > 1000) arr.shift();
  const sorted = [...arr].sort((a, b) => a - b);
  const q = (p) =>
    sorted.length
      ? sorted[
          Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
        ]
      : 0;
  metrics.latency.commitMs_p50 = q(50);
  metrics.latency.commitMs_p95 = q(95);
  metrics.latency.commitMs_p99 = q(99);
}
setInterval(() => {
  console.log(
    "[metrics]",
    JSON.stringify({
      ts: new Date().toISOString(),
      http: metrics.http,
      tx: metrics.tx,
      twopc: metrics.twopc,
      wal: metrics.wal,
      checkpoint: metrics.checkpoint,
      index: metrics.index,
      data: metrics.data,
      latency: metrics.latency,
    })
  );
}, Number(process.env.METRICS_LOG_INTERVAL_MS || 30_000)).unref();

// -------------------------------- Secondary Index Manager ----------------------
class SecondaryIndexManager {
  constructor() {
    // Map collectionName → { spec: IndexSpec, postings: Map(indexName, Map(term, Set(paths))) }
    this.collections = new Map();
  }

  /**
   * Update index spec for a collection from settings object and rebuild.
   * settings = { indexes: { field: "eq" | { mode:"eq", fold?: "lower" } } }
   */
  async updateSpec(
    collectionName,
    settings,
    rebuildFn /* async: yields [path, doc] */
  ) {
    const started = Date.now();
    const spec = normalizeSpec(settings);
    let entry = this.collections.get(collectionName);
    if (!entry) {
      entry = { spec, postings: new Map() };
      this.collections.set(collectionName, entry);
    } else entry.spec = spec;

    // Clear and rebuild postings for this collection
    entry.postings = new Map();
    for await (const [p, doc] of rebuildFn(collectionName))
      this.#indexDoc(collectionName, p, doc);

    metrics.index.rebuilds++;
    metrics.index.lastRebuildMs = Date.now() - started;
  }

  onPut(pathKey, newDoc, oldDoc) {
    const collectionName = topLevelCollectionOf(pathKey);
    const entry = this.collections.get(collectionName);
    if (!entry) return; // no indexes
    if (oldDoc) this.#unindexDoc(collectionName, pathKey, oldDoc);
    this.#indexDoc(collectionName, pathKey, newDoc);
  }

  onDel(pathKey, oldDoc) {
    const collectionName = topLevelCollectionOf(pathKey);
    const entry = this.collections.get(collectionName);
    if (!entry) return;
    if (oldDoc) this.#unindexDoc(collectionName, pathKey, oldDoc);
  }

  /** Query: returns array of doc paths matching index term in a collection */
  query(collectionName, indexName, term) {
    const c = this.collections.get(collectionName);
    if (!c) return [];
    const m = c.postings.get(indexName);
    if (!m) return [];
    const set = m.get(canonTerm(term));
    if (!set) return [];
    return [...set];
  }

  // ---- internals ----
  #indexDoc(collectionName, pathKey, doc) {
    const entry = this.collections.get(collectionName);
    if (!entry) return;
    const { spec } = entry;
    for (const [indexName, rule] of Object.entries(spec)) {
      const terms = extractTerms(rule, doc);
      if (!terms || !terms.length) continue;
      for (const t of terms) {
        const term = canonTerm(t);
        let idx = entry.postings.get(indexName);
        if (!idx) {
          idx = new Map();
          entry.postings.set(indexName, idx);
        }
        let set = idx.get(term);
        if (!set) {
          set = new Set();
          idx.set(term, set);
        }
        set.add(pathKey);
      }
    }
  }

  #unindexDoc(collectionName, pathKey, doc) {
    const entry = this.collections.get(collectionName);
    if (!entry) return;
    const { spec, postings } = entry;
    for (const [indexName, rule] of Object.entries(spec)) {
      const terms = extractTerms(rule, doc);
      if (!terms || !terms.length) continue;
      const idx = postings.get(indexName);
      if (!idx) continue;
      for (const t of terms) {
        const ct = canonTerm(t);
        const set = idx.get(ct);
        if (!set) continue;
        set.delete(pathKey);
        if (set.size === 0) idx.delete(ct);
      }
      if (idx && idx.size === 0) postings.delete(indexName);
    }
  }
}

function normalizeSpec(settings) {
  const spec = {};
  const idx = settings && settings.indexes ? settings.indexes : {};
  for (const [field, modeDef] of Object.entries(idx)) {
    let mode = modeDef;
    let fold = "none";
    if (modeDef && typeof modeDef === "object") {
      mode = String(modeDef.mode || "").trim();
      fold = modeDef.fold === "lower" ? "lower" : "none";
    } else {
      mode = String(modeDef || "").trim();
    }
    if (!["eq", "contains", "objValue", "objHasKey"].includes(mode)) continue; // ignore unknown
    spec[field] = { field, mode, fold };
  }
  return spec; // { field → {field, mode, fold} }
}

function extractTerms(rule, doc) {
  const value = getField(doc, rule.field);
  const fold = rule.fold || "none";
  const F = (s) =>
    fold === "lower" && typeof s === "string" ? s.toLowerCase() : s;

  switch (rule.mode) {
    case "eq": {
      if (isPrim(value)) return [F(value)];
      return [];
    }
    case "contains": {
      if (Array.isArray(value)) return value.filter(isPrim).map(F);
      return [];
    }
    case "objValue": {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const out = [];
        for (const [k, v] of Object.entries(value))
          if (isPrim(v))
            out.push(`${escapeEq(F(k))}=${escapeEq(String(F(v)))}`);
        return out;
      }
      return [];
    }
    case "objHasKey": {
      if (value && typeof value === "object" && !Array.isArray(value))
        return Object.keys(value).map(F);
      return [];
    }
    default:
      return [];
  }
}
function escapeEq(s) {
  return s.replace(/([=\\])/g, "\\$1");
}

function getField(obj, pathExpr) {
  const steps = String(pathExpr).split(".").filter(Boolean);
  let cur = obj;
  for (const s of steps) {
    if (!cur || typeof cur !== "object" || !(s in cur)) return undefined;
    cur = cur[s];
  }
  return cur;
}

const isPrim = (v) =>
  typeof v === "string" ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v));
const canonTerm = (t) => (typeof t === "number" ? t : String(t));

// -------------------------------- DB Core (2PC + metrics) ----------------------
class BufferStyleNDJSON_DB {
  constructor({ dataDir = DATA_DIR, lockFile = LOCK_FILE } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.lockFile = path.resolve(lockFile);

    // In-memory committed state
    this.docs = new Map(); // key → { doc, version }
    this.dirIndex = new Map(); // collectionPath → { collections:Set, documents:Set }
    this.secIdx = new SecondaryIndexManager();

    // Transactions
    this.txs = new Map();
    this.nextTx = 1;

    // Concurrency
    this.globalMutex = new Mutex();
    this.commitMutexByShard = new Map();

    // Process lock + shard I/O
    this.lockFd = null;
    this.walByShard = new Map();
    this.walPathByShard = new Map();
    this.lastWriteTsByShard = new Map();

    // 2PC commit table
    this.commitTablePath = path.join(this.dataDir, "commit-table.ndjson");
    this.commitTableFH = null;
    this._committedTx = new Map(); // txId → 'PREPARE'|'COMMIT'

    // Background maintenance
    this._checkpointTimer = null;
    this._lastCheckpointAt = 0;
    this._checkpointBusy = false; // shard-serialized checkpointing

    // Group-commit
    this._groupCommitPending = [];
    this._groupCommitTimer = null;
  }

  // Guard + fetch a live transaction
  #requireTx(txId) {
    const tx = this.txs.get(txId);
    if (!tx) throw new Error(`Unknown or closed transaction: ${txId}`);
    return tx;
  }

  // ---------- Lifecycle ----------
  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    try {
      this.lockFd = fs.openSync(
        this.lockFile,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
      );
      fs.writeSync(this.lockFd, String(process.pid));
    } catch (e) {
      throw new Error(`Database lock is held: ${this.lockFile}`);
    }

    // Open and load commit table FIRST (so WAL recovery knows committed txs)
    this.commitTableFH = await fsp.open(
      this.commitTablePath,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_APPEND
    );
    await this.#recoverCommitTable();

    // Recover shards (segments & WAL tail)
    const entries = await fsp.readdir(this.dataDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory() && /^[0-9]+$/.test(ent.name))
        await this.#recoverShard(Number(ent.name));
    }

    // Build secondary indexes for any collections with settings
    await this.#loadAllSettingsAndRebuildIndexes();

    // Start maintenance loop
    this._checkpointTimer = setInterval(
      () => this.#maybeCheckpointAll(),
      Math.max(1500, Math.floor(CHECKPOINT_INTERVAL_MS / 3))
    );
  }

  async close() {
    if (this._checkpointTimer) clearInterval(this._checkpointTimer);
    if (this._groupCommitTimer) clearTimeout(this._groupCommitTimer);
    for (const fh of this.walByShard.values()) await fh.close();
    this.walByShard.clear();
    await this.commitTableFH?.close();
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {}
      try {
        fs.unlinkSync(this.lockFile);
      } catch {}
      this.lockFd = null;
    }
  }

  // ---------- Public API ----------
  get(pathOrCollection, txId) {
    const p = normalize(pathOrCollection);
    if (isCollection(p)) return this.#listCollection(p, txId);
    return this.#readDoc(p, txId);
  }

  // Search using secondary index
  search(collectionName, indexName, term) {
    return this.secIdx.query(collectionName, indexName, term);
  }

  async put(p, doc, txId) {
    const n = normalize(p);
    if (isCollection(n)) throw new Error("PUT requires a document path");
    this.#ensureParentExists(n);
    if (txId) {
      const tx = this.#requireTx(txId);
      tx.puts.set(n, structuredClone(doc));
      tx.dels.delete(n);
      this.#snapshotKey(tx, n);
    } else {
      const t = this.beginTransaction();
      this.put(n, doc, t);
      await this.commit(t);
    }
  }

  async del(p, txId) {
    const n = normalize(p);
    if (isCollection(n)) throw new Error("DEL requires a document path");
    if (txId) {
      const tx = this.#requireTx(txId);
      tx.dels.add(n);
      tx.puts.delete(n);
      this.#snapshotKey(tx, n);
    } else {
      const t = this.beginTransaction();
      this.del(n, t);
      await this.commit(t);
    }
  }

  beginTransaction() {
    const id = this.nextTx++;
    this.txs.set(id, { id, puts: new Map(), dels: new Set(), snap: new Map() });
    metrics.tx.begun++;
    return id;
  }
  rollback(txId) {
    this.#requireTx(txId);
    this.txs.delete(txId);
    metrics.tx.rolledBack++;
  }

  async commit(txId) {
    const started = Date.now();
    const tx = this.#requireTx(txId);
    // OCC
    for (const key of new Set([...tx.puts.keys(), ...tx.dels])) {
      const sv = tx.snap.get(key) ?? 0;
      const cv = this.docs.get(key)?.version ?? 0;
      if (sv !== cv) {
        metrics.tx.conflicts++;
        throw new Error(`Conflict on ${key}: expected v${sv}, found v${cv}`);
      }
    }

    const ts = Date.now();
    const shards = new Map();
    const add = (vsid, rec) => {
      const a = shards.get(vsid) ?? [];
      a.push(rec);
      shards.set(vsid, a);
    };
    for (const [k, v] of tx.puts)
      add(getVirtualShardId(k), { ts, tx: tx.id, op: "PUT", path: k, doc: v });
    for (const k of tx.dels)
      add(getVirtualShardId(k), { ts, tx: tx.id, op: "DEL", path: k });

    // PREPARE
    const shardList = [...shards.keys()];
    await this.#appendCommitTable({
      ts,
      tx: tx.id,
      phase: "PREPARE",
      shards: shardList,
    });
    metrics.twopc.prepares++;

    // Append shard records (group commit)
    await Promise.all(
      shardList.map((vsid) => this.#groupAppend(vsid, shards.get(vsid)))
    );

    // COMMIT
    await this.#appendCommitTable({ ts, tx: tx.id, phase: "COMMIT" });
    metrics.twopc.commits++;

    // Apply to memory + directory + secondary indexes
    await this.globalMutex.lock(async () => {
      for (const [k, v] of tx.puts) {
        const old = this.docs.get(k)?.doc;
        this.#applyPut(k, v);
        if (isSettingsPath(k)) await this.#applySettingsChange(k);
        else this.secIdx.onPut(k, v, old);
      }
      for (const k of tx.dels) {
        const old = this.docs.get(k)?.doc;
        this.#applyDel(k);
        if (isSettingsPath(k))
          await this.#applySettingsChange(k, /*deleted*/ true);
        else this.secIdx.onDel(k, old);
      }
      this.txs.delete(tx.id);
      metrics.tx.committed++;
      recordCommitLatency(Date.now() - started);
    });
  }

  // ---------- Internals: reads & listings ----------
  #readDoc(p, txId) {
    if (txId) {
      const tx = this.#requireTx(txId);
      if (tx.dels.has(p)) return undefined;
      if (tx.puts.has(p)) return structuredClone(tx.puts.get(p));
    }
    const st = this.docs.get(p);
    return st ? structuredClone(st.doc) : undefined;
  }

  #listCollection(collectionPath, txId) {
    const base = normalize(collectionPath);
    if (!isCollection(base)) throw new Error("Collection path must end with /");
    const bucket = this.dirIndex.get(base) || {
      collections: new Set(),
      documents: new Set(),
    };
    const out = {
      collections: [...bucket.collections].sort(),
      documents: [...bucket.documents].sort(),
    };
    if (txId) {
      const tx = this.#requireTx(txId);
      const colls = new Set(out.collections),
        docs = new Set(out.documents);
      for (const k of tx.dels) {
        if (!k.startsWith(base)) continue;
        const child = immediateChild(base, k);
        if (!child.endsWith("/")) docs.delete(child);
      }
      for (const [k, _] of tx.puts) {
        if (!k.startsWith(base)) continue;
        const child = immediateChild(base, k);
        if (child.endsWith("/")) colls.add(child);
        else docs.add(child);
      }
      return { collections: [...colls].sort(), documents: [...docs].sort() };
    }
    return out;
  }

  #updateDirIndexOnPut(key) {
    const parent = parentCollection(key);
    const child = immediateChild(parent, key);
    const bucket = this.dirIndex.get(parent) || {
      collections: new Set(),
      documents: new Set(),
    };
    if (child.endsWith("/")) bucket.collections.add(child);
    else bucket.documents.add(child);
    this.dirIndex.set(parent, bucket);
    metrics.data.docs = this.docs.size;
    metrics.data.collections = this.dirIndex.size;
  }
  #updateDirIndexOnDel(key) {
    const parent = parentCollection(key);
    const child = immediateChild(parent, key);
    const bucket = this.dirIndex.get(parent) || {
      collections: new Set(),
      documents: new Set(),
    };
    if (!child.endsWith("/")) bucket.documents.delete(child);
    this.dirIndex.set(parent, bucket);
    metrics.data.docs = this.docs.size;
    metrics.data.collections = this.dirIndex.size;
  }

  // ---------- Internals: state management ----------
  #applyPut(k, v) {
    const cur = this.docs.get(k);
    const nextV = (cur?.version ?? 0) + 1;
    this.docs.set(k, { doc: deepFreeze(structuredClone(v)), version: nextV });
    this.lastWriteTsByShard.set(getVirtualShardId(k), Date.now());
    this.#updateDirIndexOnPut(k);
  }
  #applyDel(k) {
    if (this.docs.has(k)) this.docs.delete(k);
    this.lastWriteTsByShard.set(getVirtualShardId(k), Date.now());
    this.#updateDirIndexOnDel(k);
  }
  #snapshotKey(tx, key) {
    if (!tx.snap.has(key)) tx.snap.set(key, this.docs.get(key)?.version ?? 0);
  }
  #ensureParentExists(docPath) {
    const parent = parentCollection(docPath);
    if (!isCollection(parent))
      throw new Error("Internal: parent must be collection path");
  }

  // When /<collection>/settings.json changes, refresh secondary indexes for that collection
  async #applySettingsChange(settingsPath, deleted = false) {
    const collection = topLevelCollectionOf(settingsPath);
    if (deleted) {
      this.secIdx.collections.delete(collection);
      return;
    }
    const settings = this.docs.get(settingsPath)?.doc || {};
    const rebuild = async function* (collectionName) {
      const prefix = `/${collectionName}/`;
      for (const [k, st] of this.docs) {
        if (!k.startsWith(prefix)) continue;
        if (k === `/${collectionName}/settings.json`) continue;
        yield [k, st.doc];
      }
    }.bind(this);
    await this.secIdx.updateSpec(collection, settings, rebuild);
  }

  // ---------- 2PC Commit Table ----------
  async #appendCommitTable(rec) {
    const line = JSON.stringify(rec) + "\n";
    await this.commitTableFH.appendFile(line, "utf8");
    await this.commitTableFH.sync();
  }
  async #recoverCommitTable() {
    let data = "";
    try {
      data = await fsp.readFile(this.commitTablePath, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return;
      else throw e;
    }
    const status = new Map();
    for (const line of data.split(/\n+/).filter(Boolean)) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.phase === "PREPARE") status.set(rec.tx, "PREPARE");
      else if (rec.phase === "COMMIT") status.set(rec.tx, "COMMIT");
    }
    this._committedTx = status;
  }

  // ---------- WAL I/O & Group Commit ----------
  async #walHandleFor(vsid) {
    let fh = this.walByShard.get(vsid);
    if (fh) return fh;
    const dir = path.join(this.dataDir, String(vsid));
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, "log.ndjson");
    fh = await fsp.open(
      file,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_APPEND
    );
    this.walByShard.set(vsid, fh);
    this.walPathByShard.set(vsid, file);
    return fh;
  }
  #shardMutex(vsid) {
    let m = this.commitMutexByShard.get(vsid);
    if (!m) {
      m = new Mutex();
      this.commitMutexByShard.set(vsid, m);
    }
    return m;
  }
  async #groupAppend(vsid, records) {
    if (this._groupCommitPending.length > MAX_GROUP_QUEUE) {
      metrics.wal.backpressureRejects++;
      throw new Error("Backpressure: group commit queue full");
    }
    return new Promise((resolve, reject) => {
      this._groupCommitPending.push({ vsid, records, resolve, reject });
      if (!this._groupCommitTimer)
        this._groupCommitTimer = setTimeout(
          () => this.#flushGroupCommit(),
          GROUP_COMMIT_WINDOW_MS
        );
    });
  }
  async #flushGroupCommit() {
    const batch = this._groupCommitPending;
    this._groupCommitPending = [];
    clearTimeout(this._groupCommitTimer);
    this._groupCommitTimer = null;
    const byShard = new Map();
    for (const it of batch) {
      const arr = byShard.get(it.vsid) ?? [];
      arr.push(it);
      byShard.set(it.vsid, arr);
    }
    await Promise.all(
      [...byShard.entries()].map(async ([vsid, items]) => {
        const mutex = this.#shardMutex(vsid);
        await mutex.lock(async () => {
          const fh = await this.#walHandleFor(vsid);
          const pieces = [];
          let bytes = 0;
          for (const it of items) {
            for (const r of it.records) {
              const s = JSON.stringify(r) + "\n";
              const b = Buffer.from(s);
              pieces.push(b);
              bytes += b.length;
            }
          }
          try {
            const buf = Buffer.concat(pieces);
            await fh.appendFile(buf);
            await fh.sync();
            items.forEach((it) => it.resolve());
            metrics.wal.appends += items.reduce(
              (n, it) => n + it.records.length,
              0
            );
            metrics.wal.bytes += bytes;
            metrics.wal.groupFlushes++;
            metrics.wal.batches += items.length;
          } catch (e) {
            items.forEach((it) => it.reject(e));
          }
        });
      })
    );
    metrics.data.shardsTouched = this.walByShard.size;
  }

  // ---------- Recovery: shards, segments, then build indexes ----------
  async #recoverShard(vsid) {
    const dir = path.join(this.dataDir, String(vsid));
    await fsp.mkdir(dir, { recursive: true });

    // 1) Load current collection revisions (segments)
    const collectionsDir = path.join(dir, "collections");
    try {
      const collDirs = await fsp.readdir(collectionsDir, {
        withFileTypes: true,
      });
      for (const cEnt of collDirs) {
        if (!cEnt.isDirectory()) continue;
        await this.#recoverCollectionFromRevision(
          path.join(collectionsDir, cEnt.name)
        );
      }
    } catch (e) {
      if (e?.code !== "ENOENT") throw e;
    }

    // 2) Replay WAL tail (apply only committed)
    const wal = path.join(dir, "log.ndjson");
    let data = "";
    try {
      data = await fsp.readFile(wal, "utf8");
    } catch (e) {
      if (e?.code !== "ENOENT") return;
      else throw e;
    }
    const staged = new Map();
    for (const line of data.split(/\n+/).filter(Boolean)) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.op === "PUT") {
        const s = staged.get(rec.tx) ?? { puts: new Map(), dels: new Set() };
        s.puts.set(rec.path, rec.doc);
        s.dels.delete(rec.path);
        staged.set(rec.tx, s);
      } else if (rec.op === "DEL") {
        const s = staged.get(rec.tx) ?? { puts: new Map(), dels: new Set() };
        s.dels.add(rec.path);
        s.puts.delete(rec.path);
        staged.set(rec.tx, s);
      }
    }
    if (this._committedTx) {
      for (const [tx, s] of staged)
        if (this._committedTx.get(tx) === "COMMIT") {
          for (const [k, v] of s.puts) this.#applyPut(k, v);
          for (const k of s.dels) this.#applyDel(k);
        }
    }
    this.walPathByShard.set(vsid, wal);
  }

  async #recoverCollectionFromRevision(collectionAbsDir) {
    const curLink = path.join(collectionAbsDir, "current");
    let revName;
    try {
      revName = await fsp.readlink(curLink);
    } catch {
      try {
        revName = (
          await fsp.readFile(path.join(collectionAbsDir, "CURRENT"), "utf8")
        ).trim();
      } catch {
        return;
      }
    }
    const revDir = path.join(collectionAbsDir, revName);
    let manifest;
    try {
      manifest = JSON.parse(
        await fsp.readFile(path.join(revDir, "manifest.json"), "utf8")
      );
    } catch {
      return;
    }
    for (const seg of manifest.segments || []) {
      const segPath = path.join(revDir, `${seg.id}.ndjson`);
      let data;
      try {
        data = await fsp.readFile(segPath, "utf8");
      } catch {
        continue;
      }
      for (const line of data.split(/\n+/).filter(Boolean)) {
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!row || !row.path || !("doc" in row)) continue;
        const v = Number.isFinite(row.version) ? Number(row.version) : 1;
        this.docs.set(row.path, { doc: deepFreeze(row.doc), version: v });
        this.#updateDirIndexOnPut(row.path);
      }
    }
  }

  async #loadAllSettingsAndRebuildIndexes() {
    const settingsPaths = [...this.docs.keys()].filter((k) =>
      isSettingsPath(k)
    );
    for (const sp of settingsPaths) await this.#applySettingsChange(sp);
  }

  // ---------- Checkpoint/Compaction & GC ----------
  async #maybeCheckpointAll() {
    if (this._checkpointBusy) {
      metrics.checkpoint.skippedDueToBusy++;
      return;
    }
    const shardIds = new Set(
      [...this.walPathByShard.keys(), ...this.lastWriteTsByShard.keys()].map(
        Number
      )
    );

    // Choose at most one eligible shard per tick (serialized)
    let picked = null;
    for (const vsid of shardIds) {
      const walPath =
        this.walPathByShard.get(vsid) ||
        path.join(this.dataDir, String(vsid), "log.ndjson");
      let st;
      try {
        st = await fsp.stat(walPath);
      } catch {
        continue;
      }
      const tooBig = st.size >= CHECKPOINT_MAX_WAL_BYTES;
      const lastWrite = this.lastWriteTsByShard.get(vsid) || 0;
      const idle = Date.now() - lastWrite >= CHECKPOINT_IDLE_GRACE_MS;
      const timeDue =
        Date.now() - this._lastCheckpointAt >= CHECKPOINT_INTERVAL_MS;
      if ((tooBig && idle) || timeDue) {
        picked = vsid;
        break;
      }
    }
    if (picked === null) return;

    this._checkpointBusy = true;
    const started = Date.now();
    try {
      await this.#checkpointAndCompactShard(picked);
      metrics.checkpoint.runs++;
      const dur = Date.now() - started;
      metrics.checkpoint.totalMs += dur;
      metrics.checkpoint.lastRunAt = new Date().toISOString();
    } catch (e) {
      console.error("checkpoint error", picked, e);
    } finally {
      this._lastCheckpointAt = Date.now();
      this._checkpointBusy = false;
    }
  }

  async #checkpointAndCompactShard(vsid) {
    const snapshot = new Map();
    await this.globalMutex.lock(async () => {
      for (const [k, st] of this.docs.entries())
        if (getVirtualShardId(k) === vsid) snapshot.set(k, st);
    });

    const shardDir = path.join(this.dataDir, String(vsid));
    const collsDir = path.join(shardDir, "collections");
    await fsp.mkdir(collsDir, { recursive: true });
    await fsyncDir(shardDir);

    const byCollection = new Map();
    for (const [key, st] of snapshot) {
      const collectionName = topLevelCollectionOf(key);
      const arr = byCollection.get(collectionName) ?? [];
      arr.push([key, st]);
      byCollection.set(collectionName, arr);
    }

    const ts = Date.now();
    for (const [collectionName, entries] of byCollection) {
      const cDir = path.join(collsDir, collectionName);
      await fsp.mkdir(cDir, { recursive: true });
      await fsyncDir(cDir);
      const revs = (await safeListDir(cDir))
        .filter(
          (d) =>
            d.startsWith("rev-") &&
            fs.statSync(path.join(cDir, d)).isDirectory()
        )
        .map((d) => Number(d.slice(4)))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const nextRev = (revs.at(-1) ?? 0) + 1;
      const revName = `rev-${String(nextRev).padStart(4, "0")}`;
      const revDir = path.join(cDir, revName);
      await fsp.mkdir(revDir, { recursive: true });
      await fsyncDir(cDir);

      const manifest = {
        revision: nextRev,
        createdAt: new Date(ts).toISOString(),
        segments: [],
      };
      let segIndex = 1,
        curLines = [],
        curBytes = 0;
      const flush = async () => {
        if (!curLines.length) return;
        const segId = `seg-${String(segIndex).padStart(3, "0")}`;
        const ndjsonPath = path.join(revDir, `${segId}.ndjson`);
        const idxPath = path.join(revDir, `${segId}.primary.idx`);
        const payload = curLines.join("\n") + "\n";
        await fsp.writeFile(ndjsonPath, payload, "utf8");
        await writePrimaryIndex(idxPath, curLines);
        manifest.segments.push({ id: segId });
        segIndex++;
        curLines = [];
        curBytes = 0;
      };

      for (const [key, st] of entries) {
        const line = JSON.stringify({
          path: key,
          version: st.version,
          doc: st.doc,
        });
        const size = Buffer.byteLength(line) + 1;
        if (curBytes + size > SEGMENT_TARGET_BYTES) await flush();
        curLines.push(line);
        curBytes += size;
      }
      await flush();

      await fsp.writeFile(
        path.join(revDir, "manifest.json"),
        JSON.stringify(manifest, null, 2)
      );
      await fsyncDir(revDir);

      const cur = path.join(cDir, "current");
      const tmp = path.join(cDir, `.current.tmp-${ts}`);
      try {
        await fsp.symlink(revName, tmp);
        await fsp.rename(tmp, cur);
      } catch {
        await fsp.writeFile(path.join(cDir, "CURRENT"), revName, "utf8");
      }
      await fsyncDir(cDir);

      await this.#gcOldRevisions(cDir);
      await fsyncDir(cDir);
    }

    await this.globalMutex.lock(async () => {
      const walFh = this.walByShard.get(vsid);
      const walPath =
        this.walPathByShard.get(vsid) || path.join(shardDir, "log.ndjson");
      if (walFh) {
        await walFh.close();
        this.walByShard.delete(vsid);
      }
      const rotated = path.join(shardDir, `log-${ts}.ndjson`);
      try {
        await fsp.rename(walPath, rotated);
      } catch (e) {
        if (e?.code !== "ENOENT") throw e;
      }
      await fsyncDir(shardDir);
      await this.#walHandleFor(vsid);
    });
    await this.#gcOldRotatedLogs(vsid);
    await fsyncDir(path.join(this.dataDir, String(vsid)));
  }

  async #gcOldRevisions(collectionAbsDir) {
    const entries = await safeListDir(collectionAbsDir);
    const revs = entries
      .filter((n) => n.startsWith("rev-"))
      .map((n) => ({ name: n, num: Number(n.slice(4)) }))
      .filter((o) => Number.isFinite(o.num))
      .sort((a, b) => b.num - a.num);
    const toDelete = revs.slice(GC_KEEP_REVISIONS);
    for (const r of toDelete) await rmrf(path.join(collectionAbsDir, r.name));
  }
  async #gcOldRotatedLogs(vsid) {
    const shardDir = path.join(this.dataDir, String(vsid));
    const files = await safeListDir(shardDir);
    const logs = files
      .filter((n) => /^log-\d+\.ndjson$/.test(n))
      .map((n) => ({ name: n, ts: Number(n.match(/^log-(\d+)\.ndjson$/)[1]) }))
      .sort((a, b) => b.ts - a.ts);
    const toDelete = logs.slice(GC_KEEP_ROTATED_WALS);
    for (const f of toDelete) await rmrf(path.join(shardDir, f.name));
  }
}

// -------------------------------- HTTP Server ----------------------------------
const db = new BufferStyleNDJSON_DB();
await db.init();

let draining = false;
let activeRequests = 0;

function commonHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, must-revalidate");
}

function send(res, code, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}
function notFound(res, msg = "Not Found") {
  send(res, 404, { error: msg });
}
function bad(res, msg) {
  send(res, 400, { error: msg });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = MAX_BODY_BYTES;
    req.on("data", (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    req.on("error", reject);
  });
}

function etagForVersion(v) {
  return `"v${v}"`;
}
function etagForListing(listing) {
  const s = JSON.stringify({ c: listing.collections, d: listing.documents });
  const h = XXH.h64(s, SEED).toString(16);
  return `"lc-${h}"`;
}
function parseExpectVersion(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const qv = url.searchParams.get("expectVersion");
  if (qv != null && qv !== "") {
    const n = Number(qv);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const ifMatch = req.headers["if-match"];
  if (ifMatch) {
    const m = /"?v?(\d+)"?/.exec(ifMatch);
    if (m) return Number(m[1]);
  }
  return undefined;
}

function validateMaxDepth(obj, maxDepth = MAX_JSON_DEPTH) {
  function depth(o, d) {
    if (o === null) return d;
    const t = typeof o;
    if (t !== "object") return d;
    if (d > maxDepth) return Infinity;
    if (Array.isArray(o)) {
      let md = d;
      for (const v of o) md = Math.max(md, depth(v, d + 1));
      return md;
    } else {
      let md = d;
      for (const v of Object.values(o)) md = Math.max(md, depth(v, d + 1));
      return md;
    }
  }
  return depth(obj, 0) <= maxDepth;
}

const server = http.createServer(async (req, res) => {
  const method = req.method || "GET";
  commonHeaders(res);

  if (draining) {
    // Allow GET/HEAD to continue to finish gracefully; reject mutating requests
    if (!["GET", "HEAD"].includes(method)) {
      recordHttp(method, 503);
      return send(res, 503, { error: "Server draining" });
    }
  }

  activeRequests++;
  res.on("finish", () => {
    activeRequests--;
  });

  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = decodeURIComponent(url.pathname);
    const n = normalize(p);

    // Admin metrics
    if (n === "/admin/metrics" && method === "GET") {
      recordHttp(method, 200);
      const { _commitSamples, ...pub } = metrics;
      return send(res, 200, pub);
    }
    if (n === "/healthz" && method === "GET") {
      recordHttp(method, 200);
      return send(res, 200, {
        ok: true,
        now: new Date().toISOString(),
        draining,
      });
    }

    // Optional search endpoint: /<collection>/_search?index=name&term=value
    const parts = n.split("/").filter(Boolean);
    if (
      parts.length === 2 &&
      parts[1] === "_search" &&
      (method === "GET" || method === "HEAD")
    ) {
      const collectionName = parts[0];
      if (!collectionName) {
        recordHttp(method, 400);
        return bad(res, "Collection required");
      }
      const indexName = url.searchParams.get("index");
      const termRaw = url.searchParams.get("term");
      if (!indexName || termRaw === null) {
        recordHttp(method, 400);
        return bad(res, "index and term are required");
      }
      const term =
        isFinite(Number(termRaw)) && String(Number(termRaw)) === termRaw
          ? Number(termRaw)
          : termRaw;
      const paths = db.search(collectionName, indexName, term);
      const payload = { paths };
      if (method === "HEAD") {
        res.writeHead(200);
        return res.end();
      }
      recordHttp(method, 200);
      return send(res, 200, payload);
    }

    switch (method) {
      case "GET":
      case "HEAD": {
        if (isCollection(n)) {
          const listing = db.get(n);
          const et = etagForListing(listing);
          const inm = req.headers["if-none-match"];
          if (inm && (inm === et || inm === et.replace(/"/g, ""))) {
            recordHttp(method, 304);
            res.writeHead(304, { ETag: et });
            return res.end();
          }
          recordHttp(method, 200);
          if (method === "HEAD") {
            res.writeHead(200, { ETag: et });
            return res.end();
          }
          return send(res, 200, listing, { ETag: et });
        }
        const st = db.docs.get(n);
        if (!st) {
          recordHttp(method, 404);
          return notFound(res, "Document not found");
        }
        const et = etagForVersion(st.version);
        const inm = req.headers["if-none-match"];
        if (inm && (inm === et || inm === et.replace(/"/g, ""))) {
          recordHttp(method, 304);
          res.writeHead(304, { ETag: et });
          return res.end();
        }
        recordHttp(method, 200);
        if (method === "HEAD") {
          res.writeHead(200, { ETag: et });
          return res.end();
        }
        return send(res, 200, st.doc, { ETag: et });
      }

      case "PUT":
      case "POST": {
        if (isCollection(n)) {
          recordHttp(method, 400);
          return bad(res, "PUT/POST requires a document path");
        }
        const body = await readBody(req);
        if (!body) {
          recordHttp(method, 400);
          return bad(res, "Empty body");
        }
        let json;
        try {
          json = JSON.parse(body);
        } catch {
          recordHttp(method, 400);
          return bad(res, "Body must be valid JSON");
        }
        if (!validateMaxDepth(json)) {
          recordHttp(method, 400);
          return bad(res, `JSON exceeds max nesting depth ${MAX_JSON_DEPTH}`);
        }

        // OCC via If-Match / expectVersion
        const expectVersion = parseExpectVersion(req);
        if (expectVersion !== undefined) {
          const tx = db.beginTransaction();
          try {
            const cur = db.docs.get(n)?.version ?? 0;
            if (cur !== expectVersion) {
              db.rollback(tx);
              recordHttp(method, 412);
              return send(res, 412, {
                error: `Precondition Failed: expected v${expectVersion}, found v${cur}`,
              });
            }
            await db.put(n, json, tx);
            await db.commit(tx);
          } catch (e) {
            try {
              db.rollback(tx);
            } catch {}
            recordHttp(method, 500);
            return send(res, 500, { error: String(e?.message || e) });
          }
        } else {
          await db.put(n, json); // strict: wait for COMMIT
        }

        const st = db.docs.get(n);
        recordHttp(method, 200);
        return send(
          res,
          200,
          { ok: true, version: st?.version ?? 0 },
          { ETag: etagForVersion(st?.version ?? 0) }
        );
      }

      case "DELETE": {
        if (isCollection(n)) {
          recordHttp(method, 400);
          return bad(res, "DELETE requires a document path");
        }

        // OCC via If-Match / expectVersion
        const expectVersion = parseExpectVersion(req);
        if (expectVersion !== undefined) {
          const tx = db.beginTransaction();
          try {
            const cur = db.docs.get(n)?.version ?? 0;
            if (cur !== expectVersion) {
              db.rollback(tx);
              recordHttp(method, 412);
              return send(res, 412, {
                error: `Precondition Failed: expected v${expectVersion}, found v${cur}`,
              });
            }
            await db.del(n, tx);
            await db.commit(tx);
          } catch (e) {
            try {
              db.rollback(tx);
            } catch {}
            recordHttp(method, 500);
            return send(res, 500, { error: String(e?.message || e) });
          }
        } else {
          await db.del(n); // strict: wait for COMMIT
        }

        recordHttp(method, 200);
        return send(res, 200, { ok: true });
      }

      default: {
        recordHttp(method, 405);
        return send(
          res,
          405,
          { error: "Method Not Allowed" },
          { Allow: "GET,HEAD,PUT,POST,DELETE" }
        );
      }
    }
  } catch (e) {
    console.error(e);
    recordHttp(req.method || "GET", 500);
    send(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(
    `buffer-style-ndjson-db (2PC + secondary indexes + metrics) listening on :${PORT}`
  );
  console.log(`DATA_DIR=${DATA_DIR}`);
});

// Graceful drain
async function initiateDrainAndExit(signal) {
  try {
    console.log(`[drain] received ${signal}, stopping server intake...`);
    draining = true;
    await new Promise((resolve) => server.close(resolve)); // stop accepting new
    console.log("[drain] waiting for in-flight requests...", {
      activeRequests,
    });
    // wait up to a timeout (optional)
    const deadline =
      Date.now() + Number(process.env.DRAIN_TIMEOUT_MS || 30_000);
    while (activeRequests > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    console.log("[drain] closing database...");
    await db.close();
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  initiateDrainAndExit("SIGINT");
});
process.on("SIGTERM", () => {
  initiateDrainAndExit("SIGTERM");
});

// -------------------------------- Helpers --------------------------------------
function deepFreeze(obj) {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
    }
  }
  return obj;
}
async function safeListDir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    else throw e;
  }
}
async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

function isSettingsPath(p) {
  const parts = p.split("/").filter(Boolean);
  return parts.length >= 2 && parts[1] === "settings.json";
}

/** Primary segment index writer */
async function writePrimaryIndex(idxPath, lines) {
  let offsets = new Array(lines.length),
    lengths = new Array(lines.length),
    pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = Buffer.byteLength(lines[i]) + 1;
    offsets[i] = pos;
    lengths[i] = len;
    pos += len;
  }
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!obj || !obj.path) continue;
    const h64 = BigInt("0x" + XXH.h64(obj.path, SEED).toString(16));
    entries.push({
      keyHash: h64,
      offset: BigInt(offsets[i]),
      len: lengths[i] >>> 0,
    });
  }
  entries.sort((a, b) =>
    a.keyHash < b.keyHash ? -1 : a.keyHash > b.keyHash ? 1 : 0
  );
  const buf = Buffer.alloc(20 * entries.length);
  let w = 0;
  for (const e of entries) {
    buf.writeUInt32LE(Number(e.keyHash & 0xffffffffn), w);
    w += 4;
    buf.writeUInt32LE(Number((e.keyHash >> 32n) & 0xffffffffn), w);
    w += 4;
    buf.writeUInt32LE(Number(e.offset & 0xffffffffn), w);
    w += 4;
    buf.writeUInt32LE(Number((e.offset >> 32n) & 0xffffffffn), w);
    w += 4;
    buf.writeUInt32LE(e.len >>> 0, w);
    w += 4;
  }
  await fsp.writeFile(idxPath, buf);
}
