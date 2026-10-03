'use strict';
// Cria (ou redefine a senha de) um administrador pelo terminal do servidor.
// Uso: npm run create-admin -- email@empresa.com "Nome Completo"
const readline = require('node:readline');
const { get, run } = require('../src/db');
const { hashPassword, passwordPolicyError } = require('../src/security');

const [email, name = 'Administrador'] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Uso: npm run create-admin -- email@empresa.com "Nome"');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Senha (mín. 10 caracteres, letras e números): ', (password) => {
  rl.close();
  const err = passwordPolicyError(password);
  if (err) { console.error(err); process.exit(1); }
  const existing = get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) {
    run("UPDATE users SET password_hash = ?, role = 'admin', active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?", hashPassword(password), existing.id);
    run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    console.log('Senha redefinida e usuário promovido a admin.');
  } else {
    run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,'admin',?)", name, email.toLowerCase(), hashPassword(password), Date.now());
    console.log('Administrador criado.');
  }
});
