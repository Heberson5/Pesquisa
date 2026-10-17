'use strict';
// Autenticação do painel: login em duas etapas (senha + 2FA), recuperação de senha por e-mail
// e gerenciamento do 2FA do próprio usuário.
const express = require('express');
const { get, run, tx, audit } = require('../db');
const { hashPassword, verifyPasswordAsync, needsRehash, DUMMY_HASH, randomToken, sha256, passwordPolicyError, rateLimiter, clientKey } = require('../security');
const { createSession, destroyUserSessions, requireUser } = require('../auth');
const { HttpError, bad } = require('../validate');
const totp = require('../totp');
const { encrypt, decrypt, lookup } = require('../vault');
const { isPrivileged } = require('../permissions');
const { getSettings } = require('../settings');
const { queueEmail } = require('../notify');
const templates = require('../templates');
const { publicUrl } = require('../config');

const router = express.Router();
const LOCK_AFTER = 5;          // erros seguidos de uma mesma rede numa conta: bloqueia só essa rede
const LOCK_MS = 15 * 60_000;
const ACCOUNT_LOCK_AFTER = 50; // erros de muitas redes diferentes: bloqueia a conta toda e avisa o dono
const CHALLENGE_TTL = 5 * 60_000;
const RESET_TTL = 30 * 60_000;
const RESETS_ACTIVE_MAX = 3;

// E-mail normalizado igual em todo lugar (limites, busca do usuário): espaços não driblam o limite por e-mail.
const normMail = (v) => (typeof v === 'string' ? v.trim().toLowerCase().slice(0, 254) : '');

const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas de login. Aguarde 15 minutos.' });
const forgotLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 5, message: 'Muitas solicitações. Aguarde 15 minutos.' });
const forgotPerEmail = rateLimiter({ windowMs: 60 * 60_000, max: 3, keyFn: (req) => 'e:' + sha256(normMail(req.body?.email)), message: 'Muitas solicitações. Aguarde 15 minutos.' });
const mfaLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 15, message: 'Muitas tentativas. Aguarde 15 minutos.' });

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
// 2FA obrigatório (quando a empresa exige): administradores e perfis que podem mudar usuários, permissões ou configurações.
const mfaRequiredFor = (u) => getSettings().requireAdminMfa && isPrivileged(u);

// Bloqueio por excesso de erros. Quem erra a senha de uma rede bloqueia só a si mesmo (conta + rede), então
// ninguém consegue trancar o dono da conta de fora. Ataques de muitas redes caem no limite da conta, que avisa
// o dono por e-mail. A resposta é sempre a mesma de senha errada (não revela se a conta existe ou está bloqueada).
const pairFails = new Map(); // `${userId}|${rede}` -> { count, until }
setInterval(() => { const now = Date.now(); for (const [k, v] of pairFails) if (v.until <= now && v.seen < now - LOCK_MS) pairFails.delete(k); }, 60_000).unref();
const pairKey = (user, req) => `${user.id}|${clientKey(req)}`;
function isBlocked(user, req) {
  if (user.locked_until && user.locked_until > Date.now()) return true;
  const e = pairFails.get(pairKey(user, req));
  return !!e && e.until > Date.now();
}
function registerFailure(user, req, action) {
  const k = pairKey(user, req);
  const now = Date.now();
  const e = pairFails.get(k) || { count: 0, until: 0, seen: now };
  if (pairFails.size < 100_000 || pairFails.has(k)) {
    e.count++; e.seen = now;
    if (e.count >= LOCK_AFTER) { e.count = 0; e.until = now + LOCK_MS; audit(user.id, 'login.locked', { network: clientKey(req) }, req.ip); }
    pairFails.set(k, e);
  }
  const fails = (get('SELECT failed_logins FROM users WHERE id = ?', user.id)?.failed_logins || 0) + 1;
  if (fails >= ACCOUNT_LOCK_AFTER) {
    run('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?', now + LOCK_MS, user.id);
    audit(user.id, 'login.locked', { account: true }, req.ip);
    queueEmail({ to: user.email, kind: 'account_locked', html: null, subject: `${getSettings().companyName}: muitas tentativas de acesso na sua conta`,
      text: `Olá, ${user.name}.\n\nHouve muitas tentativas de entrar na sua conta com senha errada, de vários lugares. Por segurança, o acesso ficou bloqueado por 15 minutos.\n\nSe não foi você, troque sua senha e ative a verificação em duas etapas (2FA) em Minha conta.` });
  } else {
    run('UPDATE users SET failed_logins = ? WHERE id = ?', fails, user.id);
  }
  audit(user.id, action, null, req.ip);
}
// Desbloqueio pelo administrador (Usuários → Desbloquear) também libera as redes bloqueadas.
function clearLoginFailures(userId) {
  for (const k of pairFails.keys()) if (k.startsWith(`${userId}|`)) pairFails.delete(k);
}

function finishLogin(res, req, user) {
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
  pairFails.delete(pairKey(user, req));
  const setupRequired = !user.totp_enabled && mfaRequiredFor(user);
  const csrf = createSession(res, user, req, { setupRequired });
  audit(user.id, 'login.ok', { mfa: !!user.totp_enabled }, req.ip);
  return { user: publicUser(user), csrf, mfaSetupRequired: setupRequired };
}

// Etapa 1: e-mail e senha.
router.post('/login', loginLimiter, async (req, res) => {
  const mail = normMail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const user = get('SELECT * FROM users WHERE email = ?', mail);
  const ok = await verifyPasswordAsync(password, user ? user.password_hash : DUMMY_HASH);
  const generic = new HttpError(401, 'E-mail ou senha inválidos.');
  if (!user || !user.active) { audit(null, 'login.failed', { email: mail }, req.ip); throw generic; }
  if (isBlocked(user, req)) { audit(user.id, 'login.blocked', null, req.ip); throw generic; }
  if (!ok) { registerFailure(user, req, 'login.failed'); throw generic; }
  // Senha guardada com parâmetros antigos: refeita com os atuais.
  if (needsRehash(user.password_hash)) run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  if (user.totp_enabled) {
    // Senha correta, mas falta o código do app autenticador: devolve um desafio de uso único (5 min).
    const challenge = randomToken(32);
    run('DELETE FROM mfa_challenges WHERE user_id = ? OR created_at < ?', user.id, Date.now() - CHALLENGE_TTL);
    run('INSERT INTO mfa_challenges (token_hash, user_id, created_at) VALUES (?,?,?)', sha256(challenge), user.id, Date.now());
    return res.json({ mfaRequired: true, challenge });
  }
  res.json(finishLogin(res, req, user));
});

// Código do autenticador do usuário. Segredo que não pode ser decifrado (ex.: APP_SECRET trocado) nunca valida
// código de 6 dígitos — só códigos de recuperação — e fica registrado na auditoria.
function checkTotp(user, code, req) {
  const secret = decrypt(user.totp_secret_enc);
  if (!secret) { audit(user.id, 'mfa.secret_unreadable', null, req.ip); return null; }
  return totp.verify(secret, code, user.totp_last_step);
}

// Etapa 2: código do autenticador (6 dígitos) ou código de recuperação.
router.post('/login/mfa', loginLimiter, mfaLimiter, (req, res) => {
  const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const c = challenge.length <= 100 ? get('SELECT * FROM mfa_challenges WHERE token_hash = ?', sha256(challenge)) : null;
  const expired = new HttpError(401, 'Sessão de login expirada. Entre novamente com e-mail e senha.');
  if (!c || c.created_at < Date.now() - CHALLENGE_TTL || c.attempts >= 5) { if (c) run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash); throw expired; }
  const user = get('SELECT * FROM users WHERE id = ?', c.user_id);
  if (!user || !user.active || !user.totp_enabled) throw expired;
  if (isBlocked(user, req)) { audit(user.id, 'login.blocked', null, req.ip); throw new HttpError(401, 'Código inválido.'); }

  let valid = false;
  const step = checkTotp(user, code, req);
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
  const mail = normMail(req.body?.email);
  // Responde antes de qualquer trabalho com o usuário: o tempo de resposta não revela se o e-mail existe.
  res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.' });
  const ip = req.ip;
  setImmediate(() => {
    try {
      const user = mail ? get('SELECT * FROM users WHERE email = ? AND active = 1', mail) : null;
      if (!user) { audit(null, 'password.reset_unknown', { email: mail.slice(0, 80) }, ip); return; }
      run('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL', Date.now());
      // Pedidos novos não cancelam o link que a pessoa já recebeu; no máximo 3 links válidos ao mesmo tempo.
      if (get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', user.id).n >= RESETS_ACTIVE_MAX) { audit(user.id, 'password.reset_throttled', null, ip); return; }
      const token = randomToken(32);
      run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), user.id, Date.now(), Date.now() + RESET_TTL);
      const link = `${publicUrl}/admin/#/redefinir/${token}`;
      const m = templates.emailFor('reset', { destinatario: user.name, ip }, { buttonUrl: link });
      queueEmail({ to: user.email, subject: m.subject, text: m.text, html: m.html, kind: 'password_reset' });
      audit(user.id, 'password.reset_requested', null, ip);
    } catch (e) { console.error('[senha] pedido de redefinição', e.message); }
  });
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
  clearLoginFailures(r.user_id);
  destroyUserSessions(r.user_id);
  audit(r.user_id, 'password.reset_done', null, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 2FA do próprio usuário (exige login)
// Configurar ou trocar o 2FA exige a senha atual (protege contra sessão esquecida aberta).
async function requirePassword(req) {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (isBlocked(u, req) || !(await verifyPasswordAsync(String(req.body?.password || '').slice(0, 200), u.password_hash))) {
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
  const u = await requirePassword(req);
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
  // Aviso ao dono: se não foi ele, alguém com a senha dele ativou o 2FA num aparelho próprio.
  queueEmail({ to: u.email, kind: 'mfa_enabled', html: null, subject: `${getSettings().companyName}: verificação em duas etapas ativada`,
    text: `Olá, ${u.name}.\n\nA verificação em duas etapas (2FA) foi ativada na sua conta agora. Se não foi você, fale imediatamente com o administrador do sistema.` });
  res.json({ ok: true, recoveryCodes: codes });
});

router.post('/mfa/recovery-codes', requireUser, mfaLimiter, async (req, res) => {
  const u = await requirePassword(req);
  if (!u.totp_enabled) throw bad('Ative o 2FA primeiro.');
  // Novos códigos de recuperação exigem também o código atual do aplicativo (só a senha não basta).
  const step = checkTotp(u, String(req.body?.code || '').trim(), req);
  if (step === null) { registerFailure(u, req, 'mfa.bad_code'); throw bad('Código do aplicativo inválido.'); }
  run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, u.id);
  const codes = issueRecoveryCodes(u.id);
  audit(u.id, 'mfa.recovery_regenerated', null, req.ip);
  res.json({ recoveryCodes: codes });
});

router.post('/mfa/disable', requireUser, mfaLimiter, async (req, res) => {
  const u = await requirePassword(req);
  if (mfaRequiredFor(u)) throw new HttpError(403, 'O 2FA é obrigatório para o seu perfil nesta empresa.');
  const step = checkTotp(u, String(req.body?.code || '').trim(), req);
  if (step === null) { registerFailure(u, req, 'mfa.bad_code'); throw bad('Código inválido.'); }
  tx(() => {
    run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?', u.id);
    run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', u.id);
  });
  // Sem 2FA, as outras sessões (abertas com a proteção antiga) caem.
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', u.id, req.user.sessionHash);
  audit(u.id, 'mfa.disabled', null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
module.exports.resetUserMfa = (userId) => tx(() => {
  run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?', userId);
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  run('DELETE FROM password_resets WHERE user_id = ?', userId);
  destroyUserSessions(userId);
});
module.exports.clearLoginFailures = clearLoginFailures;
module.exports.registerFailure = registerFailure;
module.exports.isBlocked = isBlocked;
