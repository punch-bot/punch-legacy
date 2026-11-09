import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, openSync } from "node:fs";

function requestError(message, statusCode = 409, name = "Error") {
  return Object.assign(new Error(message), { statusCode, name });
}

function replay(entry) {
  if (entry.status === "done") return JSON.parse(entry.result);
  const error = JSON.parse(entry.result);
  throw Object.assign(requestError(error.message, error.statusCode, error.name), { replayed: true });
}

export class PromptRequestLedger {
  #db;
  #active = new Map();
  #unpersisted = new Map();

  constructor(path) {
    if (path !== ":memory:") {
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 0;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async #save(id, entry) {
    this.#unpersisted.set(id, entry);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.#db.prepare("UPDATE requests SET status = ?, result = ?, updated_at = ? WHERE id = ?").run(entry.status, entry.result, Date.now(), id);
        this.#unpersisted.delete(id);
        return;
      } catch {
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    console.error("[pi-gateway] request result could not be persisted; retaining it in memory and refusing unsafe replay after restart");
  }

  async run(id, fingerprint, work) {
    const saved = this.#unpersisted.get(id);
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw requestError("request ID was already used with a different prompt");
      await this.#save(id, saved);
      return replay(saved);
    }
    const row = this.#db.prepare("SELECT * FROM requests WHERE id = ?").get(id);
    if (row) {
      if (row.fingerprint !== fingerprint) throw requestError("request ID was already used with a different prompt");
      const active = this.#active.get(id);
      if (active) return active;
      if (row.status === "done" || row.status === "failed") return replay(row);
      throw requestError("previous prompt was interrupted; it will not be submitted again automatically");
    }
    this.#db.prepare("DELETE FROM requests WHERE status != 'running' AND updated_at < ?").run(Date.now() - 7 * 24 * 3600_000);
    this.#db.prepare("INSERT INTO requests (id, fingerprint, status, updated_at) VALUES (?, ?, 'running', ?)").run(id, fingerprint, Date.now());
    const pending = Promise.resolve().then(work).then(
      async (result) => {
        await this.#save(id, { fingerprint, status: "done", result: JSON.stringify(result) });
        return result;
      },
      async (error) => {
        const stored = { message: error.message || String(error), name: error.name || "Error", statusCode: error.statusCode || 500 };
        await this.#save(id, { fingerprint, status: "failed", result: JSON.stringify(stored) });
        throw error;
      },
    ).finally(() => this.#active.delete(id));
    this.#active.set(id, pending);
    return pending;
  }

  close() {
    this.#db.close();
  }
}
