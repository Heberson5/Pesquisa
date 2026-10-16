'use strict';
// Gera docs/MANUAL.md (manual completo) e CHANGELOG.md a partir dos mesmos arquivos usados no painel
// (public/admin/ajuda e public/admin/novidades.json), para os três nunca ficarem diferentes.
// Uso: npm run docs:manual
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HELP = path.join(ROOT, 'public', 'admin', 'ajuda');
const version = require('../package.json').version;

const index = JSON.parse(fs.readFileSync(path.join(HELP, 'index.json'), 'utf8'));
const groups = [...new Set(index.map((a) => a.group))];
const fixLinks = (md) => md
  .replace(/\]\(img\//g, '](../public/admin/ajuda/img/')
  .replace(/\]\(#\/ajuda\/([a-z0-9-]+)\)/g, (m, slug) => `](#${slug})`);

let manual = `# Manual do painel — versão ${version}\n\nEste arquivo é gerado a partir do menu **Ajuda** do painel (\`npm run docs:manual\`). Não edite aqui: edite \`public/admin/ajuda/*.md\`.\n\n`;
for (const g of groups) {
  manual += `- **${g}**: ${index.filter((a) => a.group === g).map((a) => `[${a.title}](#${a.slug})`).join(' · ')}\n`;
}
for (const g of groups) {
  manual += `\n## ${g}\n`;
  for (const a of index.filter((x) => x.group === g)) {
    const body = fs.readFileSync(path.join(HELP, a.slug + '.md'), 'utf8').replace(/^## /gm, '#### ').replace(/^### /gm, '##### ');
    manual += `\n<a id="${a.slug}"></a>\n### ${a.title}\n\n${fixLinks(body).trim()}\n`;
  }
}
fs.writeFileSync(path.join(ROOT, 'docs', 'MANUAL.md'), manual);

const TYPE = { novo: 'Novo', melhoria: 'Melhoria', correcao: 'Correção' };
const news = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'admin', 'novidades.json'), 'utf8'));
let log = '# Notas de versão\n\nGerado a partir de `public/admin/novidades.json` (o mesmo conteúdo do menu **Novidades** do painel).\n';
for (const v of news) {
  log += `\n## ${v.version} — ${v.date.split('-').reverse().join('/')}\n\n`;
  for (const t of ['novo', 'melhoria', 'correcao']) {
    const items = v.items.filter((i) => i.type === t);
    if (!items.length) continue;
    log += `### ${TYPE[t]}\n`;
    for (const i of items) log += `- **${i.title}.** ${i.text}${i.image ? `\n\n  ![${i.title}](public/admin/ajuda/img/${i.image})\n` : ''}\n`;
    log += '\n';
  }
}
fs.writeFileSync(path.join(ROOT, 'CHANGELOG.md'), log.trimEnd() + '\n');
console.log('docs/MANUAL.md e CHANGELOG.md atualizados.');
