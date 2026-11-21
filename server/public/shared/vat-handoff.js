// Du lieu chuyen tu hop chi tiet hoa don / don hang sang trang ORDER VAT (17/11/2026).
// Spec: docs/superpowers/specs/2026-11-21-vat-stock-order-release-design.md
// - ORDER VAT: cac dong tick (ten khach, gia) nam trong localStorage 1 lan, het han 10 phut — KHONG dua len URL.
(function (root) {
  'use strict';

  const ORDER_VAT_KEY = 'tks.vatRequest.handoff';
  const MAX_AGE_MS = 10 * 60 * 1000;

  /** Ghi cac dong Order VAT de trang ORDER VAT doc 1 lan. false khi trinh duyet chan bo nho. */
  function writeOrderVat(storage, payload, now = Date.now()) {
    if (!storage) return false;
    try {
      storage.setItem(ORDER_VAT_KEY, JSON.stringify({ createdAt: now, source: String(payload.source || ''), rows: payload.rows || [] }));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** Doc roi XOA ngay ban chuyen sang. status: 'ok' | 'none' (khong co) | 'expired' (qua 10 phut / hong). */
  function takeOrderVat(storage, now = Date.now()) {
    if (!storage) return { status: 'none', rows: [] };
    let raw = null;
    try {
      raw = storage.getItem(ORDER_VAT_KEY);
      storage.removeItem(ORDER_VAT_KEY);
    } catch (error) {
      return { status: 'none', rows: [] };
    }
    if (!raw) return { status: 'none', rows: [] };
    let data = null;
    try { data = JSON.parse(raw); } catch (error) { return { status: 'expired', rows: [] }; }
    const age = now - Number(data && data.createdAt);
    if (!data || !Array.isArray(data.rows) || !Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return { status: 'expired', rows: [] };
    return { status: 'ok', source: String(data.source || ''), rows: data.rows };
  }

  /** TSV dung thu tu cot dan cua form ORDER VAT (Khach, Ma SP, Ten SP, SL, Gia, Ghi chu) khi khong luu tam duoc. */
  function orderVatTsv(rows) {
    return (rows || []).map(row => [row.customerName, row.productCode, row.productName, row.quantity, row.unitPrice, row.saleNote]
      .map(value => String(value == null ? '' : value).replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  }

  const api = { ORDER_VAT_KEY, MAX_AGE_MS, writeOrderVat, takeOrderVat, orderVatTsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TKSVatHandoff = api;
})(typeof window !== 'undefined' ? window : globalThis);
