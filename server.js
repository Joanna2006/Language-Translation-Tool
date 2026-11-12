/**
 * Lingua – translation server
 * Zero dependencies (Node 18+). Serves /public and exposes:
 *   GET  /api/config     -> { provider }
 *   POST /api/translate  -> { translatedText, detectedLanguage? }
 * API keys stay on the server and are never sent to the browser.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- minimal .env loader ----------
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* .env is optional */ }

const PORT = Number(process.env.PORT) || 3000;
const PROVIDER = (process.env.TRANSLATE_PROVIDER || 'mymemory').toLowerCase();
const MAX_CHARS = 5000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png'
};

class ApiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

// ---------- language code mapping per provider ----------
const LT_MAP = { 'zh-CN': 'zh', 'zh-TW': 'zt', no: 'nb' };
const mapLt = c => (c === 'auto' ? 'auto' : LT_MAP[c] || c);

// ---------- providers ----------
async function fetchJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new ApiError('Could not reach the translation service. Please try again shortly.', 504);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  return { res, data };
}

async function viaLibreTranslate(text, source, target) {
  const base = (process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com').replace(/\/$/, '');
  const body = { q: text, source: mapLt(source), target: mapLt(target), format: 'text' };
  if (process.env.LIBRETRANSLATE_API_KEY) body.api_key = process.env.LIBRETRANSLATE_API_KEY;
  const { res, data } = await fetchJson(`${base}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok || !data || data.error) {
    throw new ApiError((data && data.error) || `LibreTranslate error (${res.status}).`);
  }
  return {
    translatedText: data.translatedText,
    detectedLanguage: data.detectedLanguage && data.detectedLanguage.language
  };
}

async function viaGoogle(text, source, target) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new ApiError('GOOGLE_API_KEY is not configured on the server.', 500);
  const body = { q: text, target, format: 'text' };
  if (source !== 'auto') body.source = source;
  const { res, data } = await fetchJson(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok || !data || data.error) {
    throw new ApiError((data && data.error && data.error.message) || `Google API error (${res.status}).`);
  }
  const t = data.data.translations[0];
  return { translatedText: t.translatedText, detectedLanguage: t.detectedSourceLanguage };
}

// MyMemory accepts max ~500 bytes per request, so long text is split into chunks.
function chunkText(text, max = 400) {
  const pieces = text.match(/[^.!?。！？\n]+[.!?。！？]*[ \t]*|\n+/g) || [text];
  const chunks = [];
  let cur = '';
  const push = () => { if (cur) { chunks.push(cur); cur = ''; } };
  for (let piece of pieces) {
    while (piece.length > max) {            // hard split very long sentences
      push();
      chunks.push(piece.slice(0, max));
      piece = piece.slice(max);
    }
    if ((cur + piece).length > max) push();
    cur += piece;
  }
  push();
  return chunks;
}

async function viaMyMemory(text, source, target) {
  const langpair = `${source === 'auto' ? 'Autodetect' : source}|${target}`;
  const out = [];
  let detected;
  for (const chunk of chunkText(text)) {
    if (!chunk.trim()) { out.push(chunk); continue; }   // keep whitespace/newlines
    const params = new URLSearchParams({ q: chunk, langpair });
    if (process.env.MYMEMORY_EMAIL) params.set('de', process.env.MYMEMORY_EMAIL);
    const { res, data } = await fetchJson(`https://api.mymemory.translated.net/get?${params}`);
    const status = data && Number(data.responseStatus);
    if (!res.ok || !data || status !== 200) {
      const detail = data && typeof data.responseDetails === 'string' ? data.responseDetails : '';
      if (status === 429 || /QUOTA|LIMIT/i.test(detail)) {
        throw new ApiError('Daily free translation limit reached. Try again later or set MYMEMORY_EMAIL / another provider.', 429);
      }
      throw new ApiError(detail || `MyMemory error (${res.status}).`);
    }
    out.push(data.responseData.translatedText);
    if (!detected && data.responseData.detectedLanguage) detected = data.responseData.detectedLanguage;
  }
  // Re-attach original leading/trailing whitespace of each chunk is not needed
  // because chunks keep their own spacing; we join with an empty string.
  return { translatedText: out.join(''), detectedLanguage: detected };
}

const PROVIDERS = { libretranslate: viaLibreTranslate, google: viaGoogle, mymemory: viaMyMemory };
if (!PROVIDERS[PROVIDER]) {
  console.error(`Unknown TRANSLATE_PROVIDER "${PROVIDER}". Use: ${Object.keys(PROVIDERS).join(', ')}`);
  process.exit(1);
}

// ---------- tiny per-IP rate limiter ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 30;               // 30 requests / minute
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

// ---------- helpers ----------
function send(res, status, payload, headers = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : MIME['.json'],
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new ApiError('Request is too large.', 413)); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleTranslate(req, res) {
  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) throw new ApiError('Too many requests. Please wait a minute and try again.', 429);

  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (e) { if (e instanceof ApiError) throw e; throw new ApiError('Invalid JSON request.', 400); }

  const text = typeof payload.text === 'string' ? payload.text : '';
  const source = typeof payload.source === 'string' ? payload.source : 'auto';
  const target = typeof payload.target === 'string' ? payload.target : '';
  const codeOk = c => /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$|^auto$/.test(c);

  if (!text.trim()) throw new ApiError('Please enter some text to translate.', 400);
  if (text.length > MAX_CHARS) throw new ApiError(`Text is too long (max ${MAX_CHARS} characters).`, 400);
  if (!codeOk(source) || !codeOk(target) || target === 'auto') throw new ApiError('Invalid language selection.', 400);
  if (source === target) return send(res, 200, { translatedText: text, detectedLanguage: source });

  const result = await PROVIDERS[PROVIDER](text, source, target);
  send(res, 200, result);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/api/config' && req.method === 'GET') return send(res, 200, { provider: PROVIDER, maxChars: MAX_CHARS });
    if (pathname === '/api/translate') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
      return await handleTranslate(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    serveStatic(req, res);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 500;
    if (!(err instanceof ApiError)) console.error(err);
    send(res, status, { error: err instanceof ApiError ? err.message : 'Unexpected server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`Lingua is running at http://localhost:${PORT}  (provider: ${PROVIDER})`);
});
