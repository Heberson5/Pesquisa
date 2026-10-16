'use strict';
// API do painel administrativo. Todas as rotas (exceto login) exigem sessão.
// Cada rota confere a permissão do perfil do usuário (src/permissions.js) e o escopo de filiais (src/scope.js).
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { get, all, run, tx, audit } = require('../db');
const { hashPassword, verifyPassword, pairingCode, sha256, passwordPolicyError, rateLimiter } = require('../security');
const { destroySession, destroyUserSessions, requireUser } = require('../auth');
const perm = require('../permissions');
const { can, need, needAny } = perm;
const { HttpError, bad, str, int, bool, id, email, dateParam } = require('../validate');
const { QUESTION_TYPES, DISPLAYS, LANGS, LANG_LABELS, CONTACT_MODES, loadSurvey, normalizeQuestions, normalizeI18n, npsFromCounts } = require('../surveys');
const { getSettings, saveSettings, emailList } = require('../settings');
const { queueEmail, queueWhatsApp, renderEmail, processOutbox, outboxStatus, webhookSecret, whatsappCheck } = require('../notify');
const delivery = require('../delivery');
const zones = require('../zones');
const { responseFilter, computeStats, computeBreakdown, reportFor, NPS_AGG, NPS_JOIN, npsRow } = require('../stats');
const { resetUserMfa } = require('./auth');
const QRCode = require('qrcode');
const { encrypt, decrypt, lookup } = require('../vault');
const { publicUrl, timezone: companyTz } = require('../config');
const { parseLocal } = require('../time');

const router = express.Router();
const { MEDIA_DIR } = require('../db');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const PAIR_TTL_MS = 15 * 60_000;

// Login, 2FA e recuperação de senha ficam em routes/auth.js.
const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas. Aguarde 15 minutos.' });

router.use(requireUser);

router.post('/logout', (req, res) => {
  destroySession(req, res);
  audit(req.user.id, 'logout', null, req.ip);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const u = get('SELECT totp_enabled, notify_detractors, notify_reports, notify_offline, whatsapp FROM users WHERE id = ?', req.user.id);
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, access: perm.publicAccess(req.user), mfaEnabled: !!u.totp_enabled, whatsapp: u.whatsapp || '',
    notify: { detractors: !!u.notify_detractors, reports: !!u.notify_reports, offline: !!u.notify_offline } },
  mfaSetupRequired: req.user.mfaSetupRequired, csrf: req.user.csrf,
  questionTypes: QUESTION_TYPES, displays: DISPLAYS, langs: LANG_LABELS, contactModes: CONTACT_MODES, permCatalog: perm.catalog(), settings: req.user.mfaSetupRequired ? null : settingsFor(req.user) });
});

// Menor privilégio: todos recebem o que a interface usa (marca, ícones, meta); cada aba de Configurações
// só vem para quem pode vê-la. Chaves de cada aba (as mesmas conferidas ao salvar).
const SETTINGS_GROUPS = {
  cfg_marca: ['companyName', 'primaryColor', 'accentColor', 'logoMediaId', 'faviconMediaId', 'appIconMediaId', 'menuIcons', 'defaultDisplay', 'ratingIcon', 'colorScheme', 'faceStyle'],
  cfg_alertas: ['alerts', 'weeklyReport', 'defaultNpsGoal', 'offlineAlert', 'screen'],
  cfg_lgpd: ['requireAdminMfa', 'privacyText', 'retention'],
};
const BASE_KEYS = ['companyName', 'primaryColor', 'accentColor', 'logoMediaId', 'menuIcons', 'defaultDisplay', 'ratingIcon', 'colorScheme', 'faceStyle', 'defaultNpsGoal'];
function settingsFor(user) {
  const s = getSettings();
  if (user.access.isAdmin) return s;
  const keys = new Set(BASE_KEYS);
  for (const [g, list] of Object.entries(SETTINGS_GROUPS)) if (can(user, g, 'ver')) list.forEach((k) => keys.add(k));
  return Object.fromEntries(Object.entries(s).filter(([k]) => keys.has(k)));
}

// Preferências de notificação do próprio usuário.
router.put('/me/notifications', (req, res) => {
  const b = req.body || {};
  const f = (v, cur) => (v === undefined ? cur : v === true ? 1 : v === false ? 0 : (() => { throw bad('Valor inválido.'); })());
  const u = get('SELECT notify_detractors, notify_reports, notify_offline FROM users WHERE id = ?', req.user.id);
  run('UPDATE users SET notify_detractors = ?, notify_reports = ?, notify_offline = ? WHERE id = ?',
    f(b.detractors, u.notify_detractors), f(b.reports, u.notify_reports), f(b.offline, u.notify_offline), req.user.id);
  if (b.whatsapp !== undefined) {
    // WhatsApp pessoal (opcional): só números, com DDI. 10–11 dígitos = Brasil, o 55 é acrescentado.
    if (typeof b.whatsapp !== 'string') throw bad('WhatsApp inválido.');
    let digits = b.whatsapp.replace(/[\s().+-]/g, '');
    if (digits && !/^\d{10,15}$/.test(digits)) throw bad('WhatsApp inválido. Digite DDD + número (ex.: 11 99999-0000).');
    if (/^\d{10,11}$/.test(digits)) digits = '55' + digits;
    run('UPDATE users SET whatsapp = ? WHERE id = ?', digits || null, req.user.id);
  }
  res.json({ ok: true });
});

router.post('/me/password', loginLimiter, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(req.body?.current || ''), u.password_hash)) throw bad('Senha atual incorreta.');
  const err = passwordPolicyError(req.body?.password);
  if (err) throw bad(err);
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.password), u.id);
  destroyUserSessions(u.id);
  audit(u.id, 'user.password_changed', null, req.ip);
  destroySession(req, res);
  res.json({ ok: true });
});


const { scope, assertBranch, placeholders } = require('../scope');

// ---------------------------------------------------------------- filiais
router.get('/branches', (req, res) => {
  const s = scope(req.user);
  const where = s ? `WHERE b.id IN (${placeholders(s)})` : '';
  const rows = all(`SELECT b.id, b.code, b.name, b.city, b.active, b.survey_id, s.title AS survey_title, b.alert_emails, b.alert_phones, b.nps_goal, b.hours_json, b.timezone, b.public_enabled,
      (SELECT COUNT(*) FROM devices d WHERE d.branch_id = b.id AND d.active = 1) AS devices
    FROM branches b LEFT JOIN surveys s ON s.id = b.survey_id ${where} ORDER BY b.name`, ...(s || []));
  // A lista de filiais alimenta os filtros de todas as telas; destinatários e horário só para quem vê o cadastro de filiais.
  const full = can(req.user, 'filiais', 'ver');
  // Fuso em uso agora (escolhido ou informado pelo tablet) e as opções do cadastro.
  res.json(rows.map((b) => {
    const out = { ...b, effective_tz: zones.forBranch(b) };
    if (!full) { delete out.alert_emails; delete out.alert_phones; delete out.hours_json; }
    return out;
  }));
});
router.get('/timezones', (req, res) => res.json({ company: companyTz, choices: zones.ZONE_CHOICES }));

// Fuso da filial: null = Automático (usa o do tablet); senão um fuso do Brasil.
function timezoneInput(v) {
  if (v === undefined || v === null || v === '' || v === 'auto') return null;
  if (typeof v !== 'string' || !zones.usable(v)) throw bad('Fuso horário inválido.');
  return v;
}

function branchInput(body) {
  const code = str(body?.code, { field: 'código', min: 1, max: 20 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('Código deve conter apenas letras, números, - e _.');
  return {
    code,
    name: str(body?.name, { field: 'nome', min: 2, max: 100 }),
    city: str(body?.city, { field: 'cidade', max: 100, optional: true }),
    active: body?.active === undefined ? 1 : (bool(body.active) ? 1 : 0),
    alert_emails: JSON.stringify(body?.alert_emails === undefined ? [] : emailList(body.alert_emails, 10)),
    alert_phones: JSON.stringify(phoneList(body?.alert_phones)),
    nps_goal: body?.nps_goal === undefined || body.nps_goal === null || body.nps_goal === '' ? null : int(body.nps_goal, { field: 'meta de NPS', min: -100, max: 100 }),
    hours_json: hoursInput(body?.hours),
    timezone: timezoneInput(body?.timezone),
  };
}

// Telefones para WhatsApp no formato internacional, só dígitos (ex.: 5511999990000).
function phoneList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 5) throw bad('Informe no máximo 5 telefones.');
  if (!v.every((p) => typeof p === 'string' && /^[\d\s()+.-]{8,25}$/.test(p))) throw bad('Telefone inválido: use apenas números (ex.: 5511999990000).');
  const out = [...new Set(v.map((p) => p.replace(/\D/g, '')))];
  for (const p of out) if (!/^\d{12,15}$/.test(p)) throw bad('Telefone inválido: use DDI + DDD + número (ex.: 5511999990000).');
  return out;
}

// Horário de funcionamento: 7 itens (domingo a sábado), cada um null (fechado) ou { open: 'HH:MM', close: 'HH:MM' }.
// null no total = sempre aberto.
function hoursInput(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 7) throw bad('Horário de funcionamento inválido.');
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const out = v.map((d) => {
    if (d === null) return null;
    if (!d || typeof d !== 'object' || !hm.test(d.open) || !hm.test(d.close) || d.open >= d.close) throw bad('Horário inválido (use HH:MM e abertura antes do fechamento).');
    return { open: d.open, close: d.close };
  });
  return JSON.stringify(out);
}

router.post('/branches', need('filiais', 'incluir'), (req, res) => {
  const b = branchInput(req.body);
  if (get('SELECT 1 FROM branches WHERE code = ?', b.code)) throw new HttpError(409, 'Já existe uma filial com esse código.');
  const r = run('INSERT INTO branches (code, name, city, active, alert_emails, alert_phones, nps_goal, hours_json, timezone, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    b.code, b.name, b.city, b.active, b.alert_emails, b.alert_phones, b.nps_goal, b.hours_json, b.timezone, Date.now());
  audit(req.user.id, 'branch.create', { id: r.lastInsertRowid, ...b }, req.ip);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/branches/:id', need('filiais', 'editar'), (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const b = branchInput(req.body);
  if (get('SELECT 1 FROM branches WHERE code = ? AND id <> ?', b.code, bid)) throw new HttpError(409, 'Já existe uma filial com esse código.');
  run('UPDATE branches SET code = ?, name = ?, city = ?, active = ?, alert_emails = ?, alert_phones = ?, nps_goal = ?, hours_json = ?, timezone = ? WHERE id = ?',
    b.code, b.name, b.city, b.active, b.alert_emails, b.alert_phones, b.nps_goal, b.hours_json, b.timezone, bid);
  audit(req.user.id, 'branch.update', { id: bid, ...b }, req.ip);
  res.json({ ok: true });
});

// Define qual pesquisa os tablets da filial exibem (quem tem a permissão, dentro das filiais dele).
router.put('/branches/:id/survey', need('filiais', 'pesquisa'), (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const sid = req.body?.surveyId === null ? null : id(req.body?.surveyId, 'pesquisa');
  if (sid && !get('SELECT 1 FROM surveys WHERE id = ? AND active = 1', sid)) throw bad('Pesquisa inexistente ou inativa.');
  run('UPDATE branches SET survey_id = ? WHERE id = ?', sid, bid);
  audit(req.user.id, 'branch.set_survey', { branchId: bid, surveyId: sid }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- link / QR Code por filial
async function linkInfo(b) {
  const token = b.public_token_enc ? decrypt(b.public_token_enc) : null;
  if (!token) return { enabled: false, url: null, qr: null };
  const url = `${publicUrl}/r/${token}`;
  return { enabled: !!b.public_enabled, url, qr: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 600 }) };
}

router.get('/branches/:id/public-link', need('filiais', 'ver'), async (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  res.json(await linkInfo(get('SELECT * FROM branches WHERE id = ?', bid)));
});

// Ativar/desativar ou gerar um novo link (o anterior deixa de funcionar — útil se um QR vazar).
router.post('/branches/:id/public-link', need('filiais', 'qrcode'), async (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const b = get('SELECT * FROM branches WHERE id = ?', bid);
  const enabled = req.body?.enabled !== false;
  if (req.body?.regenerate === true || !b.public_token_enc) {
    const token = crypto.randomBytes(24).toString('base64url');
    run('UPDATE branches SET public_token_enc = ?, public_token_hash = ? WHERE id = ?', encrypt(token), lookup('link:' + token), bid);
  }
  run('UPDATE branches SET public_enabled = ? WHERE id = ?', enabled ? 1 : 0, bid);
  audit(req.user.id, 'branch.public_link', { branchId: bid, enabled, regenerated: req.body?.regenerate === true }, req.ip);
  res.json(await linkInfo(get('SELECT * FROM branches WHERE id = ?', bid)));
});

// ---------------------------------------------------------------- campanhas agendadas
router.get('/schedules', need('campanhas', 'ver'), (req, res) => {
  const s = scope(req.user);
  const where = s ? `WHERE (c.branch_id IS NULL OR c.branch_id IN (${placeholders(s)}))` : '';
  const rows = all(`SELECT c.id, c.survey_id, v.title AS survey, c.branch_id, b.name AS branch, c.starts_at, c.ends_at
    FROM schedules c JOIN surveys v ON v.id = c.survey_id LEFT JOIN branches b ON b.id = c.branch_id ${where}
    ORDER BY c.starts_at DESC LIMIT 200`, ...(s || []));
  // Cada campanha é mostrada no fuso da filial dela (ou da empresa, quando vale para todas).
  res.json(rows.map((c) => ({ ...c, tz: c.branch_id ? zones.forBranch(get('SELECT id, timezone FROM branches WHERE id = ?', c.branch_id)) : companyTz })));
});

router.post('/schedules', need('campanhas', 'incluir'), (req, res) => {
  const surveyId = id(req.body?.surveyId, 'pesquisa');
  if (!get('SELECT 1 FROM surveys WHERE id = ? AND active = 1', surveyId)) throw bad('Pesquisa inexistente ou inativa.');
  const branchId = req.body?.branchId === null || req.body?.branchId === undefined || req.body?.branchId === '' ? null : id(req.body.branchId, 'filial');
  if (branchId !== null) assertBranch(req.user, branchId);
  else if (scope(req.user)) throw new HttpError(403, 'Seu perfil só pode agendar campanhas nas filiais ligadas a você.');
  // Data e hora digitadas valem no fuso da filial escolhida (ou no da empresa, se for para todas).
  const tz = branchId !== null ? zones.forBranch(get('SELECT id, timezone FROM branches WHERE id = ?', branchId)) : companyTz;
  const startsAt = parseLocal(req.body?.startsAt, tz);
  const endsAt = parseLocal(req.body?.endsAt, tz);
  if (startsAt === null || endsAt === null) throw bad('Datas inválidas (use dia e hora).');
  if (endsAt <= startsAt) throw bad('O fim precisa ser depois do início.');
  if (endsAt - startsAt > 366 * 86_400_000) throw bad('Campanha de no máximo 1 ano.');
  if (endsAt < Date.now()) throw bad('Essa campanha já terminou.');
  const r = run('INSERT INTO schedules (survey_id, branch_id, starts_at, ends_at, created_by, created_at) VALUES (?,?,?,?,?,?)',
    surveyId, branchId, startsAt, endsAt, req.user.id, Date.now());
  audit(req.user.id, 'schedule.create', { id: r.lastInsertRowid, surveyId, branchId, startsAt, endsAt }, req.ip);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.delete('/schedules/:id', need('campanhas', 'excluir'), (req, res) => {
  const sid = id(req.params.id);
  const c = get('SELECT branch_id FROM schedules WHERE id = ?', sid);
  if (!c) throw new HttpError(404, 'Campanha não encontrada.');
  if (c.branch_id !== null) assertBranch(req.user, c.branch_id);
  else if (scope(req.user)) throw new HttpError(403, 'Esta campanha vale para todas as filiais; só quem vê todas pode excluí-la.');
  run('DELETE FROM schedules WHERE id = ?', sid);
  audit(req.user.id, 'schedule.delete', { id: sid }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- pesquisas
router.get('/surveys', (req, res) => {
  res.json(all(`SELECT s.id, s.title, s.active, s.updated_at,
      (SELECT COUNT(*) FROM questions q WHERE q.survey_id = s.id) AS questions,
      (SELECT COUNT(*) FROM questions q WHERE q.survey_id = s.id AND q.is_nps = 1) AS nps_questions,
      (SELECT COUNT(*) FROM responses r WHERE r.survey_id = s.id) AS responses
    FROM surveys s ORDER BY s.active DESC, s.updated_at DESC`));
});

router.get('/surveys/:id', need('pesquisas', 'ver'), (req, res) => {
  const s = withRefs(loadSurvey(id(req.params.id)) || { questions: [] });
  if (!s.id) throw new HttpError(404, 'Pesquisa não encontrada.');
  s.has_responses = !!get('SELECT 1 FROM responses WHERE survey_id = ? LIMIT 1', s.id);
  s.thanks_media = s.thanks_media_id ? get('SELECT id, mime, original_name FROM media WHERE id = ?', s.thanks_media_id) : null;
  res.json(s);
});

function surveyInput(body) {
  const mediaId = body?.thanks_media_id ? String(body.thanks_media_id) : null;
  if (mediaId && (!/^[a-f0-9]{32}$/.test(mediaId) || !get('SELECT 1 FROM media WHERE id = ?', mediaId))) throw bad('Mídia inválida.');
  const questions = body?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 30) throw bad('A pesquisa deve ter entre 1 e 30 perguntas.');
  const languages = parseLanguages(body.languages);
  return {
    title: str(body.title, { field: 'título', min: 3, max: 120 }),
    welcome_title: str(body.welcome_title, { field: 'título de boas-vindas', min: 2, max: 120 }),
    welcome_text: str(body.welcome_text, { field: 'texto de boas-vindas', max: 300, optional: true }),
    thanks_title: str(body.thanks_title, { field: 'título de agradecimento', min: 2, max: 120 }),
    thanks_text: str(body.thanks_text, { field: 'texto de agradecimento', max: 300, optional: true }),
    thanks_media_id: mediaId,
    thanks_seconds: int(body.thanks_seconds, { field: 'tempo do agradecimento', min: 3, max: 60 }),
    idle_seconds: int(body.idle_seconds, { field: 'tempo de inatividade', min: 15, max: 600 }),
    active: body.active === false ? 0 : 1,
    contact_mode: body.contact_mode === undefined ? 'never' : (Object.hasOwn(CONTACT_MODES, body.contact_mode) ? body.contact_mode : (() => { throw bad('Modo de contato inválido.'); })()),
    languages,
    i18n: normalizeI18n(body.i18n, languages, [['welcome_title', 120], ['welcome_text', 300], ['thanks_title', 120], ['thanks_text', 300]], { where: 'da pesquisa' }),
    questions: normalizeQuestions(questions, languages),
  };
}

function parseLanguages(v) {
  if (v === undefined) return ['pt'];
  if (!Array.isArray(v) || v.length > LANGS.length || !v.every((l) => LANGS.includes(l))) throw bad('Idiomas inválidos.');
  return ['pt', ...LANGS.filter((l) => l !== 'pt' && v.includes(l))];
}

// Condições no banco referenciam o id da pergunta; no editor, a posição (ref). Converte nos dois sentidos.
function withRefs(survey) {
  const pos = new Map(survey.questions.map((q, i) => [q.id, i]));
  survey.questions = survey.questions.map((q) => ({ ...q, show_if: q.show_if && pos.has(q.show_if.q) ? { ref: pos.get(q.show_if.q), op: q.show_if.op, value: q.show_if.value } : null }));
  return survey;
}
const condForDb = (cond, ids) => (cond ? JSON.stringify({ q: ids[cond.ref], op: cond.op, value: cond.value }) : null);
const i18nForDb = (o) => (o && Object.keys(o).length ? JSON.stringify(o) : null);

function insertQuestions(surveyId, questions) {
  const ids = [];
  questions.forEach((q, i) => {
    const r = run(
      'INSERT INTO questions (survey_id, position, text, help_text, type, required, is_nps, options_json, display, icon, show_if, i18n) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      surveyId, i, q.text, q.help_text, q.type, q.required, q.is_nps, q.options.length ? JSON.stringify(q.options) : null, q.display || 'default', q.icon || null,
      condForDb(q.show_if, ids), i18nForDb(q.i18n));
    ids.push(Number(r.lastInsertRowid));
  });
}

router.post('/surveys', need('pesquisas', 'incluir'), (req, res) => {
  const s = surveyInput(req.body);
  const now = Date.now();
  const newId = tx(() => {
    const r = run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_media_id,
      thanks_seconds, idle_seconds, active, contact_mode, languages, i18n, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    s.title, s.welcome_title, s.welcome_text, s.thanks_title, s.thanks_text, s.thanks_media_id,
    s.thanks_seconds, s.idle_seconds, s.active, s.contact_mode, JSON.stringify(s.languages), i18nForDb(s.i18n), now, now);
    insertQuestions(r.lastInsertRowid, s.questions);
    return Number(r.lastInsertRowid);
  });
  audit(req.user.id, 'survey.create', { id: newId, title: s.title }, req.ip);
  res.status(201).json({ id: newId });
});

router.put('/surveys/:id', need('pesquisas', 'editar'), (req, res) => {
  const sid = id(req.params.id);
  const current = loadSurvey(sid);
  if (!current) throw new HttpError(404, 'Pesquisa não encontrada.');
  const s = surveyInput(req.body);
  const hasResponses = !!get('SELECT 1 FROM responses WHERE survey_id = ? LIMIT 1', sid);
  tx(() => {
    run(`UPDATE surveys SET title=?, welcome_title=?, welcome_text=?, thanks_title=?, thanks_text=?, thanks_media_id=?,
      thanks_seconds=?, idle_seconds=?, active=?, contact_mode=?, languages=?, i18n=?, updated_at=? WHERE id=?`,
    s.title, s.welcome_title, s.welcome_text, s.thanks_title, s.thanks_text, s.thanks_media_id,
    s.thanks_seconds, s.idle_seconds, s.active, s.contact_mode, JSON.stringify(s.languages), i18nForDb(s.i18n), Date.now(), sid);
    if (!hasResponses) {
      run('DELETE FROM questions WHERE survey_id = ?', sid);
      insertQuestions(sid, s.questions);
    } else {
      // Com respostas coletadas, a estrutura fica congelada para não corromper o histórico.
      // Só é permitido corrigir textos e a marcação de NPS (que recalcula os relatórios).
      if (s.questions.length !== current.questions.length) throw new HttpError(409, 'Esta pesquisa já tem respostas: não é possível adicionar ou remover perguntas. Use "Duplicar".');
      s.questions.forEach((q, i) => {
        const old = current.questions[i];
        if (old.type !== q.type || JSON.stringify(old.options) !== JSON.stringify(q.options)) {
          throw new HttpError(409, 'Esta pesquisa já tem respostas: não é possível mudar tipo ou opções. Use "Duplicar".');
        }
        // A aparência (números/carinhas/ícones) pode mudar: o valor gravado continua o mesmo número.
        run('UPDATE questions SET text=?, help_text=?, required=?, is_nps=?, display=?, icon=?, show_if=?, i18n=? WHERE id=?',
          q.text, q.help_text, q.required, q.is_nps, q.display, q.icon, condForDb(q.show_if, current.questions.map((x) => x.id)), i18nForDb(q.i18n), old.id);
      });
    }
    if (!s.active) run('UPDATE branches SET survey_id = NULL WHERE survey_id = ?', sid);
  });
  audit(req.user.id, 'survey.update', { id: sid, title: s.title }, req.ip);
  res.json({ ok: true });
});

router.post('/surveys/:id/duplicate', need('pesquisas', 'incluir'), (req, res) => {
  const src = loadSurvey(id(req.params.id));
  if (!src) throw new HttpError(404, 'Pesquisa não encontrada.');
  const now = Date.now();
  const newId = tx(() => {
    const r = run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_media_id,
      thanks_seconds, idle_seconds, active, contact_mode, languages, i18n, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?)`,
    (src.title + ' (cópia)').slice(0, 120), src.welcome_title, src.welcome_text, src.thanks_title, src.thanks_text,
    src.thanks_media_id, src.thanks_seconds, src.idle_seconds, src.contact_mode, JSON.stringify(src.languages), i18nForDb(src.i18n), now, now);
    insertQuestions(r.lastInsertRowid, withRefs(src).questions.map((q) => ({ ...q, required: q.required ? 1 : 0, is_nps: q.is_nps ? 1 : 0 })));
    return Number(r.lastInsertRowid);
  });
  audit(req.user.id, 'survey.duplicate', { from: src.id, id: newId }, req.ip);
  res.status(201).json({ id: newId });
});

// ---------------------------------------------------------------- mídia (imagem/vídeo de agradecimento)
const MEDIA_MAX = 25 * 1024 * 1024;
// Valida pelo conteúdo (assinatura binária), não pela extensão nem pelo Content-Type do cliente.
function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null; // SVG, HTML, PDF, executáveis etc. são recusados
}

router.post('/media', needAny(['pesquisas', 'incluir'], ['pesquisas', 'editar'], ['cfg_marca', 'editar']), express.raw({ type: () => true, limit: MEDIA_MAX }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw bad('Arquivo vazio.');
  const mime = sniffMime(req.body);
  if (!mime) throw new HttpError(415, 'Formato não suportado. Use JPG, PNG, WEBP, GIF, MP4 ou WEBM.');
  const mediaId = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(MEDIA_DIR, mediaId), req.body, { flag: 'wx', mode: 0o640 });
  const original = str(decodeURIComponent(String(req.get('x-filename') || '')).slice(0, 200), { field: 'nome', max: 200, optional: true });
  run('INSERT INTO media (id, mime, size, original_name, created_at) VALUES (?,?,?,?,?)', mediaId, mime, req.body.length, original, Date.now());
  audit(req.user.id, 'media.upload', { id: mediaId, mime, size: req.body.length }, req.ip);
  res.status(201).json({ id: mediaId, mime, url: `/media/${mediaId}` });
});

// ---------------------------------------------------------------- dispositivos (tablets)
router.get('/devices', need('tablets', 'ver'), (req, res) => {
  const s = scope(req.user);
  const where = s ? `WHERE d.branch_id IN (${placeholders(s)})` : '';
  const rows = all(`SELECT d.id, d.name, d.branch_id, b.name AS branch_name, d.active, d.paired_at, d.last_seen_at,
      d.pair_expires_at, d.timezone, d.timezone_at, (d.token_hash IS NOT NULL) AS paired
    FROM devices d JOIN branches b ON b.id = d.branch_id ${where} ORDER BY b.name, d.name`, ...(s || []));
  res.json(rows.map((r) => ({ ...r, paired: !!r.paired, pairing_pending: !!(r.pair_expires_at && r.pair_expires_at > Date.now()) })));
});

function issuePairingCode(deviceId) {
  const code = pairingCode(8);
  // Gerar novo código invalida o token anterior (o tablet antigo perde acesso).
  run('UPDATE devices SET pair_code_hash = ?, pair_expires_at = ?, token_hash = NULL, active = 1 WHERE id = ?',
    sha256(code), Date.now() + PAIR_TTL_MS, deviceId);
  return { code, expiresAt: Date.now() + PAIR_TTL_MS };
}

router.post('/devices', need('tablets', 'incluir'), (req, res) => {
  const branchId = id(req.body?.branchId, 'filial');
  assertBranch(req.user, branchId);
  const name = str(req.body?.name, { field: 'nome', min: 2, max: 60 });
  const r = run('INSERT INTO devices (branch_id, name, created_at) VALUES (?,?,?)', branchId, name, Date.now());
  const pairing = issuePairingCode(r.lastInsertRowid);
  audit(req.user.id, 'device.create', { id: r.lastInsertRowid, branchId, name }, req.ip);
  res.status(201).json({ id: Number(r.lastInsertRowid), ...pairing });
});

function loadDeviceScoped(user, deviceId) {
  const d = get('SELECT * FROM devices WHERE id = ?', deviceId);
  if (!d) throw new HttpError(404, 'Dispositivo não encontrado.');
  assertBranch(user, d.branch_id);
  return d;
}

router.post('/devices/:id/pairing-code', need('tablets', 'codigo'), (req, res) => {
  const d = loadDeviceScoped(req.user, id(req.params.id));
  const pairing = issuePairingCode(d.id);
  audit(req.user.id, 'device.new_code', { id: d.id }, req.ip);
  res.json(pairing);
});

router.post('/devices/:id/revoke', need('tablets', 'excluir'), (req, res) => {
  const d = loadDeviceScoped(req.user, id(req.params.id));
  run('UPDATE devices SET active = 0, token_hash = NULL, pair_code_hash = NULL, pair_expires_at = NULL WHERE id = ?', d.id);
  audit(req.user.id, 'device.revoke', { id: d.id }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- relatórios
router.get('/stats', need('dashboard', 'ver'), (req, res) => res.json(computeStats(req.user, req.query)));

router.get('/surveys/:id/breakdown', need('dashboard', 'ver'), (req, res) => {
  const survey = loadSurvey(id(req.params.id));
  if (!survey) throw new HttpError(404, 'Pesquisa não encontrada.');
  res.json(computeBreakdown(req.user, survey, req.query));
});

function listResponses(user, query, limit, offset) {
  const f = responseFilter(user, query);
  const total = get(`SELECT COUNT(*) AS n FROM responses r ${f.sql}`, ...f.params).n;
  const rows = all(`SELECT r.id, r.uuid, r.submitted_at, r.started_at, r.channel, r.lang, r.geo_lat, r.geo_lng, r.geo_city, r.geo_uf, r.geo_region, COALESCE(r.device_label, d.name) AS device_label, b.name AS branch, b.city AS branch_city, s.title AS survey, d.name AS device
      FROM responses r JOIN branches b ON b.id = r.branch_id JOIN surveys s ON s.id = r.survey_id
      LEFT JOIN devices d ON d.id = r.device_id ${f.sql} ORDER BY r.submitted_at DESC LIMIT ? OFFSET ?`, ...f.params, limit, offset);
  if (rows.length) {
    const ans = all(`SELECT a.response_id, q.text, q.type, q.is_nps, a.value_num, a.value_text FROM answers a
        JOIN questions q ON q.id = a.question_id WHERE a.response_id IN (${placeholders(rows)}) ORDER BY q.position`, ...rows.map((r) => r.id));
    for (const r of rows) r.answers = ans.filter((a) => a.response_id === r.id).map((a) => ({
      question: a.text, type: a.type, is_nps: !!a.is_nps, value: displayValue(a),
    }));
  }
  return { total, rows };
}

function displayValue(a) {
  if (a.type === 'yesno') return a.value_num ? 'Sim' : 'Não';
  if (a.type === 'multi') return JSON.parse(a.value_text).join(', ');
  return a.value_text ?? String(a.value_num);
}

router.get('/responses', need('respostas', 'ver'), (req, res) => {
  const page = int(req.query.page || '1', { field: 'página', min: 1, max: 100000 });
  res.json({ page, pageSize: 25, ...listResponses(req.user, req.query, 25, (page - 1) * 25) });
});

// Exclusão de respostas: só perfis com "Respostas · Excluir" (o Gestor de filial padrão não tem), dentro das
// filiais que enxergam. Respostas, casos e anotações ligados a ela saem juntos (ON DELETE CASCADE). Fica na auditoria.
router.delete('/responses/:id', need('respostas', 'excluir'), (req, res) => {
  const rid = id(req.params.id);
  const r = get('SELECT id, branch_id, survey_id, submitted_at FROM responses WHERE id = ?', rid);
  if (!r) throw new HttpError(404, 'Resposta não encontrada.');
  const sc = scope(req.user);
  if (sc && !sc.includes(r.branch_id)) throw new HttpError(404, 'Resposta não encontrada.');
  run('DELETE FROM responses WHERE id = ?', rid);
  audit(req.user.id, 'response.delete', { id: rid, branchId: r.branch_id, surveyId: r.survey_id }, req.ip);
  res.json({ ok: true });
});

// Exclusão em lote do que está filtrado na tela (útil para limpar os testes). Exige digitar a palavra EXCLUIR.
router.post('/responses/delete-filtered', need('respostas', 'excluir'), (req, res) => {
  if (req.body?.confirm !== 'EXCLUIR') throw new HttpError(400, 'Digite EXCLUIR para confirmar.');
  const f = responseFilter(req.user, req.body?.filter && typeof req.body.filter === 'object' ? req.body.filter : {});
  const n = tx(() => run(`DELETE FROM responses WHERE id IN (SELECT r.id FROM responses r ${f.sql})`, ...f.params).changes);
  audit(req.user.id, 'responses.delete_filtered', { count: Number(n), filter: req.body?.filter || {} }, req.ip);
  res.json({ ok: true, deleted: Number(n) });
});

// Exportação CSV (protege contra "CSV injection" ao abrir no Excel).
function csvCell(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return '"' + String(v).replace('.', ',') + '"'; // número de verdade (ex.: coordenada negativa) não é fórmula
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

router.get('/responses.csv', need('respostas', 'csv'), (req, res) => {
  const { rows } = listResponses(req.user, req.query, 100000, 0);
  const questions = [...new Set(rows.flatMap((r) => (r.answers || []).map((a) => a.question)))];
  const lines = [['Data/hora', 'Filial', 'Pesquisa', 'Dispositivo', 'Canal', 'Cidade da loja', 'Cidade (cliente)', 'UF (cliente)', 'Região (cliente)', 'Latitude aprox.', 'Longitude aprox.', ...questions].map(csvCell).join(';')];
  for (const r of rows) {
    const map = Object.fromEntries((r.answers || []).map((a) => [a.question, a.value]));
    lines.push([new Date(r.submitted_at).toLocaleString('pt-BR'), r.branch, r.survey, r.device_label || r.device, r.channel === 'link' ? 'QR Code' : 'Tablet', r.branch_city,
      r.geo_city, r.geo_uf, r.geo_region, r.geo_lat, r.geo_lng, ...questions.map((q) => map[q])]
      .map(csvCell).join(';'));
  }
  audit(req.user.id, 'responses.export', { count: rows.length, filter: req.query }, req.ip);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="respostas.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// ---------------------------------------------------------------- usuários
// Regras contra aumento de acesso: quem não é administrador só cria ou altera pessoas cujo perfil cabe no seu,
// só nas filiais que enxerga, e ninguém muda o próprio perfil nem se desativa.
function userView(u, links) {
  const a = perm.accessFor(u);
  return { id: u.id, name: u.name, email: u.email, role: u.role, role_id: a.roleId, role_name: a.roleName, scope_all: a.scopeAll, active: u.active,
    locked_until: u.locked_until, created_at: u.created_at, totp_enabled: u.totp_enabled, branches: links.filter((l) => l.user_id === u.id).map((l) => l.branch_id) };
}

router.get('/users', need('usuarios', 'ver'), (req, res) => {
  const links = all('SELECT user_id, branch_id FROM user_branches');
  let list = all('SELECT id, name, email, role, role_id, active, locked_until, created_at, totp_enabled FROM users ORDER BY name').map((u) => userView(u, links));
  // Quem enxerga só algumas filiais vê apenas as pessoas dessas filiais.
  const sc = scope(req.user);
  if (sc) list = list.filter((u) => u.id === req.user.id || (!u.scope_all && u.branches.length && u.branches.every((b) => sc.includes(b))));
  res.json(list);
});

function userInput(body, isNew) {
  let roleRow;
  if (body?.roleId !== undefined && body?.roleId !== null && body?.roleId !== '') {
    roleRow = get('SELECT * FROM roles WHERE id = ?', id(body.roleId, 'perfil'));
    if (!roleRow) throw bad('Perfil inválido.');
  } else roleRow = perm.builtinRole(body?.role === 'admin' ? 'admin' : 'gestor'); // compatibilidade: role = 'admin' | 'gestor'
  const u = {
    name: str(body?.name, { field: 'nome', min: 2, max: 100 }),
    email: email(body?.email),
    roleRow,
    role: roleRow.builtin === 'admin' ? 'admin' : 'gestor',
    active: body?.active === false ? 0 : 1,
    branches: Array.isArray(body?.branches) ? [...new Set(body.branches.map((b) => id(b, 'filial')))] : [],
    password: body?.password || null,
  };
  if (isNew || u.password) {
    const err = passwordPolicyError(u.password);
    if (err) throw bad(err);
  }
  for (const b of u.branches) if (!get('SELECT 1 FROM branches WHERE id = ?', b)) throw bad('Filial inválida.');
  return u;
}

function assertCanManage(actor, u, existing) {
  if (!perm.roleWithin(actor, u.roleRow)) throw new HttpError(403, 'Você não pode dar a alguém um perfil com mais acesso que o seu.');
  if (existing && !perm.roleWithin(actor, perm.roleOf(existing))) throw new HttpError(403, 'Você não pode alterar uma pessoa com mais acesso que você.');
  const sc = scope(actor);
  if (sc) {
    if (!u.branches.every((b) => sc.includes(b))) throw new HttpError(403, 'Você só pode ligar a pessoa às filiais que você enxerga.');
    if (existing && !all('SELECT branch_id FROM user_branches WHERE user_id = ?', existing.id).every((l) => sc.includes(l.branch_id))) {
      throw new HttpError(403, 'Esta pessoa tem filiais que você não enxerga.');
    }
  }
}

const activeAdmins = (exceptId) => get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", exceptId).n;

function setUserBranches(userId, branches) {
  run('DELETE FROM user_branches WHERE user_id = ?', userId);
  for (const b of branches) run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', userId, b);
}

router.post('/users', need('usuarios', 'incluir'), (req, res) => {
  const u = userInput(req.body, true);
  assertCanManage(req.user, u, null);
  if (get('SELECT 1 FROM users WHERE email = ?', u.email)) throw new HttpError(409, 'E-mail já cadastrado.');
  const newId = tx(() => {
    const r = run('INSERT INTO users (name, email, password_hash, role, role_id, active, created_at) VALUES (?,?,?,?,?,?,?)',
      u.name, u.email, hashPassword(u.password), u.role, u.roleRow.id, u.active, Date.now());
    setUserBranches(r.lastInsertRowid, u.branches);
    return Number(r.lastInsertRowid);
  });
  audit(req.user.id, 'user.create', { id: newId, email: u.email, role: u.role, roleId: u.roleRow.id, roleName: u.roleRow.name, branches: u.branches }, req.ip);
  res.status(201).json({ id: newId });
});

router.put('/users/:id', need('usuarios', 'editar'), (req, res) => {
  const uid = id(req.params.id);
  const existing = get('SELECT * FROM users WHERE id = ?', uid);
  if (!existing) throw new HttpError(404, 'Usuário não encontrado.');
  const u = userInput(req.body, false);
  const before = perm.roleOf(existing);
  if (uid === req.user.id) {
    if (u.roleRow.id !== before.id) throw bad('Você não pode mudar o seu próprio perfil.');
    if (!u.active) throw bad('Você não pode desativar a si mesmo.');
  }
  assertCanManage(req.user, u, existing);
  if (existing.role === 'admin' && existing.active && (u.role !== 'admin' || !u.active) && activeAdmins(uid) === 0) {
    throw bad('Esta é a única pessoa com perfil Administrador ativo. Cadastre outro administrador antes.');
  }
  if (get('SELECT 1 FROM users WHERE email = ? AND id <> ?', u.email, uid)) throw new HttpError(409, 'E-mail já cadastrado.');
  // Reset do 2FA (celular perdido): o usuário configura de novo no próximo login.
  const resetMfa = req.body?.resetMfa === true;
  if (resetMfa) {
    if (uid === req.user.id) throw bad('Para trocar o seu próprio 2FA, use "Minha conta".');
    if (!can(req.user, 'usuarios', 'mfa')) throw perm.deny();
  }
  tx(() => {
    run('UPDATE users SET name=?, email=?, role=?, role_id=?, active=?, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END WHERE id=?',
      u.name, u.email, u.role, u.roleRow.id, u.active, req.body?.unlock ? 1 : 0, uid);
    if (u.password) run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(u.password), uid);
    setUserBranches(uid, u.branches);
  });
  // Mudança de perfil, desativação ou senha nova derrubam as sessões abertas do usuário.
  if (u.password || !u.active || u.roleRow.id !== before.id) destroyUserSessions(uid);
  if (resetMfa) resetUserMfa(uid);
  audit(req.user.id, 'user.update', { id: uid, email: u.email, role: u.role, roleId: u.roleRow.id, roleName: u.roleRow.name, active: u.active, passwordReset: !!u.password, resetMfa }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- perfis e permissões
router.get('/roles', needAny(['permissoes', 'ver'], ['usuarios', 'ver']), (req, res) => {
  res.json({ roles: perm.listRoles(), catalog: perm.catalog() });
});

function assertRoleName(name, exceptId = 0) {
  if (get('SELECT 1 FROM roles WHERE name = ? AND id <> ?', name, exceptId)) throw new HttpError(409, 'Já existe um perfil com esse nome.');
}
const WIDER = 'Você não pode criar ou alterar um perfil com mais acesso que o seu.';

router.post('/roles', need('permissoes', 'incluir'), (req, res) => {
  const r = perm.roleInput(req.body);
  if (!perm.roleWithin(req.user, r)) throw new HttpError(403, WIDER);
  assertRoleName(r.name);
  const now = Date.now();
  const ins = run('INSERT INTO roles (name, description, scope, perms, created_at, updated_at) VALUES (?,?,?,?,?,?)', r.name, r.description, r.scope, JSON.stringify(r.perms), now, now);
  audit(req.user.id, 'role.create', { id: Number(ins.lastInsertRowid), name: r.name, scope: r.scope, perms: r.perms }, req.ip);
  res.status(201).json({ id: Number(ins.lastInsertRowid) });
});

router.put('/roles/:id', need('permissoes', 'editar'), (req, res) => {
  const rid = id(req.params.id);
  const cur = get('SELECT * FROM roles WHERE id = ?', rid);
  if (!cur) throw new HttpError(404, 'Perfil não encontrado.');
  if (cur.builtin === 'admin') throw bad('O perfil Administrador é fixo e não pode ser alterado.');
  if (!perm.roleWithin(req.user, cur)) throw new HttpError(403, WIDER);
  const r = perm.roleInput(req.body);
  if (!perm.roleWithin(req.user, r)) throw new HttpError(403, WIDER);
  assertRoleName(r.name, rid);
  const old = perm.parsePerms(cur.perms);
  run('UPDATE roles SET name = ?, description = ?, scope = ?, perms = ?, updated_at = ? WHERE id = ?', r.name, r.description, r.scope, JSON.stringify(r.perms), Date.now(), rid);
  // Auditoria com o "antes e depois": o que entrou, o que saiu e a mudança de filiais.
  audit(req.user.id, 'role.update', { id: rid, name: r.name, renamedFrom: cur.name !== r.name ? cur.name : undefined,
    scopeFrom: cur.scope !== r.scope ? cur.scope : undefined, scope: r.scope,
    added: r.perms.filter((p) => !old.includes(p)), removed: old.filter((p) => !r.perms.includes(p)) }, req.ip);
  res.json({ ok: true });
});

router.delete('/roles/:id', need('permissoes', 'excluir'), (req, res) => {
  const rid = id(req.params.id);
  const cur = get('SELECT * FROM roles WHERE id = ?', rid);
  if (!cur) throw new HttpError(404, 'Perfil não encontrado.');
  if (cur.builtin) throw bad('Os perfis padrão do sistema não podem ser excluídos.');
  if (!perm.roleWithin(req.user, cur)) throw new HttpError(403, WIDER);
  const n = get("SELECT COUNT(*) AS n FROM users WHERE role_id = ? AND role <> 'admin'", rid).n;
  if (n) throw bad(`${n} usuário(s) usam este perfil. Troque o perfil deles antes de excluir.`);
  run('DELETE FROM roles WHERE id = ?', rid);
  audit(req.user.id, 'role.delete', { id: rid, name: cur.name }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- configurações (cada aba com a sua permissão)
router.get('/settings', (req, res) => res.json(settingsFor(req.user)));

router.get('/settings/notifications', needAny(['cfg_envios', 'ver'], ['cfg_alertas', 'ver']), (req, res) => {
  const recent = can(req.user, 'cfg_envios', 'ver') ? all("SELECT id, kind, channel, status, attempts, last_error, created_at, sent_at FROM outbox ORDER BY id DESC LIMIT 30") : [];
  res.json({ ...outboxStatus(), webhookSecret: can(req.user, 'cfg_alertas', 'ver') ? webhookSecret() : null, recent });
});

const testLimiter = rateLimiter({ windowMs: 60 * 60_000, max: 5, keyFn: (req) => 'test:' + req.user.id, message: 'Limite de testes atingido. Aguarde um pouco.' });
router.post('/settings/test-email', need('cfg_envios', 'editar'), testLimiter, async (req, res) => {
  const s = getSettings();
  const { html, text } = renderEmail({ brand: s, title: 'E-mail de teste', intro: 'Se você recebeu esta mensagem, o envio de e-mails do sistema de pesquisa está funcionando.' });
  queueEmail({ to: req.user.email, subject: `${s.companyName}: e-mail de teste`, text, html, kind: 'test' });
  await processOutbox(5);
  const last = get("SELECT status, last_error FROM outbox WHERE kind = 'test' ORDER BY id DESC LIMIT 1");
  res.json({ sent: last.status === 'sent', error: last.last_error });
});

// Envia agora o relatório semanal (para testar) — mesmo conteúdo do envio automático.
router.post('/settings/weekly-report/send-now', need('cfg_alertas', 'relatorio'), testLimiter, async (req, res) => {
  const r = await require('../scheduled').sendWeeklyReport({ force: true });
  await processOutbox(50);
  audit(req.user.id, 'report.weekly_manual', r, req.ip);
  res.json(r);
});

router.put('/settings', (req, res) => {
  // Cada chave enviada precisa da permissão de editar a aba dela.
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw bad('Configurações inválidas.');
  const sent = Object.keys(req.body);
  for (const [g, keys] of Object.entries(SETTINGS_GROUPS)) {
    if (sent.some((k) => keys.includes(k)) && !can(req.user, g, 'editar')) throw perm.deny();
  }
  if (!sent.some((k) => Object.values(SETTINGS_GROUPS).flat().includes(k))) throw bad('Nada para salvar.');
  const saved = saveSettings(req.body);
  audit(req.user.id, 'settings.update', { companyName: saved.companyName }, req.ip);
  res.json(settingsFor(req.user));
});

// ---------------------------------------------------------------- relatório PowerPoint
router.get('/report.pptx', need('dashboard', 'pptx'), async (req, res) => {
  const { buffer: buf } = await reportFor(req.user, req.query, req.user.name);
  audit(req.user.id, 'report.pptx', { filter: req.query }, req.ip);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.set('Content-Disposition', `attachment; filename="relatorio-nps-${new Date().toISOString().slice(0, 10)}.pptx"`);
  res.send(buf);
});

router.get('/audit', need('auditoria', 'ver'), (req, res) => {
  const limit = int(req.query.limit || '300', { field: 'limite', min: 1, max: 1000 });
  res.json(all(`SELECT l.id, l.at, l.action, l.detail, l.ip, l.user_id, u.email, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.id DESC LIMIT ?`, limit));
});

// ---------------------------------------------------------------- envio: e-mail (SMTP) e WhatsApp, configurados pelo painel
router.get('/settings/delivery', need('cfg_envios', 'ver'), (req, res) => res.json(delivery.publicView()));
router.put('/settings/delivery', need('cfg_envios', 'editar'), async (req, res) => {
  const b = req.body || {};
  const view = await delivery.save({ smtp: b.smtp, whatsapp: b.whatsapp });
  // Auditoria sem segredos: só registra o que foi alterado.
  audit(req.user.id, 'settings.delivery', { smtp: b.smtp === undefined ? undefined : (b.smtp?.clear ? 'removido' : 'alterado'), whatsapp: b.whatsapp === undefined ? undefined : (b.whatsapp?.clear ? 'removido' : 'alterado') }, req.ip);
  res.json(view);
});
router.post('/settings/test-whatsapp', need('cfg_envios', 'editar'), testLimiter, async (req, res) => {
  try {
    const info = await whatsappCheck();
    let queued = false;
    const phone = String(req.body?.phone || '').replace(/[\s().+-]/g, '');
    const s = getSettings();
    if (phone) {
      if (!/^\d{10,15}$/.test(phone)) throw bad('Número inválido. Digite DDI + DDD + número (ex.: 5511999990000).');
      if (!s.alerts.whatsappTemplate) throw bad('Informe o "Modelo aprovado do WhatsApp" para enviar uma mensagem de teste.');
      queueWhatsApp(/^\d{10,11}$/.test(phone) ? '55' + phone : phone, { template: s.alerts.whatsappTemplate, language: s.alerts.whatsappLanguage, params: ['Teste', '10', 'Mensagem de teste'] }, 'test');
      await processOutbox(5);
      const last = get("SELECT status, last_error FROM outbox WHERE kind = 'test' AND channel = 'whatsapp' ORDER BY id DESC LIMIT 1");
      if (last.status !== 'sent') return res.json({ ok: false, ...info, error: last.last_error || 'Falha no envio.' });
      queued = true;
    }
    res.json({ ok: true, ...info, sentTest: queued });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
