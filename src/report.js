'use strict';
// Relatório PowerPoint (.pptx) com gráficos nativos (editáveis no PowerPoint),
// logo e cores da empresa definidos em Configurações.
const fs = require('node:fs');
const path = require('node:path');
const PptxGenJS = require('pptxgenjs');

const W = 13.333; // LAYOUT_WIDE
const H = 7.5;
const M = 0.6;    // margem
const FONT = 'Calibri';
const GOOD = '1B8A5A';
const NEUTRAL = 'B8C2CC';
const BAD = 'D93F44';
const INK = '1F2A37';
const MUTED = '64748B';
const SOFT = 'F1F5F9';
const LINE = 'E2E8F0';

const hex = (c) => String(c || '').replace('#', '').toUpperCase();
function isDark(c) {
  const n = parseInt(hex(c), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) < 150;
}
const fmtNps = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toLocaleString('pt-BR'));
const pct = (v, t) => (t ? Math.round((v / t) * 100) + '%' : '—');
const fmtDay = (iso) => (iso ? iso.split('-').reverse().join('/') : null);
const npsColor = (n) => (n === null ? MUTED : n >= 50 ? GOOD : n >= 0 ? 'C27C0E' : BAD);

// Dimensões de PNG/JPEG/GIF/WEBP lendo o cabeçalho (para não distorcer a logo).
function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.subarray(0, 3).toString('ascii') === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF') {
      const chunk = buf.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch { /* cabeçalho inesperado */ }
  return null;
}

function loadLogo(settings, mediaDir) {
  if (!settings.logoMediaId) return null;
  try {
    const buf = fs.readFileSync(path.join(mediaDir, settings.logoMediaId));
    const size = imageSize(buf);
    if (!size || !size.w || !size.h) return null;
    const mime = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : buf.subarray(0, 3).toString('ascii') === 'GIF' ? 'image/gif' : 'image/webp';
    // WEBP não é aceito por todas as versões do PowerPoint — nesse caso a logo fica de fora do .pptx.
    if (mime === 'image/webp') return null;
    return { data: `${mime};base64,${buf.toString('base64')}`, ratio: size.w / size.h };
  } catch { return null; }
}

// Encaixa a logo dentro de uma caixa mantendo a proporção.
function fit(logo, x, y, w, h, align = 'left') {
  let lw = w; let lh = w / logo.ratio;
  if (lh > h) { lh = h; lw = h * logo.ratio; }
  const lx = align === 'right' ? x + w - lw : align === 'center' ? x + (w - lw) / 2 : x;
  return { data: logo.data, x: lx, y: y + (h - lh) / 2, w: lw, h: lh };
}

const chartBase = () => ({
  catAxisLabelColor: MUTED, valAxisLabelColor: MUTED, catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT,
  catAxisLabelFontSize: 11, valAxisLabelFontSize: 10, dataLabelFontFace: FONT, dataLabelFontSize: 11, dataLabelColor: INK,
  valGridLine: { color: LINE, size: 0.75 }, catGridLine: { style: 'none' },
  catAxisLineShow: false, valAxisLineShow: false, legendFontFace: FONT, legendFontSize: 11, legendColor: MUTED,
  titleFontFace: FONT, titleColor: INK, titleFontSize: 14, valAxisMinVal: 0,
});

async function buildReport({ settings, stats, surveys, filters, mediaDir, generatedBy }) {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_WIDE';
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };
  pres.title = `Relatório de satisfação — ${settings.companyName}`;
  pres.author = generatedBy || settings.companyName;
  pres.company = settings.companyName.replace(/&/g, '&amp;');

  const primary = hex(settings.primaryColor);
  const accent = hex(settings.accentColor);
  const onPrimary = isDark(primary) ? 'FFFFFF' : INK;
  const logo = loadLogo(settings, mediaDir);
  const period = filters.from || filters.to ? `${fmtDay(filters.from) || 'início'} a ${fmtDay(filters.to) || 'hoje'}` : 'Todo o período';
  const scopeText = [filters.branch ? `Filial: ${filters.branch}` : 'Todas as filiais', filters.survey ? `Pesquisa: ${filters.survey}` : null]
    .filter(Boolean).join('  ·  ');

  // ------------------------------------------------ layouts
  pres.defineSlideMaster({
    title: 'CAPA',
    background: { color: primary },
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: M, y: 2.5, w: 9.5, h: 1.6, fontFace: FONT, fontSize: 44, bold: true, color: onPrimary, align: 'left', valign: 'bottom', margin: 0 }, text: '' } },
      { placeholder: { options: { name: 'body', type: 'body', x: M, y: 4.25, w: 9.5, h: 1.4, fontFace: FONT, fontSize: 18, color: onPrimary, align: 'left', valign: 'top', margin: 0 }, text: '' } },
    ],
  });
  const contentObjects = [
    { placeholder: { options: { name: 'title', type: 'title', x: M, y: 0.4, w: W - 2 * M - 2.4, h: 0.8, fontFace: FONT, fontSize: 30, bold: true, color: INK, align: 'left', valign: 'middle', margin: 0 }, text: '' } },
    { text: { text: `${settings.companyName}  ·  ${period}`, options: { x: M, y: H - 0.5, w: 8, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED, margin: 0 } } },
  ];
  if (logo) contentObjects.push({ image: fit(logo, W - M - 2.2, 0.45, 2.2, 0.7, 'right') });
  pres.defineSlideMaster({
    title: 'CONTEUDO',
    background: { color: 'FFFFFF' },
    objects: contentObjects,
    slideNumber: { x: W - M - 0.6, y: H - 0.5, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: MUTED, align: 'right' },
  });

  const addContent = (title, section) => {
    const s = pres.addSlide({ masterName: 'CONTEUDO', sectionTitle: section });
    s.addText(title, { placeholder: 'title' });
    return s;
  };
  const card = (s, x, y, w, h, name) => s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: SOFT }, line: { color: SOFT }, objectName: name });

  // ------------------------------------------------ 1. capa
  pres.addSection({ title: 'Capa' });
  const cover = pres.addSlide({ masterName: 'CAPA', sectionTitle: 'Capa' });
  if (logo) {
    cover.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y: 0.7, w: 3.2, h: 1.3, rectRadius: 0.15, fill: { color: 'FFFFFF' }, line: { color: 'FFFFFF' }, objectName: 'Fundo da logo' });
    cover.addImage({ ...fit(logo, M + 0.25, 0.85, 2.7, 1.0, 'center'), objectName: 'Logo' });
  }
  cover.addText('Relatório de satisfação e NPS', { placeholder: 'title' });
  cover.addText([
    { text: settings.companyName, options: { bold: true, breakLine: true } },
    { text: `${period}  ·  ${scopeText}`, options: { breakLine: true } },
    { text: `Gerado em ${new Date().toLocaleDateString('pt-BR')}`, options: { fontSize: 14 } },
  ], { placeholder: 'body' });
  // "selo" do NPS na capa: o motivo visual que se repete (círculos)
  cover.addShape(pres.shapes.OVAL, { x: W - M - 2.6, y: 2.4, w: 2.6, h: 2.6, fill: { color: accent }, line: { color: accent }, objectName: 'Selo NPS' });
  cover.addText([{ text: fmtNps(stats.overall.nps), options: { fontSize: 44, bold: true, breakLine: true } }, { text: 'NPS', options: { fontSize: 16 } }],
    { x: W - M - 2.6, y: 2.4, w: 2.6, h: 2.6, align: 'center', valign: 'middle', color: isDark(accent) ? 'FFFFFF' : INK, fontFace: FONT, isTextBox: true, margin: 0 });

  // ------------------------------------------------ 2. resumo
  pres.addSection({ title: 'Visão geral' });
  const o = stats.overall;
  const sum = addContent('Resumo do período', 'Visão geral');
  const kpis = [
    ['NPS', fmtNps(o.nps), npsColor(o.nps), `${o.total.toLocaleString('pt-BR')} notas de NPS`],
    ['Respostas', stats.totalResponses.toLocaleString('pt-BR'), INK, 'pesquisas concluídas'],
    ['Promotores', pct(o.promoters, o.total), GOOD, 'notas 9 e 10'],
    ['Detratores', pct(o.detractors, o.total), BAD, 'notas de 0 a 6'],
  ];
  const kw = (W - 2 * M - 3 * 0.3) / 4;
  kpis.forEach(([label, value, color, hint], i) => {
    const x = M + i * (kw + 0.3);
    card(sum, x, 1.5, kw, 1.9, `Indicador ${label}`);
    sum.addText(label.toUpperCase(), { x: x + 0.3, y: 1.65, w: kw - 0.6, h: 0.35, fontSize: 12, bold: true, color: MUTED, charSpacing: 1, isTextBox: true, margin: 0 });
    sum.addText(value, { x: x + 0.3, y: 2.0, w: kw - 0.6, h: 0.9, fontSize: 44, bold: true, color, isTextBox: true, margin: 0 });
    sum.addText(hint, { x: x + 0.3, y: 2.9, w: kw - 0.6, h: 0.35, fontSize: 12, color: MUTED, isTextBox: true, margin: 0 });
  });
  if (o.total) {
    sum.addChart(pres.charts.BAR, [
      { name: 'Promotores', labels: ['Composição'], values: [o.promoters / o.total] },
      { name: 'Neutros', labels: ['Composição'], values: [o.passives / o.total] },
      { name: 'Detratores', labels: ['Composição'], values: [o.detractors / o.total] },
    ], { ...chartBase(), x: M, y: 3.75, w: 7.4, h: 1.7, barDir: 'bar', barGrouping: 'percentStacked', chartColors: [GOOD, NEUTRAL, BAD],
      showValue: true, dataLabelPosition: 'ctr', dataLabelFormatCode: '0%', dataLabelColor: 'FFFFFF', showLegend: true, legendPos: 'b',
      catAxisHidden: true, valAxisHidden: true, valGridLine: { style: 'none' }, showTitle: true, title: 'Composição das notas', objectName: 'Composição' });
  }
  const ranked = stats.byBranch.filter((b) => b.nps !== null).sort((a, b) => b.nps - a.nps);
  const insights = [];
  if (ranked.length) insights.push(`Melhor filial: ${ranked[0].name} (NPS ${fmtNps(ranked[0].nps)})`);
  if (ranked.length > 1) insights.push(`Maior atenção: ${ranked.at(-1).name} (NPS ${fmtNps(ranked.at(-1).nps)})`);
  const bestDay = stats.trend.filter((t) => t.responses).sort((a, b) => b.responses - a.responses)[0];
  if (bestDay) insights.push(`Dia com mais respostas: ${fmtDay(bestDay.day)} (${bestDay.responses})`);
  card(sum, 8.35, 3.75, W - M - 8.35, 2.9, 'Destaques');
  sum.addText('Destaques', { x: 8.6, y: 3.9, w: W - M - 8.85, h: 0.4, fontSize: 16, bold: true, color: INK, isTextBox: true, margin: 0 });
  sum.addText(insights.length ? insights.map((t, i) => ({ text: t, options: { bullet: true, breakLine: i < insights.length - 1 } }))
    : [{ text: 'Sem respostas no período.' }], { x: 8.6, y: 4.35, w: W - M - 8.85, h: 2.2, fontSize: 14, color: INK, valign: 'top', paraSpaceAfter: 8, isTextBox: true, margin: 0 });

  // ------------------------------------------------ 3. distribuição das notas
  const dist = addContent('Distribuição das notas de 0 a 10', 'Visão geral');
  const labels = Array.from({ length: 11 }, (_, n) => String(n));
  const count = (n) => stats.scoreDist.find((d) => d.score === n)?.n || 0;
  dist.addChart(pres.charts.BAR, [
    { name: 'Detratores (0–6)', labels, values: labels.map((_, n) => (n <= 6 ? count(n) : 0)) },
    { name: 'Neutros (7–8)', labels, values: labels.map((_, n) => (n >= 7 && n <= 8 ? count(n) : 0)) },
    { name: 'Promotores (9–10)', labels, values: labels.map((_, n) => (n >= 9 ? count(n) : 0)) },
  ], { ...chartBase(), x: M, y: 1.4, w: W - 2 * M, h: 5.4, barDir: 'col', barGrouping: 'stacked', barGapWidthPct: 40,
    chartColors: [BAD, NEUTRAL, GOOD], showValue: true, dataLabelPosition: 'inEnd', dataLabelFormatCode: '0;;;', dataLabelColor: 'FFFFFF',
    showLegend: true, legendPos: 't', objectName: 'Distribuição das notas' });

  // ------------------------------------------------ 4. evolução
  if (stats.trend.length) {
    const ev = addContent('Evolução diária', 'Visão geral');
    const days = stats.trend.map((t) => fmtDay(t.day).slice(0, 5));
    ev.addChart(pres.charts.LINE, [{ name: 'NPS', labels: days, values: stats.trend.map((t) => t.nps ?? 0) }],
      { ...chartBase(), x: M, y: 1.35, w: W - 2 * M, h: 3.3, chartColors: [primary], lineSize: 2.5, lineDataSymbol: 'circle', lineDataSymbolSize: 6,
        valAxisMinVal: -100, valAxisMaxVal: 100, valAxisMajorUnit: 50, showLegend: false, showTitle: true, title: 'NPS por dia', objectName: 'NPS por dia' });
    ev.addChart(pres.charts.BAR, [{ name: 'Respostas', labels: days, values: stats.trend.map((t) => t.responses) }],
      { ...chartBase(), x: M, y: 4.75, w: W - 2 * M, h: 2.1, barDir: 'col', chartColors: [accent], showLegend: false,
        showTitle: true, title: 'Respostas por dia', showValue: stats.trend.length <= 20, dataLabelPosition: 'outEnd', objectName: 'Respostas por dia' });
  }

  // ------------------------------------------------ 5. filiais
  if (stats.byBranch.length) {
    pres.addSection({ title: 'Filiais' });
    const br = addContent('NPS por filial', 'Filiais');
    const sorted = [...stats.byBranch].sort((a, b) => (b.nps ?? -999) - (a.nps ?? -999));
    const chartH = Math.max(3.2, Math.min(5.4, 0.8 + sorted.length * 0.55));
    br.addChart(pres.charts.BAR, [{ name: 'NPS', labels: sorted.map((b) => b.name), values: sorted.map((b) => b.nps ?? 0) }],
      { ...chartBase(), x: M, y: 1.4, w: 5.7, h: chartH, barDir: 'bar', catAxisOrientation: 'maxMin', valAxisMinVal: -100, valAxisMaxVal: 100,
        valAxisMajorUnit: 50, catAxisLabelPos: 'low', chartColors: sorted.map((b) => npsColor(b.nps)), showValue: true, dataLabelPosition: 'outEnd',
        dataLabelFormatCode: '+0.0;-0.0;0', showLegend: false, showTitle: true, title: 'NPS (−100 a +100)', objectName: 'NPS por filial' });
    const head = ['Filial', 'Respostas', 'Promotores', 'Detratores', 'NPS'].map((t) => ({ text: t, options: { bold: true, fontSize: 11, color: MUTED, fill: { color: SOFT } } }));
    const rows = sorted.map((b) => [b.name, String(b.responses), pct(b.promoters, b.total), pct(b.detractors, b.total),
      { text: fmtNps(b.nps), options: { bold: true, color: npsColor(b.nps) } }]);
    br.addTable([head, ...rows.slice(0, 12)], { x: 6.5, y: 1.45, w: W - M - 6.5, colW: [1.55, 1.1, 1.3, 1.3, (W - M - 6.5) - 5.25],
      fontFace: FONT, fontSize: 12, margin: [0.04, 0.08, 0.04, 0.08], color: INK, border: { type: 'solid', pt: 0.75, color: LINE }, rowH: 0.42, valign: 'middle', objectName: 'Tabela de filiais' });
    if (rows.length > 12) br.addText(`+ ${rows.length - 12} filiais no sistema`, { x: 6.5, y: 6.75, w: 6, h: 0.3, fontSize: 11, color: MUTED, isTextBox: true, margin: 0 });
  }

  // ------------------------------------------------ 6. perguntas de NPS
  pres.addSection({ title: 'Perguntas' });
  if (stats.byQuestion.length) {
    const qn = addContent('NPS por pergunta marcada', 'Perguntas');
    const qs = stats.byQuestion.slice(0, 8);
    const short = (t) => (t.length > 60 ? t.slice(0, 57) + '…' : t);
    const qLabels = qs.map((q) => `${short(q.text)}  (NPS ${fmtNps(q.nps)})`);
    qn.addChart(pres.charts.BAR, [
      { name: 'Promotores', labels: qLabels, values: qs.map((q) => (q.total ? q.promoters / q.total : 0)) },
      { name: 'Neutros', labels: qLabels, values: qs.map((q) => (q.total ? q.passives / q.total : 0)) },
      { name: 'Detratores', labels: qLabels, values: qs.map((q) => (q.total ? q.detractors / q.total : 0)) },
    ], { ...chartBase(), x: M, y: 1.4, w: W - 2 * M, h: Math.min(5.4, 1.4 + qs.length * 0.8), barDir: 'bar', barGrouping: 'percentStacked', catAxisOrientation: 'maxMin',
      chartColors: [GOOD, NEUTRAL, BAD], showValue: true, dataLabelPosition: 'ctr', dataLabelFormatCode: '0%;;;', dataLabelColor: 'FFFFFF',
      catAxisLabelFontSize: 13, catAxisLabelColor: INK, valAxisHidden: true, valGridLine: { style: 'none' }, showLegend: true, legendPos: 'b', objectName: 'NPS por pergunta' });
  }

  // demais perguntas (escala, escolha, sim/não), duas por slide
  for (const sv of surveys) {
    const charts = sv.questions.filter((q) => !q.is_nps && Object.keys(q.counts).length);
    for (let i = 0; i < charts.length; i += 2) {
      const sl = addContent(sv.questions.length && surveys.length > 1 ? `Respostas — ${sv.title}` : 'Como os clientes responderam', 'Perguntas');
      charts.slice(i, i + 2).forEach((q, j) => {
        const x = M + j * ((W - 2 * M) / 2 + 0.15);
        const w = (W - 2 * M) / 2 - 0.15;
        let keys = Object.keys(q.counts);
        if (q.type === 'scale5') keys = ['1', '2', '3', '4', '5'];
        else if (q.type === 'nps') keys = labels;
        else if (q.options?.length) keys = q.options;
        else if (q.type === 'yesno') keys = ['Sim', 'Não'];
        const names = q.type === 'scale5' ? ['Péssimo', 'Ruim', 'Regular', 'Bom', 'Ótimo'] : keys;
        card(sl, x, 1.4, w, 5.4, `Fundo pergunta ${i + j + 1}`);
        sl.addText(q.text, { x: x + 0.3, y: 1.55, w: w - 0.6, h: 0.75, fontSize: 15, bold: true, color: INK, valign: 'top', isTextBox: true, margin: 0 });
        sl.addChart(pres.charts.BAR, [{ name: 'Respostas', labels: names, values: keys.map((k) => q.counts[k] || 0) }],
          { ...chartBase(), x: x + 0.2, y: 2.35, w: w - 0.4, h: 4.3, barDir: keys.length > 6 ? 'bar' : 'col', catAxisOrientation: keys.length > 6 ? 'maxMin' : 'minMax',
            chartColors: [primary], showValue: true, dataLabelPosition: 'outEnd', showLegend: false, objectName: `Gráfico pergunta ${i + j + 1}` });
      });
    }
  }

  // ------------------------------------------------ 7. comentários
  if (stats.comments.length) {
    pres.addSection({ title: 'Comentários' });
    const cm = addContent('O que os clientes disseram', 'Comentários');
    const list = stats.comments.slice(0, 8);
    const cw = (W - 2 * M - 0.3) / 2;
    list.forEach((c, i) => {
      const x = M + (i % 2) * (cw + 0.3);
      const y = 1.4 + Math.floor(i / 2) * 1.35;
      card(cm, x, y, cw, 1.15, `Comentário ${i + 1}`);
      cm.addShape(pres.shapes.OVAL, { x: x + 0.25, y: y + 0.3, w: 0.5, h: 0.5, fill: { color: accent }, line: { color: accent }, objectName: `Aspas ${i + 1}` });
      cm.addText('“', { x: x + 0.25, y: y + 0.3, w: 0.5, h: 0.5, fontSize: 24, bold: true, align: 'center', valign: 'middle', color: isDark(accent) ? 'FFFFFF' : INK, isTextBox: true, margin: 0 });
      const text = c.comment.length > 140 ? c.comment.slice(0, 137) + '…' : c.comment;
      cm.addText([{ text, options: { fontSize: 14, color: INK, breakLine: true } },
        { text: `${c.branch} · ${new Date(c.submitted_at).toLocaleDateString('pt-BR')}`, options: { fontSize: 11, color: MUTED } }],
      { x: x + 0.95, y: y + 0.1, w: cw - 1.2, h: 0.95, valign: 'middle', isTextBox: true, margin: 0 });
    });
  }

  return pres.write({ outputType: 'nodebuffer' });
}

module.exports = { buildReport, imageSize };
