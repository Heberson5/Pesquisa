'use strict';
// Criptografia de dados pessoais (LGPD) e segredos: AES-256-GCM com chave derivada do APP_SECRET.
// "lookup" gera um identificador determinístico (HMAC) para buscar um telefone/e-mail sem guardá-lo aberto.
const crypto = require('node:crypto');
const { appSecret } = require('./config');

const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', appSecret, 'pesquisa-satisfacao', label, 32));
const ENC_KEY = derive('enc-v1');
const LOOKUP_KEY = derive('lookup-v1');
const SIGN_KEY = derive('sign-v1');

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1' || !iv || !tag || data === undefined) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

const lookup = (value) => (value ? crypto.createHmac('sha256', LOOKUP_KEY).update(String(value)).digest('hex') : null);
const sign = (value) => crypto.createHmac('sha256', SIGN_KEY).update(String(value)).digest('base64url');

// Normalizações usadas antes do lookup, para que "(11) 99999-0000" e "11999990000" coincidam.
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const normEmail = (e) => String(e || '').trim().toLowerCase();

module.exports = { encrypt, decrypt, lookup, sign, normPhone, normEmail };
