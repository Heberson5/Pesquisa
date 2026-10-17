'use strict';
// Pesquisa por link/QR Code: o cliente responde no próprio celular, sem login.
// A filial vem do código do link (nunca do corpo). Proteções contra respostas falsas em massa:
//   • limite por IP e por filial;
//   • "bilhete" assinado (HMAC) emitido ao abrir a pesquisa, de uso único e com validade;
//   • tempo mínimo entre abrir e enviar (robôs respondem em milissegundos).
const express = require('express');
const crypto = require('node:crypto');
const { get, run } = require('../db');
const { rateLimiter, safeEqual } = require('../security');
const { HttpError, bad } = require('../validate');
const { lookup, sign } = require('../vault');
const { buildConfig, saveResponse } = require('../responses');
const { deviceLabel } = require('../ua');

const router = express.Router();
const TICKET_MIN_MS = 3_000;
const TICKET_MAX_MS = 2 * 3_600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

// Limites por aparelho (IP; no IPv6, o bloco /64) e por filial. O de filial só conta respostas com bilhete
// válido: requisições inventadas não conseguem esgotar a cota da loja e bloquear os clientes de verdade.
const configLimiter = rateLimiter({ windowMs: 60_000, max: 30 });
const perIp = rateLimiter({ windowMs: 60 * 60_000, max: 10, message: 'Limite de avaliações deste aparelho atingido. Obrigado!' });
const perBranch = rateLimiter({ windowMs: 60 * 60_000, max: 300, message: 'Muitas avaliações no momento. Tente mais tarde.' });

// O código do link é conferido antes de qualquer limite: código inválido nem ocupa memória dos limitadores.
router.param('token', (req, res, next, token) => {
  try {
    if (!TOKEN_RE.test(token)) throw new HttpError(404, 'Link inválido.');
    const b = get('SELECT * FROM branches WHERE public_token_hash = ? AND public_enabled = 1 AND active = 1', lookup('link:' + token));
    if (!b) throw new HttpError(404, 'Link inválido ou desativado.');
    req.branch = b;
    next();
  } catch (e) { next(e); }
});

// O bilhete é assinado (HMAC) e não ocupa o banco ao abrir a pesquisa: só é gravado quando usado.
router.get('/:token/config', configLimiter, (req, res) => {
  const b = req.branch;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const issued = Date.now();
  const cfg = buildConfig(b, { ticket: `${nonce}.${issued}.${sign(`${b.id}.${nonce}.${issued}`)}` });
  // O horário de funcionamento vale para o tablet da loja; pelo QR o cliente pode responder depois, em casa.
  cfg.open = true; delete cfg.reopens;
  res.json(cfg);
});

router.post('/:token/responses', perIp, (req, res) => {
  const b = req.branch;
  const [nonce, issuedRaw, sig] = String(req.body?.ticket || '').split('.');
  const issued = Number(issuedRaw);
  const valid = !!nonce && nonce.length <= 64 && Number.isSafeInteger(issued) && !!sig && safeEqual(sig, sign(`${b.id}.${nonce}.${issued}`));
  if (!valid) throw bad('Sessão da pesquisa inválida. Recarregue a página.');
  const age = Date.now() - issued;
  if (age > TICKET_MAX_MS) throw bad('A pesquisa expirou. Recarregue a página.');
  if (age < TICKET_MIN_MS) throw bad('Resposta rápida demais.');
  const limit = perBranch.hit('b:' + b.id);
  if (!limit.ok) { res.set('Retry-After', String(limit.retryAfter)); throw new HttpError(429, perBranch.message); }
  // Uso único, na mesma transação da gravação: se a resposta for recusada (ex.: e-mail digitado errado),
  // o bilhete continua valendo e o cliente corrige e envia de novo.
  const claim = () => run(`INSERT INTO link_tickets (nonce, branch_id, issued_at, used_at) VALUES (?,?,?,?)
    ON CONFLICT(nonce) DO UPDATE SET used_at = excluded.used_at WHERE link_tickets.used_at IS NULL`, nonce, b.id, issued, Date.now()).changes > 0;
  const r = saveResponse({ branch: b, channel: 'link', deviceLabel: deviceLabel(req.get('user-agent')), body: req.body, claim, startedVersionAt: issued });
  res.status(r.created ? 201 : 200).json({ ok: true });
});

module.exports = router;
