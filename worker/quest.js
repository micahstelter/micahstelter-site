/**
 * Character Quest — /api/quest, backed by D1 (the same BPC_DB database).
 *
 * The Stelter kids' character-points tracker. Anyone with the link can READ
 * (the kids look at their badges on a family iPad with no sign-in); only a
 * parent can WRITE, and the server — not the page — enforces that.
 *
 * HOW PARENTS SIGN IN. A parent PIN, hashed with PBKDF2 and stored in D1.
 * Entering it returns a random device token, which the page keeps in
 * localStorage; every write carries it. "Kid mode" is simply a device with no
 * token. Lizzie needs no Google account and no Cloudflare Access policy edit.
 * Wrong PINs are rate-limited for the whole troop: 8 misses inside 15 minutes
 * locks unlocking for 15 minutes.
 *
 * BOOTSTRAP. Until a PIN exists, the first caller may set one. The page is
 * unlisted and the PIN is set the same day it ships, so that window is minutes.
 *
 * DATA SHAPE. Documents keyed (coll, id) with JSON bodies, mirroring the
 * Claude artifact this replaced. Every write stamps a global, monotonically
 * increasing seq, and deletes leave a tombstone, so the page can poll with
 * ?since=<seq> and receive only what changed.
 */

const COLLS = new Set(['kids', 'deeds', 'rewards', 'log', 'settings']);
const MAX_BYTES = 256 * 1024;
const MAX_OPS = 100;
const TOKEN_DAYS = 365;
const FAIL_LIMIT = 8;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const PBKDF2_ITER = 100000;
const WHO = new Set(['Dad', 'Mom']);

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS quest_docs (
          coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL,
          PRIMARY KEY (coll, id))`),
        db.prepare('CREATE INDEX IF NOT EXISTS quest_docs_seq ON quest_docs (seq)'),
        db.prepare('CREATE TABLE IF NOT EXISTS quest_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
        db.prepare(`CREATE TABLE IF NOT EXISTS quest_tokens (
          hash TEXT PRIMARY KEY, who TEXT NOT NULL, created TEXT NOT NULL, expires INTEGER NOT NULL)`),
        db.prepare("INSERT INTO quest_meta (k, v) VALUES ('seq', '0') ON CONFLICT(k) DO NOTHING"),
      ])
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function pbkdf2(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
function randomHex(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return hex(b); }

async function meta(db, k) {
  const row = await db.prepare('SELECT v FROM quest_meta WHERE k = ?').bind(k).first();
  return row ? row.v : null;
}
const setMeta = (db, k, v) =>
  db.prepare('INSERT INTO quest_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v));

async function issueToken(db, who) {
  const token = randomHex(32);
  await db.prepare('INSERT INTO quest_tokens (hash, who, created, expires) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), who, new Date().toISOString(), Date.now() + TOKEN_DAYS * 864e5).run();
  return token;
}
async function tokenWho(db, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db.prepare('SELECT who, expires FROM quest_tokens WHERE hash = ?').bind(await sha256(token)).first();
  return row && row.expires > Date.now() ? row.who : null;
}

/* Rate limit on wrong PINs. Read-then-write is fine here: the worst a race
   does is let one or two extra guesses through out of 10,000+. */
async function lockedOut(db) {
  const until = Number(await meta(db, 'lock_until')) || 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}
async function recordFail(db) {
  const start = Number(await meta(db, 'fail_start')) || 0;
  let count = Number(await meta(db, 'fail_count')) || 0;
  const now = Date.now();
  const fresh = now - start > FAIL_WINDOW_MS;
  count = fresh ? 1 : count + 1;
  const stmts = [setMeta(db, 'fail_count', count)];
  if (fresh) stmts.push(setMeta(db, 'fail_start', now));
  if (count >= FAIL_LIMIT) stmts.push(setMeta(db, 'lock_until', now + FAIL_WINDOW_MS), setMeta(db, 'fail_count', 0));
  await db.batch(stmts);
}
async function checkPin(db, pin) {
  const hash = await meta(db, 'pin_hash');
  const salt = await meta(db, 'pin_salt');
  if (!hash || !salt) return false;
  return (await pbkdf2(pin, salt)) === hash;
}
async function setPin(db, pin) {
  const salt = randomHex(16);
  await db.batch([
    setMeta(db, 'pin_salt', salt),
    setMeta(db, 'pin_hash', await pbkdf2(pin, salt)),
    db.prepare('DELETE FROM quest_tokens'),   // a new PIN signs every device out
  ]);
}

const validPin = (p) => typeof p === 'string' && /^\d{4,8}$/.test(p);
const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(s);

export async function handleQuest(request, env) {
  const db = env.BPC_DB;
  if (!db) return json({ error: 'storage_unbound' }, 503);
  await ensureSchema(db);

  if (request.method === 'GET') {
    const since = Math.max(0, Number(new URL(request.url).searchParams.get('since')) || 0);
    const rows = await db.prepare('SELECT coll, id, data, deleted, seq FROM quest_docs WHERE seq > ? ORDER BY seq').bind(since).all();
    const seq = Number(await meta(db, 'seq')) || 0;
    const docs = rows.results.map((r) => ({
      coll: r.coll, id: r.id, deleted: !!r.deleted, data: r.deleted ? null : JSON.parse(r.data),
    }));
    const who = await tokenWho(db, request);
    return json({ seq, docs, pinSet: !!(await meta(db, 'pin_hash')), parent: who });
  }

  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: 'too_large' }, 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad_json' }, 400); }
  const action = body && body.action;

  if (action === 'unlock') {
    const wait = await lockedOut(db);
    if (wait) return json({ error: 'locked_out', wait }, 429);
    if (!validPin(body.pin) || !(await checkPin(db, body.pin))) {
      await recordFail(db);
      return json({ error: 'wrong_pin' }, 401);
    }
    await db.batch([setMeta(db, 'fail_count', 0)]);
    const who = WHO.has(body.who) ? body.who : 'Parent';
    return json({ ok: true, token: await issueToken(db, who), who });
  }

  if (action === 'lock') {
    const auth = request.headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (token) await db.prepare('DELETE FROM quest_tokens WHERE hash = ?').bind(await sha256(token)).run();
    return json({ ok: true });
  }

  if (action === 'setpin') {
    if (!validPin(body.pin)) return json({ error: 'bad_pin' }, 400);
    const exists = !!(await meta(db, 'pin_hash'));
    if (exists && !(await tokenWho(db, request))) return json({ error: 'unauthorized' }, 401);
    await setPin(db, body.pin);
    const who = WHO.has(body.who) ? body.who : 'Parent';
    return json({ ok: true, token: await issueToken(db, who), who });
  }

  if (action === 'write') {
    const who = await tokenWho(db, request);
    if (!who) return json({ error: 'unauthorized' }, 401);
    const ops = Array.isArray(body.ops) ? body.ops : [];
    if (!ops.length || ops.length > MAX_OPS) return json({ error: 'bad_ops' }, 400);
    for (const o of ops) {
      if (!COLLS.has(o.coll) || !validId(o.id) || !['set', 'update', 'delete'].includes(o.op)) return json({ error: 'bad_op', op: o }, 400);
      if (o.op !== 'delete' && (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data))) return json({ error: 'bad_data', op: o }, 400);
    }
    // One transaction: bump seq by n, then stamp each op with its own slot.
    const n = ops.length;
    const stmts = [db.prepare("UPDATE quest_meta SET v = CAST(v AS INTEGER) + ? WHERE k = 'seq'").bind(n)];
    ops.forEach((o, i) => {
      const seqExpr = `(SELECT CAST(v AS INTEGER) FROM quest_meta WHERE k = 'seq') - ${n - 1 - i}`;
      const data = o.op === 'delete' ? '{}' : JSON.stringify(o.coll === 'log' ? { ...o.data, by: who } : o.data);
      if (o.op === 'set') {
        stmts.push(db.prepare(`INSERT INTO quest_docs (coll, id, data, deleted, seq) VALUES (?, ?, ?, 0, ${seqExpr})
          ON CONFLICT(coll, id) DO UPDATE SET data = excluded.data, deleted = 0, seq = excluded.seq`).bind(o.coll, o.id, data));
      } else if (o.op === 'update') {
        stmts.push(db.prepare(`UPDATE quest_docs SET data = json_patch(data, ?), seq = ${seqExpr} WHERE coll = ? AND id = ? AND deleted = 0`)
          .bind(data, o.coll, o.id));
      } else {
        stmts.push(db.prepare(`UPDATE quest_docs SET data = '{}', deleted = 1, seq = ${seqExpr} WHERE coll = ? AND id = ?`).bind(o.coll, o.id));
      }
    });
    await db.batch(stmts);
    return json({ ok: true, seq: Number(await meta(db, 'seq')) || 0, who });
  }

  return json({ error: 'unknown_action' }, 400);
}
