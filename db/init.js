const sqlite3 = require('sqlite3').verbose();
const bcrypt  = require('bcryptjs');
const path    = require('path');
const fs      = require('fs');

const DB_PATH = path.join(__dirname, 'forum.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new sqlite3.Database(DB_PATH);

// ─── Async helpers ────────────────────────────────────────
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    raw.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastInsertRowid: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    raw.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    raw.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function execAsync(sql) {
  return new Promise((resolve, reject) => {
    raw.exec(sql, err => { if (err) reject(err); else resolve(); });
  });
}

// ─── db object with async API used by routes ─────────────
const db = {
  run:  (sql, params = []) => runAsync(sql, params),
  get:  (sql, params = []) => getAsync(sql, params),
  all:  (sql, params = []) => allAsync(sql, params),
  exec: (sql)              => execAsync(sql),
};

// ─── Schema ───────────────────────────────────────────────
async function initSchema() {
  await db.run(`PRAGMA journal_mode = WAL`);
  await db.run(`PRAGMA foreign_keys = ON`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      username   TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password   TEXT    NOT NULL,
      role       TEXT    NOT NULL DEFAULT 'member',
      bio        TEXT    NOT NULL DEFAULT '',
      avatar_url TEXT    NOT NULL DEFAULT '',
      reputation INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_seen  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      name_ru     TEXT    NOT NULL DEFAULT '',
      name_uz     TEXT    NOT NULL DEFAULT '',
      description TEXT    NOT NULL DEFAULT '',
      icon        TEXT    NOT NULL DEFAULT 'GEN',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      admin_only  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS threads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cat_id      INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      title       TEXT    NOT NULL,
      body        TEXT    NOT NULL,
      image       TEXT    NOT NULL DEFAULT '',
      pinned      INTEGER NOT NULL DEFAULT 0,
      locked      INTEGER NOT NULL DEFAULT 0,
      is_anonymous INTEGER NOT NULL DEFAULT 0,
      views       INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      body        TEXT    NOT NULL,
      image       TEXT    NOT NULL DEFAULT '',
      is_anonymous INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id  INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(user_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS rep_votes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      value      INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      UNIQUE(from_user, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_threads_cat  ON threads(cat_id);
    CREATE INDEX IF NOT EXISTS idx_threads_user ON threads(user_id);
    CREATE INDEX IF NOT EXISTS idx_threads_pinned ON threads(pinned, cat_id);
    CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id);
    CREATE INDEX IF NOT EXISTS idx_posts_user   ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_posts_thread_created ON posts(thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
    CREATE INDEX IF NOT EXISTS idx_bookmarks_thread ON bookmarks(thread_id);
    CREATE INDEX IF NOT EXISTS idx_rep_votes_to ON rep_votes(to_user);
    CREATE INDEX IF NOT EXISTS idx_rep_votes_post ON rep_votes(post_id);
    CREATE TABLE IF NOT EXISTS banned_words (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      word       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      event_date  INTEGER NOT NULL,
      location    TEXT    NOT NULL DEFAULT '',
      created_by  INTEGER NOT NULL REFERENCES users(id),
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS event_rsvps (
      event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      status      TEXT    NOT NULL DEFAULT 'going',
      UNIQUE(event_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT    NOT NULL DEFAULT 'dm',
      name       TEXT    NOT NULL DEFAULT '',
      avatar_url TEXT    NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS conv_participants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL DEFAULT 'member',
      joined_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_read  INTEGER NOT NULL DEFAULT 0,
      UNIQUE(conv_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      body       TEXT    NOT NULL DEFAULT '',
      image      TEXT    NOT NULL DEFAULT '',
      reply_to_id INTEGER DEFAULT NULL,
      edited     INTEGER NOT NULL DEFAULT 0,
      deleted    INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conv_participants_user ON conv_participants(user_id);
    CREATE INDEX IF NOT EXISTS idx_conv_participants_conv ON conv_participants(conv_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
  `);
  // Migration: add columns if they don't exist yet
  const cols = await db.all(`PRAGMA table_info(categories)`);
  const colNames = cols.map(c => c.name);
  if (!colNames.includes('name_ru'))    await db.run(`ALTER TABLE categories ADD COLUMN name_ru TEXT NOT NULL DEFAULT ''`);
  if (!colNames.includes('name_uz'))    await db.run(`ALTER TABLE categories ADD COLUMN name_uz TEXT NOT NULL DEFAULT ''`);
  if (!colNames.includes('admin_only')) await db.run(`ALTER TABLE categories ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0`);
  await db.run(`UPDATE categories SET admin_only=1 WHERE slug='announcements'`);

  const tcols = await db.all(`PRAGMA table_info(threads)`);
  if (!tcols.map(c=>c.name).includes('image'))
    await db.run(`ALTER TABLE threads ADD COLUMN image TEXT NOT NULL DEFAULT ''`);
  if (!tcols.map(c=>c.name).includes('is_anonymous'))
    await db.run(`ALTER TABLE threads ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0`);
  
  const pcols = await db.all(`PRAGMA table_info(posts)`);
  if (!pcols.map(c=>c.name).includes('image'))
    await db.run(`ALTER TABLE posts ADD COLUMN image TEXT NOT NULL DEFAULT ''`);
  if (!pcols.map(c=>c.name).includes('is_anonymous'))
    await db.run(`ALTER TABLE posts ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0`);

  // Migration: add profile fields to users
  const ucols = await db.all(`PRAGMA table_info(users)`);
  const ucolNames = ucols.map(c => c.name);
  if (!ucolNames.includes('bio'))        await db.run(`ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`);
  if (!ucolNames.includes('avatar_url')) await db.run(`ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''`);
  if (!ucolNames.includes('reputation')) await db.run(`ALTER TABLE users ADD COLUMN reputation INTEGER NOT NULL DEFAULT 0`);

  // Migration: add role to conv_participants
  const cpcols = await db.all(`PRAGMA table_info(conv_participants)`);
  const cpcolNames = cpcols.map(c=>c.name);
  if (!cpcolNames.includes('role'))
    await db.run(`ALTER TABLE conv_participants ADD COLUMN role TEXT NOT NULL DEFAULT 'member'`);

  // Migration: per-user conversation flags (pin / hide)
  if (!cpcolNames.includes('pinned'))
    await db.run(`ALTER TABLE conv_participants ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
  if (!cpcolNames.includes('hidden'))
    await db.run(`ALTER TABLE conv_participants ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);

  // Migration: add reply_to_id to messages
  const mcols = await db.all(`PRAGMA table_info(messages)`);
  if (!mcols.map(c=>c.name).includes('reply_to_id'))
    await db.run(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER DEFAULT NULL`);
}

async function seed() {
  const cats = await db.get('SELECT COUNT(*) as n FROM categories');
  if (cats.n === 0) {
    for (const [slug, name, name_ru, name_uz, desc, icon, ord, admin_only] of [
      ['announcements','Announcements','Объявления','E\'lonlar','Official announcements','ANN',0,1],
      ['general','General','Общее','Umumiy','General discussion','GEN',1,0],
      ['tech','Tech Talk','Технологии','Texnologiya','Hardware, software, Linux','TECH',2,0],
      ['net','Networking','Сеть','Tarmoq','LAN setup, routing, DNS','NET',3,0],
      ['random','Random','Разное','Turli xil','Anything goes','RND',4,0],
    ]) {
      await db.run(
        'INSERT INTO categories(slug,name,name_ru,name_uz,description,icon,sort_order,admin_only) VALUES(?,?,?,?,?,?,?,?)',
        [slug,name,name_ru,name_uz,desc,icon,ord,admin_only]
      );
    }
  }

  const users = await db.get('SELECT COUNT(*) as n FROM users');
  if (users.n === 0) {
    const hash = await bcrypt.hash('56446062Bmw.', 12);
    const r    = await db.run("INSERT INTO users(username,password,role) VALUES('admin',?,'admin')",[hash]);
    const ann  = await db.get("SELECT id FROM categories WHERE slug='announcements'");
    await db.run(
      'INSERT INTO threads(cat_id,user_id,title,body,pinned) VALUES(?,?,?,?,1)',
      [ann.id, r.lastInsertRowid,
       'Welcome to PLOV//CHAN!',
       'PLOV//CHAN — Welcome!\n\nForum is live. Admin account is pre-configured.']
    );
    console.log('\n  ✓ Admin created: username=admin');
    console.log('  ⚠  Default admin account ready.\n');
  }
}

db.initialize = async function() {
  await initSchema();
  await seed();
};

module.exports = db;
