'use strict';
// API do painel administrativo. Todas as rotas (exceto login) exigem sessão.
// Perfis: admin (tudo) e gestor (somente as filiais vinculadas a ele).
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { get, all, run, tx, audit } = require('../db');
const {
  hashPassword, verifyPassword, DUMMY_HASH, pairingCode, sha256, passwordPolicyError, rateLimiter,
} = require('../security');
const { createSession, destroySession, destroyUserSessions, requireUser, requireAdmin } = require('../auth');
const { HttpError, bad, str, int, bool, id, email, dateParam } = require('../validate');
const { QUESTION_TYPES, DISPLAYS, loadSurvey, normalizeQuestion, npsFromCounts } = require('../surveys');
const { getSettings, saveSettings } = require('../settings');
const { buildReport } = require('../report');

const router = express.Router();
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, '..', '..', 'data', 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const PAIR_TTL_MS = 15 * 60_000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

// ---------------------------------------------------------------- autenticação
const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas de login. Aguarde 15 minutos.' });

router.post('/login', loginLimiter, (req, res) => {
  const mail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const user = get('SELECT * FROM users WHERE email = ?', mail);
  const now = Date.now();
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  const generic = new HttpError(401, 'E-mail ou senha inválidos.');
  if (!user || !user.active) { audit(null, 'login.failed', { email: mail }, req.ip); throw generic; }
  if (user.locked_until && user.locked_until > now) {
    audit(user.id, 'login.locked', null, req.ip);
    throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');
  }
  if (!ok) {
    const fails = user.failed_logins + 1;
    run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
      fails >= LOCK_AFTER ? 0 : fails, fails >= LOCK_AFTER ? now + LOCK_MS : null, user.id);
    audit(user.id, 'login.failed', null, req.ip);
    throw generic;
  }
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', user.id);
  const csrf = createSession(res, user, req);
  audit(user.id, 'login.ok', null, req.ip);
  res.json({ user: publicUser(user), csrf });
});

router.use(requireUser);

router.post('/logout', (req, res) => {
  destroySession(req, res);
  audit(req.user.id, 'logout', null, req.ip);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role },
    csrf: req.user.csrf, questionTypes: QUESTION_TYPES, displays: DISPLAYS, settings: getSettings() });
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

function publicUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role }; }

// ---------------------------------------------------------------- escopo por filial
// Retorna null (todas as filiais) para admin, ou a lista de filiais do gestor.
function scope(user) {
  if (user.role === 'admin') return null;
  return all('SELECT branch_id FROM user_branches WHERE user_id = ?', user.id).map((r) => r.branch_id);
}
function assertBranch(user, branchId) {
  const s = scope(user);
  if (s && !s.includes(branchId)) throw new HttpError(404, 'Filial não encontrada.');
  if (!get('SELECT 1 FROM branches WHERE id = ?', branchId)) throw new HttpError(404, 'Filial não encontrada.');
}
const placeholders = (arr) => arr.map(() => '?').join(',');

// ---------------------------------------------------------------- filiais
router.get('/branches', (req, res) => {
  const s = scope(req.user);
  const where = s ? `WHERE b.id IN (${placeholders(s)})` : '';
  res.json(all(`SELECT b.id, b.code, b.name, b.city, b.active, b.survey_id, s.title AS survey_title,
      (SELECT COUNT(*) FROM devices d WHERE d.branch_id = b.id AND d.active = 1) AS devices
    FROM branches b LEFT JOIN surveys s ON s.id = b.survey_id ${where} ORDER BY b.name`, ...(s || [])));
});

function branchInput(body) {
  const code = str(body?.code, { field: 'código', min: 1, max: 20 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('Código deve conter apenas letras, números, - e _.');
  return {
    code,
    name: str(body?.name, { field: 'nome', min: 2, max: 100 }),
    city: str(body?.city, { field: 'cidade', max: 100, optional: true }),
    active: body?.active === undefined ? 1 : (bool(body.active) ? 1 : 0),
  };
}

router.post('/branches', requireAdmin, (req, res) => {
  const b = branchInput(req.body);
  if (get('SELECT 1 FROM branches WHERE code = ?', b.code)) throw new HttpError(409, 'Já existe uma filial com esse código.');
  const r = run('INSERT INTO branches (code, name, city, active, created_at) VALUES (?,?,?,?,?)', b.code, b.name, b.city, b.active, Date.now());
  audit(req.user.id, 'branch.create', { id: r.lastInsertRowid, ...b }, req.ip);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.put('/branches/:id', requireAdmin, (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const b = branchInput(req.body);
  if (get('SELECT 1 FROM branches WHERE code = ? AND id <> ?', b.code, bid)) throw new HttpError(409, 'Já existe uma filial com esse código.');
  run('UPDATE branches SET code = ?, name = ?, city = ?, active = ? WHERE id = ?', b.code, b.name, b.city, b.active, bid);
  audit(req.user.id, 'branch.update', { id: bid, ...b }, req.ip);
  res.json({ ok: true });
});

// Define qual pesquisa os tablets da filial exibem (admin ou gestor da filial).
router.put('/branches/:id/survey', (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const sid = req.body?.surveyId === null ? null : id(req.body?.surveyId, 'pesquisa');
  if (sid && !get('SELECT 1 FROM surveys WHERE id = ? AND active = 1', sid)) throw bad('Pesquisa inexistente ou inativa.');
  run('UPDATE branches SET survey_id = ? WHERE id = ?', sid, bid);
  audit(req.user.id, 'branch.set_survey', { branchId: bid, surveyId: sid }, req.ip);
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

router.get('/surveys/:id', (req, res) => {
  const s = loadSurvey(id(req.params.id));
  if (!s) throw new HttpError(404, 'Pesquisa não encontrada.');
  s.has_responses = !!get('SELECT 1 FROM responses WHERE survey_id = ? LIMIT 1', s.id);
  s.thanks_media = s.thanks_media_id ? get('SELECT id, mime, original_name FROM media WHERE id = ?', s.thanks_media_id) : null;
  res.json(s);
});

function surveyInput(body) {
  const mediaId = body?.thanks_media_id ? String(body.thanks_media_id) : null;
  if (mediaId && (!/^[a-f0-9]{32}$/.test(mediaId) || !get('SELECT 1 FROM media WHERE id = ?', mediaId))) throw bad('Mídia inválida.');
  const questions = body?.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 30) throw bad('A pesquisa deve ter entre 1 e 30 perguntas.');
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
    questions: questions.map(normalizeQuestion),
  };
}

function insertQuestions(surveyId, questions) {
  questions.forEach((q, i) => run(
    'INSERT INTO questions (survey_id, position, text, help_text, type, required, is_nps, options_json, display, icon) VALUES (?,?,?,?,?,?,?,?,?,?)',
    surveyId, i, q.text, q.help_text, q.type, q.required, q.is_nps, q.options.length ? JSON.stringify(q.options) : null, q.display || 'numbers', q.icon || null));
}

router.post('/surveys', requireAdmin, (req, res) => {
  const s = surveyInput(req.body);
  const now = Date.now();
  const newId = tx(() => {
    const r = run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_media_id,
      thanks_seconds, idle_seconds, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    s.title, s.welcome_title, s.welcome_text, s.thanks_title, s.thanks_text, s.thanks_media_id,
    s.thanks_seconds, s.idle_seconds, s.active, now, now);
    insertQuestions(r.lastInsertRowid, s.questions);
    return Number(r.lastInsertRowid);
  });
  audit(req.user.id, 'survey.create', { id: newId, title: s.title }, req.ip);
  res.status(201).json({ id: newId });
});

router.put('/surveys/:id', requireAdmin, (req, res) => {
  const sid = id(req.params.id);
  const current = loadSurvey(sid);
  if (!current) throw new HttpError(404, 'Pesquisa não encontrada.');
  const s = surveyInput(req.body);
  const hasResponses = !!get('SELECT 1 FROM responses WHERE survey_id = ? LIMIT 1', sid);
  tx(() => {
    run(`UPDATE surveys SET title=?, welcome_title=?, welcome_text=?, thanks_title=?, thanks_text=?, thanks_media_id=?,
      thanks_seconds=?, idle_seconds=?, active=?, updated_at=? WHERE id=?`,
    s.title, s.welcome_title, s.welcome_text, s.thanks_title, s.thanks_text, s.thanks_media_id,
    s.thanks_seconds, s.idle_seconds, s.active, Date.now(), sid);
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
        run('UPDATE questions SET text=?, help_text=?, required=?, is_nps=?, display=?, icon=? WHERE id=?',
          q.text, q.help_text, q.required, q.is_nps, q.display, q.icon, old.id);
      });
    }
    if (!s.active) run('UPDATE branches SET survey_id = NULL WHERE survey_id = ?', sid);
  });
  audit(req.user.id, 'survey.update', { id: sid, title: s.title }, req.ip);
  res.json({ ok: true });
});

router.post('/surveys/:id/duplicate', requireAdmin, (req, res) => {
  const src = loadSurvey(id(req.params.id));
  if (!src) throw new HttpError(404, 'Pesquisa não encontrada.');
  const now = Date.now();
  const newId = tx(() => {
    const r = run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_media_id,
      thanks_seconds, idle_seconds, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
    (src.title + ' (cópia)').slice(0, 120), src.welcome_title, src.welcome_text, src.thanks_title, src.thanks_text,
    src.thanks_media_id, src.thanks_seconds, src.idle_seconds, now, now);
    insertQuestions(r.lastInsertRowid, src.questions.map((q) => ({ ...q, required: q.required ? 1 : 0, is_nps: q.is_nps ? 1 : 0 })));
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

router.post('/media', requireAdmin, express.raw({ type: () => true, limit: MEDIA_MAX }), (req, res) => {
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
router.get('/devices', (req, res) => {
  const s = scope(req.user);
  const where = s ? `WHERE d.branch_id IN (${placeholders(s)})` : '';
  const rows = all(`SELECT d.id, d.name, d.branch_id, b.name AS branch_name, d.active, d.paired_at, d.last_seen_at,
      d.pair_expires_at, (d.token_hash IS NOT NULL) AS paired
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

router.post('/devices', (req, res) => {
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

router.post('/devices/:id/pairing-code', (req, res) => {
  const d = loadDeviceScoped(req.user, id(req.params.id));
  const pairing = issuePairingCode(d.id);
  audit(req.user.id, 'device.new_code', { id: d.id }, req.ip);
  res.json(pairing);
});

router.post('/devices/:id/revoke', (req, res) => {
  const d = loadDeviceScoped(req.user, id(req.params.id));
  run('UPDATE devices SET active = 0, token_hash = NULL, pair_code_hash = NULL, pair_expires_at = NULL WHERE id = ?', d.id);
  audit(req.user.id, 'device.revoke', { id: d.id }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- relatórios
// Monta o filtro comum (período, filial, pesquisa) respeitando o escopo do usuário.
function responseFilter(user, q) {
  const where = [];
  const params = [];
  const from = dateParam(q.from, 'de');
  const to = dateParam(q.to, 'até');
  if (from !== null) { where.push('r.submitted_at >= ?'); params.push(from); }
  if (to !== null) { where.push('r.submitted_at < ?'); params.push(to + 86_400_000); }
  if (q.surveyId) { where.push('r.survey_id = ?'); params.push(id(q.surveyId, 'pesquisa')); }
  if (q.branchId) {
    const bid = id(q.branchId, 'filial');
    assertBranch(user, bid);
    where.push('r.branch_id = ?'); params.push(bid);
  }
  const s = scope(user);
  if (s) { where.push(s.length ? `r.branch_id IN (${placeholders(s)})` : '0'); params.push(...s); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

const NPS_AGG = `SUM(CASE WHEN a.value_num >= 9 THEN 1 ELSE 0 END) AS promoters,
  SUM(CASE WHEN a.value_num BETWEEN 7 AND 8 THEN 1 ELSE 0 END) AS passives,
  SUM(CASE WHEN a.value_num <= 6 THEN 1 ELSE 0 END) AS detractors`;
const NPS_JOIN = 'JOIN answers a ON a.response_id = r.id JOIN questions q ON q.id = a.question_id AND q.is_nps = 1';
const npsRow = (row) => npsFromCounts(row?.promoters || 0, row?.passives || 0, row?.detractors || 0);

function computeStats(user, query) {
  const f = responseFilter(user, query);
  const totalResponses = get(`SELECT COUNT(*) AS n FROM responses r ${f.sql}`, ...f.params).n;
  const overall = npsRow(get(`SELECT ${NPS_AGG} FROM responses r ${NPS_JOIN} ${f.sql}`, ...f.params));
  const byBranch = all(`SELECT b.id, b.name, COUNT(DISTINCT r.id) AS responses, ${NPS_AGG}
      FROM responses r JOIN branches b ON b.id = r.branch_id
      LEFT JOIN answers a ON a.response_id = r.id AND a.question_id IN (SELECT id FROM questions WHERE is_nps = 1)
      ${f.sql} GROUP BY b.id ORDER BY b.name`, ...f.params)
    .map((r) => ({ id: r.id, name: r.name, responses: r.responses, ...npsRow(r) }));
  const byQuestion = all(`SELECT q.id, q.text, s.title AS survey, ${NPS_AGG}
      FROM responses r ${NPS_JOIN} JOIN surveys s ON s.id = q.survey_id ${f.sql} GROUP BY q.id ORDER BY s.title, q.position`, ...f.params)
    .map((r) => ({ id: r.id, text: r.text, survey: r.survey, ...npsRow(r) }));
  const trend = all(`SELECT date(r.submitted_at / 1000, 'unixepoch', 'localtime') AS day, COUNT(DISTINCT r.id) AS responses, ${NPS_AGG}
      FROM responses r LEFT JOIN answers a ON a.response_id = r.id AND a.question_id IN (SELECT id FROM questions WHERE is_nps = 1)
      ${f.sql} GROUP BY day ORDER BY day`, ...f.params)
    .map((r) => ({ day: r.day, responses: r.responses, nps: npsRow(r).nps }));
  const scoreDist = all(`SELECT a.value_num AS score, COUNT(*) AS n FROM responses r ${NPS_JOIN} ${f.sql} GROUP BY a.value_num`, ...f.params);
  const comments = all(`SELECT r.submitted_at, b.name AS branch, q.text AS question, a.value_text AS comment
      FROM responses r JOIN answers a ON a.response_id = r.id JOIN questions q ON q.id = a.question_id AND q.type = 'text'
      JOIN branches b ON b.id = r.branch_id ${f.sql} ORDER BY r.submitted_at DESC LIMIT 15`, ...f.params);
  return { totalResponses, overall, byBranch, byQuestion, trend, scoreDist, comments };
}

router.get('/stats', (req, res) => res.json(computeStats(req.user, req.query)));

// Distribuição de respostas por pergunta de UMA pesquisa.
function computeBreakdown(user, survey, query) {
  const f = responseFilter(user, { ...query, surveyId: String(survey.id) });
  const rows = all(`SELECT a.question_id, a.value_num, a.value_text, COUNT(*) AS n FROM responses r
      JOIN answers a ON a.response_id = r.id ${f.sql} AND (SELECT type FROM questions WHERE id = a.question_id) <> 'text'
      GROUP BY a.question_id, a.value_num, a.value_text`, ...f.params);
  return survey.questions.filter((q) => q.type !== 'text').map((q) => {
    const counts = {};
    for (const r of rows.filter((x) => x.question_id === q.id)) {
      if (q.type === 'multi') for (const o of JSON.parse(r.value_text)) counts[o] = (counts[o] || 0) + r.n;
      else if (q.type === 'yesno') counts[r.value_num ? 'Sim' : 'Não'] = r.n;
      else counts[r.value_text ?? r.value_num] = r.n;
    }
    return { id: q.id, text: q.text, type: q.type, is_nps: q.is_nps, options: q.options, counts };
  });
}

router.get('/surveys/:id/breakdown', (req, res) => {
  const survey = loadSurvey(id(req.params.id));
  if (!survey) throw new HttpError(404, 'Pesquisa não encontrada.');
  res.json(computeBreakdown(req.user, survey, req.query));
});

function listResponses(user, query, limit, offset) {
  const f = responseFilter(user, query);
  const total = get(`SELECT COUNT(*) AS n FROM responses r ${f.sql}`, ...f.params).n;
  const rows = all(`SELECT r.id, r.uuid, r.submitted_at, r.started_at, b.name AS branch, s.title AS survey, d.name AS device
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

router.get('/responses', (req, res) => {
  const page = int(req.query.page || '1', { field: 'página', min: 1, max: 100000 });
  res.json({ page, pageSize: 25, ...listResponses(req.user, req.query, 25, (page - 1) * 25) });
});

// Exportação CSV (protege contra "CSV injection" ao abrir no Excel).
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

router.get('/responses.csv', (req, res) => {
  const { rows } = listResponses(req.user, req.query, 100000, 0);
  const questions = [...new Set(rows.flatMap((r) => (r.answers || []).map((a) => a.question)))];
  const lines = [['Data/hora', 'Filial', 'Pesquisa', 'Dispositivo', ...questions].map(csvCell).join(';')];
  for (const r of rows) {
    const map = Object.fromEntries((r.answers || []).map((a) => [a.question, a.value]));
    lines.push([new Date(r.submitted_at).toLocaleString('pt-BR'), r.branch, r.survey, r.device, ...questions.map((q) => map[q])]
      .map(csvCell).join(';'));
  }
  audit(req.user.id, 'responses.export', { count: rows.length, filter: req.query }, req.ip);
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="respostas.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

// ---------------------------------------------------------------- usuários (somente admin)
router.get('/users', requireAdmin, (req, res) => {
  const users = all('SELECT id, name, email, role, active, locked_until, created_at FROM users ORDER BY name');
  const links = all('SELECT user_id, branch_id FROM user_branches');
  res.json(users.map((u) => ({ ...u, branches: links.filter((l) => l.user_id === u.id).map((l) => l.branch_id) })));
});

function userInput(body, isNew) {
  const u = {
    name: str(body?.name, { field: 'nome', min: 2, max: 100 }),
    email: email(body?.email),
    role: body?.role === 'admin' ? 'admin' : 'gestor',
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

function setUserBranches(userId, branches) {
  run('DELETE FROM user_branches WHERE user_id = ?', userId);
  for (const b of branches) run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', userId, b);
}

router.post('/users', requireAdmin, (req, res) => {
  const u = userInput(req.body, true);
  if (get('SELECT 1 FROM users WHERE email = ?', u.email)) throw new HttpError(409, 'E-mail já cadastrado.');
  const newId = tx(() => {
    const r = run('INSERT INTO users (name, email, password_hash, role, active, created_at) VALUES (?,?,?,?,?,?)',
      u.name, u.email, hashPassword(u.password), u.role, u.active, Date.now());
    setUserBranches(r.lastInsertRowid, u.branches);
    return Number(r.lastInsertRowid);
  });
  audit(req.user.id, 'user.create', { id: newId, email: u.email, role: u.role, branches: u.branches }, req.ip);
  res.status(201).json({ id: newId });
});

router.put('/users/:id', requireAdmin, (req, res) => {
  const uid = id(req.params.id);
  const existing = get('SELECT * FROM users WHERE id = ?', uid);
  if (!existing) throw new HttpError(404, 'Usuário não encontrado.');
  const u = userInput(req.body, false);
  if (uid === req.user.id && (u.role !== 'admin' || !u.active)) throw bad('Você não pode remover seu próprio acesso de administrador.');
  if (get('SELECT 1 FROM users WHERE email = ? AND id <> ?', u.email, uid)) throw new HttpError(409, 'E-mail já cadastrado.');
  tx(() => {
    run('UPDATE users SET name=?, email=?, role=?, active=?, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END WHERE id=?',
      u.name, u.email, u.role, u.active, req.body?.unlock ? 1 : 0, uid);
    if (u.password) run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(u.password), uid);
    setUserBranches(uid, u.branches);
  });
  // Mudança de papel, desativação ou senha nova derrubam as sessões abertas do usuário.
  if (u.password || !u.active || u.role !== existing.role) destroyUserSessions(uid);
  audit(req.user.id, 'user.update', { id: uid, email: u.email, role: u.role, active: u.active, passwordReset: !!u.password }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- configurações (somente admin)
router.get('/settings', (req, res) => res.json(getSettings()));

router.put('/settings', requireAdmin, (req, res) => {
  const saved = saveSettings(req.body);
  audit(req.user.id, 'settings.update', { companyName: saved.companyName }, req.ip);
  res.json(saved);
});

// ---------------------------------------------------------------- relatório PowerPoint
router.get('/report.pptx', async (req, res) => {
  const stats = computeStats(req.user, req.query);
  const surveyIds = req.query.surveyId ? [id(req.query.surveyId, 'pesquisa')]
    : all(`SELECT r.survey_id, COUNT(*) AS n FROM responses r ${responseFilter(req.user, req.query).sql}
           GROUP BY r.survey_id ORDER BY n DESC LIMIT 3`, ...responseFilter(req.user, req.query).params).map((r) => r.survey_id);
  const surveys = surveyIds.map(loadSurvey).filter(Boolean)
    .map((s) => ({ title: s.title, questions: computeBreakdown(req.user, s, req.query) }));
  const branchName = req.query.branchId ? get('SELECT name FROM branches WHERE id = ?', id(req.query.branchId, 'filial'))?.name : null;
  const buf = await buildReport({
    settings: getSettings(), stats, surveys, mediaDir: MEDIA_DIR,
    filters: { from: req.query.from || null, to: req.query.to || null, branch: branchName, survey: req.query.surveyId ? surveys[0]?.title : null },
    generatedBy: req.user.name,
  });
  audit(req.user.id, 'report.pptx', { filter: req.query }, req.ip);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.set('Content-Disposition', `attachment; filename="relatorio-nps-${new Date().toISOString().slice(0, 10)}.pptx"`);
  res.send(buf);
});

router.get('/audit', requireAdmin, (req, res) => {
  res.json(all(`SELECT l.at, l.action, l.detail, l.ip, u.email FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    ORDER BY l.id DESC LIMIT 200`));
});

module.exports = router;
