const PptxGenJS = require('pptxgenjs');
const fs = require('fs/promises');
const { safePath, relativePath, withExtension, ensureParent, writeSidecar, readSidecar, fileInfo } = require('./officeCommon');

const THEMES = {
  'corporate-light': { bg: 'F7F9FC', text: '1F2937', accent: '2563EB', muted: '64748B', card: 'FFFFFF', line: 'D9E2F0' },
  'corporate-dark': { bg: '0F172A', text: 'F8FAFC', accent: '38BDF8', muted: '94A3B8', card: '1E293B', line: '334155' },
  minimal: { bg: 'FFFFFF', text: '111827', accent: '111827', muted: '6B7280', card: 'F3F4F6', line: 'E5E7EB' },
  training: { bg: 'F8FAFC', text: '16302B', accent: '0F766E', muted: '5F6F6B', card: 'FFFFFF', line: 'D6E4E1' }
};

function normalizeSpec(input = {}) {
  return {
    title: String(input.title || 'Presentation'),
    subject: String(input.subject || ''),
    author: String(input.author || 'Dify for VS Code'),
    company: String(input.company || ''),
    theme: THEMES[input.theme] ? input.theme : 'corporate-light',
    font_family: String(input.font_family || 'Microsoft YaHei'),
    slides: Array.isArray(input.slides) ? input.slides.map(normalizeSlide) : []
  };
}

function normalizeSlide(slide = {}) {
  const type = ['title','section','bullets','two_column','table','chart','quote','blank'].includes(slide.type) ? slide.type : 'bullets';
  return {
    type,
    title: String(slide.title || ''),
    subtitle: String(slide.subtitle || ''),
    bullets: arrStrings(slide.bullets),
    left_title: String(slide.left_title || ''),
    left_bullets: arrStrings(slide.left_bullets),
    right_title: String(slide.right_title || ''),
    right_bullets: arrStrings(slide.right_bullets),
    quote: String(slide.quote || ''),
    attribution: String(slide.attribution || ''),
    table: normalizeTable(slide.table),
    chart: normalizeChart(slide.chart),
    notes: String(slide.notes || '')
  };
}
function arrStrings(value) { return Array.isArray(value) ? value.map(v => String(v)) : []; }
function normalizeTable(table) {
  if (!table || typeof table !== 'object') return null;
  return {
    headers: arrStrings(table.headers),
    rows: Array.isArray(table.rows) ? table.rows.map(r => Array.isArray(r) ? r.map(formatValue) : []) : []
  };
}
function normalizeChart(chart) {
  if (!chart || typeof chart !== 'object') return null;
  return {
    type: ['bar','column','line','pie','doughnut'].includes(chart.type) ? chart.type : 'column',
    categories: arrStrings(chart.categories),
    series: Array.isArray(chart.series) ? chart.series.map(s => ({
      name: String(s?.name || 'Series'),
      values: Array.isArray(s?.values) ? s.values.map(v => Number(v) || 0) : []
    })) : []
  };
}
function formatValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function addTitle(pptx, slide, text, theme, font, options = {}) {
  slide.addText(text || '', {
    x: options.x ?? 0.72, y: options.y ?? 0.45, w: options.w ?? 11.9, h: options.h ?? 0.72,
    fontFace: font, fontSize: options.fontSize ?? 26, bold: true, color: theme.text,
    margin: 0, breakLine: false, valign: 'mid', fit: 'shrink'
  });
  slide.addShape(pptx.ShapeType.line, { x: 0.72, y: (options.y ?? 0.45) + 0.83, w: 1.25, h: 0, line: { color: theme.accent, width: 3 } });
}

function addBullets(slide, bullets, theme, font, x, y, w, h) {
  const items = bullets.slice(0, 12);
  const size = items.length > 8 ? 16 : items.length > 5 ? 18 : 20;
  const lineH = Math.max(0.42, Math.min(0.72, h / Math.max(1, items.length)));
  items.forEach((item, i) => {
    slide.addText(`• ${item}`, {
      x, y: y + i * lineH, w, h: lineH * 0.92, fontFace: font, fontSize: size,
      color: theme.text, margin: 0, breakLine: false, valign: 'mid', fit: 'shrink'
    });
  });
}

function addFooter(slide, index, theme, font) {
  slide.addText(String(index), { x: 12.45, y: 7.08, w: 0.45, h: 0.2, fontFace: font, fontSize: 9, color: theme.muted, align: 'right', margin: 0 });
}

function renderSlide(pptx, slide, spec, index, warnings) {
  const theme = THEMES[spec.theme];
  const font = spec.font_family;
  slide.background = { color: theme.bg };
  const s = spec.slides[index - 1];
  switch (s.type) {
    case 'title': {
      slide.addText(s.title || spec.title, { x: 0.9, y: 2.15, w: 11.55, h: 1.15, fontFace: font, fontSize: 34, bold: true, color: theme.text, margin: 0, align: 'center', valign: 'mid', fit: 'shrink' });
      if (s.subtitle) slide.addText(s.subtitle, { x: 1.4, y: 3.5, w: 10.55, h: 0.55, fontFace: font, fontSize: 18, color: theme.muted, margin: 0, align: 'center', fit: 'shrink' });
      slide.addShape(pptx.ShapeType.line, { x: 5.5, y: 4.35, w: 2.3, h: 0, line: { color: theme.accent, width: 4 } });
      break;
    }
    case 'section': {
      slide.addText(s.title, { x: 0.95, y: 2.45, w: 11.3, h: 0.95, fontFace: font, fontSize: 32, bold: true, color: theme.text, margin: 0, align: 'center', fit: 'shrink' });
      if (s.subtitle) slide.addText(s.subtitle, { x: 1.5, y: 3.55, w: 10.2, h: 0.5, fontFace: font, fontSize: 17, color: theme.muted, margin: 0, align: 'center', fit: 'shrink' });
      break;
    }
    case 'two_column': {
      addTitle(pptx, slide, s.title, theme, font);
      slide.addShape(pptx.ShapeType.roundRect, { x: 0.75, y: 1.55, w: 5.8, h: 4.9, fill: { color: theme.card }, line: { color: theme.line, width: 1 }, radius: 0.08 });
      slide.addShape(pptx.ShapeType.roundRect, { x: 6.78, y: 1.55, w: 5.8, h: 4.9, fill: { color: theme.card }, line: { color: theme.line, width: 1 }, radius: 0.08 });
      if (s.left_title) slide.addText(s.left_title, { x: 1.05, y: 1.88, w: 5.2, h: 0.45, fontFace: font, fontSize: 19, bold: true, color: theme.accent, margin: 0, fit: 'shrink' });
      if (s.right_title) slide.addText(s.right_title, { x: 7.08, y: 1.88, w: 5.2, h: 0.45, fontFace: font, fontSize: 19, bold: true, color: theme.accent, margin: 0, fit: 'shrink' });
      addBullets(slide, s.left_bullets, theme, font, 1.05, 2.5, 5.15, 3.55);
      addBullets(slide, s.right_bullets, theme, font, 7.08, 2.5, 5.15, 3.55);
      break;
    }
    case 'table': {
      addTitle(pptx, slide, s.title, theme, font);
      const table = s.table || { headers: [], rows: [] };
      const rows = [];
      if (table.headers.length) rows.push(table.headers);
      rows.push(...table.rows);
      if (!rows.length) warnings.push(`Slide ${index}: table slide has no rows.`);
      else slide.addTable(rows.slice(0, 22), {
        x: 0.75, y: 1.55, w: 11.85, h: 5.35, border: { type: 'solid', color: theme.line, pt: 1 },
        fill: theme.card, color: theme.text, fontFace: font, fontSize: rows.length > 14 ? 11 : 13,
        margin: 0.08, valign: 'mid', autoFit: false, bold: false
      });
      break;
    }
    case 'chart': {
      addTitle(pptx, slide, s.title, theme, font);
      const chart = s.chart;
      if (!chart || !chart.categories.length || !chart.series.length) {
        warnings.push(`Slide ${index}: chart slide has incomplete chart data.`);
        addBullets(slide, ['Chart data is missing or incomplete.'], theme, font, 1.0, 2.2, 11, 1.2);
      } else {
        const data = chart.series.map(series => ({ name: series.name, labels: chart.categories, values: series.values }));
        let type = pptx.ChartType.bar;
        const options = { x: 0.9, y: 1.55, w: 11.45, h: 5.25, showLegend: chart.series.length > 1, showTitle: false, showValue: chart.type === 'pie' || chart.type === 'doughnut', chartColors: [theme.accent, '0EA5E9', '14B8A6', 'F59E0B', '8B5CF6'], showCatName: false, showPercent: chart.type === 'pie' || chart.type === 'doughnut', legendPos: 'b', catAxisLabelFontFace: font, valAxisLabelFontFace: font };
        if (chart.type === 'line') type = pptx.ChartType.line;
        else if (chart.type === 'pie') type = pptx.ChartType.pie;
        else if (chart.type === 'doughnut') type = pptx.ChartType.doughnut;
        else options.barDir = chart.type === 'bar' ? 'bar' : 'col';
        slide.addChart(type, data, options);
      }
      break;
    }
    case 'quote': {
      if (s.title) addTitle(pptx, slide, s.title, theme, font);
      slide.addText(`“${s.quote}”`, { x: 1.1, y: s.title ? 2.1 : 2.35, w: 11.1, h: 2.0, fontFace: font, fontSize: 28, italic: true, color: theme.text, align: 'center', valign: 'mid', margin: 0.08, fit: 'shrink' });
      if (s.attribution) slide.addText(`— ${s.attribution}`, { x: 2.0, y: 4.65, w: 9.3, h: 0.45, fontFace: font, fontSize: 16, color: theme.muted, align: 'right', margin: 0, fit: 'shrink' });
      break;
    }
    case 'blank': {
      if (s.title) addTitle(pptx, slide, s.title, theme, font);
      break;
    }
    case 'bullets':
    default: {
      addTitle(pptx, slide, s.title, theme, font);
      addBullets(slide, s.bullets, theme, font, 0.95, 1.65, 11.45, 4.95);
      if (s.bullets.length > 10) warnings.push(`Slide ${index}: ${s.bullets.length} bullets may be visually dense.`);
      break;
    }
  }
  addFooter(slide, index, theme, font);
  if (s.notes) {
    try { slide.addNotes(s.notes); } catch {}
  }
}

async function buildPpt(specInput, outputFull) {
  const spec = normalizeSpec(specInput);
  if (!spec.slides.length) throw new Error('ppt_create requires at least one slide.');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = spec.author;
  pptx.company = spec.company;
  pptx.subject = spec.subject;
  pptx.title = spec.title;
  pptx.lang = 'zh-CN';
  pptx.theme = { headFontFace: spec.font_family, bodyFontFace: spec.font_family, lang: 'zh-CN' };
  const warnings = [];
  spec.slides.forEach((_, i) => renderSlide(pptx, pptx.addSlide(), spec, i + 1, warnings));
  await ensureParent(outputFull);
  await pptx.writeFile({ fileName: outputFull });
  await writeSidecar(outputFull, { format: 'dify-office-ppt-spec', version: 1, presentation: spec });
  return { spec, warnings };
}

async function createPresentation(args = {}) {
  const rel = withExtension(args.output_path, '.pptx');
  const full = safePath(rel);
  const { spec, warnings } = await buildPpt(args, full);
  return { success: true, ...(await fileInfo(full)), slide_count: spec.slides.length, theme: spec.theme, sidecar: `${relativePath(full)}.dify.json`, warnings };
}

async function updatePresentation(args = {}) {
  const full = safePath(withExtension(args.path, '.pptx'));
  const sidecar = await readSidecar(full);
  if (!sidecar?.presentation) throw new Error('This presentation has no Dify editable sidecar. Recreate it with ppt_create before using ppt_update.');
  const spec = normalizeSpec(sidecar.presentation);
  const action = String(args.action || 'replace_slide');
  const index = Number(args.slide_index || 0);
  if (action === 'set_title') spec.title = String(args.title || spec.title);
  else if (action === 'append_slide') spec.slides.push(normalizeSlide(args.slide || {}));
  else if (action === 'delete_slide') {
    if (index < 1 || index > spec.slides.length) throw new Error(`slide_index must be between 1 and ${spec.slides.length}.`);
    spec.slides.splice(index - 1, 1);
  } else if (action === 'replace_slide') {
    if (index < 1 || index > spec.slides.length) throw new Error(`slide_index must be between 1 and ${spec.slides.length}.`);
    spec.slides[index - 1] = normalizeSlide(args.slide || {});
  } else throw new Error(`Unsupported ppt_update action: ${action}`);
  if (!spec.slides.length) throw new Error('A presentation must contain at least one slide.');
  const { warnings } = await buildPpt(spec, full);
  return { success: true, ...(await fileInfo(full)), slide_count: spec.slides.length, action, warnings };
}

async function inspectPresentation(args = {}) {
  const full = safePath(withExtension(args.path, '.pptx'));
  await fs.access(full);
  const sidecar = await readSidecar(full);
  const info = await fileInfo(full);
  if (!sidecar?.presentation) return { success: true, ...info, editable: false, message: 'PPTX exists but was not generated with the Dify Office sidecar, so structured slide inspection/update is unavailable.' };
  const spec = normalizeSpec(sidecar.presentation);
  return {
    success: true, ...info, editable: true, title: spec.title, theme: spec.theme, slide_count: spec.slides.length,
    slides: spec.slides.map((s, i) => ({ index: i + 1, type: s.type, title: s.title, bullet_count: s.bullets.length + s.left_bullets.length + s.right_bullets.length, table_rows: s.table?.rows?.length || 0, chart_series: s.chart?.series?.length || 0 })),
    ...(args.include_spec ? { spec } : {})
  };
}

module.exports = { createPresentation, updatePresentation, inspectPresentation, normalizeSlide };
