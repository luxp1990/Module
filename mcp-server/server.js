#!/usr/bin/env node
// Module MCP Server — 标准 stdio JSON-RPC 2.0 入口
'use strict';

const readline = require('readline');
const DataBridge = require('./bridge');
const tools = require('./tools');

const SERVER_NAME = 'module-taskmanager-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';

const bridge = new DataBridge();
const toolMap = new Map(tools.map(t => [t.name, t]));

// 保证所有日志输出到 stderr，绝不污染 stdout 通信通道
function logInfo(...args) {
  process.stderr.write(`[MCP INFO] ${args.join(' ')}\n`);
}
function logError(...args) {
  process.stderr.write(`[MCP ERROR] ${args.join(' ')}\n`);
}

function sendResponse(id, result) {
  const payload = {
    jsonrpc: '2.0',
    id,
    result
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendError(id, code, message, data) {
  const payload = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data
    }
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

async function handleRequest(request) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize': {
      logInfo(`Client connected: ${params?.clientInfo?.name || 'unknown'}`);
      return sendResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION
        }
      });
    }

    case 'notifications/initialized': {
      // 客户端初始化完成通知，无需回复
      logInfo('Client initialized notification received.');
      return;
    }

    case 'ping': {
      return sendResponse(id, {});
    }

    case 'tools/list': {
      const toolList = tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      }));
      return sendResponse(id, { tools: toolList });
    }

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const tool = toolMap.get(toolName);

      if (!tool) {
        return sendError(id, -32601, `Tool not found: ${toolName}`);
      }

      try {
        const result = await tool.handler(bridge, toolArgs);
        return sendResponse(id, {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }
          ],
          isError: false
        });
      } catch (err) {
        logError(`Tool ${toolName} execution error:`, err.message);
        return sendResponse(id, {
          content: [
            {
              type: 'text',
              text: `Error executing ${toolName}: ${err.message}`
            }
          ],
          isError: true
        });
      }
    }

    default: {
      if (id !== undefined) {
        return sendError(id, -32601, `Method not found: ${method}`);
      }
    }
  }
}

function main() {
  logInfo(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const request = JSON.parse(trimmed);
      handleRequest(request).catch(err => {
        logError('Unhandled request error:', err);
      });
    } catch (err) {
      logError('Invalid JSON received:', trimmed);
      sendError(null, -32700, 'Parse error: invalid JSON');
    }
  });

  rl.on('close', () => {
    logInfo('Stdin closed, exiting.');
    process.exit(0);
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main();
