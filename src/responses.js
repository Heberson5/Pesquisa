'use strict';
// Gravação de respostas (tablet e link/QR Code) e montagem da configuração enviada ao aparelho.
// Toda regra de validação fica aqui, para os dois canais serem igualmente rígidos.
const { get, run, tx } = require('./db');
const { HttpError, bad, int, str, UUID_RE } = require('./validate');
const { loadSurvey, normalizeAnswer, isVisible, LANGS } = require('./surveys');
const { encrypt, lookup, normPhone, normEmail } = require('./vault');
const { isEmail } = require('./notify');
const { publicBranding } = require('./settings');
const alerts = require('./alerts');
const { timezone } = require('./config');

// ---------------------------------------------------------------- pesquisa vigente (com campanhas agendadas)
// A campanha mais recente que cobre o momento vence; sem campanha, vale a pesquisa padrão da filial.
function effectiveSurveyId(branch, at = Date.now()) {
  const s = get(`SELECT s.survey_id FROM schedules s JOIN surveys v ON v.id = s.survey_id AND v.active = 1
      WHERE (s.branch_id = ? OR s.branch_id IS NULL) AND s.starts_at <= ? AND s.ends_at > ?
      ORDER BY s.starts_at DESC, s.id DESC LIMIT 1`, branch.id, at, at);
  return s ? s.survey_id : branch.survey_id;
}

// Aceita a pesquisa vigente agora OU no momento em que o cliente respondeu (fila offline / troca de campanha).
function surveyAllowed(branch, surveyId, submittedAt) {
  return [Date.now(), submittedAt, submittedAt - 60 * 60_000].some((t) => effectiveSurveyId(branch, t) === surveyId);
}

function mediaInfo(id) {
  const m = id ? get('SELECT id, mime FROM media WHERE id = ?', id) : null;
  return m ? { url: `/media/${m.id}`, kind: m.mime.startsWith('video/') ? 'video' : 'image' } : null;
}

// Configuração enviada ao tablet/celular: só o necessário para exibir a pesquisa.
function surveyPayload(survey) {
  if (!survey || !survey.active) return null;
  return {
    id: survey.id,
    version: survey.updated_at,
    languages: survey.languages,
    i18n: survey.i18n,
    welcomeTitle: survey.welcome_title,
    welcomeText: survey.welcome_text,
    thanksTitle: survey.thanks_title,
    thanksText: survey.thanks_text,
    thanksMedia: mediaInfo(survey.thanks_media_id),
    thanksSeconds: survey.thanks_seconds,
    idleSeconds: survey.idle_seconds,
    contactMode: survey.contact_mode,
    questions: survey.questions.map((q) => ({
      id: q.id, text: q.text, helpText: q.help_text, type: q.type, required: q.required, options: q.options,
      display: q.display, icon: q.icon, showIf: q.show_if, i18n: q.i18n,
    })),
  };
}

// ---------------------------------------------------------------- horário de funcionamento
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function localParts(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { day: WD_EN.indexOf(p.weekday), hm: `${p.hour}:${p.minute}` };
}

// { open: true } quando sem horário configurado ou dentro do expediente; senão { open: false, reopens: 'Abrimos ...' }.
function hoursStatus(branch, at = Date.now()) {
  let hours = null;
  try { hours = branch.hours_json ? JSON.parse(branch.hours_json) : null; } catch { hours = null; }
  if (!Array.isArray(hours) || hours.length !== 7) return { open: true };
  const { day, hm } = localParts(at);
  const today = hours[day];
  if (today && today.open <= hm && hm < today.close) return { open: true };
  if (today && hm < today.open) return { open: false, reopens: `Abrimos hoje às ${today.open}.` };
  for (let i = 1; i <= 7; i++) {
    const d = hours[(day + i) % 7];
    if (d) return { open: false, reopens: `Abrimos ${i === 1 ? 'amanhã' : WEEKDAYS[(day + i) % 7]} às ${d.open}.` };
  }
  return { open: false, reopens: null };
}

function buildConfig(branch, extra = {}) {
  const sid = effectiveSurveyId(branch);
  return { ...extra, ...hoursStatus(branch), branding: publicBranding(), branch: { name: branch.name }, survey: surveyPayload(sid ? loadSurvey(sid) : null) };
}

// ---------------------------------------------------------------- contato (LGPD)
function parseContact(raw, survey, minNps) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('Contato inválido.');
  if (survey.contact_mode === 'never') throw bad('Esta pesquisa não coleta contato.');
  if (survey.contact_mode === 'detractors' && !(minNps !== null && minNps <= alerts.DETRACTOR_MAX)) throw bad('Contato não disponível para esta resposta.');
  if (raw.consent !== true) throw bad('É preciso autorizar o uso dos dados de contato.');
  const name = str(raw.name, { field: 'nome', max: 100, optional: true });
  const phone = raw.phone ? normPhone(str(raw.phone, { field: 'telefone', max: 30 })) : null;
  const email = raw.email ? normEmail(str(raw.email, { field: 'e-mail', max: 254 })) : null;
  if (phone && !/^\d{10,13}$/.test(phone)) throw bad('Telefone inválido.');
  if (email && !isEmail(email)) throw bad('E-mail inválido.');
  if (!phone && !email) throw bad('Informe telefone ou e-mail.');
  return { name, phone, email };
}

// ---------------------------------------------------------------- gravação
function saveResponse({ branch, deviceId = null, channel, body }) {
  if (!body || typeof body !== 'object') throw bad('Resposta inválida.');
  if (typeof body.uuid !== 'string' || !UUID_RE.test(body.uuid)) throw bad('Identificador inválido.');
  const surveyId = int(body.surveyId, { field: 'pesquisa', min: 1 });

  const now = Date.now();
  let submittedAt = int(body.submittedAt, { field: 'data', optional: true, min: 0, max: Number.MAX_SAFE_INTEGER }) ?? now;
  // Respostas da fila offline podem chegar depois, mas não do futuro nem de mais de 30 dias.
  if (channel !== 'tablet' || submittedAt > now + 5 * 60_000 || submittedAt < now - 30 * 86_400_000) submittedAt = now;
  let startedAt = int(body.startedAt, { field: 'início', optional: true, min: 0, max: Number.MAX_SAFE_INTEGER });
  if (startedAt !== null && (startedAt > submittedAt || submittedAt - startedAt > 3_600_000)) startedAt = null;

  // A filial vem do token (tablet) ou do link — nunca do corpo da requisição.
  if (!surveyAllowed(branch, surveyId, submittedAt)) throw new HttpError(409, 'A pesquisa desta filial mudou. Recarregando.');
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

  // Perguntas condicionais: só valem (e só são obrigatórias) quando a condição é atendida.
  const raw = new Map();
  const normalized = [];
  for (const q of survey.questions) {
    if (!isVisible(q, raw)) {
      const v = byId.get(q.id);
      if (!(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length))) throw bad('Resposta para pergunta que não deveria aparecer.');
      continue;
    }
    const v = normalizeAnswer(q, byId.get(q.id));
    if (v !== null) { normalized.push({ q, v }); raw.set(q.id, byId.get(q.id)); }
  }
  if (normalized.length === 0) throw bad('Resposta vazia.');

  const npsScores = normalized.filter((x) => x.q.is_nps).map((x) => x.v.num);
  const minNps = npsScores.length ? Math.min(...npsScores) : null;
  const contact = parseContact(body.contact, survey, minNps);
  const lang = typeof body.lang === 'string' && survey.languages.includes(body.lang) && LANGS.includes(body.lang) ? body.lang : null;

  const result = tx(() => {
    if (get('SELECT 1 FROM responses WHERE uuid = ?', body.uuid.toLowerCase())) return { created: false };
    const r = run(`INSERT INTO responses (uuid, survey_id, branch_id, device_id, started_at, submitted_at, received_at, channel, lang,
        contact_name_enc, contact_phone_enc, contact_email_enc, contact_phone_lookup, contact_email_lookup, contact_consent_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    body.uuid.toLowerCase(), survey.id, branch.id, deviceId, startedAt, submittedAt, now, channel, lang,
    contact ? encrypt(contact.name) : null, contact ? encrypt(contact.phone) : null, contact ? encrypt(contact.email) : null,
    contact?.phone ? lookup('phone:' + contact.phone) : null, contact?.email ? lookup('email:' + contact.email) : null, contact ? now : null);
    for (const { q, v } of normalized) {
      run('INSERT INTO answers (response_id, question_id, value_num, value_text) VALUES (?,?,?,?)', r.lastInsertRowid, q.id, v.num, v.text);
    }
    return { created: true, id: Number(r.lastInsertRowid) };
  });
  if (result.created) alerts.onResponse(result.id);
  return result;
}

module.exports = { effectiveSurveyId, surveyAllowed, buildConfig, surveyPayload, saveResponse, mediaInfo, hoursStatus };
