'use strict';
// Autenticação do painel (sessão em cookie HttpOnly + token CSRF) e do quiosque (token de dispositivo).
const { get, run } = require('./db');
const { randomToken, sha256, safeEqual } = require('./security');
const { HttpError } = require('./validate');

const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const COOKIE_NAME = SECURE_COOKIE ? '__Host-sid' : 'sid';
const IDLE_MS = 2 * 60 * 60 * 1000;      // 2h sem uso encerra a sessão
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // no máximo 12h por login

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  return [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    SECURE_COOKIE ? 'Secure' : null, `Max-Age=${maxAgeSec}`].filter(Boolean).join('; ');
}

function createSession(res, user, req, { setupRequired = false } = {}) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  // Sessões antigas do mesmo usuário continuam válidas (vários computadores),
  // mas o token novo sempre é gerado no login (evita fixação de sessão).
  run('INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen_at, ip, user_agent, mfa_setup_required) VALUES (?,?,?,?,?,?,?,?)',
    sha256(token), user.id, csrf, now, now, req.ip, String(req.get('user-agent') || '').slice(0, 300), setupRequired ? 1 : 0);
  res.append('Set-Cookie', cookieString(token, ABSOLUTE_MS / 1000));
  return csrf;
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.append('Set-Cookie', cookieString('', 0));
}

function destroyUserSessions(userId) { run('DELETE FROM sessions WHERE user_id = ?', userId); }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MFA_SETUP_ALLOWED = new Set(['GET /me', 'POST /mfa/setup', 'POST /mfa/enable', 'POST /logout']);

// Middleware: exige sessão válida; em métodos que alteram dados exige CSRF + Origin.
function requireUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length > 100) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  const s = get(`SELECT s.*, u.name, u.email, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?`, sha256(token));
  const now = Date.now();
  if (!s || !s.active || now - s.last_seen_at > IDLE_MS || now - s.created_at > ABSOLUTE_MS) {
    if (s) run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  }
  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) throw new HttpError(403, 'Origem não permitida.');
    if (!safeEqual(req.get('x-csrf-token'), s.csrf)) throw new HttpError(403, 'Token CSRF inválido.');
  }
  if (now - s.last_seen_at > 60_000) run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, s.token_hash);
  req.user = { id: s.user_id, name: s.name, email: s.email, role: s.role, csrf: s.csrf, mfaSetupRequired: !!s.mfa_setup_required, sessionHash: s.token_hash };
  // Administrador sem 2FA (quando obrigatório): só pode configurar o 2FA, ver seus dados ou sair.
  if (req.user.mfaSetupRequired && !MFA_SETUP_ALLOWED.has(`${req.method} ${req.path}`)) {
    return res.status(403).json({ error: 'Ative a autenticação em duas etapas para continuar.', code: 'MFA_SETUP_REQUIRED' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Acesso restrito a administradores.');
  next();
}

// Middleware do quiosque: token do dispositivo no cabeçalho Authorization.
// A filial SEMPRE vem do dispositivo — nunca do que o tablet envia.
function requireDevice(req, res, next) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Dispositivo não autorizado.');
  const d = get(`SELECT d.*, b.name AS branch_name, b.active AS branch_active, b.survey_id
                 FROM devices d JOIN branches b ON b.id = d.branch_id WHERE d.token_hash = ?`, sha256(m[1]));
  if (!d || !d.active || !d.branch_active) throw new HttpError(401, 'Dispositivo não autorizado.');
  const now = Date.now();
  if (!d.last_seen_at || now - d.last_seen_at > 30_000) run('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ?', now, req.ip, d.id);
  req.device = d;
  next();
}

module.exports = { createSession, destroySession, destroyUserSessions, requireUser, requireAdmin, requireDevice };
