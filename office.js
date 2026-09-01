const { createPresentation, updatePresentation, inspectPresentation, reviewPresentation } = require('./officePptDesign');
const { createWorkbook, inspectWorkbook, writeRange, appendRows, formatRange } = require('./officeExcel');
const { createDocument, updateDocument, inspectDocument } = require('./officeWord');
const { renderOfficePdf } = require('./officeCommon');

function fn(name, description, parameters) { return { type: 'function', function: { name, description, parameters } }; }
function str(description) { return { type: 'string', ...(description ? { description } : {}) }; }
function bool(description) { return { type: 'boolean', ...(description ? { description } : {}) }; }
function int(minimum, maximum, description) { return { type: 'integer', minimum, maximum, ...(description ? { description } : {}) }; }
function num(description) { return { type: 'number', ...(description ? { description } : {}) }; }
function enumStr(values, description) { return { type: 'string', enum: values, ...(description ? { description } : {}) }; }
function obj(properties, required = [], additionalProperties = false) { return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties }; }
function arr(items, options = {}) { return { type: 'array', items, ...options }; }

const primitiveCell = { anyOf: [
  { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
  obj({ formula: str('Excel formula without leading =.'), result: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } }, ['formula']),
  obj({ hyperlink: str(), text: str() }, ['hyperlink']),
  obj({ date: str('ISO date/time string.') }, ['date'])
] };
const rowSchema = arr(primitiveCell, { maxItems: 200 });

const pptTable = obj({ headers: arr(str(), { maxItems: 20 }), rows: arr(arr(str(), { maxItems: 20 }), { maxItems: 50 }) });
const pptChart = obj({
  type: enumStr(['bar','column','line','pie','doughnut']),
  categories: arr(str(), { maxItems: 50 }),
  series: arr(obj({ name: str(), values: arr(num(), { maxItems: 50 }) }, ['name','values']), { maxItems: 12 })
}, ['type','categories','series']);
const pptCard = obj({ title: str(), text: str(), badge: str(), value: str() });
const pptMetric = obj({ value: str(), label: str(), detail: str(), trend: str() });
const pptStep = obj({ title: str(), text: str(), label: str(), value: str() });
const pptMatrixItem = obj({ title: str(), text: str(), badge: str() });
const pptSlide = obj({
  type: enumStr(['title','section','bullets','two_column','table','chart','quote','blank','hero_statement','hero_number','kpi_cards','three_cards','comparison','before_after','process','timeline','matrix','data_story','chart_insight','closing'], 'Choose a visual archetype, not just a content container. Prefer varied visual archetypes over repeated bullets.'),
  title: str('Short slide title; usually one message.'), subtitle: str(), eyebrow: str('Small category/section label.'), statement: str('Large core statement or slide thesis.'), takeaway: str('One concise insight or conclusion.'),
  metric_value: str('Large hero metric such as 73% or 4.6h.'), metric_label: str(), metric_detail: str(),
  bullets: arr(str(), { maxItems: 12 }), density: enumStr(['low','medium','high']),
  left_title: str(), left_text: str(), left_bullets: arr(str(), { maxItems: 12 }),
  right_title: str(), right_text: str(), right_bullets: arr(str(), { maxItems: 12 }),
  quote: str(), attribution: str(),
  cards: arr(pptCard, { maxItems: 6 }), metrics: arr(pptMetric, { maxItems: 6 }), steps: arr(pptStep, { maxItems: 8 }), matrix: arr(pptMatrixItem, { maxItems: 4 }),
  table: pptTable, chart: pptChart, notes: str()
}, ['type']);

const wordTable = obj({ headers: arr(str(), { maxItems: 30 }), rows: arr(arr(str(), { maxItems: 30 }), { maxItems: 200 }) });
const wordBlock = obj({ type: enumStr(['heading','paragraph','bullets','numbered','table','quote','page_break']), text: str(), level: int(1, 6), items: arr(str(), { maxItems: 100 }), table: wordTable }, ['type']);

const themes = ['corporate-light','corporate-dark','minimal','training','executive','tech','editorial','consulting'];
const OFFICE_TOOLS = [
  fn('ppt_create', 'Create a designed PowerPoint .pptx using the Presentation Design Engine. Use varied visual archetypes (hero, KPI cards, comparison, process, timeline, matrix, data story, chart insight) instead of defaulting to bullet slides. The engine controls typography, spacing, cards, hierarchy and layout, and saves an editable Dify sidecar.', obj({
    output_path: str('Workspace-relative .pptx output path.'), title: str(), subject: str(), author: str(), company: str(),
    theme: enumStr(themes, 'executive/editorial/consulting are light professional styles; tech/corporate-dark are dark; training is friendly; minimal is restrained.'),
    design_mode: enumStr(['safe','polished','bold'], 'polished is the recommended default. bold favors stronger visual hierarchy.'),
    font_family: str('Presentation font family.'), slides: arr(pptSlide, { minItems: 1, maxItems: 100 })
  }, ['output_path','slides'])),
  fn('ppt_update', 'Update a PowerPoint generated by ppt_create. Replace/append/delete a slide, change title, or switch the whole theme. Rebuilds from the saved declarative sidecar and returns a new design score.', obj({
    path: str('Workspace-relative .pptx path.'), action: enumStr(['replace_slide','append_slide','delete_slide','set_title','set_theme']), slide_index: int(1, 100), slide: pptSlide, title: str(), theme: enumStr(themes)
  }, ['path','action'])),
  fn('ppt_inspect', 'Inspect a PowerPoint generated by the engine. Returns slide archetypes, structured metadata and a design review score; include_spec=true returns the editable presentation spec.', obj({ path: str(), include_spec: bool() }, ['path'])),
  fn('ppt_design_review', 'Score a Dify-generated presentation for information density, layout variety, visual archetype usage, repetitive slides, oversized tables/charts and other design risks. Use after ppt_create; if grade is revise/poor, improve weak slides with ppt_update and review again.', obj({ path: str() }, ['path'])),

  fn('excel_create', 'Create a styled Excel .xlsx workbook with one or more sheets, headers, rows, freeze panes, filters, widths, number formats and formulas. Best for reports, manifests, summaries and tabular office automation.', obj({
    output_path: str('Workspace-relative .xlsx output path.'), title: str(), subject: str(), author: str(), company: str(), style: enumStr(['corporate','dark','training']),
    sheets: arr(obj({ name: str(), headers: arr(str(), { maxItems: 200 }), rows: arr(rowSchema, { maxItems: 10000 }), freeze_header: bool(), auto_filter: bool(), style: enumStr(['corporate','dark','training']), column_widths: arr(num(), { maxItems: 200 }), number_formats: obj({}, [], true) }, ['name']), { minItems: 1, maxItems: 50 })
  }, ['output_path','sheets'])),
  fn('excel_inspect', 'Read workbook metadata and a bounded sample from an existing .xlsx file, including formulas/results where available.', obj({ path: str(), sheet: str(), max_rows: int(1, 200), max_cols: int(1, 100) }, ['path'])),
  fn('excel_write_range', 'Write a 2D array of values/formulas into an existing .xlsx workbook starting at an A1 cell. Can create the target sheet when requested.', obj({ path: str(), sheet: str(), start_cell: str('A1 address such as B3.'), values: arr(rowSchema, { minItems: 1, maxItems: 5000 }), create_sheet: bool() }, ['path','values'])),
  fn('excel_append_rows', 'Append rows to an existing Excel worksheet and save the workbook.', obj({ path: str(), sheet: str(), rows: arr(rowSchema, { minItems: 1, maxItems: 5000 }) }, ['path','rows'])),
  fn('excel_format_range', 'Apply common formatting to a rectangular A1 range in an existing Excel worksheet.', obj({ path: str(), sheet: str(), range: str('A1 range such as A1:F20.'), style: obj({ bold: bool(), italic: bool(), font_size: num(), font_color: str('Hex RGB.'), fill_color: str('Hex RGB.'), number_format: str(), horizontal: enumStr(['left','center','right','fill','justify','centerContinuous','distributed']), vertical: enumStr(['top','middle','bottom','distributed','justify']), wrap_text: bool(), border: bool() }) }, ['path','range','style'])),

  fn('word_create', 'Create a professional Word .docx document from declarative content blocks such as headings, paragraphs, bullets, tables and quotes. An editable Dify sidecar is saved for reliable later updates.', obj({ output_path: str('Workspace-relative .docx output path.'), title: str(), author: str(), subject: str(), company: str(), font_family: str(), blocks: arr(wordBlock, { minItems: 1, maxItems: 500 }) }, ['output_path','blocks'])),
  fn('word_update', 'Update a Word document previously generated by word_create by rebuilding it from its saved declarative sidecar.', obj({ path: str(), action: enumStr(['replace_block','append_block','delete_block','set_title']), block_index: int(1, 500), block: wordBlock, title: str() }, ['path','action'])),
  fn('word_inspect', 'Extract readable text from an existing .docx and, when created by word_create, return structured editable block metadata/spec.', obj({ path: str(), max_chars: int(500, 100000), include_spec: bool() }, ['path'])),
  fn('office_render_pdf', 'Render a workspace .pptx, .docx or .xlsx file to PDF for preview/review. Uses local LibreOffice when available, with Microsoft Office COM fallback on Windows.', obj({ path: str(), output_dir: str('Workspace-relative directory for rendered PDFs; default office-preview.') }, ['path']))
];

const OFFICE_MUTATING = new Set(['ppt_create','ppt_update','excel_create','excel_write_range','excel_append_rows','excel_format_range','word_create','word_update','office_render_pdf']);
const OFFICE_NAMES = new Set(OFFICE_TOOLS.map(t => t.function.name));
function isOfficeTool(name) { return OFFICE_NAMES.has(name); }
function isOfficeMutating(name) { return OFFICE_MUTATING.has(name); }
async function executeOfficeTool(name, args = {}) {
  switch (name) {
    case 'ppt_create': return createPresentation(args);
    case 'ppt_update': return updatePresentation(args);
    case 'ppt_inspect': return inspectPresentation(args);
    case 'ppt_design_review': return reviewPresentation(args);
    case 'excel_create': return createWorkbook(args);
    case 'excel_inspect': return inspectWorkbook(args);
    case 'excel_write_range': return writeRange(args);
    case 'excel_append_rows': return appendRows(args);
    case 'excel_format_range': return formatRange(args);
    case 'word_create': return createDocument(args);
    case 'word_update': return updateDocument(args);
    case 'word_inspect': return inspectDocument(args);
    case 'office_render_pdf': return renderOfficePdf(args.path, args.output_dir);
    default: return { success: false, error: `Unknown Office tool: ${name}` };
  }
}
module.exports = { OFFICE_TOOLS, OFFICE_MUTATING, isOfficeTool, isOfficeMutating, executeOfficeTool };
