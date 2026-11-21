'use strict';

// 本地演示服务：只用 Node.js 内置模块。
// 启动：node server.js （读取环境变量 PORT，默认 3000，绑定 127.0.0.1）

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const logic = require('./src/logic');

const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const MAX_BODY = 1024 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer() {
  let state = logic.createState();

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const { pathname } = url;

      if (req.method === 'GET' && pathname === '/') {
        return sendHtml(res, fs.readFileSync(INDEX_HTML, 'utf8'));
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, {
          orders: state.orders,
          tickets: state.tickets,
          threshold: logic.CONFIDENCE_THRESHOLD,
        });
      }

      // 「计算原替换和投诉」
      if (req.method === 'POST' && pathname === '/api/compute') {
        return sendJson(res, 200, logic.computeMetrics(state));
      }

      // 「重分配一张投诉单」 body: { ticketId, lineId? } 缺省 lineId 时按可信度自动归因
      if (req.method === 'POST' && pathname === '/api/reassign') {
        const raw = await readBody(req);
        let payload = {};
        if (raw) {
          try {
            payload = JSON.parse(raw);
          } catch {
            return sendJson(res, 400, { error: 'BAD_JSON', message: '请求体不是合法 JSON' });
          }
        }
        try {
          return sendJson(res, 200, logic.reassignTicket(state, payload.ticketId, payload.lineId));
        } catch (err) {
          if (err && err.code) {
            return sendJson(res, 400, { error: err.code, message: err.message, extra: err.extra || null });
          }
          throw err;
        }
      }

      // 「查看品类归因」
      if (req.method === 'GET' && pathname === '/api/attribution') {
        return sendJson(res, 200, logic.attributionView(state));
      }

      if (req.method === 'POST' && pathname === '/api/reset') {
        state = logic.createState();
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 404, { error: 'NOT_FOUND', message: `${req.method} ${pathname} 不存在` });
    } catch (err) {
      return sendJson(res, 500, { error: 'INTERNAL', message: String((err && err.message) || err) });
    }
  });
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 3000);
  createServer().listen(PORT, '127.0.0.1', () => {
    console.log(`植株订单售后归因演示已启动: http://127.0.0.1:${PORT}`);
  });
}

module.exports = { createServer };
