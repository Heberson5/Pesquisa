'use strict';
// Testes de ataque no login: 2FA com segredo ilegível, cookie malformado, 2FA obrigatório ligado com sessões
// abertas, limite de redefinição por e-mail, hash de senha atualizado no login e porta do "configurar 2FA".
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, run, get } = require('./helpers');
const totp = require('../src/totp');
const { hashPassword } = require('../src/security');
const crypto = require('node:crypto');

const PW = 'SenhaForte123';
test.before(async () => {
  await start();
  makeUser('totp@h.local', 'admin');
  makeUser('cookie@h.local', 'admin');
  makeUser('obrig@h.local', 'admin');
  makeUser('reset@h.local', 'gestor');
  makeUser('rehash@h.local', 'gestor');
});
test.after(stop);

test('2FA com segredo que não pode ser decifrado nunca aceita código (nem o calculável com chave vazia)', async () => {
  run("UPDATE users SET totp_enabled = 1, totp_secret_enc = 'lixo-que-nao-decifra' WHERE email = ?", 'totp@h.local');
  const c = new Client(); const r = await c.login('totp@h.local', PW);
  assert.equal(r.json.mfaRequired, true);
  const step = Math.floor(Date.now() / 30_000);
  const crafted = totp.codeAt('', step);
  assert.equal((await c.req('POST', '/api/admin/login/mfa', { body: { challenge: r.json.challenge, code: crafted } })).status, 401);
  assert.equal(totp.verify('', crafted), null);
  assert.ok(get("SELECT 1 FROM audit_log WHERE action = 'mfa.secret_unreadable'"));
});

test('cookie malformado de outro site não derruba a sessão', async () => {
  const c = new Client(); await c.login('cookie@h.local', PW);
  const r = await c.req('GET', '/api/admin/me', { headers: { Cookie: `x=%E0%A4%A; ${c.cookie}` } });
  assert.equal(r.status, 200);
});

test('ligar o 2FA obrigatório vale também para sessões já abertas', async () => {
  const c = new Client(); await c.login('obrig@h.local', PW);
  assert.equal((await c.req('GET', '/api/admin/users')).status, 200);
  run("INSERT INTO settings (key, value) VALUES ('requireAdminMfa', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  try {
    const r = await c.req('GET', '/api/admin/users');
    assert.equal(r.status, 403);
    assert.equal(r.json.code, 'MFA_SETUP_REQUIRED');
    // A porta "só configurar o 2FA" compara o caminho completo: /cases/me não passa.
    assert.equal((await c.req('GET', '/api/admin/cases/me')).status, 403);
    assert.equal((await c.req('GET', '/api/admin/me')).status, 200);
  } finally {
    run("UPDATE settings SET value = 'false' WHERE key = 'requireAdminMfa'");
    }
});

test('limite de redefinição por e-mail não é driblado com espaços; pedido novo não cancela o link anterior', async () => {
  const ask = (email) => new Client().req('POST', '/api/admin/password/forgot', { body: { email } });
  for (const e of ['reset@h.local', ' reset@h.local', '  reset@h.local', 'RESET@h.local ']) await ask(e);
  await new Promise((r) => setTimeout(r, 200));
  const uid = get('SELECT id FROM users WHERE email = ?', 'reset@h.local').id;
  const n = get('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?', uid).n;
  assert.equal(n, 3, 'três links válidos ao mesmo tempo, no máximo; o quarto pedido é barrado pelo limite');
  assert.equal(get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'password_reset' AND recipient = 'reset@h.local'").n, 3);
});

test('hash de senha com parâmetros antigos é refeito no login', async () => {
  const salt = crypto.randomBytes(16);
  const old = `scrypt$16384$8$1$${salt.toString('base64')}$${crypto.scryptSync(PW, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  run('UPDATE users SET password_hash = ? WHERE email = ?', old, 'rehash@h.local');
  assert.equal((await new Client().login('rehash@h.local', PW)).status, 200);
  assert.match(get('SELECT password_hash FROM users WHERE email = ?', 'rehash@h.local').password_hash, /^scrypt\$16384\$8\$5\$/);
  assert.match(hashPassword('x'), /^scrypt\$16384\$8\$5\$/);
});
