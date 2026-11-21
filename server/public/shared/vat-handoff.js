// Du lieu chuyen tu hop chi tiet hoa don / don hang sang trang ORDER VAT (17/11/2026).
// Spec: docs/superpowers/specs/2026-11-21-vat-stock-order-release-design.md
// - ORDER VAT: cac dong tick (ten khach, gia) nam trong localStorage 1 lan, het han 10 phut — KHONG dua len URL.
(function (root) {
  'use strict';

  const ORDER_VAT_PREFIX = 'tks.vatRequest.handoff:';
  const MAX_AGE_MS = 10 * 60 * 1000;

  const HANDOFF_ID = /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-f0-9]{32}|fallback-[a-z0-9]{1,12}-[a-z0-9]{1,12}-[a-z0-9]{20})$/;
  let sequence = 0;

  function createId() {
    if (root.crypto?.randomUUID) return root.crypto.randomUUID();
    if (root.crypto?.getRandomValues) {
      const bytes = root.crypto.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
    const randomPart = () => Math.random().toString(36).slice(2, 12).padEnd(10, '0');
    return 'fallback-' + Date.now().toString(36) + '-' + (++sequence).toString(36) + '-' + randomPart() + randomPart();
  }

  function validId(id) {
    return typeof id === 'string' && HANDOFF_ID.test(id);
  }

  function readPayload(raw) {
    try { return JSON.parse(raw); } catch (error) { return null; }
  }

  function pruneExpired(storage, now) {
    for (let i = storage.length - 1; i >= 0; i -= 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(ORDER_VAT_PREFIX) || !validId(key.slice(ORDER_VAT_PREFIX.length))) continue;
      const data = readPayload(storage.getItem(key));
      if (data && Number.isFinite(data.createdAt) && now - data.createdAt > MAX_AGE_MS) {
        storage.removeItem(key);
      }
    }
  }

  /** Ghi du lieu cho mot lan chuyen. Tra ve ID, hoac false khi khong luu duoc. */
  function writeOrderVat(storage, payload, now = Date.now()) {
    if (!storage) return false;
    try {
      pruneExpired(storage, now);
      const id = createId();
      storage.setItem(ORDER_VAT_PREFIX + id, JSON.stringify({ createdAt: now, source: String(payload.source || ''), rows: payload.rows || [] }));
      return id;
    } catch (error) {
      return false;
    }
  }

  /** Chi doc va xoa ban chuyen ung voi ID. */
  function takeOrderVat(storage, id, now = Date.now()) {
    if (!storage || !validId(id)) return { status: 'none', rows: [] };
    const key = ORDER_VAT_PREFIX + id;
    let raw;
    try {
      raw = storage.getItem(key);
      if (raw === null) return { status: 'none', rows: [] };
      storage.removeItem(key);
    } catch (error) {
      return { status: 'none', rows: [] };
    }
    const data = readPayload(raw);
    const age = now - (data && data.createdAt);
    if (!data || !Array.isArray(data.rows) || !Number.isFinite(data.createdAt) || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) {
      return { status: 'expired', rows: [] };
    }
    return { status: 'ok', source: String(data.source || ''), rows: data.rows };
  }

  /** TSV dung thu tu cot dan cua form ORDER VAT (Khach, Ma SP, Ten SP, SL, Gia, Ghi chu) khi khong luu tam duoc. */
  function orderVatTsv(rows) {
    return (rows || []).map(row => [row.customerName, row.productCode, row.productName, row.quantity, row.unitPrice, row.saleNote]
      .map(value => String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  }

  const api = { ORDER_VAT_PREFIX, MAX_AGE_MS, writeOrderVat, takeOrderVat, orderVatTsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TKSVatHandoff = api;
})(typeof window !== 'undefined' ? window : globalThis);
