'use strict';
// Popula o banco com dados de DEMONSTRAÇÃO (filiais, pesquisa, tablets e respostas fictícias).
// Uso: DEMO_ADMIN_PASSWORD="..." npm run seed:demo   — nunca use em produção.
const crypto = require('node:crypto');
const { get, run, tx } = require('../src/db');
const { hashPassword, passwordPolicyError } = require('../src/security');

if (process.env.NODE_ENV === 'production') { console.error('seed:demo não pode rodar em produção.'); process.exit(1); }
if (get('SELECT 1 FROM surveys LIMIT 1')) { console.error('O banco já possui dados; seed ignorado.'); process.exit(0); }
const adminPw = process.env.DEMO_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url') + '1a';
const err = passwordPolicyError(adminPw);
if (err) { console.error(err); process.exit(1); }

const now = Date.now();
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

tx(() => {
  const adminId = run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,'admin',?)",
    'Administrador Demo', 'admin@demo.local', hashPassword(adminPw), now).lastInsertRowid;
  const branches = [['SP01', 'São Paulo — Paulista', 'São Paulo', 62], ['RJ01', 'Rio — Barra', 'Rio de Janeiro', 35], ['BH01', 'Belo Horizonte — Savassi', 'Belo Horizonte', 15]]
    .map(([code, name, city, bias]) => ({ id: run('INSERT INTO branches (code, name, city, created_at) VALUES (?,?,?,?)', code, name, city, now).lastInsertRowid, bias }));
  const gestorId = run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,'gestor',?)",
    'Gestora RJ', 'gestor.rj@demo.local', hashPassword(adminPw), now).lastInsertRowid;
  run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', gestorId, branches[1].id);

  const surveyId = run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_seconds, idle_seconds, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, 'Satisfação no atendimento 2026', 'Como foi sua experiência hoje?', 'Responda em menos de 1 minuto e nos ajude a melhorar.',
  'Muito obrigado! 💛', 'Sua opinião faz toda a diferença.', 8, 45, now, now).lastInsertRowid;
  const qs = [
    ['Em uma escala de 0 a 10, o quanto você recomendaria nossa loja a um amigo ou familiar?', 'nps', 1, null],
    ['Como você avalia o atendimento da nossa equipe?', 'scale5', 0, null],
    ['De 0 a 10, qual a chance de você voltar a comprar conosco?', 'nps', 1, null],
    ['O que mais influenciou sua nota?', 'multi', 0, ['Atendimento', 'Preço', 'Tempo de espera', 'Variedade de produtos', 'Ambiente da loja']],
    ['Você encontrou tudo o que procurava?', 'yesno', 0, null],
    ['Quer deixar um comentário ou sugestão?', 'text', 0, null],
  ].map(([text, type, isNps, opts], i) => ({ type, opts, id: run(
    'INSERT INTO questions (survey_id, position, text, type, required, is_nps, options_json, display) VALUES (?,?,?,?,?,?,?,?)',
    surveyId, i, text, type, type === 'text' ? 0 : 1, isNps, opts ? JSON.stringify(opts) : null,
    'default').lastInsertRowid }));
  for (const b of branches) run('UPDATE branches SET survey_id = ? WHERE id = ?', surveyId, b.id);

  const comments = ['Atendimento excelente, a Ana foi muito atenciosa!', 'Fila do caixa muito demorada.', 'Loja limpa e organizada.',
    'Faltou o tamanho que eu queria.', 'Preço bom, voltarei com certeza.', 'Ar-condicionado estava fraco.', 'Equipe simpática e rápida.'];
  for (const b of branches) {
    const devId = run('INSERT INTO devices (branch_id, name, token_hash, paired_at, last_seen_at, created_at) VALUES (?,?,?,?,?,?)',
      b.id, 'Tablet recepção', crypto.randomBytes(32).toString('hex'), now, now, now).lastInsertRowid;
    const n = rnd(110, 170);
    for (let i = 0; i < n; i++) {
      const t = now - rnd(0, 29) * 86_400_000 - rnd(0, 36_000_000);
      const rid = run('INSERT INTO responses (uuid, survey_id, branch_id, device_id, started_at, submitted_at, received_at) VALUES (?,?,?,?,?,?,?)',
        crypto.randomUUID(), surveyId, b.id, devId, t - rnd(20, 90) * 1000, t, t).lastInsertRowid;
      const happy = Math.random() * 100 < b.bias + 30;
      const score = happy ? rnd(8, 10) : rnd(2, 8);
      for (const q of qs) {
        let num = null; let text = null;
        if (q.type === 'nps') num = Math.max(0, Math.min(10, score + rnd(-1, 1)));
        else if (q.type === 'scale5') num = Math.max(1, Math.min(5, Math.round(score / 2)));
        else if (q.type === 'multi') text = JSON.stringify([...new Set([pick(q.opts), pick(q.opts)])]);
        else if (q.type === 'yesno') num = happy ? 1 : rnd(0, 1);
        else if (q.type === 'text') { if (Math.random() < 0.25) text = pick(comments); else continue; }
        run('INSERT INTO answers (response_id, question_id, value_num, value_text) VALUES (?,?,?,?)', rid, q.id, num, text);
      }
    }
  }
  void adminId;
});
console.log('Dados de demonstração criados.');
console.log('  admin:  admin@demo.local');
console.log('  gestor: gestor.rj@demo.local (somente filial RJ01)');
console.log('  senha:  ' + (process.env.DEMO_ADMIN_PASSWORD ? '(a informada em DEMO_ADMIN_PASSWORD)' : adminPw));
