'use strict';
const fs = require('fs');
const path = require('path');

// Tiny document store: collections of JSON objects keyed by id.
// File backend for local use, Postgres backend when DATABASE_URL is set.
class FileStore {
  constructor(file) {
    this.file = file; this.d = {}; this.t = null;
    try { this.d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* new db */ }
  }
  async get(c, id) { return (this.d[c] || {})[id] || null; }
  async put(c, id, o) { (this.d[c] = this.d[c] || {})[id] = o; this._save(); }
  async del(c, id) { if (this.d[c]) delete this.d[c][id]; this._save(); }
  async list(c) { return Object.values(this.d[c] || {}); }
  async find(c, f, v) { return (await this.list(c)).filter(o => o[f] === v); }
  _save() { clearTimeout(this.t); this.t = setTimeout(() => this.flush(), 400); }
  flush() {
    clearTimeout(this.t);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.d));
    fs.renameSync(tmp, this.file);
  }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    const host = new URL(url).hostname;
    const ssl = process.env.DATABASE_SSL === 'true' || (process.env.DATABASE_SSL !== 'false' && host.includes('.') && host !== 'localhost');
    this.p = new Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: false } : false, max: 8 });
  }
  async init() {
    await this.p.query('create table if not exists docs(coll text not null, id text not null, data jsonb not null, primary key(coll,id))');
  }
  async get(c, id) { const r = await this.p.query('select data from docs where coll=$1 and id=$2', [c, id]); return r.rows[0] ? r.rows[0].data : null; }
  async put(c, id, o) {
    await this.p.query('insert into docs(coll,id,data) values($1,$2,$3) on conflict(coll,id) do update set data=excluded.data', [c, id, JSON.stringify(o)]);
  }
  async del(c, id) { await this.p.query('delete from docs where coll=$1 and id=$2', [c, id]); }
  async list(c) { const r = await this.p.query('select data from docs where coll=$1', [c]); return r.rows.map(x => x.data); }
  async find(c, f, v) { const r = await this.p.query('select data from docs where coll=$1 and data->>$2=$3', [c, f, String(v)]); return r.rows.map(x => x.data); }
  flush() {}
}

async function openStore() {
  if (process.env.DATABASE_URL) { const s = new PgStore(process.env.DATABASE_URL); await s.init(); return s; }
  return new FileStore(process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'));
}
module.exports = { openStore };
