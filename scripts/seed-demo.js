'use strict';
// Popula o banco com dados de DEMONSTRAÇÃO (filiais, pesquisa, tablets e respostas fictícias).
// Uso: DEMO_ADMIN_PASSWORD="..." npm run seed:demo   — nunca use em produção.
const crypto = require('node:crypto');
const { get, run, tx } = require('../src/db');
const { hashPassword, passwordPolicyError } = require('../src/security');
const { encrypt, lookup } = require('../src/vault');

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
  const week = JSON.stringify([null, ...Array(5).fill({ open: '08:00', close: '20:00' }), { open: '09:00', close: '14:00' }]);
  const branches = [['SP01', 'São Paulo — Paulista', 'São Paulo', 62, 50], ['RJ01', 'Rio — Barra', 'Rio de Janeiro', 35, 40], ['BH01', 'Belo Horizonte — Savassi', 'Belo Horizonte', 15, 30]]
    .map(([code, name, city, bias, goal]) => ({ id: run('INSERT INTO branches (code, name, city, nps_goal, hours_json, alert_emails, created_at) VALUES (?,?,?,?,?,?,?)',
      code, name, city, goal, null, JSON.stringify([`gerente.${code.toLowerCase()}@demo.local`]), now).lastInsertRowid, bias }));
  void week;
  // Demonstração: 2FA não obrigatório para facilitar o primeiro acesso (em produção o padrão é obrigatório).
  run("INSERT INTO settings (key, value) VALUES ('requireAdminMfa', 'false')");
  const gestorId = run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?,?,?,'gestor',?)",
    'Gestora RJ', 'gestor.rj@demo.local', hashPassword(adminPw), now).lastInsertRowid;
  run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', gestorId, branches[1].id);

  const surveyId = run(`INSERT INTO surveys (title, welcome_title, welcome_text, thanks_title, thanks_text, thanks_seconds, idle_seconds, contact_mode, languages, i18n, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, 'Satisfação no atendimento 2026', 'Como foi sua experiência hoje?', 'Responda em menos de 1 minuto e nos ajude a melhorar.',
  'Muito obrigado! 💛', 'Sua opinião faz toda a diferença.', 8, 45, 'detractors', JSON.stringify(['pt', 'en']),
  JSON.stringify({ en: { welcome_title: 'How was your experience today?', welcome_text: 'It takes less than a minute.', thanks_title: 'Thank you! 💛', thanks_text: 'Your feedback makes a difference.' } }), now, now).lastInsertRowid;
  const OPTS_LOW = ['Atendimento', 'Preço', 'Tempo de espera', 'Variedade de produtos', 'Ambiente da loja'];
  const qs = [];
  const addQ = (text, type, isNps, opts, showIf, en) => {
    const id = run('INSERT INTO questions (survey_id, position, text, type, required, is_nps, options_json, display, show_if, i18n) VALUES (?,?,?,?,?,?,?,?,?,?)',
      surveyId, qs.length, text, type, type === 'text' ? 0 : 1, isNps, opts ? JSON.stringify(opts) : null, 'default',
      showIf ? JSON.stringify({ q: qs[showIf.ref].id, op: showIf.op, value: showIf.value }) : null, en ? JSON.stringify({ en }) : null).lastInsertRowid;
    qs.push({ id, type, opts, showIf });
  };
  addQ('Em uma escala de 0 a 10, o quanto você recomendaria nossa loja a um amigo ou familiar?', 'nps', 1, null, null, { text: 'On a scale of 0 to 10, how likely are you to recommend us to a friend?' });
  addQ('Como você avalia o atendimento da nossa equipe?', 'scale5', 0, null, null, { text: 'How do you rate our staff?' });
  addQ('O que mais pesou na sua nota?', 'multi', 0, OPTS_LOW, { ref: 0, op: 'lte', value: 6 }, { text: 'What influenced your score the most?', options: ['Service', 'Price', 'Waiting time', 'Product variety', 'Store environment'] });
  addQ('Do que você mais gostou?', 'single', 0, ['Atendimento', 'Preço', 'Variedade', 'Ambiente'], { ref: 0, op: 'gte', value: 9 }, { text: 'What did you like the most?', options: ['Service', 'Price', 'Variety', 'Environment'] });
  addQ('Você encontrou tudo o que procurava?', 'yesno', 0, null, null, { text: 'Did you find everything you were looking for?' });
  addQ('Quer deixar um comentário ou sugestão?', 'text', 0, null, null, { text: 'Any comment or suggestion?' });
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
      const nps0 = Math.max(0, Math.min(10, score + rnd(-1, 1)));
      for (const q of qs) {
        let num = null; let text = null;
        if (q.showIf && !(q.showIf.op === 'lte' ? nps0 <= q.showIf.value : nps0 >= q.showIf.value)) continue;
        if (q.type === 'nps') num = nps0;
        else if (q.type === 'single') text = pick(q.opts);
        else if (q.type === 'scale5') num = Math.max(1, Math.min(5, Math.round(score / 2)));
        else if (q.type === 'multi') text = JSON.stringify([...new Set([pick(q.opts), pick(q.opts)])]);
        else if (q.type === 'yesno') num = happy ? 1 : rnd(0, 1);
        else if (q.type === 'text') { if (Math.random() < 0.25) text = pick(comments); else continue; }
        run('INSERT INTO answers (response_id, question_id, value_num, value_text) VALUES (?,?,?,?)', rid, q.id, num, text);
      }
      // Detratores viram casos; os antigos já tratados, os recentes ainda abertos.
      if (nps0 <= 6) {
        const age = now - t;
        const st = age > 10 * 86_400_000 ? pick(['resolvido', 'resolvido', 'sem_retorno']) : age > 3 * 86_400_000 ? pick(['em_contato', 'resolvido']) : 'aberto';
        const cid = run('INSERT INTO cases (response_id, branch_id, min_score, status, assignee_id, created_at, updated_at, resolved_at) VALUES (?,?,?,?,?,?,?,?)',
          rid, b.id, nps0, st, st === 'aberto' ? null : adminId, t, t, ['resolvido', 'sem_retorno'].includes(st) ? t + rnd(2, 48) * 3_600_000 : null).lastInsertRowid;
        if (st !== 'aberto') run('INSERT INTO case_notes (case_id, user_id, at, text, status_from, status_to) VALUES (?,?,?,?,?,?)',
          cid, adminId, t + 3_600_000, pick(['Liguei para o cliente e pedi desculpas.', 'Cliente recebeu cupom de desconto.', 'Sem resposta no telefone informado.']), 'aberto', st);
        if (Math.random() < 0.3) {
          const phone = `119${rnd(10000000, 99999999)}`;
          run(`UPDATE responses SET contact_name_enc = ?, contact_phone_enc = ?, contact_phone_lookup = ?, contact_consent_at = ? WHERE id = ?`,
            encrypt(pick(['Carla', 'João', 'Marina', 'Pedro', 'Luiza'])), encrypt(phone), lookup('phone:' + phone), t, rid);
        }
      }
    }
  }
  void adminId;
});
console.log('Dados de demonstração criados.');
console.log('  admin:  admin@demo.local');
console.log('  gestor: gestor.rj@demo.local (somente filial RJ01)');
console.log('  senha:  ' + (process.env.DEMO_ADMIN_PASSWORD ? '(a informada em DEMO_ADMIN_PASSWORD)' : adminPw));
