// Ton VAT trong hop chi tiet chung tu (tab Hoa don: Chi tiet giao dich; Vong doi don hang: Chi tiet don), 17/11/2026.
// Spec: docs/superpowers/specs/2026-11-21-vat-stock-order-release-design.md
// - computeVatShortages: ham thuan (chay ca Node de test) — chia Ton co the nhap cua ma VAT cho cac dong theo thu tu.
// - headHtml / cellsHtml / barHtml: trang chen vao bang luc dung (o "…" cho API); attach() dien so, gan tick va nut.
// Ton lay tu POST /api/vat-lookup/stock (cung bo dem trang Tra cuu VAT). Chuyen trang: shared/vat-handoff.js.
(function (root) {
  'use strict';

  const STOCK_API = '/api/vat-lookup/stock';
  const MAX_CODES_PER_CALL = 200;
  const CANCELLED = 'Đã hủy';
  const QTY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
  const round3 = value => Math.round(value * 1000) / 1000;
  const num = value => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const codeOf = line => String((line && line.productCode) || '').trim();
  const isVatFeeCode = code => /^vat/i.test(code);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ESC[ch]);

  /** Dong co xet VAT: co ma, khong phai dong phi ma VAT…, SL > 0. */
  function isConsidered(line) {
    const code = codeOf(line);
    return !!code && !isVatFeeCode(code) && num(line && line.quantity) > 0;
  }
  function hasConsidered(lines) { return (lines || []).some(isConsidered); }

  /**
   * items = ket qua API (null khi khong doc duoc ton). Moi nhom cung ma VAT bat dau voi max(ton, 0) va chia lan luot
   * cho cac dong theo thu tu; phan khong lay duoc la phan thieu. enough = co dong duoc xet va moi dong deu 'ok'.
   */
  function computeVatShortages(lines, items) {
    const remaining = new Map();
    const result = (lines || []).map(line => {
      if (!isConsidered(line)) return { considered: false, status: 'skip', vatCode: null, stock: null, shortage: 0 };
      const quantity = num(line.quantity);
      if (!items) return { considered: true, status: 'unknown', vatCode: null, stock: null, shortage: quantity };
      const info = items[codeOf(line)];
      if (!info || !info.vatCode) return { considered: true, status: 'noVat', vatCode: null, stock: null, shortage: quantity };
      const key = String(info.vatCode).trim();
      if (!remaining.has(key)) remaining.set(key, Math.max(num(info.stock), 0));
      const take = Math.min(quantity, remaining.get(key));
      remaining.set(key, round3(remaining.get(key) - take));
      const shortage = round3(quantity - take);
      return { considered: true, status: shortage > 0 ? 'short' : 'ok', vatCode: info.vatCode, stock: num(info.stock), shortage };
    });
    const considered = result.filter(r => r.considered);
    return { lines: result, enough: considered.length > 0 && considered.every(r => r.status === 'ok') };
  }

  /**
   * can(key) = TKSNav.can. Order VAT can them quyen Tra cuu VAT (khong co ton thi khong biet dong nao thieu).
   */
  function permissions(can) {
    const has = key => { try { return !!can(key); } catch (error) { return false; } };
    const stock = has('accounting.vatLookup');
    return { stock, order: stock && has('accounting.vatRequest') };
  }

  /** Trang co ve thanh trang thai khi co dong hang duoc xet va co quyen xem ton. */
  function showsBar(lines, perms) {
    return showsColumns(lines, perms);
  }
  /** Trang co ve cot Ton VAT / Order VAT khong. */
  function showsColumns(lines, perms) {
    return !!perms && perms.stock && hasConsidered(lines);
  }

  function headHtml(perms) {
    return '<th class="num vat-stock-head" title="Tồn có thể nháp của mã VAT, cộng mọi công ty (như trang Tra cứu VAT)">Tồn VAT</th>' +
      (perms.order ? '<th class="vat-order-head" title="Tick dòng thiếu VAT rồi bấm Order VAT">Order VAT</th>' : '');
  }

  function cellsHtml(line, perms) {
    if (!isConsidered(line)) return '<td class="num vat-stock-cell"></td>' + (perms.order ? '<td class="vat-order-cell"></td>' : '');
    return '<td class="num vat-stock-cell" data-vat-cell="stock">…</td>' +
      (perms.order ? '<td class="vat-order-cell"><input type="checkbox" class="vat-order-tick" disabled aria-label="Order VAT ' + escapeHtml(codeOf(line)) + '"></td>' : '');
  }

  function barHtml() { return '<div class="vat-stock-bar" data-vat-bar hidden></div>'; }

  async function postStock(codes) {
    const res = await root.fetch(STOCK_API, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
    return data;
  }

  /** Tai ton cho cac dong duoc xet, lo toi da 200 ma. Khong bao gio reject: loi -> { error }. */
  function loadStock(lines, post = postStock) {
    const codes = [...new Set((lines || []).filter(isConsidered).map(codeOf))];
    if (!codes.length) return Promise.resolve({ items: {}, meta: null });
    const batches = [];
    for (let i = 0; i < codes.length; i += MAX_CODES_PER_CALL) batches.push(codes.slice(i, i + MAX_CODES_PER_CALL));
    return Promise.all(batches.map(async batch => post(batch)))
      .then(results => {
        const metadata = results.map(r => r && r.meta).filter(Boolean);
        return {
          items: Object.fromEntries(results.flatMap(r => Object.entries((r && r.items) || {}))),
          meta: metadata.find(meta => meta.stale) || metadata[0] || null
        };
      })
      .catch(error => ({ error: (error && error.message) || 'Không đọc được tồn VAT' }));
  }

  function updatedLabel(meta) {
    if (!meta || !meta.loadedAt) return '';
    const date = new Date(meta.loadedAt);
    if (Number.isNaN(date.getTime())) return '';
    const time = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh' });
    return 'Cập nhật lúc ' + time + (meta.stale ? ' (bản cũ)' : '');
  }

  /**
   * Gan vao khoi `root` chua bang (dong hang co data-vat-line = index trong `lines`) va thanh nut barHtml().
   * Gan lai tren cung root (trang ve lai) thi ban cu bi huy: bo listener, ket qua ve muon khong ve de.
   */
  function attach(options) {
    const host = options.root;
    const lines = options.lines || [];
    const doc = options.doc || {};
    const perms = options.perms;
    const isCurrent = options.isCurrent || (() => true);
    const openTab = options.openTab || (url => root.open(url, '_blank', 'noopener'));
    const getStorage = options.getStorage || (() => { try { return root.localStorage; } catch (error) { return null; } });
    const writeClipboard = options.writeClipboard || (text => (root.navigator && root.navigator.clipboard
      ? root.navigator.clipboard.writeText(text) : Promise.reject(new Error('Không có khay nhớ'))));
    const handoff = options.handoff || root.TKSVatHandoff;
    const cancelled = doc.status === CANCELLED;
    const state = { result: null, error: '', meta: null, ticked: new Set(), notice: '' };
    let dead = false;

    const rowOf = index => host.querySelector('tr[data-vat-line="' + index + '"]');
    const bar = () => host.querySelector('[data-vat-bar]');

    function paintCells() {
      lines.forEach((line, index) => {
        const r = state.result.lines[index];
        const tr = rowOf(index);
        if (!tr || !r.considered) return;
        const cell = tr.querySelector('[data-vat-cell="stock"]');
        const tick = tr.querySelector('.vat-order-tick');
        let text = '—';
        let title = '';
        let short = false;
        let tickable = false;
        if (r.status === 'unknown') {
          tickable = true;
        } else if (r.status === 'noVat') {
          text = 'Chưa có mã VAT';
          title = 'Mã này chưa có mã VAT trong tab Khớp mã / Gộp VAT';
          short = true;
          tickable = true;
        } else {
          text = QTY.format(r.stock);
          short = r.status === 'short';
          tickable = short;
          title = ['Mã VAT ' + r.vatCode, short ? 'Thiếu ' + QTY.format(r.shortage) : 'Đủ VAT', updatedLabel(state.meta)].filter(Boolean).join(' · ');
        }
        if (cell) {
          cell.textContent = text;
          cell.title = title;
          cell.classList.toggle('is-vat-short', short);
        }
        if (tick) {
          tick.dataset.vatTick = String(index);
          tick.disabled = cancelled || !tickable;
          tick.title = r.status === 'ok' ? 'Đủ VAT' : '';
          tick.checked = state.ticked.has(index);
        }
      });
    }

    function paintBar() {
      const el = bar();
      if (!el) return;
      const parts = [];
      if (state.error) parts.push('<span class="vat-stock-hint is-error">Không đọc được tồn VAT, thử lại sau.</span>');
      if (!cancelled && perms.order && state.ticked.size) {
        parts.push('<button type="button" class="btn-primary vat-stock-btn" data-vat-action="order">Order VAT (' + state.ticked.size + ' dòng)</button>');
      }
      if (state.meta && state.meta.stale) {
        parts.push('<span class="vat-stock-hint" role="status">Đang hiển thị tồn VAT bản cũ.</span>');
      }
      if (state.notice) parts.push('<span class="vat-stock-hint" role="status">' + escapeHtml(state.notice) + '</span>');
      el.innerHTML = parts.join('');
      el.hidden = !parts.length;
    }

    function orderRows() {
      return [...state.ticked].sort((a, b) => a - b).map(index => {
        const line = lines[index];
        return {
          customerName: doc.customerName || '',
          productCode: codeOf(line),
          productName: String(line.productName || ''),
          quantity: round3(state.result.lines[index].shortage),
          unitPrice: Math.round(num(line.price) - num(line.discount)),
          saleNote: 'Từ ' + doc.code
        };
      });
    }

    function onOrder() {
      const rows = orderRows();
      if (!rows.length || !handoff) return;
      if (handoff.writeOrderVat(getStorage(), { source: doc.code, rows })) {
        state.ticked.clear();
        state.notice = 'Đã mở trang ORDER VAT.';
        paintCells();
        paintBar();
        openTab('/vat-request/?handoff=1');
        return;
      }
      Promise.resolve()
        .then(() => writeClipboard(handoff.orderVatTsv(rows)))
        .then(() => true, () => false)
        .then(copied => {
          if (dead || !isCurrent()) return;
          state.notice = 'Trình duyệt không cho lưu tạm, hãy mở trang ORDER VAT và dán dữ liệu.' + (copied ? ' Đã chép sẵn các dòng vào khay nhớ.' : '');
          paintBar();
        });
    }

    function onChange(event) {
      const tick = event.target.closest && event.target.closest('.vat-order-tick');
      if (!tick || tick.disabled || !host.contains(tick) || !isCurrent() || tick.dataset.vatTick === undefined) return;
      const index = Number(tick.dataset.vatTick);
      if (tick.checked) state.ticked.add(index); else state.ticked.delete(index);
      state.notice = '';
      paintBar();
    }

    function onClick(event) {
      const button = event.target.closest && event.target.closest('[data-vat-action]');
      if (cancelled || !perms.order || !button || !host.contains(button) || !isCurrent()) return;
      if (button.dataset.vatAction === 'order') onOrder();
    }

    if (host._tksVatStock) host._tksVatStock.destroy();
    host.addEventListener('change', onChange);
    host.addEventListener('click', onClick);
    const controller = {
      destroy() {
        if (dead) return;
        dead = true;
        state.ticked.clear();
        host.removeEventListener('change', onChange);
        host.removeEventListener('click', onClick);
        host.querySelectorAll('.vat-order-tick').forEach(tick => {
          tick.checked = false;
          tick.disabled = true;
        });
        const el = bar();
        if (el) {
          el.hidden = true;
          el.innerHTML = '';
        }
        delete host._tksVatStock;
      }
    };
    host._tksVatStock = controller;

    paintBar();
    if (!perms.stock) return controller;
    Promise.resolve(options.stock)
      .catch(error => ({ error: (error && error.message) || 'Không đọc được tồn VAT' }))
      .then(data => {
        if (dead || !isCurrent()) return;
        const safe = data || { error: 'Không đọc được tồn VAT' };
        state.error = safe.error || '';
        state.meta = safe.meta || null;
        state.result = computeVatShortages(lines, safe.error ? null : (safe.items || {}));
        paintCells();
        paintBar();
      });
    return controller;
  }

  const api = { isConsidered, hasConsidered, computeVatShortages, permissions, showsBar, showsColumns, headHtml, cellsHtml, barHtml, loadStock, updatedLabel, attach };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TKSVatStock = api;
})(typeof window !== 'undefined' ? window : globalThis);
