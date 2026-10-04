'use strict';
// Pesquisa por link/QR Code: o cliente responde no próprio celular, sem login.
// A filial vem do código do link (nunca do corpo). Proteções contra respostas falsas em massa:
//   • limite por IP e por filial;
//   • "bilhete" assinado (HMAC) emitido ao abrir a pesquisa, de uso único e com validade;
//   • tempo mínimo entre abrir e enviar (robôs respondem em milissegundos).
const express = require('express');
const crypto = require('node:crypto');
const { get, run } = require('../db');
const { rateLimiter } = require('../security');
const { HttpError, bad } = require('../validate');
const { lookup, sign } = require('../vault');
const { buildConfig, saveResponse } = require('../responses');

const router = express.Router();
const TICKET_MIN_MS = 3_000;
const TICKET_MAX_MS = 2 * 3_600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

const configLimiter = rateLimiter({ windowMs: 60_000, max: 30 });
const perIp = rateLimiter({ windowMs: 60 * 60_000, max: 10, message: 'Limite de avaliações deste aparelho atingido. Obrigado!' });
const perBranch = rateLimiter({ windowMs: 60 * 60_000, max: 300, keyFn: (req) => 'b:' + req.params.token, message: 'Muitas avaliações no momento. Tente mais tarde.' });

function branchByToken(token) {
  if (!TOKEN_RE.test(token)) throw new HttpError(404, 'Link inválido.');
  const b = get('SELECT * FROM branches WHERE public_token_hash = ? AND public_enabled = 1 AND active = 1', lookup('link:' + token));
  if (!b) throw new HttpError(404, 'Link inválido ou desativado.');
  return b;
}

router.get('/:token/config', configLimiter, (req, res) => {
  const b = branchByToken(req.params.token);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const issued = Date.now();
  run('INSERT INTO link_tickets (nonce, branch_id, issued_at) VALUES (?,?,?)', nonce, b.id, issued);
  res.json(buildConfig(b, { ticket: `${nonce}.${issued}.${sign(`${b.id}.${nonce}.${issued}`)}` }));
});

router.post('/:token/responses', perIp, perBranch, (req, res) => {
  const b = branchByToken(req.params.token);
  const [nonce, issuedRaw, sig] = String(req.body?.ticket || '').split('.');
  const issued = Number(issuedRaw);
  const expected = nonce && Number.isFinite(issued) ? sign(`${b.id}.${nonce}.${issued}`) : '';
  const valid = sig && expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  if (!valid) throw bad('Sessão da pesquisa inválida. Recarregue a página.');
  const age = Date.now() - issued;
  if (age > TICKET_MAX_MS) throw bad('A pesquisa expirou. Recarregue a página.');
  if (age < TICKET_MIN_MS) throw bad('Resposta rápida demais.');
  // Uso único: a atualização só acontece se o bilhete ainda não foi usado.
  const used = run('UPDATE link_tickets SET used_at = ? WHERE nonce = ? AND branch_id = ? AND used_at IS NULL', Date.now(), nonce, b.id);
  if (!used.changes) throw new HttpError(409, 'Esta avaliação já foi enviada. Obrigado!');
  const r = saveResponse({ branch: b, channel: 'link', body: req.body });
  res.status(r.created ? 201 : 200).json({ ok: true });
});

module.exports = router;
