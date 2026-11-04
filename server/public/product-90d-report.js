/* Tab Hàng hóa — mục 4 "Hàng hóa 90 ngày" (API chỉ đọc /api/product-report/90d, quyền reports.products + reports.products.sales).
   Bảng tính sẵn lúc 02:00 (product_90d_report), web KHÔNG tính lại. 26 cột: Mã, Tên rồi 4 kỳ T.trc nữa | T.trc | T.này | 90 ngày,
   mỗi kỳ 6 cột SL | DS | Giá TB | SL khách | Lượt mua | Top 3 khách. thead tĩnh trong index.html (2 tầng, khớp COLUMNS bên dưới —
   test/frontend/product-90d-report.test.js khóa khớp). Tìm kiếm, sắp xếp, phân trang đều ở máy chủ trên TOÀN BỘ kết quả.
   Ẩn/hiện cột + kéo độ rộng: shared/table-controls.js (data-table-sort="off": trang tự sắp xếp qua API).
   Phần đầu file là hàm thuần (không đụng DOM) — Node require() được để test. */
(function () {
  'use strict';

  // ---------- hàm thuần ----------
  const PERIODS = [
    { key: '61_90d', label: 'T.trc nữa' },
    { key: '31_60d', label: 'T.trc' },
    { key: '1_30d', label: 'T.này' },
    { key: '1_90d', label: '90 ngày' }
  ];
  // width = máy tính, mobile = màn hẹp (≤ 600px, cùng mốc screenMode của table-controls).
  const METRICS = [
    { metric: 'qty', label: 'SL', width: 90, mobile: 80, sortable: true },
    { metric: 'revenue', label: 'DS', width: 124, mobile: 112, sortable: true },
    { metric: 'avg_price', label: 'Giá TB', width: 108, mobile: 100, sortable: true },
    { metric: 'customer_count', label: 'SL khách', width: 96, mobile: 88, sortable: true },
    { metric: 'invoice_count', label: 'Lượt mua', width: 96, mobile: 88, sortable: true },
    { metric: 'top_customers', label: 'Top 3 khách', width: 330, mobile: 260, sortable: false }
  ];
  const COLUMNS = [
    { key: 'product_code', label: 'Mã hàng', pickerLabel: 'Mã hàng', width: 110, mobile: 82, sortable: true, type: 'code' },
    { key: 'product_name', label: 'Tên hàng', pickerLabel: 'Tên hàng', width: 240, mobile: 130, sortable: true, type: 'name' }
  ].concat(PERIODS.reduce(function (list, period) {
    return list.concat(METRICS.map(function (m, index) {
      return {
        key: m.metric + '_' + period.key, label: m.label, pickerLabel: period.label + ' – ' + m.label,
        width: m.width, mobile: m.mobile, sortable: m.sortable, period: period.key, first: index === 0,
        type: m.metric === 'top_customers' ? 'top' : 'number'
      };
    }));
  }, []));

  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 });
  const PERCENT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
  const DASH = '—';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // NULL/không phải số → "—"; 0 → "0"; số âm và số lẻ giữ nguyên (tối đa 8 chữ số thập phân, bỏ số 0 thừa). KHÔNG dùng `||`.
  function formatValue(value) {
    const n = toNumber(value);
    if (n === null) return DASH;
    return NUMBER.format(n === 0 ? 0 : n);
  }

  // share là tỷ lệ 0–1 → "45.2%".
  function formatShare(value) {
    const n = toNumber(value);
    if (n === null) return DASH;
    const pct = n * 100;
    return PERCENT.format(pct === 0 ? 0 : pct) + '%';
  }

  function parseDay(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: m[1], m: m[2], d: m[3] } : null;
  }

  // Khoảng ngày thực tế của kỳ: cùng năm "06/08–04/09/2026", khác năm "15/12/2025–13/01/2026"; thiếu ngày → "".
  function formatPeriodRange(from, to) {
    const a = parseDay(from), b = parseDay(to);
    if (!a || !b) return '';
    return a.y === b.y
      ? a.d + '/' + a.m + '–' + b.d + '/' + b.m + '/' + b.y
      : a.d + '/' + a.m + '/' + a.y + '–' + b.d + '/' + b.m + '/' + b.y;
  }

  // Thời điểm (ISO UTC) → "HH:mm dd/MM/yyyy" theo giờ Việt Nam; sai định dạng → "".
  const STAMP = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  function formatStamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = {};
    STAMP.formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
    return parts.hour + ':' + parts.minute + ' ' + parts.day + '/' + parts.month + '/' + parts.year;
  }

  // Top 3 khách — hàm DÙNG CHUNG màn hình + file xuất (exportService require file này):
  // bỏ khách có SL = 0 (không góp gì; giữ SL âm = trả hàng thật), mỗi khách còn lại 1 dòng "Tên|%DS|DS", vd
  // "HN C Vương Ninh HN|10%|45000000": nối bằng "|" KHÔNG khoảng trắng, % = tỷ lệ × 100 (tối đa 1 chữ số lẻ, bỏ 0 thừa),
  // DS là số thô KHÔNG phân cách hàng nghìn (giữ số lẻ/số âm). Không ghi SL. Không còn ai → mảng rỗng (hiển thị "—").
  const PLAIN = new Intl.NumberFormat('en-US', { maximumFractionDigits: 8, useGrouping: false });
  const PLAIN_SHARE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false });
  function plainNumber(value, format) {
    const n = toNumber(value);
    return n === null ? DASH : format.format(n === 0 ? 0 : n).replace(/^-0$/, '0');
  }
  function topCustomerLines(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 3).filter(function (item) {
      return item && typeof item === 'object' && toNumber(item.quantity) !== 0;
    }).map(function (c) {
      const name = c.name == null || String(c.name).trim() === '' ? 'Khách lẻ' : String(c.name).trim();
      const share = toNumber(c.share);
      return name + '|' + (share === null ? DASH : plainNumber(share * 100, PLAIN_SHARE) + '%') + '|' + plainNumber(c.revenue, PLAIN);
    });
  }
  function topCustomersHtml(list) {
    const lines = topCustomerLines(list);
    if (!lines.length) return '<span class="muted">' + DASH + '</span>';
    return '<ol class="p90-top">' + lines.map(function (line) {
      return '<li title="' + escapeHtml(line) + '">' + escapeHtml(line) + '</li>';
    }).join('') + '</ol>';
  }

  function cellHtml(row, column) {
    const value = row ? row[column.key] : null;
    const edge = column.first ? ' p90-group-start' : '';
    if (column.type === 'code') return '<td class="mono p90-sticky p90-sticky-code">' + (value ? escapeHtml(value) : '<span class="muted">' + DASH + '</span>') + '</td>';
    if (column.type === 'name') return '<td class="name-cell p90-sticky p90-sticky-name">' + (value ? escapeHtml(value) : '<span class="muted">' + DASH + '</span>') + '</td>';
    if (column.type === 'top') return '<td class="p90-top-cell' + edge + '">' + topCustomersHtml(value) + '</td>';
    const text = formatValue(value);
    const n = toNumber(value);
    return '<td class="mono col-num' + edge + (n !== null && n < 0 ? ' p90-negative' : '') + '">' +
      (text === DASH ? '<span class="muted">' + DASH + '</span>' : escapeHtml(text)) + '</td>';
  }

  function rowHtml(row) {
    return '<tr>' + COLUMNS.map(function (column) { return cellHtml(row, column); }).join('') + '</tr>';
  }

  // Chuỗi truy vấn: BỎ tham số rỗng (máy chủ trả 400 cho chuỗi rỗng); dir chỉ đi kèm sort.
  function buildQuery(params) {
    const p = params || {};
    const out = new URLSearchParams();
    const q = typeof p.q === 'string' ? p.q.trim() : '';
    if (q) out.set('q', q.slice(0, 200));
    if (p.sort && p.sort !== 'relevance') {
      out.set('sort', p.sort);
      if (p.dir === 'asc' || p.dir === 'desc') out.set('dir', p.dir);
    }
    const page = Number(p.page);
    if (Number.isInteger(page) && page >= 1) out.set('page', String(page));
    const size = Number(p.pageSize);
    if (Number.isInteger(size) && size >= 1) out.set('pageSize', String(Math.min(200, size)));
    return out.toString();
  }

  // Thứ tự bấm tiêu đề: tăng dần → giảm dần → bỏ sắp xếp (thứ tự mặc định của máy chủ).
  function nextSort(current, key) {
    if (!current || current.sort !== key) return { sort: key, dir: 'asc' };
    if (current.dir === 'asc') return { sort: key, dir: 'desc' };
    return { sort: '', dir: '' };
  }

  // Chữ của nút sắp xếp báo hành động KẾ TIẾP khi bấm (như table-controls): chưa sắp → tăng dần → giảm dần → bỏ sắp xếp.
  function sortAction(mode) {
    return mode === 'ascending' ? 'Sắp xếp giảm dần' : mode === 'descending' ? 'Bỏ sắp xếp' : 'Sắp xếp tăng dần';
  }

  // Ngữ cảnh gửi hộp thoại "Xuất file" (POST /api/export, tableKey products.product90d): đúng từ khóa ĐANG áp dụng
  // (state.q) và cột sắp xếp theo NHÃN cột xuất (pickerLabel, vd "T.này – SL") — máy chủ đổi nhãn → cột whitelist.
  function exportContext(current) {
    const s = current || {};
    const out = { tableSearch: { mode: 'normal', query: typeof s.q === 'string' ? s.q.trim().slice(0, 200) : '' } };
    const column = s.sort ? COLUMNS.find(function (c) { return c.key === s.sort && c.sortable; }) : null;
    if (column && (s.dir === 'asc' || s.dir === 'desc')) out.tableSort = { label: column.pickerLabel, direction: s.dir };
    return out;
  }

  const helpers = {
    PERIODS: PERIODS, METRICS: METRICS, COLUMNS: COLUMNS, escapeHtml: escapeHtml, formatValue: formatValue, formatShare: formatShare,
    formatPeriodRange: formatPeriodRange, formatStamp: formatStamp, topCustomersHtml: topCustomersHtml, topCustomerLines: topCustomerLines,
    rowHtml: rowHtml, buildQuery: buildQuery, nextSort: nextSort, sortAction: sortAction, exportContext: exportContext
  };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;
  if (typeof window === 'undefined' || !window.document) return;

  // ---------- giao diện ----------
  const API = '/api/product-report/90d';
  const FRESH_MS = 5 * 60 * 1000; // bảng tính 1 lần/đêm: quay lại tab sau 5 phút mới hỏi lại máy chủ
  const SEARCH_DELAY = 150;
  const SORT_GLYPH = { none: '▲▼', ascending: '▼', descending: '▲' };
  const NOT_LOADED = 'Chưa nạp báo cáo Hàng hóa 90 ngày. Báo cáo được tính sẵn lúc 02:00 hằng ngày; vui lòng quay lại sau lượt tính đầu tiên.';
  const GENERIC_ERROR = 'Không tải được báo cáo Hàng hóa 90 ngày.';

  const $ = function (id) { return document.getElementById(id); };
  const can = function (key) { return !!(window.TKSNav && typeof window.TKSNav.can === 'function' && window.TKSNav.can(key)); };

  function freshState() {
    return { q: '', sort: '', dir: '', page: 1, pageSize: 50, data: null, error: '', loading: false, seq: 0,
      controller: null, pending: null, loadedAt: 0, timer: null, composing: false };
  }
  let state = freshState();
  let initialized = false;
  let tableMode = '';

  function screenMode() { return window.innerWidth <= 600 ? 'mobile' : 'desktop'; }

  // Bật table-controls với nhãn đầy đủ cho hộp "Cột hiển thị" (vd "T.này – SL") và độ rộng theo cỡ màn hình.
  // Gọi ngay khi nạp script (trước lần dựng tự động của table-controls) để phiên cột nhận đúng độ rộng mặc định.
  function setupTable() {
    const table = $('product90dTable');
    if (!table || !window.TKSTables || typeof window.TKSTables.enhance !== 'function') return;
    const mode = screenMode();
    if (mode === tableMode) return;
    tableMode = mode;
    window.TKSTables.enhance(table, {
      columns: COLUMNS.map(function (c) { return { key: c.key, label: c.pickerLabel, width: mode === 'mobile' ? c.mobile : c.width }; })
    });
    syncSticky();
  }

  // Cột Tên dính sau cột Mã: left = độ rộng đang thấy của cột Mã (0 khi ẩn); tầng tiêu đề 2 dính dưới tầng 1.
  // Gọi khi vẽ lại và từ ResizeObserver (đổi cỡ khung, kéo/ẩn cột); mục đang ẩn (chưa có bố cục) thì giữ nguyên giá trị cũ.
  function syncSticky() {
    const table = $('product90dTable');
    if (!table || !table.tHead || !table.getClientRects().length) return;
    const code = table.tHead.querySelector('th[data-column-key="product_code"]');
    const codeWidth = code && !code.classList.contains('tks-column-hidden') ? code.getBoundingClientRect().width : 0;
    const group = Array.from(table.tHead.rows[0].cells).find(function (cell) {
      return cell.classList.contains('p90-group') && !cell.classList.contains('tks-column-hidden');
    });
    const rowTop = group ? group.getBoundingClientRect().height : 0;
    const frame = $('product90dScroll');
    const frameWidth = frame ? Math.max(0, frame.clientWidth - 18) + 'px' : '';
    if (frameWidth && table.style.getPropertyValue('--p90-frame-w') !== frameWidth) table.style.setProperty('--p90-frame-w', frameWidth);
    const nameCell = table.tHead.querySelector('th[data-column-key="product_name"]');
    const nameWidth = nameCell && !nameCell.classList.contains('tks-column-hidden') ? nameCell.getBoundingClientRect().width : 0;
    const stickyWidth = Math.round((codeWidth + nameWidth) * 100) / 100 + 'px';
    if (table.style.getPropertyValue('--p90-sticky-w') !== stickyWidth) table.style.setProperty('--p90-sticky-w', stickyWidth);
    const left = Math.round(codeWidth * 100) / 100 + 'px';
    const top = Math.round(rowTop * 100) / 100 + 'px';
    if (table.style.getPropertyValue('--p90-name-left') !== left) table.style.setProperty('--p90-name-left', left);
    if (table.style.getPropertyValue('--p90-row2-top') !== top) table.style.setProperty('--p90-row2-top', top);
  }
  function observeSticky() {
    const table = $('product90dTable');
    if (!table || typeof window.ResizeObserver !== 'function') return;
    // ResizeObserver đã chạy đúng nhịp vẽ: đồng bộ ngay (không qua rAF, vốn bị treo ở tab nền / màn giả lập).
    const observer = new window.ResizeObserver(syncSticky);
    observer.observe(table);
    if ($('product90dScroll')) observer.observe($('product90dScroll'));
    table.tHead.querySelectorAll('th').forEach(function (th) { observer.observe(th); });
  }

  // ---------- vẽ ----------
  function noteRow(html) {
    // Ô ghi chú trải 26 cột (rộng hơn khung nhiều): nội dung dính mép trái + rộng bằng khung để thông báo và nút Thử lại luôn thấy.
    return '<tr><td colspan="' + COLUMNS.length + '" class="table-note p90-note"><div class="p90-note-inner">' + html + '</div></td></tr>';
  }

  function totalPages() {
    const d = state.data;
    return d && d.available && d.totalRows ? Math.max(1, Math.ceil(Number(d.totalRows) / state.pageSize)) : 1;
  }

  function renderHeader() {
    const d = state.data;
    const periods = d && d.available && Array.isArray(d.periods) ? d.periods : [];
    document.querySelectorAll('#product90dTable th.p90-group').forEach(function (th) {
      const period = periods.find(function (p) { return p && p.key === th.dataset.period; });
      const range = th.querySelector('.p90-group-range');
      const text = period ? formatPeriodRange(period.from, period.to) : '';
      if (range && range.textContent !== text) range.textContent = text;
    });
    document.querySelectorAll('#product90dTable th.sortable[data-sort]').forEach(function (th) {
      const active = state.sort === th.dataset.sort;
      const mode = active ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none';
      if (th.getAttribute('aria-sort') !== mode) th.setAttribute('aria-sort', mode);
      th.classList.toggle('sort-active', active);
      const mark = th.querySelector('.sort-indicator');
      if (mark && mark.textContent !== SORT_GLYPH[mode]) mark.textContent = SORT_GLYPH[mode];
      const button = th.querySelector('.sort-button');
      const column = COLUMNS.find(function (c) { return c.key === th.dataset.sort; });
      if (button && column) {
        const title = sortAction(mode) + ' theo ' + column.pickerLabel;
        const aria = sortAction(mode) + ' theo cột ' + column.pickerLabel;
        if (button.title !== title) button.title = title;
        if (button.getAttribute('aria-label') !== aria) button.setAttribute('aria-label', aria);
      }
    });
  }

  function renderBody() {
    const body = $('product90dRows');
    const d = state.data;
    if (state.error) {
      body.innerHTML = noteRow('<span class="p90-error" role="alert">' + escapeHtml(state.error) + '</span> ' +
        '<button type="button" class="btn-secondary p90-retry" data-action="retry">Thử lại</button>');
      return;
    }
    if (!d) { body.innerHTML = noteRow('Đang tải...'); return; }
    if (!d.available) { body.innerHTML = noteRow(escapeHtml(NOT_LOADED)); return; }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) {
      body.innerHTML = noteRow(state.q
        ? 'Không có mã hàng nào khớp “' + escapeHtml(state.q) + '”.'
        : 'Báo cáo chưa có mã hàng nào.');
      return;
    }
    body.innerHTML = rows.map(rowHtml).join('');
  }

  function renderMeta() {
    const d = state.data;
    const ok = !state.error && d && d.available;
    const stamp = ok && d.state ? formatStamp(d.state.computedAt) : '';
    $('product90dUpdatedAt').textContent = stamp ? 'Dữ liệu cập nhật lúc ' + stamp : '—';
    const total = ok ? Number(d.totalRows) || 0 : 0;
    $('tagProduct90dRows').textContent = ok ? NUMBER.format(total) + ' mã' : '—';
    const busy = state.loading && !!d && !state.error;
    const frame = $('product90dScroll');
    frame.classList.toggle('is-busy', busy);
    if (busy || (state.loading && !d)) frame.setAttribute('aria-busy', 'true'); else frame.removeAttribute('aria-busy');
    $('product90dStatus').textContent = state.loading ? (d ? 'Đang cập nhật…' : 'Đang tải…') : '';
    const pages = totalPages();
    $('product90dPagination').hidden = !ok || total === 0;
    $('product90dPageLabel').textContent = 'Trang ' + state.page + '/' + pages;
    $('product90dFirstPage').disabled = $('product90dPrevPage').disabled = state.page <= 1;
    $('product90dNextPage').disabled = $('product90dLastPage').disabled = state.page >= pages;
    const clear = $('product90dSearchClear');
    if (clear) clear.hidden = !$('product90dSearch').value;
    // Nút Xuất file: ẩn khi tài khoản không có quyền xuất; khóa khi chưa có ảnh chụp / lỗi / đang tải / tìm không ra.
    const exportButton = $('product90dExportButton');
    if (exportButton) {
      exportButton.hidden = !can('reports.export');
      const ready = ok && total > 0 && !state.loading;
      exportButton.disabled = !ready;
      exportButton.title = ready ? 'Xuất Excel hoặc HTML đúng từ khóa và cột đang sắp xếp' : 'Chưa có dữ liệu để xuất';
    }
  }

  // Mở hộp thoại "Xuất file" dùng chung (index.html openExportDialog → buildExportPayload đọc exportState()).
  function openExport() {
    if (typeof window.openExportDialog === 'function') window.openExportDialog('products.product90d');
  }
  function exportState() { return exportContext({ q: state.q, sort: state.sort, dir: state.dir }); }

  function render() {
    if (!$('product90dRows')) return;
    renderHeader();
    renderBody();
    renderMeta();
    syncSticky();
  }

  // ---------- tải ----------
  function readJson(res) {
    if (res.status === 401) {
      window.location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
      return Promise.reject(Object.assign(new Error('Phiên đăng nhập đã hết hạn.'), { status: 401 }));
    }
    return res.json().catch(function () { return {}; }).then(function (body) {
      if (!res.ok) throw Object.assign(new Error((body && body.error) || 'HTTP ' + res.status), { status: res.status });
      return body;
    });
  }

  // Mỗi lần gọi: hủy yêu cầu cũ (AbortController) + số thứ tự — phản hồi cũ về muộn KHÔNG ghi đè truy vấn/sắp xếp/trang mới hơn.
  function fetchPage() {
    const seq = ++state.seq;
    if (state.controller) { try { state.controller.abort(); } catch (_) { /* đã xong */ } }
    const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    state.controller = controller;
    state.loading = true;
    state.error = '';
    render();
    const url = API + '?' + buildQuery({ q: state.q, sort: state.sort, dir: state.dir, page: state.page, pageSize: state.pageSize });
    const options = { credentials: 'same-origin' };
    if (controller) options.signal = controller.signal;
    let request;
    try { request = Promise.resolve(window.fetch(url, options)); } catch (err) { request = Promise.reject(err); }
    const pending = request.then(readJson).then(function (data) {
      if (seq !== state.seq) return;
      state.data = data && typeof data === 'object' ? data : { available: false, rows: [], totalRows: 0 };
      if (state.data.available && Number.isInteger(Number(state.data.page)) && Number(state.data.page) >= 1) state.page = Number(state.data.page);
      state.loadedAt = Date.now();
    }, function (err) {
      if (seq !== state.seq || (err && err.name === 'AbortError')) return;
      if (err && err.status === 401) return;
      console.error('Không tải được báo cáo Hàng hóa 90 ngày:', err);
      // Lỗi KHÔNG được thành bảng số 0: bỏ dữ liệu, chỉ hiện thông báo + Thử lại.
      state.data = null;
      state.error = err && err.status && err.status < 500 && err.message && !/^HTTP /.test(err.message)
        ? err.message : GENERIC_ERROR;
    }).then(function () {
      if (seq !== state.seq) return;
      state.loading = false;
      state.controller = null;
      state.pending = null;
      render();
    });
    state.pending = pending;
    return pending;
  }

  function scheduleSearch() {
    clearTimeout(state.timer);
    const input = $('product90dSearch');
    const value = input.value.trim();
    const run = function () {
      state.timer = null;
      if (value === state.q) return;
      state.q = value;
      state.page = 1;
      fetchPage();
    };
    if (!value) run(); else state.timer = setTimeout(run, SEARCH_DELAY);
    const clear = $('product90dSearchClear');
    if (clear) clear.hidden = !input.value;
  }

  function onSortClick(event) {
    // Bấm nút hoặc phần đệm của ô tiêu đề (ngoài nút) đều sắp xếp — quy ước chung (table-controls.js); tay kéo độ rộng thì không.
    const button = event.target.closest('.sort-button');
    const th = button ? button.closest('th.sortable[data-sort]')
      : (event.target.matches && event.target.matches('th.sortable[data-sort]') ? event.target : null);
    if (!th) return;
    event.preventDefault();
    const next = nextSort({ sort: state.sort, dir: state.dir }, th.dataset.sort);
    state.sort = next.sort;
    state.dir = next.dir;
    state.page = 1;
    fetchPage();
  }

  function goTo(target) {
    const page = Math.min(Math.max(1, target), totalPages());
    if (page === state.page) return;
    state.page = page;
    fetchPage();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    setupTable();
    $('product90dTable').tHead.addEventListener('click', onSortClick);
    const input = $('product90dSearch');
    input.addEventListener('compositionstart', function () { state.composing = true; });
    input.addEventListener('compositionend', function () { state.composing = false; scheduleSearch(); });
    input.addEventListener('input', function (event) {
      if (state.composing || event.isComposing) return; // đang gõ bộ gõ (IME): chờ compositionend
      scheduleSearch();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; scheduleSearch(); }
    });
    const clear = $('product90dSearchClear');
    if (clear) clear.addEventListener('click', function () { input.value = ''; scheduleSearch(); input.focus(); });
    $('product90dPageSize').addEventListener('change', function (event) {
      state.pageSize = Number(event.target.value) || 50;
      state.page = 1;
      fetchPage();
    });
    $('product90dFirstPage').addEventListener('click', function () { goTo(1); });
    $('product90dPrevPage').addEventListener('click', function () { goTo(state.page - 1); });
    $('product90dNextPage').addEventListener('click', function () { goTo(state.page + 1); });
    $('product90dLastPage').addEventListener('click', function () { goTo(totalPages()); });
    // Thử lại: chỉ gọi lại API với đúng truy vấn hiện tại.
    $('product90dRows').addEventListener('click', function (event) {
      if (event.target.closest('[data-action="retry"]')) fetchPage();
    });
    window.addEventListener('resize', setupTable);
    observeSticky();
  }

  function allowed() { return can('reports.products') && can('reports.products.sales'); }

  /** Mở tab Hàng hóa: ẩn mục khi thiếu quyền (không gọi API); có quyền thì tải nếu chưa có dữ liệu hoặc đã cũ (force = luôn tải). */
  function load(force) {
    const section = $('product90dSection');
    if (!section) return Promise.resolve();
    const ok = allowed();
    section.hidden = !ok;
    if (!ok) return Promise.resolve();
    init();
    if (state.pending) return state.pending;
    if (!force && state.data && !state.error && Date.now() - state.loadedAt < FRESH_MS) return Promise.resolve();
    return fetchPage();
  }

  /** Về trạng thái ban đầu (hủy yêu cầu đang chạy, xóa tìm kiếm/sắp xếp/trang). */
  function reset() {
    if (state.controller) { try { state.controller.abort(); } catch (_) { /* đã xong */ } }
    clearTimeout(state.timer);
    const seq = state.seq + 1;
    state = freshState();
    state.seq = seq;
    const input = $('product90dSearch');
    if (input) input.value = '';
    const size = $('product90dPageSize');
    if (size) size.value = '50';
    render();
  }

  window.TKSProduct90d = { load: load, reset: reset, helpers: helpers, exportState: exportState, openExport: openExport };
  if ($('product90dTable')) setupTable();
})();
