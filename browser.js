const vscode = require('vscode');
const path = require('path');

const BROWSER_TOOLS = [
  fn('browser_open', 'Open or navigate the managed browser page to a URL.', obj({ url: str(), wait_until: enumStr(['load','domcontentloaded','networkidle','commit']) }, ['url'])),
  fn('browser_snapshot', 'Return page title/url/text plus interactive elements with stable data-dify-ref selectors.', obj({ max_chars: int(1000,120000), max_elements: int(1,300) })),
  fn('browser_click', 'Click an element using a CSS/text selector or a selector from browser_snapshot.', obj({ selector: str(), button: enumStr(['left','right','middle']), click_count: int(1,3) }, ['selector'])),
  fn('browser_fill', 'Fill an input, textarea, or contenteditable element.', obj({ selector: str(), text: str() }, ['selector','text'])),
  fn('browser_press', 'Press a keyboard key, optionally focused on a selector.', obj({ key: str('Playwright key such as Enter, Escape, Control+A.'), selector: str() }, ['key'])),
  fn('browser_select', 'Select one or more values in a <select>.', obj({ selector: str(), values: { type:'array', items:{type:'string'}, minItems:1, maxItems:20 } }, ['selector','values'])),
  fn('browser_wait', 'Wait for milliseconds or until a selector appears.', obj({ ms: int(0,60000), selector: str(), state: enumStr(['attached','detached','visible','hidden']) })),
  fn('browser_evaluate', 'Evaluate JavaScript in the current page and return the JSON-serializable result.', obj({ script: str('JavaScript expression or function body.') }, ['script'])),
  fn('browser_screenshot', 'Save a screenshot inside the current workspace.', obj({ path: str('Workspace-relative .png path.'), full_page: bool() }, ['path'])),
  fn('browser_close', 'Close the managed browser session.', obj({}))
];

const BROWSER_MUTATING = new Set(['browser_open','browser_click','browser_fill','browser_press','browser_select','browser_evaluate']);

let browser;
let context;
let page;
let lastConfigKey = '';

function fn(name, description, parameters){ return {type:'function', function:{name,description,parameters}}; }
function str(description){ return {type:'string', ...(description?{description}:{})}; }
function int(minimum,maximum){ return {type:'integer',minimum,maximum}; }
function bool(){ return {type:'boolean'}; }
function enumStr(values){ return {type:'string', enum:values}; }
function obj(properties,required=[]){ return {type:'object',properties,...(required.length?{required}:{}),additionalProperties:false}; }

function workspaceRoot(){
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if(!folder || folder.uri.scheme !== 'file') throw new Error('Open a local file workspace first.');
  return folder.uri.fsPath;
}
function safePath(relative){
  const root = path.resolve(workspaceRoot());
  const target = path.resolve(root, relative || '.');
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  if(t !== r && !t.startsWith(r + path.sep)) throw new Error(`Path escapes workspace: ${relative}`);
  return target;
}

async function ensurePage(config){
  const cfg = {
    channel: String(config?.get?.('browserChannel','auto') || 'auto'),
    executablePath: String(config?.get?.('browserExecutablePath','') || ''),
    headless: !!config?.get?.('browserHeadless', false),
    ignoreHTTPSErrors: !!config?.get?.('browserIgnoreHTTPSErrors', false)
  };
  const key = JSON.stringify(cfg);
  if(page && lastConfigKey === key && !page.isClosed()) return page;
  await closeBrowser();
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch (error) {
    throw new Error(`Browser automation dependency is unavailable: ${error.message}`);
  }
  const attempts = [];
  if(cfg.executablePath) attempts.push({ executablePath:cfg.executablePath });
  if(cfg.channel !== 'auto') attempts.push({ channel:cfg.channel });
  if(cfg.channel === 'auto') {
    if(process.platform === 'win32') attempts.push({channel:'msedge'},{channel:'chrome'});
    else if(process.platform === 'darwin') attempts.push({channel:'chrome'},{channel:'msedge'});
    else attempts.push({channel:'chrome'},{channel:'msedge'});
    attempts.push({});
  }
  let lastError;
  for(const extra of attempts){
    try {
      browser = await chromium.launch({ headless:cfg.headless, ...extra });
      context = await browser.newContext({ ignoreHTTPSErrors:cfg.ignoreHTTPSErrors, viewport:{width:1440,height:1000} });
      page = await context.newPage();
      lastConfigKey = key;
      return page;
    } catch (error) {
      lastError = error;
      if(browser) await browser.close().catch(()=>{});
      browser = context = page = undefined;
    }
  }
  throw new Error(`Could not launch Chrome/Edge for browser automation. Install Chrome/Edge or configure difyForVscode.browserExecutablePath. ${lastError?.message || ''}`.trim());
}

async function executeBrowserTool(name,args={},config){
  if(name === 'browser_close') return closeBrowser();
  const p = await ensurePage(config);
  switch(name){
    case 'browser_open': {
      const url = new URL(String(args.url || ''));
      if(!['http:','https:'].includes(url.protocol)) throw new Error('Only http/https URLs are supported.');
      const waitUntil = ['load','domcontentloaded','networkidle','commit'].includes(args.wait_until) ? args.wait_until : 'domcontentloaded';
      const response = await p.goto(url.toString(), { waitUntil, timeout:60000 });
      return {success:true,url:p.url(),title:await p.title(),status:response?.status() ?? null};
    }
    case 'browser_snapshot': return snapshot(p,args);
    case 'browser_click': {
      const locator = p.locator(String(args.selector)).first();
      await locator.click({button:args.button || 'left', clickCount:Number(args.click_count || 1), timeout:30000});
      return {success:true,url:p.url(),title:await p.title()};
    }
    case 'browser_fill': {
      await p.locator(String(args.selector)).first().fill(String(args.text ?? ''), {timeout:30000});
      return {success:true};
    }
    case 'browser_press': {
      if(args.selector) await p.locator(String(args.selector)).first().press(String(args.key), {timeout:30000});
      else await p.keyboard.press(String(args.key));
      return {success:true};
    }
    case 'browser_select': {
      const selected = await p.locator(String(args.selector)).first().selectOption((args.values || []).map(String), {timeout:30000});
      return {success:true,selected};
    }
    case 'browser_wait': {
      if(args.selector) await p.locator(String(args.selector)).first().waitFor({state:args.state || 'visible',timeout:Number(args.ms || 30000)});
      else await p.waitForTimeout(Number(args.ms || 1000));
      return {success:true};
    }
    case 'browser_evaluate': {
      const script = String(args.script || '');
      if(!script) throw new Error('script is required.');
      const result = await p.evaluate(code => {
        try { return (0,eval)(code); }
        catch (e) { return {__dify_error:String(e && e.message || e)}; }
      }, script);
      if(result && result.__dify_error) throw new Error(result.__dify_error);
      return {success:true,result};
    }
    case 'browser_screenshot': {
      const target = safePath(args.path);
      if(path.extname(target).toLowerCase() !== '.png') throw new Error('browser_screenshot path must end with .png.');
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));
      await p.screenshot({path:target,fullPage:!!args.full_page});
      return {success:true,path:path.relative(workspaceRoot(),target).replace(/\\/g,'/'),url:p.url()};
    }
    default: return {success:false,error:`Unknown browser tool: ${name}`};
  }
}

async function snapshot(p,args){
  const maxChars = Math.max(1000,Math.min(120000,Number(args.max_chars || 30000)));
  const maxElements = Math.max(1,Math.min(300,Number(args.max_elements || 120)));
  const data = await p.evaluate(({maxChars,maxElements}) => {
    let counter = 0;
    const elements = [];
    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'));
    for(const el of candidates){
      if(elements.length >= maxElements) break;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if(style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0) continue;
      const ref = `e${++counter}`;
      el.setAttribute('data-dify-ref',ref);
      const tag = el.tagName.toLowerCase();
      elements.push({
        ref,
        selector:`[data-dify-ref="${ref}"]`,
        tag,
        role:el.getAttribute('role') || '',
        type:el.getAttribute('type') || '',
        name:el.getAttribute('name') || '',
        text:(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('value') || '').trim().slice(0,300),
        href:tag === 'a' ? el.href : undefined,
        disabled:!!el.disabled
      });
    }
    const text = (document.body?.innerText || '').replace(/\n{3,}/g,'\n\n').slice(0,maxChars);
    return {title:document.title,url:location.href,text,elements};
  }, {maxChars,maxElements});
  return {success:true,...data};
}

async function closeBrowser(){
  if(context) await context.close().catch(()=>{});
  if(browser) await browser.close().catch(()=>{});
  browser = context = page = undefined;
  lastConfigKey = '';
  return {success:true};
}

module.exports = { BROWSER_TOOLS, BROWSER_MUTATING, executeBrowserTool, closeBrowser };
