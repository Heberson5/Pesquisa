'use strict';
// API pública do quiosque (tablet). Sem login de pessoa: o tablet é pareado
// uma vez com um código gerado no painel e passa a usar um token próprio.
const express = require('express');
const { get, run, tx, audit } = require('../db');
const { randomToken, sha256, rateLimiter } = require('../security');
const { requireDevice } = require('../auth');
const { HttpError, bad, str, int, UUID_RE } = require('../validate');
const { loadSurvey, normalizeAnswer } = require('../surveys');
const { publicBranding } = require('../settings');

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

// Configuração atual: filial + pesquisa ativa da filial.
router.get('/config', configLimiter, requireDevice, (req, res) => {
  const d = req.device;
  const survey = d.survey_id ? loadSurvey(d.survey_id) : null;
  res.json({
    device: { name: d.name },
    branding: publicBranding(),
    branch: { name: d.branch_name },
    survey: survey && survey.active ? {
      id: survey.id,
      version: survey.updated_at,
      welcomeTitle: survey.welcome_title,
      welcomeText: survey.welcome_text,
      thanksTitle: survey.thanks_title,
      thanksText: survey.thanks_text,
      thanksMedia: survey.thanks_media_id ? mediaInfo(survey.thanks_media_id) : null,
      thanksSeconds: survey.thanks_seconds,
      idleSeconds: survey.idle_seconds,
      questions: survey.questions.map((q) => ({
        id: q.id, text: q.text, helpText: q.help_text, type: q.type, required: q.required, options: q.options,
        display: q.display, icon: q.icon,
      })),
    } : null,
  });
});

function mediaInfo(id) {
  const m = get('SELECT id, mime FROM media WHERE id = ?', id);
  return m ? { url: `/media/${m.id}`, kind: m.mime.startsWith('video/') ? 'video' : 'image' } : null;
}

// Recebe uma resposta completa. Idempotente pelo uuid (o tablet reenvia se cair a internet).
router.post('/responses', requireDevice, submitLimiter, (req, res) => {
  const d = req.device;
  const body = req.body || {};
  if (typeof body.uuid !== 'string' || !UUID_RE.test(body.uuid)) throw bad('Identificador inválido.');
  const surveyId = int(body.surveyId, { field: 'pesquisa', min: 1 });
  // O dispositivo só pode responder a pesquisa da SUA filial.
  if (surveyId !== d.survey_id) throw new HttpError(409, 'A pesquisa desta filial mudou. Recarregando.');
  const survey = loadSurvey(surveyId);
  if (!survey || !survey.active) throw new HttpError(409, 'Pesquisa indisponível.');

  if (!Array.isArray(body.answers) || body.answers.length > survey.questions.length) throw bad('Respostas inválidas.');
  const byId = new Map();
  for (const a of body.answers) {
    if (!a || typeof a !== 'object') throw bad('Respostas inválidas.');
    const qid = int(a.questionId, { field: 'pergunta', min: 1 });
    if (byId.has(qid)) throw bad('Pergunta repetida.');
    byId.set(qid, a.value);
  }
  const known = new Set(survey.questions.map((q) => q.id));
  for (const qid of byId.keys()) if (!known.has(qid)) throw bad('Pergunta não pertence à pesquisa.');
  const normalized = survey.questions
    .map((q) => ({ q, v: normalizeAnswer(q, byId.get(q.id)) }))
    .filter((x) => x.v !== null);
  if (normalized.length === 0) throw bad('Resposta vazia.');

  const now = Date.now();
  let submittedAt = int(body.submittedAt, { field: 'data', optional: true, min: 0, max: Number.MAX_SAFE_INTEGER }) ?? now;
  // Respostas da fila offline podem chegar depois, mas não do futuro nem de mais de 30 dias.
  if (submittedAt > now + 5 * 60_000 || submittedAt < now - 30 * 86_400_000) submittedAt = now;
  let startedAt = int(body.startedAt, { field: 'início', optional: true, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (startedAt !== null && (startedAt > submittedAt || submittedAt - startedAt > 3_600_000)) startedAt = null;

  const created = tx(() => {
    if (get('SELECT 1 FROM responses WHERE uuid = ?', body.uuid)) return false;
    const r = run(`INSERT INTO responses (uuid, survey_id, branch_id, device_id, started_at, submitted_at, received_at)
                   VALUES (?,?,?,?,?,?,?)`, body.uuid.toLowerCase(), survey.id, d.branch_id, d.id, startedAt, submittedAt, now);
    for (const { q, v } of normalized) {
      run('INSERT INTO answers (response_id, question_id, value_num, value_text) VALUES (?,?,?,?)',
        r.lastInsertRowid, q.id, v.num, v.text);
    }
    return true;
  });
  res.status(created ? 201 : 200).json({ ok: true, duplicate: !created });
});

module.exports = router;
