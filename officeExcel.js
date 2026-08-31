const ExcelJS = require('exceljs');
const fs = require('fs/promises');
const path = require('path');
const { safePath, withExtension, ensureParent, fileInfo } = require('./officeCommon');

function normalizeCellValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.formula === 'string') return { formula: value.formula, result: value.result ?? null };
    if (typeof value.hyperlink === 'string') return { text: String(value.text || value.hyperlink), hyperlink: value.hyperlink };
    if (typeof value.date === 'string') {
      const date = new Date(value.date);
      return Number.isNaN(date.getTime()) ? String(value.date) : date;
    }
  }
  if (value === undefined) return null;
  return value;
}

function serializableCellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value.formula) return { formula: value.formula, result: value.result ?? null };
    if (Array.isArray(value.richText)) return value.richText.map(x => x.text || '').join('');
    if (value.text && value.hyperlink) return { text: value.text, hyperlink: value.hyperlink };
    if (value.result !== undefined) return value.result;
    return JSON.parse(JSON.stringify(value));
  }
  return value;
}

function styleHeader(row, theme = 'corporate') {
  const fill = theme === 'dark' ? '1F2937' : theme === 'training' ? '0F766E' : '2563EB';
  row.height = 24;
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = thinBorder();
  });
}
function thinBorder() {
  const edge = { style: 'thin', color: { argb: 'FFD1D5DB' } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function autoWidth(ws, maxWidth = 40) {
  ws.columns.forEach(column => {
    let width = 10;
    column.eachCell({ includeEmpty: false }, cell => {
      const value = serializableCellValue(cell.value);
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
      width = Math.max(width, Math.min(maxWidth, text.length + 2));
    });
    column.width = Math.min(maxWidth, width);
  });
}

function normalizeSheetName(name, index) {
  const value = String(name || `Sheet${index + 1}`).replace(/[\\/*?:[\]]/g, '_').slice(0, 31);
  return value || `Sheet${index + 1}`;
}

async function createWorkbook(args = {}) {
  const rel = withExtension(args.output_path, '.xlsx');
  const full = safePath(rel);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = String(args.author || 'Dify for VS Code');
  workbook.company = String(args.company || '');
  workbook.subject = String(args.subject || '');
  workbook.title = String(args.title || path.basename(rel, '.xlsx'));
  workbook.created = new Date();
  workbook.modified = new Date();
  const sheets = Array.isArray(args.sheets) ? args.sheets : [];
  if (!sheets.length) throw new Error('excel_create requires at least one sheet.');
  const summaries = [];

  sheets.forEach((sheet, index) => {
    const name = normalizeSheetName(sheet?.name, index);
    const ws = workbook.addWorksheet(name);
    const headers = Array.isArray(sheet?.headers) ? sheet.headers.map(v => String(v)) : [];
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    if (headers.length) {
      ws.addRow(headers);
      styleHeader(ws.getRow(1), String(sheet?.style || args.style || 'corporate'));
    }
    rows.forEach(row => {
      const values = Array.isArray(row) ? row.map(normalizeCellValue) : [normalizeCellValue(row)];
      const added = ws.addRow(values);
      added.eachCell(cell => {
        cell.alignment = { vertical: 'top', wrapText: true };
        cell.border = thinBorder();
      });
    });
    if (sheet?.freeze_header && headers.length) ws.views = [{ state: 'frozen', ySplit: 1 }];
    if (sheet?.auto_filter && headers.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    if (Array.isArray(sheet?.column_widths)) {
      sheet.column_widths.forEach((width, i) => { if (Number(width) > 0) ws.getColumn(i + 1).width = Math.min(100, Number(width)); });
    } else autoWidth(ws);
    if (sheet?.number_formats && typeof sheet.number_formats === 'object') {
      for (const [columnName, format] of Object.entries(sheet.number_formats)) {
        const column = ws.getColumn(columnName);
        column.eachCell({ includeEmpty: false }, (cell, rowNumber) => { if (!headers.length || rowNumber > 1) cell.numFmt = String(format); });
      }
    }
    summaries.push({ name, rows: ws.rowCount, columns: ws.columnCount });
  });
  await ensureParent(full);
  await workbook.xlsx.writeFile(full);
  return { success: true, ...(await fileInfo(full)), sheets: summaries };
}

async function loadWorkbook(relative) {
  const full = safePath(withExtension(relative, '.xlsx'));
  await fs.access(full);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(full);
  return { full, workbook };
}

function resolveWorksheet(workbook, name) {
  if (name) {
    const byName = workbook.getWorksheet(String(name));
    if (!byName) throw new Error(`Worksheet not found: ${name}`);
    return byName;
  }
  const first = workbook.worksheets[0];
  if (!first) throw new Error('Workbook has no worksheets.');
  return first;
}

async function inspectWorkbook(args = {}) {
  const { full, workbook } = await loadWorkbook(args.path);
  const maxRows = Math.max(1, Math.min(200, Number(args.max_rows || 30)));
  const maxCols = Math.max(1, Math.min(100, Number(args.max_cols || 20)));
  const sheets = workbook.worksheets.map(ws => ({ name: ws.name, rows: ws.rowCount, columns: ws.columnCount }));
  const ws = resolveWorksheet(workbook, args.sheet);
  const data = [];
  for (let r = 1; r <= Math.min(maxRows, ws.rowCount); r += 1) {
    const row = [];
    for (let c = 1; c <= Math.min(maxCols, ws.columnCount); c += 1) row.push(serializableCellValue(ws.getCell(r, c).value));
    data.push(row);
  }
  return { success: true, ...(await fileInfo(full)), sheets, selected_sheet: ws.name, sample: data, truncated: ws.rowCount > maxRows || ws.columnCount > maxCols };
}

function columnNumber(label) {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function parseCell(address) {
  const m = /^([A-Za-z]+)([1-9][0-9]*)$/.exec(String(address || '').trim());
  if (!m) throw new Error(`Invalid A1 cell address: ${address}`);
  return { row: Number(m[2]), col: columnNumber(m[1]) };
}
function parseRange(range) {
  const parts = String(range || '').split(':');
  const start = parseCell(parts[0]);
  const end = parts[1] ? parseCell(parts[1]) : start;
  if (end.row < start.row || end.col < start.col) throw new Error(`Invalid range: ${range}`);
  return { start, end };
}

async function writeRange(args = {}) {
  const { full, workbook } = await loadWorkbook(args.path);
  let ws = workbook.getWorksheet(String(args.sheet || ''));
  if (!ws && args.create_sheet) ws = workbook.addWorksheet(normalizeSheetName(args.sheet || 'Sheet', workbook.worksheets.length));
  if (!ws) ws = resolveWorksheet(workbook, args.sheet);
  const start = parseCell(args.start_cell || 'A1');
  const values = Array.isArray(args.values) ? args.values : [];
  if (!values.length) throw new Error('excel_write_range requires a non-empty 2D values array.');
  values.forEach((row, r) => {
    if (!Array.isArray(row)) throw new Error('excel_write_range values must be a 2D array.');
    row.forEach((value, c) => { ws.getCell(start.row + r, start.col + c).value = normalizeCellValue(value); });
  });
  workbook.modified = new Date();
  await workbook.xlsx.writeFile(full);
  return { success: true, ...(await fileInfo(full)), sheet: ws.name, start_cell: args.start_cell || 'A1', rows_written: values.length, columns_written: Math.max(...values.map(r => r.length)) };
}

async function appendRows(args = {}) {
  const { full, workbook } = await loadWorkbook(args.path);
  const ws = resolveWorksheet(workbook, args.sheet);
  const rows = Array.isArray(args.rows) ? args.rows : [];
  if (!rows.length) throw new Error('excel_append_rows requires rows.');
  rows.forEach(row => {
    if (!Array.isArray(row)) throw new Error('excel_append_rows rows must be arrays.');
    ws.addRow(row.map(normalizeCellValue));
  });
  autoWidth(ws);
  workbook.modified = new Date();
  await workbook.xlsx.writeFile(full);
  return { success: true, ...(await fileInfo(full)), sheet: ws.name, appended_rows: rows.length, total_rows: ws.rowCount };
}

async function formatRange(args = {}) {
  const { full, workbook } = await loadWorkbook(args.path);
  const ws = resolveWorksheet(workbook, args.sheet);
  const { start, end } = parseRange(args.range);
  const style = args.style && typeof args.style === 'object' ? args.style : {};
  let count = 0;
  for (let r = start.row; r <= end.row; r += 1) {
    for (let c = start.col; c <= end.col; c += 1) {
      const cell = ws.getCell(r, c);
      cell.font = {
        ...(cell.font || {}),
        ...(style.bold !== undefined ? { bold: !!style.bold } : {}),
        ...(style.italic !== undefined ? { italic: !!style.italic } : {}),
        ...(Number(style.font_size) > 0 ? { size: Number(style.font_size) } : {}),
        ...(style.font_color ? { color: { argb: `FF${cleanColor(style.font_color)}` } } : {})
      };
      if (style.fill_color) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${cleanColor(style.fill_color)}` } };
      if (style.number_format) cell.numFmt = String(style.number_format);
      cell.alignment = {
        ...(cell.alignment || {}),
        ...(style.horizontal ? { horizontal: String(style.horizontal) } : {}),
        ...(style.vertical ? { vertical: String(style.vertical) } : {}),
        ...(style.wrap_text !== undefined ? { wrapText: !!style.wrap_text } : {})
      };
      if (style.border) cell.border = thinBorder();
      count += 1;
    }
  }
  workbook.modified = new Date();
  await workbook.xlsx.writeFile(full);
  return { success: true, ...(await fileInfo(full)), sheet: ws.name, range: args.range, cells_formatted: count };
}
function cleanColor(value) { return String(value).replace(/^#/, '').replace(/[^0-9A-Fa-f]/g, '').padEnd(6, '0').slice(0, 6).toUpperCase(); }

module.exports = { createWorkbook, inspectWorkbook, writeRange, appendRows, formatRange };
