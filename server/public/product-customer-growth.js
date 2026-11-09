/* Tab Hàng hóa — mục 4 "Hàng hóa 90 ngày": bảng Khách hàng theo sản phẩm (mỗi dòng một cặp sản phẩm × khách) kèm Tăng trưởng
   (API chỉ đọc /api/product-report/customer-growth, quyền reports.products + reports.products.sales). Tăng trưởng = T.này ÷
   trung bình(T.trước, T.trước nữa) − 1, do máy chủ tính; ba mức màu theo %: đỏ ≤ −100% (không còn doanh số), cam −100%..−50%, vàng −50%..0 (chỉ hiện %). Lọc tên sản phẩm / tên khách /
   nhóm tăng trưởng, sắp xếp và phân trang đều ở máy chủ trên TOÀN BỘ kết quả. thead tĩnh trong index.html (1 tầng, khớp COLUMNS
   bên dưới — test/frontend/product-customer-growth.test.js khóa khớp). Ẩn/hiện cột + kéo độ rộng: shared/table-controls.js
   (data-table-sort="off": trang tự sắp xếp qua API). Phần đầu file là hàm thuần (không đụng DOM) — Node require() được để test. */
(function () {
  'use strict';

  // ---------- hàm thuần ----------
  // sort = khóa sắp xếp gửi API (whitelist của máy chủ); field = tên trường trong dòng API; width = máy tính, mobile = màn hẹp (≤ 600px).
  const COLUMNS = [
    { key: 'product', label: 'Sản phẩm', sort: 'product_name', width: 280, mobile: 190, type: 'product' },
    { key: 'customer', label: 'Khách hàng', sort: 'customer_name', width: 240, mobile: 170, type: 'customer' },
    { key: 'revenue', label: 'DS 90 ngày', sort: 'revenue', field: 'revenue', width: 130, mobile: 110, type: 'money' },
    { key: 'revenue_1_30d', label: 'T.này', sort: 'revenue_1_30d', field: 'revenue1_30d', width: 120, mobile: 100, type: 'money', period: '1_30d' },
    { key: 'revenue_31_60d', label: 'T.trước', sort: 'revenue_31_60d', field: 'revenue31_60d', width: 120, mobile: 100, type: 'money', period: '31_60d' },
    { key: 'revenue_61_90d', label: 'T.trước nữa', sort: 'revenue_61_90d', field: 'revenue61_90d', width: 130, mobile: 110, type: 'money', period: '61_90d' },
    { key: 'share', label: '% của SP', sort: 'share', width: 150, mobile: 120, type: 'share' },
    { key: 'growth', label: 'Tăng trưởng', sort: 'growth', width: 170, mobile: 140, type: 'growth' }
  ];
  const GROWTH_OPTIONS = [
    ['all', 'Tất cả'], ['lost', 'Giảm hết 100%'], ['check', 'Giảm hơn 50%'], ['drop', 'Giảm dưới 50%'],
    ['up', 'Đang tăng'], ['new', 'Khách mới']
  ];
  const GROWTH_VALUES = GROWTH_OPTIONS.map(function (option) { return option[0]; });

  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
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

  // Làm tròn nửa ra xa số 0, KHÔNG BAO GIỜ trả -0 (chỉ để HIỂN THỊ; màu đỏ/nhóm lọc do máy chủ quyết định trên giá trị gốc).
  function roundTo(n, digits) {
    const k = Math.pow(10, digits);
    const r = n < 0 ? -Math.round(-n * k) / k : Math.round(n * k) / k;
    return r === 0 ? 0 : r;
  }

  // NULL/không phải số → "—"; 0 → "0"; số tiền hiển thị KHÔNG có phần thập phân (en-US: 26920000 → "26,920,000").
  function formatMoney(value) {
    const n = toNumber(value);
    return n === null ? DASH : NUMBER.format(roundTo(n, 0));
  }

  // share là tỷ lệ 0–1 → "45.2%".
  function formatShare(value) {
    const n = toNumber(value);
    return n === null ? DASH : PERCENT.format(roundTo(n * 100, 1)) + '%';
  }

  // growth là tỷ lệ (−0.625 = −62.5%) → "-62.5%", số dương có dấu "+" ("+12.5%"), 0 → "0%".
  function formatGrowth(value) {
    const n = toNumber(value);
    if (n === null) return DASH;
    const pct = roundTo(n * 100, 1);
    return (pct > 0 ? '+' : '') + PERCENT.format(pct) + '%';
  }

  function parseDay(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: m[1], m: m[2], d: m[3] } : null;
  }

  // Khoảng ngày thực tế của kỳ: cùng năm "07/10–05/11/2026", khác năm "15/12/2025–13/01/2026"; thiếu ngày → "".
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

  function muted() { return '<span class="muted">' + DASH + '</span>'; }

  // lost/check/drop → chỉ hiện %, tô đỏ / cam / vàng (lớp is-lost / is-check / is-drop) kèm title mô tả mức; new → nhãn "Mới";
  // không tính được → "—"; tăng (up) chỉ hiện % không màu.
  const TIER_TITLES = { lost: 'Giảm hết 100%', check: 'Giảm hơn 50%', drop: 'Giảm dưới 50%' };
  function growthCellHtml(row) {
    const state = row ? row.growthState : null;
    const n = toNumber(row ? row.growth : null);
    if (state === 'new') return '<td class="col-num pcg-growth"><span class="pcg-new" title="Chưa có doanh số 2 kỳ trước">Mới</span></td>';
    if (n === null || !state) return '<td class="col-num pcg-growth">' + muted() + '</td>';
    const tier = TIER_TITLES[state];
    return '<td class="col-num pcg-growth' + (tier ? ' is-' + state : '') + '"' + (tier ? ' title="' + tier + '"' : '') + '>' +
      '<span class="pcg-pct">' + escapeHtml(formatGrowth(n)) + '</span></td>';
  }

  function shareCellHtml(value) {
    const n = toNumber(value);
    if (n === null) return '<td class="col-num">' + muted() + '</td>';
    const width = Math.max(0, Math.min(100, roundTo(n * 100, 1)));
    return '<td class="col-num"><span class="pcg-share"><span>' + escapeHtml(formatShare(n)) + '</span>' +
      '<span class="pcg-bar"><i style="width:' + width + '%"></i></span></span></td>';
  }

  function cellHtml(row, column) {
    const r = row || {};
    if (column.type === 'product') {
      return '<td class="name-cell"><span class="pcg-code">' + escapeHtml(r.productCode) + '</span><span class="pcg-name">' + escapeHtml(r.productName) + '</span></td>';
    }
    if (column.type === 'customer') return '<td class="name-cell">' + (String(r.customerName || '').trim() ? escapeHtml(r.customerName) : 'Khách lẻ') + '</td>';
    if (column.type === 'share') return shareCellHtml(r.share);
    if (column.type === 'growth') return growthCellHtml(r);
    const text = formatMoney(r[column.field]);
    return '<td class="col-num">' + (text === DASH ? muted() : escapeHtml(text)) + '</td>';
  }

  function rowHtml(row) {
    return '<tr>' + COLUMNS.map(function (column) { return cellHtml(row, column); }).join('') + '</tr>';
  }

  function trimmed(value) { return typeof value === 'string' ? value.trim().slice(0, 200) : ''; }

  // Chuỗi truy vấn: BỎ tham số rỗng (máy chủ chỉ nhận chuỗi hợp lệ); growth=all không gửi; dir chỉ đi kèm sort.
  function buildQuery(params) {
    const p = params || {};
    const out = new URLSearchParams();
    const product = trimmed(p.product), customer = trimmed(p.customer);
    if (product) out.set('product', product);
    if (customer) out.set('customer', customer);
    if (GROWTH_VALUES.indexOf(p.growth) > 0) out.set('growth', p.growth);
    if (p.sort) {
      out.set('sort', p.sort);
      if (p.dir === 'asc' || p.dir === 'desc') out.set('dir', p.dir);
    }
    const page = Number(p.page);
    if (Number.isInteger(page) && page >= 1) out.set('page', String(page));
    const size = Number(p.pageSize);
    if (Number.isInteger(size) && size >= 1) out.set('pageSize', String(Math.min(200, size)));
    return out.toString();
  }

  // Thứ tự bấm tiêu đề: tăng dần → giảm dần → bỏ sắp xếp (thứ tự mặc định của máy chủ: DS 90 ngày giảm dần).
  function nextSort(current, key) {
    if (!current || current.sort !== key) return { sort: key, dir: 'asc' };
    if (current.dir === 'asc') return { sort: key, dir: 'desc' };
    return { sort: '', dir: '' };
  }

  // Chữ của nút sắp xếp báo hành động KẾ TIẾP khi bấm: chưa sắp → tăng dần → giảm dần → bỏ sắp xếp.
  function sortAction(mode) {
    return mode === 'ascending' ? 'Sắp xếp giảm dần' : mode === 'descending' ? 'Bỏ sắp xếp' : 'Sắp xếp tăng dần';
  }

  // Ngữ cảnh gửi hộp thoại "Xuất file" (POST /api/export, tableKey products.productCustomerGrowth): đúng bộ lọc ĐANG áp dụng.
  function exportContext(current) {
    const s = current || {};
    const context = {
      productQuery: trimmed(s.product),
      customerQuery: trimmed(s.customer),
      growthGroup: GROWTH_VALUES.indexOf(s.growth) >= 0 ? s.growth : 'all'
    };
    if (s.sort) {
      context.sortKey = s.sort;
      context.sortDir = s.dir === 'asc' ? 'asc' : 'desc';
    }
    return { context: context };
  }

  const helpers = {
    COLUMNS: COLUMNS, GROWTH_OPTIONS: GROWTH_OPTIONS, escapeHtml: escapeHtml, formatMoney: formatMoney, formatShare: formatShare,
    formatGrowth: formatGrowth, formatPeriodRange: formatPeriodRange, formatStamp: formatStamp, growthCellHtml: growthCellHtml,
    rowHtml: rowHtml, buildQuery: buildQuery, nextSort: nextSort, sortAction: sortAction, exportContext: exportContext
  };
  if (typeof module === 'object' && module && module.exports) module.exports = helpers;
  if (typeof window === 'undefined' || !window.document) return;

  // ---------- giao diện ----------
  const API = '/api/product-report/customer-growth';
  const FRESH_MS = 5 * 60 * 1000; // số liệu làm mới sau mỗi lượt đồng bộ: quay lại tab sau 5 phút mới hỏi lại máy chủ
  const SEARCH_DELAY = 150;
  const SORT_GLYPH = { none: '▲▼', ascending: '▼', descending: '▲' };
  const NOT_LOADED = 'Chưa có dữ liệu kỳ của khách theo sản phẩm. Số liệu được tính sau mỗi lượt đồng bộ KiotViet; vui lòng quay lại sau.';
  const GENERIC_ERROR = 'Không tải được báo cáo khách hàng theo sản phẩm.';

  const $ = function (id) { return document.getElementById(id); };
  const can = function (key) { return !!(window.TKSNav && typeof window.TKSNav.can === 'function' && window.TKSNav.can(key)); };

  function freshState() {
    return {
      product: '', customer: '', growth: 'all', sort: '', dir: '', page: 1, pageSize: 50,
      data: null, error: '', loading: false, seq: 0, controller: null, pending: null, loadedAt: 0,
      timers: { product: null, customer: null }, composing: { product: false, customer: false }
    };
  }
  let state = freshState();
  let initialized = false;
  let tableMode = '';

  function screenMode() { return window.innerWidth <= 600 ? 'mobile' : 'desktop'; }

  // Bật table-controls với nhãn đầy đủ cho hộp "Cột hiển thị" và độ rộng theo cỡ màn hình.
  // Gọi ngay khi nạp script (trước lần dựng tự động của table-controls) để phiên cột nhận đúng độ rộng mặc định.
  function setupTable() {
    const table = $('pcgTable');
    if (!table || !window.TKSTables || typeof window.TKSTables.enhance !== 'function') return;
    const mode = screenMode();
    if (mode === tableMode) return;
    tableMode = mode;
    window.TKSTables.enhance(table, {
      columns: COLUMNS.map(function (c) { return { key: c.key, label: c.label, width: mode === 'mobile' ? c.mobile : c.width }; })
    });
  }

  // ---------- vẽ ----------
  function noteRow(html) {
    return '<tr><td colspan="' + COLUMNS.length + '" class="table-note pcg-note"><div class="pcg-note-inner">' + html + '</div></td></tr>';
  }

  function totalRows() {
    const d = state.data;
    return d && d.available && d.summary ? Number(d.summary.totalRows) || 0 : 0;
  }
  function totalPages() {
    return Math.max(1, Math.ceil(totalRows() / state.pageSize));
  }

  function renderHeader() {
    const d = state.data;
    const periods = d && d.available && Array.isArray(d.periods) ? d.periods : [];
    document.querySelectorAll('#pcgTable th.sortable[data-sort]').forEach(function (th) {
      const column = COLUMNS.find(function (c) { return c.key === th.dataset.columnKey; });
      const active = state.sort === th.dataset.sort;
      const mode = active ? (state.dir === 'desc' ? 'descending' : 'ascending') : 'none';
      if (th.getAttribute('aria-sort') !== mode) th.setAttribute('aria-sort', mode);
      th.classList.toggle('sort-active', active);
      const mark = th.querySelector('.sort-indicator');
      if (mark && mark.textContent !== SORT_GLYPH[mode]) mark.textContent = SORT_GLYPH[mode];
      const button = th.querySelector('.sort-button');
      if (button && column) {
        const period = column.period ? periods.find(function (p) { return p && p.key === column.period; }) : null;
        const range = period ? formatPeriodRange(period.from, period.to) : '';
        const title = sortAction(mode) + ' theo ' + column.label + (range ? ' (' + range + ')' : '');
        const aria = sortAction(mode) + ' theo cột ' + column.label;
        if (button.title !== title) button.title = title;
        if (button.getAttribute('aria-label') !== aria) button.setAttribute('aria-label', aria);
      }
    });
  }

  function hasFilter() { return !!(state.product || state.customer || state.growth !== 'all'); }

  function renderBody() {
    const body = $('pcgRows');
    const d = state.data;
    if (state.error) {
      body.innerHTML = noteRow('<span class="pcg-error" role="alert">' + escapeHtml(state.error) + '</span> ' +
        '<button type="button" class="btn-secondary pcg-retry" data-action="retry">Thử lại</button>');
      return;
    }
    if (!d) { body.innerHTML = noteRow('Đang tải...'); return; }
    if (!d.available) { body.innerHTML = noteRow(escapeHtml(NOT_LOADED)); return; }
    const rows = Array.isArray(d.rows) ? d.rows : [];
    if (!rows.length) {
      body.innerHTML = noteRow(hasFilter() ? 'Không có dòng nào khớp bộ lọc.' : 'Chưa có dữ liệu khách theo sản phẩm.');
      return;
    }
    body.innerHTML = rows.map(rowHtml).join('');
  }

  function renderMeta() {
    const d = state.data;
    const ok = !state.error && d && d.available;
    const stamp = ok && d.state ? formatStamp(d.state.computedAt) : '';
    $('pcgUpdatedAt').textContent = stamp ? 'Dữ liệu cập nhật lúc ' + stamp : '—';
    const total = ok ? totalRows() : 0;
    const lost = ok && d.summary ? Number(d.summary.lostRows) || 0 : 0;
    const check = ok && d.summary ? Number(d.summary.checkRows) || 0 : 0;
    $('pcgRowsTag').textContent = ok ? NUMBER.format(total) + ' dòng' : '—';
    const busy = state.loading && !!d && !state.error;
    const frame = $('pcgScroll');
    frame.classList.toggle('is-busy', busy);
    if (busy || (state.loading && !d)) frame.setAttribute('aria-busy', 'true'); else frame.removeAttribute('aria-busy');
    $('pcgStatus').textContent = state.loading ? (d ? 'Đang cập nhật…' : 'Đang tải…')
      : ok ? NUMBER.format(total) + ' dòng khớp · ' + NUMBER.format(lost) + ' giảm hết 100% · ' + NUMBER.format(check) + ' giảm hơn 50%' : '';
    const pages = totalPages();
    $('pcgPagination').hidden = !ok || total === 0;
    $('pcgPageLabel').textContent = 'Trang ' + state.page + '/' + pages;
    $('pcgFirstPage').disabled = $('pcgPrevPage').disabled = state.page <= 1;
    $('pcgNextPage').disabled = $('pcgLastPage').disabled = state.page >= pages;
    ['Product', 'Customer'].forEach(function (name) {
      const clear = $('pcg' + name + 'Clear');
      if (clear) clear.hidden = !$('pcg' + name + 'Search').value;
    });
    // Nút Xuất file: ẩn khi tài khoản không có quyền xuất; khóa khi chưa có dữ liệu / lỗi / đang tải / lọc không ra dòng nào.
    const exportButton = $('pcgExportButton');
    if (exportButton) {
      exportButton.hidden = !can('reports.export');
      const ready = ok && total > 0 && !state.loading;
      exportButton.disabled = !ready;
      exportButton.title = ready ? 'Xuất Excel hoặc HTML đúng bộ lọc và cột đang sắp xếp' : 'Chưa có dữ liệu để xuất';
    }
  }

  // Mở hộp thoại "Xuất file" dùng chung (index.html openExportDialog → buildExportPayload đọc exportState()).
  function openExport() {
    if (typeof window.openExportDialog === 'function') window.openExportDialog('products.productCustomerGrowth');
  }
  function exportState() {
    return exportContext({ product: state.product, customer: state.customer, growth: state.growth, sort: state.sort, dir: state.dir });
  }

  function render() {
    if (!$('pcgRows')) return;
    renderHeader();
    renderBody();
    renderMeta();
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

  // Mỗi lần gọi: hủy yêu cầu cũ (AbortController) + số thứ tự — phản hồi cũ về muộn KHÔNG ghi đè bộ lọc/sắp xếp/trang mới hơn.
  function fetchPage() {
    const seq = ++state.seq;
    if (state.controller) { try { state.controller.abort(); } catch (_) { /* đã xong */ } }
    const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    state.controller = controller;
    state.loading = true;
    state.error = '';
    render();
    const url = API + '?' + buildQuery({
      product: state.product, customer: state.customer, growth: state.growth, sort: state.sort, dir: state.dir,
      page: state.page, pageSize: state.pageSize
    });
    const options = { credentials: 'same-origin' };
    if (controller) options.signal = controller.signal;
    let request;
    try { request = Promise.resolve(window.fetch(url, options)); } catch (err) { request = Promise.reject(err); }
    const pending = request.then(readJson).then(function (data) {
      if (seq !== state.seq) return;
      state.data = data && typeof data === 'object' ? data : { available: false, rows: [], summary: { totalRows: 0, lostRows: 0, checkRows: 0 } };
      if (state.data.available && Number.isInteger(Number(state.data.page)) && Number(state.data.page) >= 1) state.page = Number(state.data.page);
      state.loadedAt = Date.now();
    }, function (err) {
      if (seq !== state.seq || (err && err.name === 'AbortError')) return;
      if (err && err.status === 401) return;
      console.error('Không tải được báo cáo khách hàng theo sản phẩm:', err);
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

  // Ô tìm kiếm có debounce; bỏ qua khi đang gõ bộ gõ (IME) và chờ compositionend; Esc / nút × xóa ô.
  function bindSearch(field, inputId, clearId) {
    const input = $(inputId), clear = $(clearId);
    const run = function () {
      state.timers[field] = null;
      const value = input.value.trim();
      if (value === state[field]) return;
      state[field] = value;
      state.page = 1;
      fetchPage();
    };
    const schedule = function () {
      clearTimeout(state.timers[field]);
      if (clear) clear.hidden = !input.value;
      if (!input.value.trim()) run(); else state.timers[field] = setTimeout(run, SEARCH_DELAY);
    };
    input.addEventListener('compositionstart', function () { state.composing[field] = true; });
    input.addEventListener('compositionend', function () { state.composing[field] = false; schedule(); });
    input.addEventListener('input', function (event) {
      if (state.composing[field] || event.isComposing) return;
      schedule();
    });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && input.value) { event.preventDefault(); input.value = ''; schedule(); }
    });
    if (clear) clear.addEventListener('click', function () { input.value = ''; schedule(); input.focus(); });
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
    $('pcgTable').tHead.addEventListener('click', onSortClick);
    bindSearch('product', 'pcgProductSearch', 'pcgProductClear');
    bindSearch('customer', 'pcgCustomerSearch', 'pcgCustomerClear');
    $('pcgGrowth').addEventListener('change', function (event) {
      state.growth = GROWTH_VALUES.indexOf(event.target.value) >= 0 ? event.target.value : 'all';
      state.page = 1;
      fetchPage();
    });
    $('pcgPageSize').addEventListener('change', function (event) {
      state.pageSize = Number(event.target.value) || 50;
      state.page = 1;
      fetchPage();
    });
    $('pcgFirstPage').addEventListener('click', function () { goTo(1); });
    $('pcgPrevPage').addEventListener('click', function () { goTo(state.page - 1); });
    $('pcgNextPage').addEventListener('click', function () { goTo(state.page + 1); });
    $('pcgLastPage').addEventListener('click', function () { goTo(totalPages()); });
    // Thử lại: chỉ gọi lại API với đúng bộ lọc hiện tại.
    $('pcgRows').addEventListener('click', function (event) {
      if (event.target.closest('[data-action="retry"]')) fetchPage();
    });
    window.addEventListener('resize', setupTable);
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

  /** Về trạng thái ban đầu (hủy yêu cầu đang chạy, xóa bộ lọc/sắp xếp/trang). */
  function reset() {
    if (state.controller) { try { state.controller.abort(); } catch (_) { /* đã xong */ } }
    clearTimeout(state.timers.product);
    clearTimeout(state.timers.customer);
    const seq = state.seq + 1;
    state = freshState();
    state.seq = seq;
    ['pcgProductSearch', 'pcgCustomerSearch'].forEach(function (id) { if ($(id)) $(id).value = ''; });
    if ($('pcgGrowth')) $('pcgGrowth').value = 'all';
    if ($('pcgPageSize')) $('pcgPageSize').value = '50';
    render();
  }

  window.TKSProductCustomerGrowth = { load: load, reset: reset, helpers: helpers, exportState: exportState, openExport: openExport };
  if ($('pcgTable')) setupTable();
})();
