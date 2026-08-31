/**
 * SPOTTED photo reader — /api/spot.
 *
 * Micah's constraint on the app is that capture must cost him nothing on a walk:
 * shoot and keep moving, no typing. That means something else has to decide what
 * the photo shows. This endpoint takes one downscaled JPEG and returns the kind,
 * a plain-language note, any legible writer name, and a confidence.
 *
 * WHY RAW FETCH AND NOT THE SDK. This repo has no package.json, no node_modules
 * and no build step of its own — Cloudflare builds it straight from wrangler.jsonc.
 * Adding an npm dependency would introduce an install step into the pipeline that
 * deploys his live site. The Messages API over fetch has no such cost.
 *
 * WHAT PROTECTS IT. The endpoint spends money, so it has three gates: a shared
 * token the page sends (real but modest — the page is public source, so treat it
 * as a speed bump, not a lock), a hard cap on request size, and a per-day call
 * ceiling in D1 that bounds the worst case no matter who finds it. If the API key
 * is not configured it fails clean with 503 and the app falls back to letting
 * Micah tap the kind himself.
 */

const MODEL = 'claude-opus-5';
const MAX_B64 = 1_400_000;        // ~1 MB of JPEG once decoded
const DAILY_CAP = 300;            // reads per UTC day, across everyone
const SHARED_TOKEN = 'spotted-field-log-v1';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/* The taxonomy the app scores against. The model has to land in this list, so
   the list is described to it rather than assumed — "throwie" and "piece" mean
   specific things to a writer and the difference is 35 points. */
const KIND_GUIDE = `
slap    — a sticker: postal label, name sticker, printed vinyl, stuck on rather than painted.
tag      — a signature in one color, done fast, marker or a single spray line. The most common thing on a wall.
throwie  — bubble or blockish letters, typically two colors: an outline and a quick fill. Faster than a piece, more than a tag.
stencil  — sprayed through a cut template. Crisp repeated edges, often an image rather than letters.
paste    — wheatpaste or a poster: printed or drawn on paper, glued flat to the surface. Look for paper edges and wrinkling.
piece    — a full "masterpiece": many colors, deliberate letter construction, highlights, outlines, 3D or shading.
mural    — a large commissioned or production wall. Scenic or designed, covers a whole wall, looks sanctioned.
roller   — painted with a paint roller on an extension pole, usually huge letters very high up or on a rooftop.
none     — the photo is not graffiti or street art at all (a building, a sign, a person, a blurry mistake).
`.trim();

const SYSTEM = `You catalogue graffiti and street art that someone photographs while out walking.

For each photo, return:

kind — exactly one of these:
${KIND_GUIDE}

note — one or two plain sentences on what it actually looks like: colors, letterforms or subject, the surface it is on, and anything that makes it worth remembering. Write it the way a person would describe it to a friend later. No jargon, no preamble, do not begin with "This image shows".

writer — the tag name or crew, only if letters are genuinely legible. Return it uppercase. If you cannot read a name with confidence, return an empty string. Never guess at letters, and never name a real person.

confidence — 0 to 1, how sure you are of the kind. Be honest: a dim or partial photo should score low, and anything below 0.6 gets shown to the person to confirm.

Judge only what is visible. If the photo is not graffiti, say kind "none" and explain what it is instead in the note.`;

const SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['slap', 'tag', 'throwie', 'stencil', 'paste', 'piece', 'mural', 'roller', 'none'],
    },
    note: { type: 'string' },
    writer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['kind', 'note', 'writer', 'confidence'],
  additionalProperties: false,
};

/* One CREATE per isolate, same pattern as bpc.js. */
let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS spot_usage (
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

/**
 * Count this call against today's ceiling. Written as one INSERT ... ON CONFLICT
 * so two requests landing together cannot both read the same count and both pass.
 * Returns the new total, or null if the database is unavailable — a missing
 * database must not take the feature down, it just removes the ceiling.
 */
async function countCall(db) {
  if (!db) return null;
  try {
    await ensureSchema(db);
    const day = new Date().toISOString().slice(0, 10);
    const row = await db
      .prepare(
        `INSERT INTO spot_usage (day, calls) VALUES (?1, 1)
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

export async function handleSpot(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  if (request.headers.get('x-spotted-token') !== SHARED_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }

  if (!env.ANTHROPIC_API_KEY) {
    // The app treats this as "reading is off" and falls back to manual review.
    return json(
      {
        error: 'not_configured',
        message: 'No Anthropic API key is set on this Worker yet, so photos are not being read.',
      },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'bad_json' }, 400);
  }

  const b64 = typeof body.b64 === 'string' ? body.b64 : '';
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(body.media_type)
    ? body.media_type
    : 'image/jpeg';

  if (!b64) return json({ error: 'no_image' }, 400);
  if (b64.length > MAX_B64) return json({ error: 'too_large', max_b64: MAX_B64 }, 413);

  const used = await countCall(env.BPC_DB);
  if (used !== null && used > DAILY_CAP) {
    return json({ error: 'daily_cap', message: 'Reached today’s reading limit.' }, 429);
  }

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
        max_tokens: 4000,
        system: SYSTEM,
        // Effort low, not thinking-off: this is a straightforward classification,
        // and disabling thinking on Opus 5 has its own failure modes.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: SCHEMA },
        },
        messages: [
          {
            role: 'user',
            // Image before text — the model reads image-then-text better.
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: 'Catalogue this one.' },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    return json({ error: 'upstream_unreachable' }, 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error: 'upstream_error', status: res.status, detail: detail.slice(0, 400) }, 502);
  }

  const msg = await res.json();

  // A safety decline arrives as HTTP 200 with stop_reason "refusal", so check it
  // before reading content rather than after failing to parse it.
  if (msg.stop_reason === 'refusal') {
    return json({ error: 'declined', message: 'The model declined to read this photo.' }, 422);
  }

  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try {
    out = JSON.parse(text);
  } catch (e) {
    return json({ error: 'unparseable', raw: text.slice(0, 400) }, 502);
  }

  return json({
    kind: out.kind,
    note: out.note,
    writer: (out.writer || '').trim().toUpperCase(),
    confidence: typeof out.confidence === 'number' ? out.confidence : 0,
    model: msg.model,
  });
}
