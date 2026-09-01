const SUMMARY_PREFIX = '[Context Manager: previous task summaries]';

function asInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    recentTasks: asInt(options.recentTasks, 2, 1, 8),
    maxChars: asInt(options.maxChars, 120000, 20000, 1000000),
    toolResultMaxChars: asInt(options.toolResultMaxChars, 12000, 1000, 100000),
    storedToolResultMaxChars: asInt(options.storedToolResultMaxChars, 6000, 500, 50000),
    summaryMaxChars: asInt(options.summaryMaxChars, 16000, 2000, 100000)
  };
}

function messageChars(message) {
  try { return JSON.stringify(message).length; } catch { return String(message?.content || '').length; }
}

function historyChars(history) {
  return (Array.isArray(history) ? history : []).reduce((sum, message) => sum + messageChars(message), 0);
}

function clip(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  if (max < 80) return value.slice(0, max);
  return `${value.slice(0, Math.floor(max * 0.72))}\n...[truncated]...\n${value.slice(-Math.floor(max * 0.2))}`;
}

function clipTail(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `[older summaries truncated]\n${value.slice(-Math.max(0, max - 30))}`;
}

function isSummaryMessage(message) {
  return message?.role === 'system' && String(message.content || '').startsWith(SUMMARY_PREFIX);
}

function splitTasks(history) {
  const tasks = [];
  let current = null;
  const leading = [];
  for (const message of Array.isArray(history) ? history : []) {
    if (isSummaryMessage(message)) {
      leading.push(message);
      continue;
    }
    if (message?.role === 'user') {
      if (current?.length) tasks.push(current);
      current = [message];
      continue;
    }
    if (current) current.push(message);
    else leading.push(message);
  }
  if (current?.length) tasks.push(current);
  return { leading, tasks };
}

function extractToolNames(task) {
  const names = [];
  for (const message of task) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        const name = String(call?.name || call?.function?.name || '').trim();
        if (name) names.push(name);
      }
    }
    if (message?.role === 'tool' && message.name) names.push(String(message.name));
  }
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => count > 1 ? `${name} x${count}` : name);
}

function extractArtifacts(task) {
  const found = new Set();
  const pattern = /(?:[A-Za-z]:[\\/])?[A-Za-z0-9_ .()\-\\/]+\.(?:pptx|xlsx|docx|pdf|csv|json|md|png|jpg|jpeg|svg|zip|txt|html|js|ts|py)\b/gi;
  for (const message of task) {
    let text = '';
    if (typeof message?.content === 'string') text += message.content;
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) {
        try { text += ` ${JSON.stringify(call.arguments ?? call.function?.arguments ?? '')}`; } catch {}
      }
    }
    for (const match of text.matchAll(pattern)) {
      const item = String(match[0] || '').trim().replace(/^[-:;,.\s]+/, '');
      if (item && item.length <= 180) found.add(item);
      if (found.size >= 12) return [...found];
    }
  }
  return [...found];
}

function summarizeTask(task, ordinal) {
  const user = task.find(message => message?.role === 'user');
  const finalAssistant = [...task].reverse().find(message => message?.role === 'assistant' && typeof message.content === 'string' && message.content.trim());
  const tools = extractToolNames(task);
  const artifacts = extractArtifacts(task);
  const lines = [
    `Task ${ordinal}: ${clip(user?.content, 900) || '(no user text)'}`,
    `Outcome: ${clip(finalAssistant?.content, 1800) || 'Task ended without a final assistant message.'}`
  ];
  if (tools.length) lines.push(`Tools: ${tools.slice(0, 18).join(', ')}`);
  if (artifacts.length) lines.push(`Artifacts: ${artifacts.join(', ')}`);
  return lines.join('\n');
}

function trimToolMessage(message, maxChars) {
  if (message?.role !== 'tool' || typeof message.content !== 'string' || message.content.length <= maxChars) return { message: { ...message }, trimmed: false };
  return { message: { ...message, content: clip(message.content, maxChars) }, trimmed: true };
}

function trimTask(task, maxChars) {
  let trimmed = 0;
  const messages = task.map(message => {
    const result = trimToolMessage(message, maxChars);
    if (result.trimmed) trimmed += 1;
    return result.message;
  });
  return { messages, trimmed };
}

function compactHistory(history, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  if (!options.enabled) return { history: Array.isArray(history) ? history.map(message => ({ ...message })) : [], stats: { summarizedTasks: 0, trimmedToolResults: 0 } };

  const { leading, tasks } = splitTasks(history);
  const oldSummary = leading.filter(isSummaryMessage).map(message => String(message.content || '').slice(SUMMARY_PREFIX.length).trim()).filter(Boolean).join('\n\n');
  const passThroughLeading = leading.filter(message => !isSummaryMessage(message)).map(message => ({ ...message }));
  const cutoff = Math.max(0, tasks.length - options.recentTasks);
  const oldTasks = tasks.slice(0, cutoff);
  const keepTasks = tasks.slice(cutoff);
  const newSummaries = oldTasks.map((task, index) => summarizeTask(task, index + 1));
  const combinedSummary = clipTail([oldSummary, ...newSummaries].filter(Boolean).join('\n\n---\n\n'), options.summaryMaxChars);

  const output = [...passThroughLeading];
  if (combinedSummary) output.push({ role: 'system', content: `${SUMMARY_PREFIX}\n${combinedSummary}` });
  let trimmedToolResults = 0;
  for (const task of keepTasks) {
    const trimmed = trimTask(task, options.storedToolResultMaxChars);
    trimmedToolResults += trimmed.trimmed;
    output.push(...trimmed.messages);
  }
  return { history: output, stats: { summarizedTasks: oldTasks.length, trimmedToolResults } };
}

function reduceToBudget(messages, options) {
  const output = messages.map(message => ({ ...message }));
  let trimmedToolResults = 0;
  for (let i = 0; i < output.length; i += 1) {
    const trimmed = trimToolMessage(output[i], options.toolResultMaxChars);
    output[i] = trimmed.message;
    if (trimmed.trimmed) trimmedToolResults += 1;
  }

  let total = historyChars(output);
  if (total <= options.maxChars) return { messages: output, trimmedToolResults };

  const { leading, tasks } = splitTasks(output);
  if (tasks.length > 1) {
    const older = tasks.slice(0, -1);
    const latest = tasks[tasks.length - 1];
    const existingSummary = leading.filter(isSummaryMessage).map(message => String(message.content || '').slice(SUMMARY_PREFIX.length).trim()).filter(Boolean);
    const generated = older.map((task, index) => summarizeTask(task, index + 1));
    const summary = clipTail([...existingSummary, ...generated].join('\n\n---\n\n'), Math.min(options.summaryMaxChars, Math.floor(options.maxChars * 0.28)));
    const passThrough = leading.filter(message => !isSummaryMessage(message)).map(message => ({ ...message }));
    output.length = 0;
    output.push(...passThrough);
    if (summary) output.push({ role: 'system', content: `${SUMMARY_PREFIX}\n${summary}` });
    output.push(...latest);
  }

  total = historyChars(output);
  let guard = 0;
  while (total > options.maxChars && guard++ < 100) {
    let candidate = -1;
    let longest = 0;
    for (let i = 0; i < output.length; i += 1) {
      const message = output[i];
      if (message?.role !== 'tool' || typeof message.content !== 'string') continue;
      if (message.content.length > longest && message.content.length > 800) {
        candidate = i;
        longest = message.content.length;
      }
    }
    if (candidate === -1) break;
    const nextMax = Math.max(600, Math.floor(longest * 0.55));
    output[candidate] = { ...output[candidate], content: clip(output[candidate].content, nextMax) };
    trimmedToolResults += 1;
    total = historyChars(output);
  }

  const summaryIndex = output.findIndex(isSummaryMessage);
  if (total > options.maxChars && summaryIndex >= 0) {
    const excess = total - options.maxChars;
    const current = String(output[summaryIndex].content || '');
    output[summaryIndex] = { ...output[summaryIndex], content: clipTail(current, Math.max(800, current.length - excess - 200)) };
  }

  return { messages: output, trimmedToolResults };
}

function prepareContext(history, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  const original = Array.isArray(history) ? history : [];
  if (!options.enabled) {
    return { messages: original.map(message => ({ ...message })), stats: { enabled: false, originalChars: historyChars(original), outboundChars: historyChars(original), summarizedTasks: 0, trimmedToolResults: 0 } };
  }
  const compacted = compactHistory(original, options);
  const reduced = reduceToBudget(compacted.history, options);
  return {
    messages: reduced.messages,
    stats: {
      enabled: true,
      originalChars: historyChars(original),
      outboundChars: historyChars(reduced.messages),
      summarizedTasks: compacted.stats.summarizedTasks,
      trimmedToolResults: compacted.stats.trimmedToolResults + reduced.trimmedToolResults,
      maxChars: options.maxChars
    }
  };
}

function optionsFromConfig(config) {
  const get = (key, fallback) => config?.get?.(key, fallback) ?? fallback;
  return normalizeOptions({
    enabled: get('contextManagerEnabled', true),
    recentTasks: get('contextRecentTasks', 2),
    maxChars: get('contextMaxChars', 120000),
    toolResultMaxChars: get('contextToolResultMaxChars', 12000),
    storedToolResultMaxChars: get('contextStoredToolResultMaxChars', 6000),
    summaryMaxChars: get('contextSummaryMaxChars', 16000)
  });
}

module.exports = {
  SUMMARY_PREFIX,
  normalizeOptions,
  splitTasks,
  summarizeTask,
  compactHistory,
  prepareContext,
  optionsFromConfig,
  historyChars
};
