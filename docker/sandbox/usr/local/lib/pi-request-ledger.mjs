import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, openSync } from "node:fs";

function requestError(message, statusCode = 409, name = "Error") {
  return Object.assign(new Error(message), { statusCode, name });
}

export class PromptRequestLedger {
  #db;
  #active = new Map();

  constructor(path) {
    if (path !== ":memory:") {
      closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async run(id, fingerprint, work) {
    const row = this.#db.prepare("SELECT * FROM requests WHERE id = ?").get(id);
    if (row) {
      if (row.fingerprint !== fingerprint) throw requestError("request ID was already used with a different prompt");
      const active = this.#active.get(id);
      if (active) return active;
      if (row.status === "done") return JSON.parse(row.result);
      if (row.status === "failed") {
        const error = JSON.parse(row.result);
        throw Object.assign(requestError(error.message, error.statusCode, error.name), { replayed: true });
      }
      throw requestError("previous prompt was interrupted; it will not be submitted again automatically");
    }
    this.#db.prepare("DELETE FROM requests WHERE status != 'running' AND updated_at < ?").run(Date.now() - 7 * 24 * 3600_000);
    this.#db.prepare("DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE status != 'running' ORDER BY updated_at DESC LIMIT -1 OFFSET 512)").run();
    this.#db.prepare("INSERT INTO requests (id, fingerprint, status, updated_at) VALUES (?, ?, 'running', ?)").run(id, fingerprint, Date.now());
    const pending = Promise.resolve().then(work).then(
      (result) => {
        this.#db.prepare("UPDATE requests SET status = 'done', result = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(result), Date.now(), id);
        return result;
      },
      (error) => {
        const stored = { message: error.message || String(error), name: error.name || "Error", statusCode: error.statusCode || 500 };
        this.#db.prepare("UPDATE requests SET status = 'failed', result = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(stored), Date.now(), id);
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
