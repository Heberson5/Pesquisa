'use strict';
// Configuração por variáveis de ambiente. Em produção, recusa iniciar sem os segredos obrigatórios.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const DATA_DIR = env.DATA_DIR || path.join(__dirname, '..', 'data');

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

// APP_SECRET: chave mestra para criptografar dados pessoais e segredos de 2FA.
// Em desenvolvimento é gerada uma vez e guardada em data/.dev-secret.
let appSecret = env.APP_SECRET;
if (!appSecret) {
  if (isProd) fail('APP_SECRET é obrigatório em produção (gere com: openssl rand -base64 48).');
  const file = path.join(DATA_DIR, '.dev-secret');
  try { appSecret = fs.readFileSync(file, 'utf8').trim(); } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    appSecret = crypto.randomBytes(48).toString('base64');
    fs.writeFileSync(file, appSecret, { mode: 0o600 });
  }
}
if (appSecret.length < 32) fail('APP_SECRET precisa ter pelo menos 32 caracteres.');

// PUBLIC_URL: endereço público usado em links de e-mail e QR Codes.
// Nunca usamos o cabeçalho Host da requisição para isso (evita "host header injection").
let publicUrl = (env.PUBLIC_URL || (isProd ? '' : `http://127.0.0.1:${env.PORT || 3000}`)).replace(/\/+$/, '');
if (!publicUrl) fail('PUBLIC_URL é obrigatório em produção (ex.: https://pesquisa.sauberlich.com.br).');
try {
  const u = new URL(publicUrl);
  if (isProd && u.protocol !== 'https:') fail('PUBLIC_URL deve usar https em produção.');
  publicUrl = u.origin;
} catch { fail('PUBLIC_URL inválido.'); }

const smtp = env.SMTP_HOST ? {
  host: env.SMTP_HOST,
  port: Number(env.SMTP_PORT || 587),
  secure: env.SMTP_SECURE === 'true' || Number(env.SMTP_PORT) === 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
  from: env.SMTP_FROM || env.SMTP_USER,
} : null;
if (smtp && (!smtp.from || /[\r\n]/.test(smtp.from))) fail('SMTP_FROM inválido.');

const whatsapp = env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID ? {
  token: env.WHATSAPP_TOKEN,
  phoneId: /^\d{5,30}$/.test(env.WHATSAPP_PHONE_ID) ? env.WHATSAPP_PHONE_ID : fail('WHATSAPP_PHONE_ID inválido.'),
} : null;

module.exports = {
  isProd,
  isTest: env.NODE_ENV === 'test',
  DATA_DIR,
  appSecret,
  publicUrl,
  smtp,
  whatsapp,
  timezone: env.TZ_EMPRESA || 'America/Sao_Paulo',
  jobsEnabled: env.DISABLE_JOBS !== 'true',
};
