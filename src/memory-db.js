import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { normalize, terms, ftsQuery } from "./memory-text.js";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const owner = (value) => (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));

function readLegacy(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`[memory] migration refused: cannot read/parse ${file} (${error.code || error.name}). Source preserved; restore it before retrying.`);
  }
}

function validRecord(record, file) {
  if (!object(record) || typeof record.id !== "string" || !record.id ||
      typeof record.text !== "string" || !record.text.trim() ||
      !Number.isFinite(record.ts)) {
    throw new Error(`[memory] migration refused: malformed record in ${file}. Source preserved.`);
  }
}

function factRow(row) {
  return { ...JSON.parse(row.payload), lastSeen: row.last_seen, lastUsed: row.last_used, confirmed: row.confirmed === 1 };
}

export class MemoryDatabase {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, "memory.sqlite");
    const cutoverFile = join(dataDir, "memory.sqlite.cutover");
    if (existsSync(cutoverFile) && !existsSync(file)) {
      throw new Error("[memory] SQLite disappeared after cutover. Restore a database backup; refusing to reimport stale JSON.");
    }
    this.db = new DatabaseSync(file);
    this.depth = 0;
    try {
      chmodSync(file, 0o600);
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.transaction(() => {
        const version = this.db.prepare("PRAGMA user_version").get().user_version;
        if (version > 3) throw new Error("[memory] database schema is newer than this bot; refusing to open it.");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS memory_records (
            rowid INTEGER PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('fact', 'daily')),
            scope TEXT NOT NULL CHECK(scope IN ('user', 'channel', 'dm')),
            owner_id TEXT NOT NULL,
            channel_id TEXT NOT NULL DEFAULT '',
            day TEXT NOT NULL DEFAULT '',
            id TEXT NOT NULL,
            ts REAL NOT NULL,
            text TEXT NOT NULL,
            normalized TEXT NOT NULL,
            search_text TEXT NOT NULL,
            payload TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
            UNIQUE(kind, scope, owner_id, channel_id, day, id)
          );
          CREATE INDEX IF NOT EXISTS memory_owner ON memory_records(kind, scope, owner_id);
          CREATE INDEX IF NOT EXISTS memory_daily ON memory_records(kind, owner_id, channel_id, day);
          CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            search_text, content='memory_records', content_rowid='rowid',
            tokenize="unicode61 remove_diacritics 0 tokenchars '+#._-'"
          );
          CREATE TRIGGER IF NOT EXISTS memory_insert AFTER INSERT ON memory_records BEGIN
            INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
          END;
          CREATE TRIGGER IF NOT EXISTS memory_delete AFTER DELETE ON memory_records BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
          END;
          CREATE TRIGGER IF NOT EXISTS memory_update AFTER UPDATE OF search_text ON memory_records BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
            INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
          END;
        `);
        if (!this.db.prepare("PRAGMA table_info(memory_records)").all().some((column) => column.name === "pinned")) {
          this.db.exec("ALTER TABLE memory_records ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1))");
          this.db.exec("UPDATE memory_records SET pinned = 1 WHERE json_extract(payload, '$.pinned') = 1");
        }
        const columns = new Set(this.db.prepare("PRAGMA table_info(memory_records)").all().map((column) => column.name));
        if (!columns.has("last_seen")) {
          this.db.exec(`ALTER TABLE memory_records ADD COLUMN last_seen REAL;
            ALTER TABLE memory_records ADD COLUMN last_used REAL;
            ALTER TABLE memory_records ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 1 CHECK(confirmed IN (0, 1));
            UPDATE memory_records SET last_seen = ts;`);
        }
        this.db.exec(`CREATE INDEX IF NOT EXISTS memory_profile ON memory_records(kind, scope, owner_id, pinned DESC, ts);
          CREATE INDEX IF NOT EXISTS memory_normalized ON memory_records(kind, scope, owner_id, normalized);
          PRAGMA user_version = 3;`);
        if (!this.db.prepare("SELECT 1 FROM memory_meta WHERE key = 'legacy_json_v1'").get()) {
          if (existsSync(cutoverFile)) throw new Error("[memory] SQLite cutover marker exists but database migration state is missing; restore a database backup.");
          this.importLegacy(dataDir);
          this.db.prepare("INSERT INTO memory_meta VALUES ('legacy_json_v1', ?)").run(new Date().toISOString());
        }
      });
      try {
        writeFileSync(cutoverFile, "legacy_json_v1\n", { mode: 0o600, flag: "wx", flush: true });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction(fn) {
    if (this.depth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  insert(kind, scope, ownerId, entry, channelId = "", day = "") {
    this.db.prepare(`INSERT INTO memory_records
      (kind, scope, owner_id, channel_id, day, id, ts, text, normalized, search_text, payload, pinned, last_seen, confirmed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(kind, scope, String(ownerId), String(channelId), day, entry.id, entry.ts,
        entry.text, normalize(entry.text), terms(entry.text).join(" "), JSON.stringify(entry), entry.pinned === true ? 1 : 0,
        entry.ts, entry.confirmed === false ? 0 : 1);
  }

  importRecord(file, index, reservedIds, kind, scope, ownerId, entry, channelId = "", day = "") {
    const exists = (id) => this.db.prepare(`SELECT 1 FROM memory_records WHERE kind = ? AND scope = ?
      AND owner_id = ? AND channel_id = ? AND day = ? AND id = ?`)
      .get(kind, scope, String(ownerId), String(channelId), day, id);
    if (exists(entry.id)) {
      const legacyId = entry.id;
      const hash = createHash("sha256").update(JSON.stringify([basename(file), index, kind, scope, ownerId, channelId, day, entry])).digest("hex").slice(0, 16);
      let id = `${legacyId}~${hash}`;
      for (let suffix = 1; reservedIds.has(id) || exists(id); suffix++) id = `${legacyId}~${hash}-${suffix}`;
      entry = { ...entry, id, legacyId };
      console.warn(`[memory] reassigned duplicate legacy ID ${JSON.stringify(legacyId)} in ${file}; scope=${scope}, owner=${JSON.stringify(String(ownerId))}, channel=${JSON.stringify(String(channelId))}, record=${index + 1}, newId=${JSON.stringify(id)}. Both records preserved.`);
    }
    this.insert(kind, scope, ownerId, entry, channelId, day);
  }

  importLegacy(dataDir) {
    const file = join(dataDir, "memory.json");
    const document = readLegacy(file);
    if (document === undefined && readdirSync(dataDir).some((name) => name.startsWith("memory.json.corrupt-"))) {
      throw new Error("[memory] migration refused: restore quarantined memory.json before retrying.");
    }
    if (document !== undefined) {
      if (!object(document) || (Object.keys(document).length && !("users" in document) && !("channels" in document))) {
        throw new Error(`[memory] migration refused: malformed store ${file}.`);
      }
      for (const [key, scope] of [["users", "user"], ["channels", "channel"]]) {
        if (document[key] === undefined) continue;
        if (!object(document[key])) throw new Error(`[memory] migration refused: malformed ${key} in ${file}.`);
        for (const [ownerId, entries] of Object.entries(document[key])) {
          if (!ownerId || !Array.isArray(entries)) throw new Error(`[memory] migration refused: malformed owner in ${file}.`);
          const reservedIds = new Set(entries.map((entry) => entry?.id));
          for (const [index, entry] of entries.entries()) {
            validRecord(entry, file);
            this.importRecord(file, index, reservedIds, "fact", scope, ownerId, entry);
          }
        }
      }
    }
    const dailyDir = join(dataDir, "memory");
    let names;
    try { names = readdirSync(dailyDir); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      names = [];
    }
    if (names.some((name) => /\.json\.corrupt-/.test(name))) {
      throw new Error("[memory] migration refused: restore quarantined daily notes before retrying.");
    }
    for (const name of names.sort()) {
      const match = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (!match) continue;
      const path = join(dailyDir, name);
      const day = match[1];
      if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error(`[memory] invalid daily date: ${name}`);
      const daily = readLegacy(path);
      const records = Array.isArray(daily) ? daily : daily?.records;
      if (!Array.isArray(records)) throw new Error(`[memory] migration refused: malformed daily file ${path}.`);
      const reservedIds = new Set(records.map((record) => record?.id));
      for (const [index, record] of records.entries()) {
        validRecord(record, path);
        if (!owner(record.userId) || !owner(record.channelId) || (record.date && record.date !== day)) {
          throw new Error(`[memory] migration refused: invalid ownership/date in ${path}.`);
        }
        this.importRecord(path, index, reservedIds, "daily", "dm", record.userId, { ...record, date: day }, record.channelId, day);
      }
    }
    const collisions = this.db.prepare(`SELECT count(*) AS count FROM (
      SELECT 1 FROM memory_records WHERE kind = 'fact'
      GROUP BY scope, owner_id, normalized HAVING count(*) > 1
    )`).get().count;
    if (collisions) console.warn(`[memory] imported ${collisions} normalized duplicate groups; all records preserved. Use compactMemory explicitly to deduplicate.`);
  }

  list(scope, ownerId) {
    if (ownerId == null) return [];
    return this.db.prepare(`SELECT payload, last_seen, last_used, confirmed FROM memory_records WHERE kind = 'fact'
      AND scope = ? AND owner_id = ? ORDER BY rowid`).all(scope, String(ownerId)).map(factRow);
  }

  fact(scope, ownerId, id) {
    const row = this.db.prepare(`SELECT payload, last_seen, last_used, confirmed FROM memory_records WHERE kind = 'fact'
      AND scope = ? AND owner_id = ? AND id = ?`).get(scope, String(ownerId), String(id));
    return row ? factRow(row) : null;
  }

  sameFacts(scope, ownerId, text) {
    return this.db.prepare(`SELECT payload, last_seen, last_used, confirmed FROM memory_records WHERE kind = 'fact'
      AND scope = ? AND owner_id = ? AND normalized = ? ORDER BY rowid`).all(scope, String(ownerId), normalize(text)).map(factRow);
  }

  reassert(scope, ownerId, id, pinned) {
    this.db.prepare(`UPDATE memory_records SET last_seen = ?, confirmed = 1,
      pinned = max(pinned, ?), payload = CASE WHEN ? = 1 THEN json_set(payload, '$.pinned', json('true')) ELSE payload END
      WHERE kind = 'fact' AND scope = ? AND owner_id = ? AND id = ?`)
      .run(Date.now(), pinned ? 1 : 0, pinned ? 1 : 0, scope, String(ownerId), String(id));
  }

  revise(scope, ownerId, id, text) {
    return this.db.prepare(`UPDATE memory_records SET text = ?, normalized = ?, search_text = ?,
      payload = json_set(payload, '$.text', ?), last_seen = ?, confirmed = 1
      WHERE kind = 'fact' AND scope = ? AND owner_id = ? AND id = ?`)
      .run(text, normalize(text), terms(text).join(" "), text, Date.now(), scope, String(ownerId), String(id)).changes > 0;
  }

  setConfirmed(scope, ownerId, id, confirmed) {
    return this.db.prepare("UPDATE memory_records SET confirmed = ? WHERE kind = 'fact' AND scope = ? AND owner_id = ? AND id = ?")
      .run(confirmed ? 1 : 0, scope, String(ownerId), String(id)).changes > 0;
  }

  markUsed(records, at = Date.now()) {
    const statement = this.db.prepare(`UPDATE memory_records SET last_used = ?
      WHERE kind = 'fact' AND scope = ? AND owner_id = ? AND id = ? AND (last_used IS NULL OR last_used < ?)`);
    this.transaction(() => {
      for (const { scope, ownerId, id } of records) statement.run(at, scope, String(ownerId), String(id), at - 3_600_000);
    });
  }

  recentDaily(userId, sinceDay, limit) {
    return this.db.prepare(`SELECT id, day, text FROM memory_records WHERE kind = 'daily' AND owner_id = ? AND day >= ?
      ORDER BY ts DESC, rowid DESC LIMIT ?`).all(String(userId), sinceDay, limit);
  }

  meta(key) {
    return this.db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO memory_meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  forget(scope, ownerId, id) {
    return this.db.prepare("DELETE FROM memory_records WHERE kind = 'fact' AND scope = ? AND owner_id = ? AND id = ?")
      .run(scope, String(ownerId), String(id)).changes > 0;
  }

  pin(scope, ownerId, id, pinned) {
    return this.db.prepare(`UPDATE memory_records SET pinned = ?, payload = json_set(payload, '$.pinned', json(?))
      WHERE kind = 'fact' AND scope = ? AND owner_id = ? AND id = ?`)
      .run(pinned ? 1 : 0, pinned ? "true" : "false", scope, String(ownerId), String(id)).changes > 0;
  }

  coreFacts(userId) {
    return this.db.prepare(`SELECT payload, last_seen, last_used, confirmed FROM memory_records WHERE kind = 'fact' AND scope = 'user' AND owner_id = ?
      AND (pinned = 1 OR confirmed = 1)
      ORDER BY pinned DESC, CASE WHEN normalized LIKE 'my name is %' OR normalized LIKE 'my time%zone is %'
        OR normalized LIKE 'i prefer %' THEN 0 ELSE 1 END, ts, rowid LIMIT 50`)
      .all(String(userId)).map(factRow);
  }

  search({ userId, channelId, isDm, queryTerms, cutoff }) {
    if (!queryTerms.length) return [];
    return this.db.prepare(`SELECT r.* FROM memory_fts JOIN memory_records r ON r.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ? AND (
        (kind = 'fact' AND scope = 'user' AND owner_id = ?) OR
        (kind = 'fact' AND scope = 'channel' AND owner_id = ?) OR
        (? = 1 AND kind = 'daily' AND owner_id = ? AND channel_id = ? AND day >= ?)
      )`).all(ftsQuery(queryTerms), String(userId ?? ""), String(channelId ?? ""),
      isDm ? 1 : 0, String(userId ?? ""), String(channelId ?? ""), cutoff)
      .map((row) => ({ ...JSON.parse(row.payload), scope: row.scope, ownerId: row.owner_id, confirmed: row.confirmed === 1,
        source: row.kind === "fact" ? "durable" : "daily",
        citation: row.kind === "fact" ? `[memory:${row.scope}:${row.id}]` : `[daily:${row.day}:${row.id}]`,
      }));
  }

  pruneDaily(userId, channelId, day, cutoff, maxRecords) {
    this.db.prepare("DELETE FROM memory_records WHERE kind = 'daily' AND owner_id = ? AND channel_id = ? AND day < ?")
      .run(String(userId), String(channelId), cutoff);
    this.db.prepare(`DELETE FROM memory_records WHERE rowid IN (
      SELECT rowid FROM memory_records WHERE kind = 'daily' AND owner_id = ? AND channel_id = ? AND day = ?
      ORDER BY ts DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(String(userId), String(channelId), day, maxRecords);
  }

  close() { this.db.close(); }
}
