/**
 * PPT InteractiveWebPage — Cloudflare Worker (API Gateway) v3.0
 *
 * Architecture:
 *   Frontend → Worker (this) → DeepSeek / Claude API
 *                                ↓
 *                         R2: generated HTML pages
 *                         KV: rate limits + metadata + cache
 *
 * Routes:
 *   OPTIONS /*           → CORS preflight
 *   GET  /api/health     → Health check
 *   GET  /api/config     → Provider info
 *   POST /api/evolve     → Stream AI evolution (SSE)
 *   POST /api/store      → Store generated HTML in R2, return permalink
 *   GET  /p/:id          → Serve generated page from R2
 *   GET  /api/page/:id   → Page metadata from KV
 *   DELETE /api/page/:id → Delete page from R2 + KV
 */
// 测试

// ============================================================
// CONSTANTS
// ============================================================
const MAX_INPUT_CHARS = 500_000;
const MAX_FILE_NAME_LEN = 200;
const MAX_HTML_SIZE = 3_000_000;        // 3MB max for R2 storage
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 10;
const CACHE_TTL = 3600;
const PAGE_TTL_SECONDS = 86400 * 30;    // 30 days default page expiry
const RETRY_MAX = 2;
const RETRY_BASE_DELAY = 1000;

// ============================================================
// SYSTEM PROMPT — Evolution Agent v2
// ============================================================
const EVOLUTION_SYSTEM_PROMPT = `# Role
You are the Ultimate Creative Technologist Agent — a world-class creative engineer who transforms static 2D documents into breathtaking, immersive 3D interactive web experiences.

# Task
Ingest the provided document data (extracted text, layout information, and page images) and re-engineer it into a single, fully self-contained HTML file that brings the document to life in three-dimensional space.

# Output Format (CRITICAL — follow exactly)
- Output ONE SINGLE, completely self-contained HTML file
- Wrap the entire output in a single \`\`\`html code block
- No conversational preamble, no explanations before or after the code
- No markdown formatting outside the code block

# Technical Requirements
1. All CSS must be inline or within <style> tags. Use modern CSS: grid, flexbox, custom properties, 3D transforms (perspective, transform-style: preserve-3d).
2. All JS must be within a <script> tag at the bottom of the HTML.
3. You may import ONLY these libraries via CDN (place in <head>):
   - GSAP 3.12: https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js
   - Three.js r128: https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
4. ALL images from the source document MUST be embedded as inline Base64 data URLs (in <img> src or WebGL textures). This ensures total offline portability.
5. The file must work when opened directly in a browser — no server required.

# Design Directive: "Make it Alive & 3D"
- **Break the 2D plane**: Do NOT stack elements vertically like a regular document. Treat the screen as a 3D Z-axis stage with depth.
- **Layer Isolation**: Map titles, body text, figures, and key data points to independent floating visual plates at different Z-depths.
- **Camera Motion**: Implement smooth parallax tracking mouse movement (clientX/clientY) OR scroll-driven camera interpolation using GSAP ScrollTrigger.
- **Cinematic Transitions**: When moving between sections (formerly slides/pages), use camera pans, rotations, or particle dispersion effects — like walking through a physical 3D exhibition.
- **Physics-based motion**: Use GSAP's elastic, bounce, and custom easing for all element entrances. Elements should feel like they have mass and inertia.

# Information Fidelity (ZERO HALLUCINATION)
- Every piece of raw text, metric, table data, and image from the source MUST find its exact place in the output.
- Do NOT invent, hallucinate, or omit any data.
- If the source contains tables, recreate them as styled HTML tables within the 3D space.
- If the source contains charts/graphs, recreate them using CSS/SVG within the 3D space.

# Visual Style Guardrails
- **Typography**: Bold, high-contrast scaling. Use font-weight 800-900 for headlines, 400 for body. Elegant letter-spacing (-0.02em to -0.04em for large text).
- **Color Palette**: Restrained. Deep charcoal background (#0a0a0f or similar), raw ivory/off-white text (#f0f0f0), with a single fluid accent color.
- **No genericism**: This is NOT a dashboard. This is an interactive digital artwork — a high-end luxury product reveal.
- **Dark theme**: Use dark backgrounds to make content feel like it emerges from space.

# Particle Effects (Recommended)
Add subtle floating particles or ambient dust motes using canvas or CSS animations to enhance the sense of depth and life.`;

// ============================================================
// CORS + HELPERS
// ============================================================
function corsHeaders(env) {
  const o = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResp(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function getClientIP(request) {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

// ============================================================
// HASHING
// ============================================================
async function hashContent(str) {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Short ID: first 12 hex chars of hash — URL-friendly, collision-resistant */
function shortId(hash) { return hash.slice(0, 12); }

// ============================================================
// RATE LIMITING (KV sliding window)
// ============================================================
async function checkRateLimit(ip, env) {
  const key = `rl:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - RATE_LIMIT_WINDOW;
  try {
    const raw = await env.KV.get(key);
    let ts = raw ? JSON.parse(raw) : [];
    ts = ts.filter(t => t > windowStart);
    if (ts.length >= RATE_LIMIT_MAX) {
      const retryAfter = ts[0] + RATE_LIMIT_WINDOW - now;
      return { allowed: false, retryAfter: Math.max(retryAfter, 1), remaining: 0 };
    }
    ts.push(now);
    await env.KV.put(key, JSON.stringify(ts), { expirationTtl: RATE_LIMIT_WINDOW + 10 });
    return { allowed: true, retryAfter: 0, remaining: RATE_LIMIT_MAX - ts.length };
  } catch {
    return { allowed: true, retryAfter: 0, remaining: RATE_LIMIT_MAX };
  }
}

// ============================================================
// KV CACHE (content-hash dedup for AI responses)
// ============================================================
async function getCachedResponse(docHash, env) {
  try {
    const raw = await env.KV.get(`cache:${docHash}`);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function setCachedResponse(docHash, html, env) {
  try {
    await env.KV.put(`cache:${docHash}`, JSON.stringify({ html, ts: Date.now() }), {
      expirationTtl: CACHE_TTL,
    });
  } catch {}
}

// ============================================================
// R2 STORAGE
// ============================================================

/**
 * Store generated HTML page in R2 + metadata in KV
 * Returns the permalink ID
 */
async function storePage(html, meta, env) {
  const contentHash = await hashContent(html);
  const id = shortId(contentHash);

  // Check if already exists (dedup)
  const existing = await env.KV.get(`page:${id}`);
  if (existing) {
    return { id, ...JSON.parse(existing) };
  }

  // Store HTML in R2
  await env.R2.put(`pages/${id}.html`, html, {
    httpMetadata: {
      contentType: 'text/html; charset=utf-8',
      cacheControl: 'public, max-age=300',
    },
    customMetadata: {
      fileName: meta.fileName || 'untitled',
      provider: meta.provider || 'unknown',
      createdAt: new Date().toISOString(),
    },
  });

  // Store metadata in KV
  const pageMeta = {
    id,
    fileName: meta.fileName || 'untitled',
    provider: meta.provider || 'unknown',
    fileSize: meta.fileSize || 0,
    htmlSize: html.length,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PAGE_TTL_SECONDS * 1000).toISOString(),
  };
  await env.KV.put(`page:${id}`, JSON.stringify(pageMeta), {
    expirationTtl: PAGE_TTL_SECONDS,
  });

  return { id, ...pageMeta };
}

/**
 * Retrieve page HTML from R2
 */
async function getPage(id, env) {
  const obj = await env.R2.get(`pages/${id}.html`);
  if (!obj) return null;
  return {
    html: await obj.text(),
    meta: obj.customMetadata || {},
    httpMetadata: obj.httpMetadata || {},
  };
}

/**
 * Get page metadata from KV
 */
async function getPageMeta(id, env) {
  const raw = await env.KV.get(`page:${id}`);
  return raw ? JSON.parse(raw) : null;
}

/**
 * Delete page from R2 + KV
 */
async function deletePage(id, env) {
  await env.R2.delete(`pages/${id}.html`);
  await env.KV.delete(`page:${id}`);
}

// ============================================================
// INPUT VALIDATION
// ============================================================
function validateEvolveInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { valid: false, errors: ['Request body must be a JSON object'] };
  if (!body.document_data || typeof body.document_data !== 'string') {
    errors.push('document_data is required and must be a string');
  } else if (body.document_data.length > MAX_INPUT_CHARS) {
    errors.push(`document_data exceeds max ${MAX_INPUT_CHARS} chars`);
  } else if (body.document_data.trim().length < 50) {
    errors.push('document_data too short (min 50 chars)');
  }
  if (body.file_name && typeof body.file_name === 'string' && body.file_name.length > MAX_FILE_NAME_LEN) {
    errors.push(`file_name exceeds ${MAX_FILE_NAME_LEN} chars`);
  }
  if (body.provider && !['deepseek', 'claude'].includes(body.provider)) {
    errors.push(`Invalid provider: ${body.provider}`);
  }
  return { valid: errors.length === 0, errors };
}

function validateStoreInput(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return { valid: false, errors: ['Request body must be a JSON object'] };
  if (!body.html || typeof body.html !== 'string') {
    errors.push('html is required');
  } else if (body.html.length > MAX_HTML_SIZE) {
    errors.push(`html exceeds max ${MAX_HTML_SIZE} chars`);
  } else if (body.html.length < 100) {
    errors.push('html too short to be valid');
  }
  return { valid: errors.length === 0, errors };
}

// ============================================================
// AI PROVIDERS + RETRY
// ============================================================
async function callDeepSeek(apiKey, sp, uc) {
  return fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: sp }, { role: 'user', content: uc }],
      temperature: 0.7, max_tokens: 16384, stream: true,
    }),
  });
}

async function callClaude(apiKey, sp, uc) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 16384,
      system: sp, messages: [{ role: 'user', content: uc }], stream: true,
    }),
  });
}

async function callAI(provider, apiKey, sp, uc) {
  return provider === 'claude' ? callClaude(apiKey, sp, uc) : callDeepSeek(apiKey, sp, uc);
}

async function callAIWithRetry(provider, apiKey, sp, uc) {
  let lastErr;
  for (let i = 0; i <= RETRY_MAX; i++) {
    try {
      const r = await callAI(provider, apiKey, sp, uc);
      if ([429, 500, 502, 503].includes(r.status) && i < RETRY_MAX) {
        const delay = RETRY_BASE_DELAY * Math.pow(2, i);
        const ra = r.headers.get('retry-after');
        await new Promise(ok => setTimeout(ok, Math.min(ra ? parseInt(ra) * 1000 : delay, 10000)));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < RETRY_MAX) await new Promise(ok => setTimeout(ok, RETRY_BASE_DELAY * Math.pow(2, i)));
    }
  }
  throw lastErr || new Error('All retries exhausted');
}

// ============================================================
// SSE TRANSFORMER
// ============================================================
function sseTransform(provider) {
  return new TransformStream({
    transform(chunk, controller) {
      const text = new TextDecoder().decode(chunk);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); continue; }
        try {
          const j = JSON.parse(d);
          const content = provider === 'claude'
            ? (j.type === 'content_block_delta' ? j.delta?.text : undefined)
            : j.choices?.[0]?.delta?.content;
          if (content) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`));
        } catch {}
      }
    },
  });
}

// ============================================================
// HANDLERS
// ============================================================

/** POST /api/evolve — Stream AI evolution */
async function handleEvolve(request, env) {
  const cors = corsHeaders(env);
  const ip = getClientIP(request);
  const rl = await checkRateLimit(ip, env);
  if (!rl.allowed) return jsonResp({ error: 'Rate limit exceeded', retryAfter: rl.retryAfter }, 429, { 'Retry-After': String(rl.retryAfter), ...cors });

  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400, cors); }

  const v = validateEvolveInput(body);
  if (!v.valid) return jsonResp({ error: 'Validation failed', details: v.errors }, 400, cors);

  const { provider = 'deepseek', api_key, document_data, file_name } = body;
  const apiKey = api_key || (provider === 'claude' ? env.CLAUDE_API_KEY : env.DEEPSEEK_API_KEY);
  if (!apiKey) return jsonResp({ error: `No API key for ${provider}` }, 401, cors);

  // Cache check
  const docHash = await hashContent(document_data);
  const cached = await getCachedResponse(docHash, env);
  if (cached) {
    console.log(`Cache hit: ${docHash.slice(0, 12)}`);
    return new Response(cached.html, { status: 200, headers: { 'Content-Type': 'text/html', 'X-Cache': 'HIT', ...cors } });
  }

  const userContent = `## Source Document: ${file_name || 'Untitled'}\n\n${document_data}`;

  let aiResp;
  try { aiResp = await callAIWithRetry(provider, apiKey, EVOLUTION_SYSTEM_PROMPT, userContent); }
  catch (e) { return jsonResp({ error: 'AI unavailable after retries', message: e.message }, 502, cors); }

  if (!aiResp.ok) {
    const t = await aiResp.text().catch(() => '');
    let detail = `AI returned ${aiResp.status}`;
    try { const j = JSON.parse(t); detail = j.error?.message || detail; } catch { detail = t.slice(0, 300) || detail; }
    return jsonResp({ error: detail }, 502, cors);
  }

  const transformed = aiResp.body.pipeThrough(sseTransform(provider));
  return new Response(transformed, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-RateLimit-Remaining': String(rl.remaining), 'X-Cache': 'MISS', ...cors },
  });
}

/** POST /api/store — Store generated HTML in R2, return permalink */
async function handleStore(request, env) {
  const cors = corsHeaders(env);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400, cors); }

  const v = validateStoreInput(body);
  if (!v.valid) return jsonResp({ error: 'Validation failed', details: v.errors }, 400, cors);

  try {
    const result = await storePage(body.html, {
      fileName: body.file_name || 'untitled',
      provider: body.provider || 'unknown',
      fileSize: body.file_size || 0,
    }, env);

    // Build permalink URL
    const reqUrl = new URL(request.url);
    const baseUrl = `${reqUrl.protocol}//${reqUrl.host}`;
    const permalink = `${baseUrl}/p/${result.id}`;

    return jsonResp({
      ok: true,
      id: result.id,
      permalink,
      fileName: result.fileName,
      htmlSize: result.htmlSize,
      createdAt: result.createdAt,
      expiresAt: result.expiresAt,
    }, 201, cors);
  } catch (e) {
    console.error('Store error:', e);
    return jsonResp({ error: 'Failed to store page', message: e.message }, 500, cors);
  }
}

/** GET /p/:id — Serve generated page from R2 */
async function handlePageServe(id, env) {
  const page = await getPage(id, env);
  if (!page) {
    return new Response('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page Not Found</title><style>body{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;background:#0a0a0f;color:#f0f0f0}h1{opacity:.5}</style></head><body><h1>Page not found or expired</h1></body></html>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return new Response(page.html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'X-Page-Provider': page.meta.provider || 'unknown',
    },
  });
}

/** GET /api/page/:id — Page metadata */
async function handlePageMeta(id, env) {
  const meta = await getPageMeta(id, env);
  if (!meta) return jsonResp({ error: 'Page not found' }, 404, corsHeaders(env));
  return jsonResp({ ok: true, ...meta }, 200, corsHeaders(env));
}

/** DELETE /api/page/:id — Delete page */
async function handlePageDelete(id, env) {
  const meta = await getPageMeta(id, env);
  if (!meta) return jsonResp({ error: 'Page not found' }, 404, corsHeaders(env));
  await deletePage(id, env);
  return jsonResp({ ok: true, deleted: id }, 200, corsHeaders(env));
}

/** POST /api/cache-store — Client-side cache store (legacy, now redirects to /api/store) */
async function handleCacheStore(request, env) {
  const cors = corsHeaders(env);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400, cors); }
  const { doc_hash, html } = body || {};
  if (!doc_hash || !html) return jsonResp({ error: 'doc_hash and html required' }, 400, cors);
  if (html.length > MAX_HTML_SIZE) return jsonResp({ error: 'HTML too large' }, 400, cors);

  // Store in KV cache
  await setCachedResponse(doc_hash, html, env);

  // Also store in R2 for permanent hosting
  try {
    const result = await storePage(html, { fileName: 'cached', provider: 'cached' }, env);
    const reqUrl = new URL(request.url);
    const permalink = `${reqUrl.protocol}//${reqUrl.host}/p/${result.id}`;
    return jsonResp({ ok: true, id: result.id, permalink }, 200, cors);
  } catch {
    return jsonResp({ ok: true, cached: true }, 200, cors);
  }
}

/** GET /api/health */
function handleHealth(env) {
  return jsonResp({
    status: 'ok', service: 'ppt-evolution-worker', version: '3.0.0',
    timestamp: new Date().toISOString(),
    features: ['rate-limit', 'cache', 'retry', 'streaming', 'r2-storage', 'permalinks'],
  }, 200, corsHeaders(env));
}

/** GET /api/config */
function handleConfig(env) {
  return jsonResp({
    providers: [
      { id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', available: !!env.DEEPSEEK_API_KEY },
      { id: 'claude', name: 'Claude', model: 'claude-sonnet-4-20250514', available: !!env.CLAUDE_API_KEY },
    ],
    limits: { maxInputChars: MAX_INPUT_CHARS, maxHtmlSize: MAX_HTML_SIZE, rateLimitPerMin: RATE_LIMIT_MAX, pageTtlDays: PAGE_TTL_SECONDS / 86400 },
  }, 200, corsHeaders(env));
}

// ============================================================
// ROUTER
// ============================================================
//艹！变量method在代码里变成了undefined
//当浏览器发起跨域预检OPTIONS请求时，if (method === 'OPTIONS') 判定为假，
//直接跳过了CORS的204响应，一路坠落到最底部的404错误。这就导致了在控制台里 “预检请求不通过，没有HTTP OK状态” + CORS拦截。
//当访问/api/health时，由于method是 undefined，if (path === '/api/health' && method === 'GET')同样判定为假，
//直接触发了最后的兜底 404 路由，吐出了 {"error":"Not found","path":"/api/health"}
//
// export default {
//   async fetch(request, env, ctx) {
//     const url = new URL(request.url);
//     const { pathname: path, method } = url;

//     if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });



     
    // API routes
    if (path === '/api/health' && method === 'GET') return handleHealth(env);
    if (path === '/api/config' && method === 'GET') return handleConfig(env);
    if (path === '/api/evolve' && method === 'POST') return handleEvolve(request, env);
    if (path === '/api/store' && method === 'POST') return handleStore(request, env);
    if (path === '/api/cache-store' && method === 'POST') return handleCacheStore(request, env);

    // Page serving: /p/:id
    const pageMatch = path.match(/^\/p\/([a-f0-9]{12})$/);
    if (pageMatch && method === 'GET') return handlePageServe(pageMatch[1], env);

    // Page metadata: /api/page/:id
    const metaMatch = path.match(/^\/api\/page\/([a-f0-9]{12})$/);
    if (metaMatch) {
      if (method === 'GET') return handlePageMeta(metaMatch[1], env);
      if (method === 'DELETE') return handlePageDelete(metaMatch[1], env);
    }

    return jsonResp({ error: 'Not found', path }, 404, corsHeaders(env));
  },
};
