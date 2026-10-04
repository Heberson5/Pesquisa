'use strict';
// Autenticação do painel: login em duas etapas (senha + 2FA), recuperação de senha por e-mail
// e gerenciamento do 2FA do próprio usuário.
const express = require('express');
const { get, run, tx, audit } = require('../db');
const { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, passwordPolicyError, rateLimiter } = require('../security');
const { createSession, destroyUserSessions, requireUser } = require('../auth');
const { HttpError, bad } = require('../validate');
const totp = require('../totp');
const { encrypt, decrypt, lookup } = require('../vault');
const { getSettings } = require('../settings');
const { queueEmail, renderEmail } = require('../notify');
const { publicUrl } = require('../config');

const router = express.Router();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const CHALLENGE_TTL = 5 * 60_000;
const RESET_TTL = 30 * 60_000;

const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas de login. Aguarde 15 minutos.' });
const forgotLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 5, message: 'Muitas solicitações. Aguarde 15 minutos.' });
const forgotPerEmail = rateLimiter({ windowMs: 60 * 60_000, max: 3, keyFn: (req) => 'e:' + sha256(String(req.body?.email || '').toLowerCase()), message: 'Muitas solicitações. Aguarde 15 minutos.' });
const mfaLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 15, message: 'Muitas tentativas. Aguarde 15 minutos.' });

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const mfaRequiredFor = (u) => u.role === 'admin' && getSettings().requireAdminMfa;

function registerFailure(user, req, action) {
  const fails = user.failed_logins + 1;
  const lock = fails >= LOCK_AFTER;
  run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock ? Date.now() + LOCK_MS : null, user.id);
  audit(user.id, action, null, req.ip);
}

function finishLogin(res, req, user) {
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
  const setupRequired = !user.totp_enabled && mfaRequiredFor(user);
  const csrf = createSession(res, user, req, { setupRequired });
  audit(user.id, 'login.ok', { mfa: !!user.totp_enabled }, req.ip);
  return { user: publicUser(user), csrf, mfaSetupRequired: setupRequired };
}

// Etapa 1: e-mail e senha.
router.post('/login', loginLimiter, (req, res) => {
  const mail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const user = get('SELECT * FROM users WHERE email = ?', mail);
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  const generic = new HttpError(401, 'E-mail ou senha inválidos.');
  if (!user || !user.active) { audit(null, 'login.failed', { email: mail }, req.ip); throw generic; }
  if (user.locked_until && user.locked_until > Date.now()) {
    audit(user.id, 'login.locked', null, req.ip);
    throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');
  }
  if (!ok) { registerFailure(user, req, 'login.failed'); throw generic; }
  if (user.totp_enabled) {
    // Senha correta, mas falta o código do app autenticador: devolve um desafio de uso único (5 min).
    const challenge = randomToken(32);
    run('DELETE FROM mfa_challenges WHERE user_id = ? OR created_at < ?', user.id, Date.now() - CHALLENGE_TTL);
    run('INSERT INTO mfa_challenges (token_hash, user_id, created_at) VALUES (?,?,?)', sha256(challenge), user.id, Date.now());
    return res.json({ mfaRequired: true, challenge });
  }
  res.json(finishLogin(res, req, user));
});

// Etapa 2: código do autenticador (6 dígitos) ou código de recuperação.
router.post('/login/mfa', loginLimiter, mfaLimiter, (req, res) => {
  const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const c = challenge.length <= 100 ? get('SELECT * FROM mfa_challenges WHERE token_hash = ?', sha256(challenge)) : null;
  const expired = new HttpError(401, 'Sessão de login expirada. Entre novamente com e-mail e senha.');
  if (!c || c.created_at < Date.now() - CHALLENGE_TTL || c.attempts >= 5) { if (c) run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash); throw expired; }
  const user = get('SELECT * FROM users WHERE id = ?', c.user_id);
  if (!user || !user.active || !user.totp_enabled) throw expired;
  if (user.locked_until && user.locked_until > Date.now()) throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');

  let valid = false;
  const step = totp.verify(decrypt(user.totp_secret_enc) || '', code, user.totp_last_step);
  if (step !== null) {
    run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
    valid = true;
  } else {
    const norm = totp.normalizeRecovery(code);
    if (norm.length === 10) {
      const r = run('UPDATE mfa_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', Date.now(), user.id, lookup('rc:' + norm));
      if (r.changes === 1) { valid = true; audit(user.id, 'mfa.recovery_code_used', null, req.ip); }
    }
  }
  if (!valid) {
    run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', c.token_hash);
    registerFailure(user, req, 'login.mfa_failed');
    throw new HttpError(401, 'Código inválido.');
  }
  run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash);
  res.json(finishLogin(res, req, user));
});

// ---------------------------------------------------------------- recuperação de senha
// Resposta sempre igual (não revela se o e-mail existe). O link usa PUBLIC_URL — nunca o Host da requisição.
router.post('/password/forgot', forgotLimiter, forgotPerEmail, (req, res) => {
  const mail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
  const user = mail ? get('SELECT * FROM users WHERE email = ? AND active = 1', mail) : null;
  if (user) {
    const token = randomToken(32);
    run('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?', user.id, Date.now());
    run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), user.id, Date.now(), Date.now() + RESET_TTL);
    const s = getSettings();
    const { html, text } = renderEmail({
      brand: s, title: 'Redefinição de senha',
      intro: `Olá, ${user.name}. Recebemos um pedido para redefinir sua senha do painel. O link vale por 30 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha continua a mesma.`,
      button: { label: 'Criar nova senha', url: `${publicUrl}/admin/#/redefinir/${token}` },
      footer: `Pedido feito a partir do IP ${req.ip}.`,
    });
    queueEmail({ to: user.email, subject: `${s.companyName}: redefinição de senha`, text, html, kind: 'password_reset' });
    audit(user.id, 'password.reset_requested', null, req.ip);
  } else {
    audit(null, 'password.reset_unknown', { email: mail.slice(0, 80) }, req.ip);
  }
  res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.' });
});

router.post('/password/reset', forgotLimiter, (req, res) => {
  const token = typeof req.body?.token === 'string' && req.body.token.length <= 100 ? req.body.token : '';
  const err = passwordPolicyError(req.body?.password);
  if (err) throw bad(err);
  const r = token ? get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(token)) : null;
  if (!r || r.used_at || r.expires_at < Date.now()) throw new HttpError(400, 'Link inválido ou expirado. Solicite um novo.');
  tx(() => {
    run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', Date.now(), r.token_hash);
    run('DELETE FROM password_resets WHERE user_id = ? AND token_hash <> ?', r.user_id, r.token_hash);
    run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(req.body.password), r.user_id);
  });
  destroyUserSessions(r.user_id);
  audit(r.user_id, 'password.reset_done', null, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 2FA do próprio usuário (exige login)
// Configurar ou trocar o 2FA exige a senha atual (protege contra sessão esquecida aberta).
function requirePassword(req) {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body?.password || '').slice(0, 200), u.password_hash)) {
    registerFailure(u, req, 'mfa.bad_password');
    throw bad('Senha atual incorreta.');
  }
  return u;
}

router.get('/mfa', requireUser, (req, res) => {
  const u = get('SELECT totp_enabled FROM users WHERE id = ?', req.user.id);
  const left = get('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', req.user.id).n;
  res.json({ enabled: !!u.totp_enabled, required: mfaRequiredFor(req.user), recoveryCodesLeft: left });
});

router.post('/mfa/setup', requireUser, mfaLimiter, async (req, res) => {
  const u = requirePassword(req);
  if (u.totp_enabled) throw new HttpError(409, 'O 2FA já está ativo. Desative antes de configurar um novo aparelho.');
  const secret = totp.generateSecret();
  run('UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?', encrypt(secret), u.id);
  const url = totp.otpauthUrl(secret, u.email, getSettings().companyName);
  res.json({ secret, otpauthUrl: url, qr: await totp.qrDataUrl(url) });
});

function issueRecoveryCodes(userId) {
  const codes = totp.recoveryCodes();
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  for (const c of codes) run('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?,?)', userId, lookup('rc:' + totp.normalizeRecovery(c)));
  return codes;
}

router.post('/mfa/enable', requireUser, mfaLimiter, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (u.totp_enabled) throw new HttpError(409, 'O 2FA já está ativo.');
  const secret = decrypt(u.totp_secret_enc);
  if (!secret) throw bad('Comece a configuração novamente.');
  const step = totp.verify(secret, String(req.body?.code || '').trim(), null);
  if (step === null) throw bad('Código inválido. Confira o horário do celular e tente de novo.');
  const codes = tx(() => {
    run('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?', step, u.id);
    return issueRecoveryCodes(u.id);
  });
  // Derruba as outras sessões e libera a atual.
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', u.id, req.user.sessionHash);
  run('UPDATE sessions SET mfa_setup_required = 0 WHERE token_hash = ?', req.user.sessionHash);
  audit(u.id, 'mfa.enabled', null, req.ip);
  res.json({ ok: true, recoveryCodes: codes });
});

router.post('/mfa/recovery-codes', requireUser, mfaLimiter, (req, res) => {
  const u = requirePassword(req);
  if (!u.totp_enabled) throw bad('Ative o 2FA primeiro.');
  const codes = issueRecoveryCodes(u.id);
  audit(u.id, 'mfa.recovery_regenerated', null, req.ip);
  res.json({ recoveryCodes: codes });
});

router.post('/mfa/disable', requireUser, mfaLimiter, (req, res) => {
  const u = requirePassword(req);
  if (mfaRequiredFor(u)) throw new HttpError(403, 'O 2FA é obrigatório para administradores nesta empresa.');
  const step = totp.verify(decrypt(u.totp_secret_enc) || '', String(req.body?.code || '').trim(), u.totp_last_step);
  if (step === null) throw bad('Código inválido.');
  tx(() => {
    run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?', u.id);
    run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', u.id);
  });
  audit(u.id, 'mfa.disabled', null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
module.exports.resetUserMfa = (userId) => tx(() => {
  run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?', userId);
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  destroyUserSessions(userId);
});
