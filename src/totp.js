'use strict';
// Autenticação em duas etapas (TOTP, RFC 6238) — compatível com Google Authenticator, Microsoft Authenticator, Authy etc.
const crypto = require('node:crypto');
const QRCode = require('qrcode');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const n = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Aceita o código do passo atual e de ±1 passo (relógio do celular adiantado/atrasado).
// Retorna o passo usado, ou null. Passos já usados (<= lastStep) são recusados: impede reutilizar um código interceptado.
function verify(secret, code, lastStep = null, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 1000 / STEP);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}

function otpauthUrl(secret, account, issuer) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;
}

const qrDataUrl = (text) => QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 240 });

// Códigos de recuperação: 10 códigos de 10 caracteres (50 bits cada), uso único.
function recoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const raw = Array.from(crypto.randomBytes(10), (b) => B32[b & 31]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
const normalizeRecovery = (c) => String(c || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

module.exports = { generateSecret, verify, codeAt, otpauthUrl, qrDataUrl, recoveryCodes, normalizeRecovery, STEP };
