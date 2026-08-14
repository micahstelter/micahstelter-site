/**
 * Cloudflare Access verification.
 *
 * Access sits at Cloudflare's edge and will not pass a request through without a
 * valid session, so by the time anything reaches this Worker it has already been
 * checked once. We verify the token again anyway, for two reasons that are not
 * paranoia:
 *
 *   1. It tells us WHO is signed in, so the endpoint can be restricted to one
 *      person rather than anyone the Access policy happens to admit.
 *   2. If the Access policy is ever edited, removed, or scoped to a different
 *      path, this endpoint fails closed instead of quietly becoming public.
 *
 * Replaces the shared passphrase: nothing to remember, nothing to type on a
 * phone, and no secret sitting in localStorage waiting for an XSS.
 */

const CERTS_TTL_MS = 60 * 60 * 1000;
let certs = { at: 0, team: null, keys: null };

function b64urlBytes(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const decodeSegment = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

function cookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function signingKeys(team) {
  if (certs.keys && certs.team === team && Date.now() - certs.at < CERTS_TTL_MS) return certs.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } });
  if (!res.ok) throw new Error('could not fetch Access signing keys');
  const jwks = await res.json();
  certs = { at: Date.now(), team, keys: jwks.keys || [] };
  return certs.keys;
}

/**
 * @returns {Promise<{ok: true, email: string} | {ok: false, reason: string}>}
 */
export async function verifyAccess(request, env) {
  const team = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!team || !aud) return { ok: false, reason: 'unconfigured' };

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) return { ok: false, reason: 'no_session' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  let header, payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'RS256') return { ok: false, reason: 'bad_algorithm' };

  const jwk = (await signingKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown_key' };

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed);
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return { ok: false, reason: 'expired' };
  if (payload.nbf && payload.nbf > now + 60) return { ok: false, reason: 'not_yet_valid' };

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, reason: 'wrong_application' };
  if (payload.iss && payload.iss !== `https://${team}`) return { ok: false, reason: 'wrong_issuer' };

  const email = String(payload.email || '').toLowerCase();
  const allowed = String(env.ACCESS_ALLOWED_EMAILS || '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(email)) return { ok: false, reason: 'not_permitted' };

  return { ok: true, email };
}
