/**
 * micahstelter.ai — Worker entry point.
 *
 * The site was previously a static-assets-only Worker, which meant Cloudflare
 * would not let it hold environment variables, secrets or storage bindings. This
 * file exists so the project has real code and can. Static assets still take
 * precedence for every path that matches a file, so the site behaves exactly as
 * it did before; this only handles paths no asset claims.
 *
 * Routes /api/bpc to the BPC Momentum sync API; everything else is the site.
 */

import { handleBpc } from './bpc.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/bpc') {
      return handleBpc(request, env);
    }

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        worker: true,
        d1: Boolean(env.BPC_DB),
        secret: Boolean(env.BPC_SECRET),
        time: new Date().toISOString(),
      });
    }

    // Everything else is the site. ASSETS honours _redirects, _headers and the
    // custom 404 page, so nothing about the existing site changes.
    return env.ASSETS.fetch(request);
  },
};
