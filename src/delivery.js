'use strict';
// Configuração de envio (e-mail SMTP e WhatsApp da Meta) feita pelo painel.
// Senha do SMTP e token do WhatsApp ficam criptografados no banco (AES-256-GCM) e NUNCA voltam ao navegador:
// a tela só recebe "senha cadastrada: sim/não". Sem configuração no painel, vale o que estiver no .env (SMTP_*, WHATSAPP_*).
const dns = require('node:dns').promises;
const net = require('node:net');
const config = require('./config');
const { get, run } = require('./db');
const { encrypt, decrypt } = require('./vault');
const { bad } = require('./validate');

const KEY = 'delivery';
const SMTP_PORTS = [25, 465, 587, 2525];
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function stored() {
  const row = get('SELECT value FROM settings WHERE key = ?', KEY);
  try { return row ? JSON.parse(row.value) : {}; } catch { return {}; }
}
const write = (v) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(v));
const dec = (v) => { try { return v ? decrypt(v) : ''; } catch { return ''; } };

// Configuração em uso (painel tem prioridade sobre o .env).
function smtp() {
  const s = stored().smtp;
  if (s?.host) {
    return { source: 'painel', host: s.host, port: s.port, secure: !!s.secure, from: s.from,
      auth: s.user ? { user: s.user, pass: dec(s.passEnc) } : undefined };
  }
  return config.smtp ? { ...config.smtp, source: 'servidor' } : null;
}
function whatsapp() {
  const w = stored().whatsapp;
  if (w?.phoneId && w.tokenEnc) return { source: 'painel', phoneId: w.phoneId, token: dec(w.tokenEnc) };
  return config.whatsapp ? { ...config.whatsapp, source: 'servidor' } : null;
}

// Visão para a tela: sem segredos.
function publicView() {
  const s = stored(); const sm = smtp(); const wa = whatsapp();
  return {
    smtp: { configured: !!sm, source: sm?.source || null, host: s.smtp?.host || sm?.host || '', port: s.smtp?.port || sm?.port || 587,
      secure: s.smtp ? !!s.smtp.secure : !!sm?.secure, user: s.smtp?.user ?? sm?.auth?.user ?? '', from: s.smtp?.from || sm?.from || '',
      passwordSet: !!(s.smtp?.passEnc || sm?.auth?.pass) },
    whatsapp: { configured: !!wa, source: wa?.source || null, phoneId: s.whatsapp?.phoneId || wa?.phoneId || '', tokenSet: !!(s.whatsapp?.tokenEnc || wa?.token) },
  };
}

const isPrivateOrLocal = (ip) => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('::ffff:');
};

// Resolve o servidor SMTP para um IP PÚBLICO (impede apontar para serviços internos da VPS). O IP é "fixado" no envio.
async function resolvePublic(host) {
  if (net.isIP(host)) throw bad('Use o nome do servidor (ex.: smtp.gmail.com), não um número de IP.');
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw bad('Não foi possível encontrar esse servidor de e-mail. Confira o endereço.'); }
  if (!addrs.length || addrs.some((a) => isPrivateOrLocal(a.address))) throw bad('O servidor de e-mail precisa ser público (não pode apontar para a rede interna).');
  return addrs[0].address;
}

// Valida e grava. Campos em branco mantêm o valor atual (senha/token nunca precisam ser digitados de novo).
async function save(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('Dados inválidos.');
  const cur = stored(); const next = { ...cur };
  const str = (v, field, max) => { if (typeof v !== 'string') throw bad(`Valor de ${field} inválido.`); const t = v.trim(); if (t.length > max || /[\r\n\0]/.test(t)) throw bad(`Valor de ${field} inválido.`); return t; };

  if (input.smtp !== undefined) {
    const s = input.smtp;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw bad('Dados do e-mail inválidos.');
    if (s.clear === true) delete next.smtp;
    else {
      const prev = cur.smtp || {};
      const host = str(s.host ?? prev.host ?? '', 'servidor', 253).toLowerCase();
      if (!HOST_RE.test(host)) throw bad('Servidor de e-mail inválido (ex.: smtp.gmail.com).');
      if (s.port !== undefined && (typeof s.port !== 'number' && !/^\d{1,5}$/.test(String(s.port)))) throw bad('Porta inválida.');
      const port = Number(s.port ?? prev.port ?? 587);
      if (!SMTP_PORTS.includes(port)) throw bad(`Porta inválida. Use ${SMTP_PORTS.join(', ')}.`);
      const user = str(s.user ?? prev.user ?? '', 'usuário', 200);
      const from = str(s.from ?? prev.from ?? user, 'remetente', 200);
      if (!from) throw bad('Informe o e-mail remetente.');
      if (!/^([^<>"\r\n]{0,100}<)?[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+>?$/.test(from)) throw bad('E-mail remetente inválido (ex.: pesquisa@empresa.com.br).');
      let passEnc = prev.passEnc || null;
      if (s.password !== undefined && s.password !== '') {
        if (typeof s.password !== 'string' || s.password.length > 300 || /[\r\n\0]/.test(s.password)) throw bad('Senha inválida.');
        passEnc = encrypt(s.password);
      }
      if (user && !passEnc) throw bad('Informe a senha do e-mail.');
      await resolvePublic(host);
      next.smtp = { host, port, secure: s.secure === undefined ? port === 465 : s.secure === true || port === 465, user, from, passEnc };
    }
  }
  if (input.whatsapp !== undefined) {
    const w = input.whatsapp;
    if (!w || typeof w !== 'object' || Array.isArray(w)) throw bad('Dados do WhatsApp inválidos.');
    if (w.clear === true) delete next.whatsapp;
    else {
      const prev = cur.whatsapp || {};
      const phoneId = str(w.phoneId ?? prev.phoneId ?? '', 'identificador do número', 30);
      if (!/^\d{5,30}$/.test(phoneId)) throw bad('O "Identificador do número" do WhatsApp tem só números (veja no painel da Meta).');
      let tokenEnc = prev.tokenEnc || null;
      if (w.token !== undefined && w.token !== '') {
        if (typeof w.token !== 'string' || !/^[A-Za-z0-9_\-.=]{20,600}$/.test(w.token.trim())) throw bad('Token do WhatsApp inválido.');
        tokenEnc = encrypt(w.token.trim());
      }
      if (!tokenEnc) throw bad('Informe o token de acesso do WhatsApp.');
      next.whatsapp = { phoneId, tokenEnc };
    }
  }
  write(next);
  return publicView();
}

module.exports = { smtp, whatsapp, publicView, save, resolvePublic, isPrivateOrLocal };
