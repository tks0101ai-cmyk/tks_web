'use strict';
// Gioi han so request GET DANG CHAY cung luc cua 1 nguoi dung tren 1 duong dan API nang.
// Bam lam moi lien tuc / mo nhieu tab khong the xep hang chuc truy van vao pool DB 4 ket noi.
// Bo dem trong bo nho tien trinh: web chi chay 1 instance (xem README).
// Tra suat khi handler goi res.end (xu ly xong that); client huy giua chung thi van giu suat
// toi khi handler xong, toi da holdAfterCloseMs, vi truy van DB van dang chay.
const { verifyToken } = require('../auth/authService');

const DEFAULT_PREFIXES = ['/api/product-report', '/api/stocktake/sessions/', '/api/shipment/lifecycle', '/api/shipment/pick'];

const routeKey = path => path.split('/').map(seg => (/\d/.test(seg) ? ':id' : seg)).join('/');

function identifyRequest(req) {
  const token = req.cookies && req.cookies.tks_auth;
  if (token) {
    try { return 'u:' + verifyToken(token).id; } catch (error) { /* token hong: tinh theo IP */ }
  }
  return 'ip:' + req.ip;
}

function createInflightLimit({ prefixes = DEFAULT_PREFIXES, max = 4, holdAfterCloseMs = 120000, identify = identifyRequest, logger = console } = {}) {
  const counts = new Map();
  const release = key => {
    const left = (counts.get(key) || 1) - 1;
    if (left > 0) counts.set(key, left); else counts.delete(key);
  };
  return function inflightLimit(req, res, next) {
    // SSE (/events) mo suot phien xem trang: khong tinh, neu khong tab thu 5 cung dot bi chan.
    if (req.method !== 'GET' || req.path.endsWith('/events') || !prefixes.some(prefix => req.path.startsWith(prefix))) return next();
    const key = identify(req) + ' ' + routeKey(req.path);
    const current = counts.get(key) || 0;
    if (current >= max) {
      logger.warn('[inflightLimit] 429 ' + key);
      res.set('Retry-After', '2');
      return res.status(429).json({ code: 'TOO_MANY_INFLIGHT', error: 'Đang xử lý yêu cầu trước, vui lòng chờ.' });
    }
    counts.set(key, current + 1);
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      release(key);
    };
    const end = res.end;
    res.end = function patchedEnd(...args) { finish(); return end.apply(this, args); };
    res.once('close', () => {
      if (done) return;
      timer = setTimeout(finish, holdAfterCloseMs);
      if (timer.unref) timer.unref();
    });
    return next();
  };
}

module.exports = { createInflightLimit, identifyRequest, routeKey, DEFAULT_PREFIXES };
