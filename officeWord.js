const fs = require('fs/promises');
const mammoth = require('mammoth');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, PageBreak
} = require('docx');
const { safePath, relativePath, withExtension, ensureParent, writeSidecar, readSidecar, fileInfo } = require('./officeCommon');

function normalizeSpec(input = {}) {
  return {
    title: String(input.title || 'Document'),
    author: String(input.author || 'Dify for VS Code'),
    subject: String(input.subject || ''),
    company: String(input.company || ''),
    font_family: String(input.font_family || 'Microsoft YaHei'),
    blocks: Array.isArray(input.blocks) ? input.blocks.map(normalizeBlock) : []
  };
}

function normalizeBlock(block = {}) {
  const type = ['heading','paragraph','bullets','numbered','table','quote','page_break'].includes(block.type) ? block.type : 'paragraph';
  return {
    type,
    text: String(block.text || ''),
    level: Math.max(1, Math.min(6, Number(block.level || 1))),
    items: Array.isArray(block.items) ? block.items.map(v => String(v)) : [],
    table: normalizeTable(block.table)
  };
}
function normalizeTable(table) {
  if (!table || typeof table !== 'object') return null;
  return {
    headers: Array.isArray(table.headers) ? table.headers.map(v => String(v)) : [],
    rows: Array.isArray(table.rows) ? table.rows.map(r => Array.isArray(r) ? r.map(v => String(v ?? '')) : []) : []
  };
}

function headingEnum(level) {
  return [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][level] || HeadingLevel.HEADING_1;
}
function thinBorders() {
  const edge = { style: BorderStyle.SINGLE, size: 1, color: 'D1D5DB' };
  return { top: edge, bottom: edge, left: edge, right: edge, insideHorizontal: edge, insideVertical: edge };
}
function paragraphText(text, font, options = {}) {
  return new Paragraph({
    alignment: options.align || AlignmentType.LEFT,
    spacing: { after: options.after ?? 140, line: options.line ?? 320 },
    children: [new TextRun({ text: String(text || ''), font, size: options.size || 22, bold: !!options.bold, italics: !!options.italics, color: options.color })]
  });
}

function tableBlock(table, font) {
  const rows = [];
  const all = [];
  if (table.headers.length) all.push({ values: table.headers, header: true });
  table.rows.forEach(values => all.push({ values, header: false }));
  for (const row of all) {
    rows.push(new TableRow({
      tableHeader: row.header,
      children: row.values.map(value => new TableCell({
        children: [new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: String(value ?? ''), font, size: 20, bold: row.header })] })],
        shading: row.header ? { fill: 'E8EEF9' } : undefined,
        margins: { top: 90, bottom: 90, left: 110, right: 110 }
      }))
    }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: thinBorders(), rows });
}

function buildChildren(spec) {
  const font = spec.font_family;
  const children = [];
  if (spec.title) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 },
      children: [new TextRun({ text: spec.title, font, size: 38, bold: true, color: '1F2937' })]
    }));
  }
  for (const block of spec.blocks) {
    if (block.type === 'heading') {
      children.push(new Paragraph({ heading: headingEnum(block.level), spacing: { before: 180, after: 120 }, children: [new TextRun({ text: block.text, font, bold: true })] }));
    } else if (block.type === 'paragraph') {
      children.push(paragraphText(block.text, font));
    } else if (block.type === 'bullets') {
      block.items.forEach(item => children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 80, line: 300 }, children: [new TextRun({ text: item, font, size: 22 })] })));
    } else if (block.type === 'numbered') {
      block.items.forEach((item, i) => children.push(paragraphText(`${i + 1}. ${item}`, font, { after: 80 })));
    } else if (block.type === 'quote') {
      children.push(paragraphText(`“${block.text}”`, font, { size: 24, italics: true, color: '475569', align: AlignmentType.CENTER, after: 220 }));
    } else if (block.type === 'table') {
      if (block.table && (block.table.headers.length || block.table.rows.length)) children.push(tableBlock(block.table, font));
    } else if (block.type === 'page_break') {
      children.push(new Paragraph({ children: [new PageBreak()] }));
    }
  }
  return children;
}

async function buildWord(specInput, outputFull) {
  const spec = normalizeSpec(specInput);
  if (!spec.blocks.length) throw new Error('word_create requires at least one content block.');
  const doc = new Document({
    creator: spec.author,
    title: spec.title,
    subject: spec.subject,
    description: spec.subject,
    sections: [{ properties: {}, children: buildChildren(spec) }]
  });
  await ensureParent(outputFull);
  await fs.writeFile(outputFull, await Packer.toBuffer(doc));
  await writeSidecar(outputFull, { format: 'dify-office-word-spec', version: 1, document: spec });
  return spec;
}

async function createDocument(args = {}) {
  const rel = withExtension(args.output_path, '.docx');
  const full = safePath(rel);
  const spec = await buildWord(args, full);
  return { success: true, ...(await fileInfo(full)), block_count: spec.blocks.length, sidecar: `${relativePath(full)}.dify.json` };
}

async function updateDocument(args = {}) {
  const full = safePath(withExtension(args.path, '.docx'));
  const sidecar = await readSidecar(full);
  if (!sidecar?.document) throw new Error('This DOCX has no Dify editable sidecar. Recreate it with word_create before using word_update.');
  const spec = normalizeSpec(sidecar.document);
  const action = String(args.action || 'replace_block');
  const index = Number(args.block_index || 0);
  if (action === 'set_title') spec.title = String(args.title || spec.title);
  else if (action === 'append_block') spec.blocks.push(normalizeBlock(args.block || {}));
  else if (action === 'delete_block') {
    if (index < 1 || index > spec.blocks.length) throw new Error(`block_index must be between 1 and ${spec.blocks.length}.`);
    spec.blocks.splice(index - 1, 1);
  } else if (action === 'replace_block') {
    if (index < 1 || index > spec.blocks.length) throw new Error(`block_index must be between 1 and ${spec.blocks.length}.`);
    spec.blocks[index - 1] = normalizeBlock(args.block || {});
  } else throw new Error(`Unsupported word_update action: ${action}`);
  if (!spec.blocks.length) throw new Error('A Word document must contain at least one block.');
  await buildWord(spec, full);
  return { success: true, ...(await fileInfo(full)), block_count: spec.blocks.length, action };
}

async function inspectDocument(args = {}) {
  const full = safePath(withExtension(args.path, '.docx'));
  await fs.access(full);
  const info = await fileInfo(full);
  const sidecar = await readSidecar(full);
  const maxChars = Math.max(500, Math.min(100000, Number(args.max_chars || 20000)));
  let text = '';
  let messages = [];
  try {
    const result = await mammoth.extractRawText({ path: full });
    text = String(result.value || '').trim();
    messages = (result.messages || []).map(m => ({ type: m.type, message: m.message })).slice(0, 20);
  } catch (error) {
    messages = [{ type: 'warning', message: `Raw text extraction failed: ${error.message}` }];
  }
  const response = { success: true, ...info, text: text.slice(0, maxChars), truncated: text.length > maxChars, messages };
  if (sidecar?.document) {
    const spec = normalizeSpec(sidecar.document);
    response.editable = true;
    response.title = spec.title;
    response.block_count = spec.blocks.length;
    response.blocks = spec.blocks.map((b, i) => ({ index: i + 1, type: b.type, text: b.text.slice(0, 160), item_count: b.items.length, table_rows: b.table?.rows?.length || 0 }));
    if (args.include_spec) response.spec = spec;
  } else response.editable = false;
  return response;
}

module.exports = { createDocument, updateDocument, inspectDocument };
