/**
 * BPC Momentum sync endpoint — Cloudflare Pages Function at /api/bpc
 *
 * Holds one JSON blob (Micah's whole BPC store) in KV so the tool follows him
 * between his laptop and his phone instead of keeping a separate copy per browser.
 *
 * Bindings required on the Pages project:
 *   KV namespace  BPC_STORE   — where the blob lives
 *   Env variable  BPC_SECRET  — the passphrase the browser sends (SECRET, not in this repo)
 *
 * Concurrency: the server never merges. It holds a revision number (`rseq`) and
 * refuses a write whose base revision is stale, handing back the current copy so
 * the browser can merge with the same signal-level logic it already uses for two
 * tabs, then retry. That keeps one merge implementation rather than two.
 *
 * KV is eventually consistent, so a write can take a moment to be visible from
 * another region. The stale-write check plus client-side merge means the worst
 * case is an extra merge round trip, not a lost edit.
 */

const BLOB = 'store';
const MAX_BYTES = 2 * 1024 * 1024;      // generous for this data; guards against a runaway payload

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // The page and the API are same-origin, so no CORS allowance is granted.
      'x-content-type-options': 'nosniff',
    },
  });

/** Length-independent comparison so a wrong guess doesn't leak length by timing. */
function secretMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.BPC_STORE) {
    return json({ error: 'storage_unbound', message: 'The BPC_STORE KV namespace is not bound to this project.' }, 503);
  }
  if (!env.BPC_SECRET) {
    return json({ error: 'secret_unset', message: 'BPC_SECRET is not set on this project.' }, 503);
  }
  if (!secretMatches(bearer(request), env.BPC_SECRET)) {
    return json({ error: 'unauthorized', message: 'Wrong or missing passphrase.' }, 401);
  }

  if (request.method === 'GET') {
    const raw = await env.BPC_STORE.get(BLOB);
    if (!raw) return json({ store: null, rseq: 0 });
    let stored;
    try { stored = JSON.parse(raw); } catch (_) { return json({ store: null, rseq: 0 }); }
    return json({ store: stored.store ?? null, rseq: stored.rseq || 0, updatedAt: stored.updatedAt || null });
  }

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BYTES) return json({ error: 'too_large' }, 413);

    let body;
    try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad_json' }, 400); }
    if (!body || typeof body.store !== 'object' || body.store === null) {
      return json({ error: 'bad_body', message: 'Expected { store, baseRseq }.' }, 400);
    }

    const raw = await env.BPC_STORE.get(BLOB);
    let current = null;
    if (raw) { try { current = JSON.parse(raw); } catch (_) { current = null; } }
    const currentSeq = current && Number.isFinite(current.rseq) ? current.rseq : 0;
    const base = Number.isFinite(body.baseRseq) ? body.baseRseq : 0;

    // Someone else advanced the store since this browser last read it.
    if (currentSeq > base) {
      return json({ conflict: true, store: current ? current.store : null, rseq: currentSeq }, 409);
    }

    const next = { store: body.store, rseq: currentSeq + 1, updatedAt: new Date().toISOString() };
    await env.BPC_STORE.put(BLOB, JSON.stringify(next));
    return json({ ok: true, rseq: next.rseq, updatedAt: next.updatedAt });
  }

  if (request.method === 'DELETE') {
    await env.BPC_STORE.delete(BLOB);
    return json({ ok: true, rseq: 0 });
  }

  return json({ error: 'method_not_allowed' }, 405);
}
