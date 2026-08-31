const local = require('./localTools');
const { isPlatformTool, isPlatformMutating, executePlatformTool } = require('./platform');

const MUTATING_TOOLS = {
  has(name) { return local.MUTATING_TOOLS.has(name) || (isPlatformTool(name) && isPlatformMutating(name)); }
};

async function executeTool(name, args = {}, config) {
  if (isPlatformTool(name)) return executePlatformTool(name, args, config);
  return local.executeTool(name, args, config);
}

// The stable core extension still advertises its local TOOLS array. platform-entry.js
// dynamically augments every main Dify request with the platform schemas, including
// live MCP-discovered tools, before compat.js maps the request to messages_json/tools_json.
module.exports = { TOOLS: local.TOOLS, MUTATING_TOOLS, executeTool };
