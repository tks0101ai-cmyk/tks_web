'use strict';
// Service Oregon sau khi chuyen web sang Singapore: KHONG ket noi DB, chi chuyen moi request sang ten mien moi.
// 302/307 (tam thoi) thay vi 301/308: trinh duyet khong nho vinh vien, quay lui ve Oregon khong bi ket.
// Start command tren Render: node redirect.js ; bien moi truong: REDIRECT_TO=https://app.<ten-mien>.com
const http = require('node:http');

function createRedirectServer({ target }) {
  const base = String(target || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#]+$/.test(base)) throw new Error('REDIRECT_TO phai co dang https://ten-mien (khong co duong dan).');
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    const status = req.method === 'GET' || req.method === 'HEAD' ? 302 : 307;
    res.writeHead(status, { Location: base + (req.url || '/'), 'Cache-Control': 'no-store' });
    res.end();
  });
}

if (require.main === module) {
  const server = createRedirectServer({ target: process.env.REDIRECT_TO });
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log('[redirect] Chuyen huong sang ' + process.env.REDIRECT_TO + ' tren port ' + port));
}

module.exports = { createRedirectServer };
