'use strict';
// Testes de ataque: 2FA (TOTP), códigos de recuperação e recuperação de senha por e-mail.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const totp = require('../src/totp');

const PW = 'SenhaForte123';
const now = () => totp.codeAt(secret, Math.floor(Date.now() / 30000));
let secret; let recovery;

async function enroll(c) {
  const s = await c.req('POST', '/api/admin/mfa/setup', { body: { password: PW } });
  assert.equal(s.status, 200, s.text);
  assert.match(s.json.qr, /^data:image\/png;base64,/);
  secret = s.json.secret;
  const e = await c.req('POST', '/api/admin/mfa/enable', { body: { code: now() } });
  assert.equal(e.status, 200, e.text);
  return e.json.recoveryCodes;
}
const resetLink = (email) => {
  const row = get("SELECT body_text FROM outbox WHERE kind = 'password_reset' AND recipient = ? ORDER BY id DESC LIMIT 1", email);
  return row && /#\/redefinir\/([A-Za-z0-9_-]+)/.exec(row.body_text)?.[1];
};

test.before(async () => {
  await start();
  makeUser('mfa@t.local', 'admin');
  makeUser('reset@t.local', 'gestor');
  makeUser('obrig@t.local', 'admin');
});
test.after(stop);

test('2FA: configuração exige a senha atual', async () => {
  const c = new Client(); await c.login('mfa@t.local', PW);
  assert.equal((await c.req('POST', '/api/admin/mfa/setup', { body: { password: 'errada' } })).status, 400);
  recovery = await enroll(c);
  assert.equal(recovery.length, 10);
  assert.equal(get('SELECT totp_enabled FROM users WHERE email = ?', 'mfa@t.local').totp_enabled, 1);
  // segredo nunca fica em texto puro no banco
  const enc = get('SELECT totp_secret_enc FROM users WHERE email = ?', 'mfa@t.local').totp_secret_enc;
  assert.ok(enc.startsWith('v1.') && !enc.includes(secret));
});

test('2FA: senha correta sem código NÃO cria sessão', async () => {
  const c = new Client();
  const r = await c.login('mfa@t.local', PW);
  assert.equal(r.json.mfaRequired, true);
  assert.equal(r.setCookie, null);
  assert.equal((await c.req('GET', '/api/admin/me')).status, 401);
});

test('2FA: código errado, desafio forjado e reutilização de código são recusados', async () => {
  const c = new Client();
  const r = await c.login('mfa@t.local', PW);
  assert.equal((await c.req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code: '000000' === now() ? '111111' : '000000' } })).status, 401);
  assert.equal((await c.req('POST', '/api/admin/login/mfa', { body: { challenge: 'A'.repeat(43), code: now() } })).status, 401);
  // espera o próximo passo de 30s para não colidir com o código usado na ativação
  await new Promise((res) => setTimeout(res, 31_000 - (Date.now() % 30_000)));
  const code = now();
  const ok = await c.req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await c.req('GET', '/api/admin/me')).status, 200);
  // mesmo código, novo login: recusado (anti-replay)
  const c2 = new Client(); const r2 = await c2.login('mfa@t.local', PW);
  assert.equal((await c2.req('POST', '/api/admin/login/mfa', { body: { challenge: r2.json.challenge, code } })).status, 401);
  // o desafio já usado não serve de novo
  assert.equal((await new Client().req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code: now() } })).status, 401);
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'mfa@t.local');
});

test('2FA: código de recuperação funciona uma única vez', async () => {
  const c = new Client(); const r = await c.login('mfa@t.local', PW);
  const ok = await c.req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code: recovery[0].toLowerCase() } });
  assert.equal(ok.status, 200, ok.text);
  const c2 = new Client(); const r2 = await c2.login('mfa@t.local', PW);
  assert.equal((await c2.req('POST', '/api/admin/login/mfa', { body: { challenge: r2.json.challenge, code: recovery[0] } })).status, 401);
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'mfa@t.local');
});

test('2FA: desafio expira após 5 tentativas (força bruta no código)', async () => {
  const c = new Client(); const r = await c.login('mfa@t.local', PW);
  for (let i = 0; i < 5; i++) await c.req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code: String(100000 + i) } });
  assert.notEqual((await c.req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code: now() } })).status, 200);
  assert.ok(get('SELECT locked_until FROM users WHERE email = ?', 'mfa@t.local').locked_until > Date.now());
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'mfa@t.local');
});

test('2FA obrigatório: admin sem 2FA só consegue configurar o 2FA', async () => {
  run("UPDATE settings SET value = 'true' WHERE key = 'requireAdminMfa'");
  const c = new Client(); const r = await c.login('obrig@t.local', PW);
  assert.equal(r.json.mfaSetupRequired, true);
  for (const [m, u] of [['GET', '/api/admin/cases'], ['POST', '/api/admin/privacy/search'], ['GET', '/api/admin/report.pptx'], ['GET', '/api/admin/stats'], ['GET', '/api/admin/users'], ['GET', '/api/admin/responses.csv'], ['PUT', '/api/admin/settings'], ['POST', '/api/admin/branches']]) {
    const x = await c.req(m, u, { body: {} });
    assert.equal(x.status, 403, `${m} ${u}`);
    assert.equal(x.json?.code, 'MFA_SETUP_REQUIRED');
  }
  assert.equal((await c.req('GET', '/api/admin/me')).status, 200);
  await enroll(c);
  assert.equal((await c.req('GET', '/api/admin/stats')).status, 200);
  // com 2FA obrigatório, admin não pode desligar o próprio 2FA
  assert.equal((await c.req('POST', '/api/admin/mfa/disable', { body: { password: PW, code: now() } })).status, 403);
  run("UPDATE settings SET value = 'false' WHERE key = 'requireAdminMfa'");
});

test('recuperação de senha: resposta não revela se o e-mail existe', async () => {
  const a = await new Client().req('POST', '/api/admin/password/forgot', { body: { email: 'reset@t.local' } });
  const b = await new Client().req('POST', '/api/admin/password/forgot', { body: { email: 'naoexiste@t.local' } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(a.text, b.text);
  assert.ok(resetLink('reset@t.local'));
  assert.equal(get("SELECT COUNT(*) AS n FROM outbox WHERE recipient = 'naoexiste@t.local'").n, 0);
});

test('recuperação de senha: link usa PUBLIC_URL e ignora Host forjado', async () => {
  await new Client().req('POST', '/api/admin/password/forgot', { body: { email: 'reset@t.local' }, headers: { Host: 'site-do-atacante.com', 'X-Forwarded-Host': 'site-do-atacante.com' } });
  const body = get("SELECT body_text, body_html FROM outbox WHERE kind = 'password_reset' ORDER BY id DESC LIMIT 1");
  assert.doesNotMatch(body.body_text + body.body_html, /atacante/);
});

test('recuperação de senha: token é de uso único, invalida sessões e respeita a política de senha', async () => {
  const s = new Client(); await s.login('reset@t.local', PW);
  await new Client().req('POST', '/api/admin/password/forgot', { body: { email: 'reset@t.local' } });
  const token = resetLink('reset@t.local');
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token, password: '123' } })).status, 400);
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token: 'x'.repeat(43), password: 'NovaSenha2026' } })).status, 400);
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token, password: 'NovaSenha2026' } })).status, 200);
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token, password: 'OutraSenha2026' } })).status, 400);
  assert.equal((await s.req('GET', '/api/admin/me')).status, 401, 'sessão antiga deve cair');
  assert.equal((await new Client().login('reset@t.local', 'NovaSenha2026')).status, 200);
});

test('recuperação de senha: link expirado não funciona e pedidos em massa são limitados', async () => {
  await new Client().req('POST', '/api/admin/password/forgot', { body: { email: 'reset@t.local' } });
  const token = resetLink('reset@t.local');
  run('UPDATE password_resets SET expires_at = ?', Date.now() - 1);
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token, password: 'NovaSenha2027' } })).status, 400);
  const c = new Client(); let last;
  for (let i = 0; i < 7; i++) last = await c.req('POST', '/api/admin/password/forgot', { body: { email: `x${i}@t.local` } });
  assert.equal(last.status, 429);
});

test('admin pode resetar o 2FA de outro usuário (celular perdido), mas não o próprio por essa via', async () => {
  const adm = new Client(); await adm.login('reset@t.local', 'NovaSenha2026'); void adm;
  makeUser('chefe@t.local', 'admin');
  const boss = new Client(); await boss.login('chefe@t.local', PW);
  const mfaUser = get('SELECT id, name, email, role FROM users WHERE email = ?', 'mfa@t.local');
  const r = await boss.req('PUT', `/api/admin/users/${mfaUser.id}`, { body: { name: mfaUser.name, email: mfaUser.email, role: 'admin', resetMfa: true } });
  assert.equal(r.status, 200, r.text);
  assert.equal(get('SELECT totp_enabled FROM users WHERE id = ?', mfaUser.id).totp_enabled, 0);
  const me = get('SELECT id, name, email FROM users WHERE email = ?', 'chefe@t.local');
  assert.equal((await boss.req('PUT', `/api/admin/users/${me.id}`, { body: { name: me.name, email: me.email, role: 'admin', resetMfa: true } })).status, 400);
});
