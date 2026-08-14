/**
 * BPC Momentum sync API — /api/bpc, backed by D1.
 *
 * WHY D1 AND NOT KV. The first attempt at this used Workers KV and was reverted.
 * KV cannot express compare-and-swap: the handler had to read the revision,
 * compare it, then write, and two devices saving close together could both pass
 * the check and both be told "Saved" while one silently overwrote the other.
 * KV's edge read caching widened that window to about a minute after any write.
 *
 * D1 is a single-primary SQLite database, so the swap is one statement:
 *
 *     UPDATE store SET data=?, rseq=rseq+1 WHERE id=1 AND rseq=?
 *
 * If another device already moved the revision on, the WHERE matches nothing,
 * `meta.changes` is 0, and we return 409 with the current copy for the client to
 * merge. There is no window in which both writers can win.
 *
 * The server never merges. Reconciliation lives in the browser, which already
 * owns that logic for two tabs on one machine — one implementation, not two.
 */

const MAX_BYTES = 2 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/** Length-independent comparison, so timing reveals nothing about the secret. */
function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length, 1);
  for (let i = 0; i < n; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

const bearer = (request) => {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
};

// One CREATE per isolate rather than per request.
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS store (
           id         INTEGER PRIMARY KEY CHECK (id = 1),
           data       TEXT    NOT NULL,
           rseq       INTEGER NOT NULL,
           updated_at TEXT    NOT NULL
         )`
      )
      .run()
      .catch((e) => {
        schemaReady = null;   // let the next request retry rather than wedging the isolate
        throw e;
      });
  }
  return schemaReady;
}

export async function handleBpc(request, env) {
  if (!env.BPC_DB) {
    return json({ error: 'storage_unbound', message: 'The database is not connected to this site yet.' }, 503);
  }
  if (!env.BPC_SECRET) {
    return json({ error: 'secret_unset', message: 'The sync passphrase has not been set on the server yet.' }, 503);
  }
  // Auth before any database work, so an unauthenticated flood costs no queries.
  if (!secretMatches(bearer(request), env.BPC_SECRET)) {
    return json({ error: 'unauthorized', message: 'Wrong or missing passphrase.' }, 401);
  }

  await ensureSchema(env.BPC_DB);

  if (request.method === 'GET') {
    const row = await env.BPC_DB.prepare('SELECT data, rseq, updated_at FROM store WHERE id = 1').first();
    if (!row) return json({ store: null, rseq: 0 });
    let store = null;
    try { store = JSON.parse(row.data); } catch (_) { store = null; }
    return json({ store, rseq: row.rseq, updatedAt: row.updated_at });
  }

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'too_large' }, 413);

    let body;
    try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad_json' }, 400); }
    if (!body || typeof body.store !== 'object' || body.store === null) {
      return json({ error: 'bad_body', message: 'Expected { store, baseRseq }.' }, 400);
    }

    const payload = JSON.stringify(body.store);
    const base = Number.isFinite(body.baseRseq) ? body.baseRseq : 0;
    const now = new Date().toISOString();

    // First write ever. ON CONFLICT DO NOTHING makes the create race safe too:
    // whoever loses it simply falls through to the UPDATE path below.
    if (base === 0) {
      const ins = await env.BPC_DB
        .prepare('INSERT INTO store (id, data, rseq, updated_at) VALUES (1, ?, 1, ?) ON CONFLICT(id) DO NOTHING')
        .bind(payload, now)
        .run();
      if (ins.meta.changes === 1) return json({ ok: true, rseq: 1, updatedAt: now });
    }

    // The compare-and-swap. Matches nothing if another device already moved on.
    const upd = await env.BPC_DB
      .prepare('UPDATE store SET data = ?, rseq = rseq + 1, updated_at = ? WHERE id = 1 AND rseq = ?')
      .bind(payload, now, base)
      .run();

    if (upd.meta.changes === 1) {
      return json({ ok: true, rseq: base + 1, updatedAt: now });
    }

    const row = await env.BPC_DB.prepare('SELECT data, rseq, updated_at FROM store WHERE id = 1').first();
    let store = null;
    if (row) { try { store = JSON.parse(row.data); } catch (_) { store = null; } }
    return json({ conflict: true, store, rseq: row ? row.rseq : 0, updatedAt: row ? row.updated_at : null }, 409);
  }

  if (request.method === 'DELETE') {
    await env.BPC_DB.prepare('DELETE FROM store WHERE id = 1').run();
    return json({ ok: true, rseq: 0 });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
