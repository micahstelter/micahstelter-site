/**
 * The CEO Seat — AI drafting, /api/bpc/draft.
 *
 * His call (2026-10-29): "Love AI doing drafting — but many don't have that
 * setup — so should have manual version too." So this endpoint is an extra, never
 * a dependency. The page asks /api/health whether drafting exists and simply hides
 * the draft buttons when it doesn't; every box can still be filled by hand.
 *
 * Two jobs, both returning a DRAFT he edits, never a decision:
 *   monday — propose up to three signals from the dump, what's carried, and what
 *            last Friday said was emerging.
 *   friday — draft the four close-the-week answers from what was actually logged.
 *
 * Same guard as /api/bpc: the Cloudflare Access session, re-verified here, so this
 * fails closed if the Access policy is ever removed. Nothing sent is stored.
 * Claude when ANTHROPIC_API_KEY is set; Cloudflare Workers AI otherwise.
 */

import { verifyAccess } from './access.js';

const MODEL = 'claude-sonnet-5-5';
const CF_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_CHARS = 30_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

const FRAME = `You are drafting for a CEO's weekly planning tool, "The CEO Seat".
The CEO names a few SIGNALS a week: the moves only the CEO can make. A signal is a move, not an outcome or a task a manager could do.
Brand, People and Customer are a lens, not a quota. A week that is all People is fine; never force balance.
Every signal has a WHY (what part of the bigger picture it moves) and an IF I DON'T (the honest cost of not doing it, to the business and to the CEO; CEOs are optimists, so name the real risk).
"Done looks like" must be something the CEO could check on Friday and say yes or no.
Write plainly and briefly, in the CEO's own first person. No jargon, no hype, no em dashes. Never invent facts, names, numbers or dates that are not in the input.`;

const MONDAY = `${FRAME}

TASK: Propose up to 3 signals for this week from the input. Prefer lines from the dump and open carried signals; you may sharpen their wording. Skip anything that reads like a manager's job.
Reply with ONLY a JSON array, no prose, no code fence. Each item:
{"from": "<dump id this came from, or null>", "domain": "brand"|"people"|"customer"|"off", "signal": "...", "why": "...", "ifnot": "...", "done": "..."}`;

const FRIDAY = `${FRAME}

TASK: Draft the CEO's Friday close from what was logged this week. Use only what the input shows. Where a signal has nothing logged, say so plainly in "didnt" and leave the reason for the CEO to fill in; do not guess a reason.
Reply with ONLY a JSON object, no prose, no code fence:
{"moved": "...", "didnt": "...", "picture": "...", "emerging": "..."}
"picture" is whether anything this week changed the bigger picture (a new risk or opportunity). If nothing in the input suggests one, write an empty string.`;

export async function handleBpcDraft(request, env) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.ANTHROPIC_API_KEY && !env.AI) return json({ error: 'not_configured' }, 503);

  const who = await verifyAccess(request, env);
  if (!who.ok) {
    return json({ error: who.reason === 'not_permitted' ? 'forbidden' : 'signin_required' }, who.reason === 'not_permitted' ? 403 : 401);
  }

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
  const kind = body && body.kind;
  if (kind !== 'monday' && kind !== 'friday') return json({ error: 'bad_kind' }, 400);
  const input = JSON.stringify(body.input || {});
  if (input.length > MAX_CHARS) return json({ error: 'too_long', message: 'Too much to draft from in one go.' }, 413);

  const system = kind === 'monday' ? MONDAY : FRIDAY;
  const ask = `Here is this week's material as JSON:\n<input>\n${input}\n</input>`;

  let text;
  try {
    text = env.ANTHROPIC_API_KEY ? await viaClaude(env, system, ask) : await viaCloudflare(env, system, ask);
  } catch (e) {
    return json({ error: 'upstream_error', message: 'The drafter hiccuped. Try again, or fill it in by hand.' }, 502);
  }

  const parsed = extractJson(text, kind === 'monday' ? '[' : '{');
  if (parsed === null) return json({ error: 'unreadable', message: 'The draft came back garbled. Try again.' }, 502);
  return json({ kind, draft: clean(kind, parsed) });
}

async function viaClaude(env, system, ask) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: ask }] }),
  });
  if (!res.ok) throw new Error('claude ' + res.status);
  const msg = await res.json();
  return (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function viaCloudflare(env, system, ask) {
  const r = await env.AI.run(CF_MODEL, {
    messages: [{ role: 'system', content: system }, { role: 'user', content: ask }],
    max_tokens: 1500,
    temperature: 0.3,
  });
  return r && typeof r.response === 'string' ? r.response : JSON.stringify((r && r.response) || '');
}

/* Models wrap JSON in prose or code fences often enough that a strict parse
   would fail a usable answer. Take the outermost bracket pair of the right kind. */
export function extractJson(text, open) {
  const s = String(text || '');
  const close = open === '[' ? ']' : '}';
  const a = s.indexOf(open), b = s.lastIndexOf(close);
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const DOMS = new Set(['brand', 'people', 'customer', 'off']);

function clean(kind, d) {
  if (kind === 'monday') {
    return (Array.isArray(d) ? d : []).slice(0, 3).map((x) => ({
      from: x && typeof x.from === 'string' ? x.from.slice(0, 80) : null,
      domain: x && DOMS.has(x.domain) ? x.domain : 'off',
      signal: str(x && x.signal, 400),
      why: str(x && x.why, 600),
      ifnot: str(x && x.ifnot, 600),
      done: str(x && x.done, 600),
    })).filter((x) => x.signal);
  }
  const o = d && typeof d === 'object' ? d : {};
  return { moved: str(o.moved, 2000), didnt: str(o.didnt, 2000), picture: str(o.picture, 1000), emerging: str(o.emerging, 1500) };
}
