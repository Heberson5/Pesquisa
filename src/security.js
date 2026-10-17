'use strict';
// Primitivas de segurança: hash de senha, tokens, rate limit, cabeçalhos HTTP.
const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(actual, expected);
}

// Hash "falso" usado quando o e-mail não existe, para que o tempo de resposta
// seja igual e não revele quais usuários existem.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Código de pareamento legível em tablet: sem caracteres ambíguos (0/O, 1/I/L).
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function pairingCode(len = 8) {
  let out = '';
  for (let i = 0; i < len; i++) out += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
  return out;
}

function passwordPolicyError(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
  if (pw.length > 200) return 'Senha longa demais.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'A senha deve conter letras e números.';
  return null;
}

// Chave do cliente para limites por IP. IPv6: um único aparelho costuma ter um bloco /64 inteiro (e pode trocar
// de endereço à vontade dentro dele), então conta o bloco; IPv4 mapeado em IPv6 vira o IPv4.
function clientKey(req) {
  const ip = String(req.ip || '');
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}

// Rate limiter em memória (janela fixa simples). Para várias instâncias do servidor, trocar por Redis.
// Tem teto de chaves: muitos endereços diferentes não esgotam a memória (cheio, recusa até a limpeza).
const MAX_KEYS = 50_000;
function rateLimiter({ windowMs, max, keyFn, message = 'Muitas requisições. Tente novamente em instantes.' }) {
  const hits = new Map();
  const sweep = (now) => { for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); };
  setInterval(() => sweep(Date.now()), Math.min(windowMs, 60_000)).unref();
  // Conta um acesso para a chave. ok = dentro do limite; retryAfter em segundos.
  function hit(key) {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= now) {
      if (!e && hits.size >= MAX_KEYS) { sweep(now); if (hits.size >= MAX_KEYS) return { ok: false, retryAfter: Math.ceil(Math.min(windowMs, 60_000) / 1000) }; }
      e = { count: 0, reset: now + windowMs }; hits.set(key, e);
    }
    e.count++;
    return { ok: e.count <= max, retryAfter: Math.ceil((e.reset - now) / 1000) };
  }
  const limiter = (req, res, next) => {
    const r = hit(String(keyFn ? keyFn(req) : clientKey(req)).slice(0, 200));
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: message });
    }
    next();
  };
  limiter.hit = hit;
  limiter.message = message;
  limiter.reset = () => hits.clear();
  return limiter;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Localização só na página pública do QR Code (/r/…), e mesmo assim depende da autorização do cliente.
    'Permissions-Policy': `camera=(), microphone=(), geolocation=${req.path.startsWith('/r/') ? '(self)' : '()'}, payment=(), usb=()`,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

module.exports = {
  hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, safeEqual,
  pairingCode, passwordPolicyError, rateLimiter, clientKey, securityHeaders,
};
