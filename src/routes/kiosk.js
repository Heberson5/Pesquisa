'use strict';
// API pública do quiosque (tablet). Sem login de pessoa: o tablet é pareado
// uma vez com um código gerado no painel e passa a usar um token próprio.
const express = require('express');
const { get, run, audit } = require('../db');
const { randomToken, sha256, rateLimiter } = require('../security');
const { requireDevice } = require('../auth');
const { HttpError, str } = require('../validate');
const { buildConfig, saveResponse } = require('../responses');

const router = express.Router();

const pairLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 10, message: 'Muitas tentativas de pareamento. Aguarde 15 minutos.' });
// Por dispositivo: um cliente leva pelo menos alguns segundos para responder.
const submitLimiter = rateLimiter({ windowMs: 60_000, max: 20, keyFn: (req) => 'dev:' + req.device.id,
  message: 'Muitas respostas em sequência neste dispositivo.' });
const configLimiter = rateLimiter({ windowMs: 60_000, max: 60 });

// Pareamento: troca o código de 8 caracteres (válido 15 min, uso único) por um token permanente.
router.post('/pair', pairLimiter, (req, res) => {
  const code = str(req.body?.code, { field: 'código', min: 6, max: 12 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const device = get('SELECT * FROM devices WHERE pair_code_hash = ? AND active = 1', sha256(code));
  if (!device || !device.pair_expires_at || device.pair_expires_at < Date.now()) {
    audit(null, 'device.pair_failed', null, req.ip);
    throw new HttpError(400, 'Código inválido ou expirado. Gere um novo código no painel.');
  }
  const token = randomToken(32);
  run(`UPDATE devices SET token_hash = ?, pair_code_hash = NULL, pair_expires_at = NULL,
       paired_at = ?, last_seen_at = ?, last_ip = ? WHERE id = ?`, sha256(token), Date.now(), Date.now(), req.ip, device.id);
  audit(null, 'device.paired', { deviceId: device.id }, req.ip);
  res.json({ token });
});

// Configuração atual: filial + pesquisa vigente (padrão ou campanha agendada) + marca + horário.
router.get('/config', configLimiter, requireDevice, (req, res) => {
  const d = req.device;
  res.json(buildConfig(branchOf(d), { device: { name: d.name } }));
});

const branchOf = (d) => get('SELECT * FROM branches WHERE id = ?', d.branch_id);

// Recebe uma resposta completa. Idempotente pelo uuid (o tablet reenvia se cair a internet).
router.post('/responses', requireDevice, submitLimiter, (req, res) => {
  const r = saveResponse({ branch: branchOf(req.device), deviceId: req.device.id, channel: 'tablet', body: req.body });
  res.status(r.created ? 201 : 200).json({ ok: true, duplicate: !r.created });
});

module.exports = router;
