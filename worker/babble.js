/**
 * Beza Babble Translator — /api/babble.
 *
 * Built for Micah's friend Beza, who talks her thoughts out (six-minute voice
 * memos) and wants the short version she can send someone without repeating
 * herself. This endpoint takes her raw text and a format, and returns the
 * condensed message in her own voice.
 *
 * Same shape and same guards as spot.js: raw fetch (no package.json in this
 * repo), a shared token that is a speed bump rather than a lock, a size cap, and
 * a per-day ceiling in D1 that bounds the spend no matter who finds the page.
 * Nothing she sends is stored here — only a per-day call count.
 */

const MODEL = 'claude-sonnet-5';
// Used when no Anthropic key is set: Cloudflare's own models, billed to the
// Cloudflare account's free daily allowance, no secret required.
const CF_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_CHARS = 40_000;         // ~40 minutes of talking
const DAILY_CAP = 200;            // translations per UTC day, across everyone
const SHARED_TOKEN = 'beza-babble-v1';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const FORMATS = {
  text: `A text message. Two to five sentences, conversational, ready to paste into iMessage. No greeting line unless the babble clearly had one, no sign-off.`,
  bullets: `Short bullet points, the fewest that carry everything that matters (usually 3 to 8). One idea per bullet, each one a complete thought someone could act on. Start each line with "• ".`,
  email: `A short email: a one-line subject on the first line starting with "Subject: ", a blank line, then a few tight paragraphs. Warm, clear, no filler.`,
};

const SYSTEM = `You are the Babble Translator. A person talks or types their thoughts out loud — rambling, circling back, repeating themselves, thinking as they go — and you turn it into something short and clear they can send to another person.

Rules:
- Write in HER voice, first person, as if she wrote it herself on a good day. Keep her warmth and her way of speaking. Do not make her sound corporate, and do not add enthusiasm she did not have.
- Keep every point that matters: decisions, asks, feelings she clearly wants heard, dates, names, numbers. Drop the repetition, the false starts, and the "I don't know, like, anyway".
- Never add facts, opinions, advice, or conclusions she did not say. You are condensing, not counseling.
- If she names who it is for, write it to that person.
- Output only the finished message. No preamble, no "Here is", no quotation marks around it, no notes about what you changed.`;

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS babble_usage (
           day   TEXT PRIMARY KEY,
           calls INTEGER NOT NULL
         )`
      )
      .run()
      .catch((e) => {
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

/* One INSERT ... ON CONFLICT so two requests together cannot both pass the cap.
   A missing database removes the ceiling rather than taking the feature down. */
async function countCall(db) {
  if (!db) return null;
  try {
    await ensureSchema(db);
    const day = new Date().toISOString().slice(0, 10);
    const row = await db
      .prepare(
        `INSERT INTO babble_usage (day, calls) VALUES (?1, 1)
         ON CONFLICT(day) DO UPDATE SET calls = calls + 1
         RETURNING calls`
      )
      .bind(day)
      .first();
    return row ? row.calls : null;
  } catch (e) {
    return null;
  }
}

export async function handleBabble(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (request.headers.get('x-babble-token') !== SHARED_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (!env.ANTHROPIC_API_KEY && !env.AI) {
    return json(
      { error: 'not_configured', message: 'The translator isn’t switched on yet. Tell Micah!' },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad_json' }, 400);
  }

  const babble = typeof body.text === 'string' ? body.text.trim() : '';
  const format = FORMATS[body.format] ? body.format : 'text';
  const to = typeof body.to === 'string' ? body.to.trim().slice(0, 80) : '';

  if (!babble) return json({ error: 'empty', message: 'Say or type something first.' }, 400);
  if (babble.length > MAX_CHARS) {
    return json({ error: 'too_long', message: 'That’s a lot of babble — try it in two pieces.' }, 413);
  }

  const used = await countCall(env.BPC_DB);
  if (used !== null && used > DAILY_CAP) {
    return json({ error: 'daily_cap', message: 'The translator is tired for today. Try again tomorrow.' }, 429);
  }

  const ask =
    `Format: ${FORMATS[format]}\n` +
    (to ? `It's going to: ${to}\n` : '') +
    `\nHere is the babble:\n<babble>\n${babble}\n</babble>`;

  if (!env.ANTHROPIC_API_KEY) return viaCloudflare(env, ask, format);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        system: SYSTEM,
        messages: [{ role: 'user', content: ask }],
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_unreachable', message: 'Couldn’t reach the translator. Try again.' }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json(
      { error: 'upstream_error', status: res.status, detail: detail.slice(0, 400), message: 'The translator hiccuped. Try again.' },
      502
    );
  }

  const msg = await res.json();
  if (msg.stop_reason === 'refusal') {
    return json({ error: 'declined', message: 'The translator couldn’t do that one.' }, 422);
  }

  const out = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!out) return json({ error: 'empty_reply', message: 'Came back blank — try again.' }, 502);

  return json({ result: out, format, model: msg.model });
}

/* No Anthropic key: run the same prompt on Cloudflare Workers AI. */
async function viaCloudflare(env, ask, format) {
  let r;
  try {
    r = await env.AI.run(CF_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: ask },
      ],
      max_tokens: 1500,
      temperature: 0.4,
    });
  } catch (e) {
    return json({ error: 'upstream_error', detail: String(e).slice(0, 400), message: 'The translator hiccuped. Try again.' }, 502);
  }
  const out = (r && typeof r.response === 'string' ? r.response : '').trim();
  if (!out) return json({ error: 'empty_reply', message: 'Came back blank — try again.' }, 502);
  return json({ result: out, format, model: CF_MODEL });
}
