/* Tab Hóa đơn — mục 2 "Kiểm tra giá bán" (API /api/invoice-price-audit, quyền reports.invoices.priceAudit).
   MỘT bảng: thead tĩnh trong index.html sinh từ catalog cột (server/invoicePriceAudit/priceAuditColumns.js — 17 cột nghiệp vụ,
   15 hiện mặc định, cột đối chiếu ẩn, cùng bộ Cột hiển thị của table-controls). Lọc, sắp xếp, phân trang và chỉ số đều ở
   máy chủ trên toàn bộ tập đã lọc; trang chỉ nhận đúng 1 trang dòng, không tính giá trong trình duyệt.
   Sửa "Sale giải thích" (Lưu/Hủy, ≤ 4000 ký tự) và "Chốt" theo quyền từng dòng (canEditExplanation / canDecide)
   kèm expectedVersion; 409 → báo xung đột + nạp dòng mới nhất. Cơ sở theo bộ chọn HN/SG/Cả hai chung (cookie). */
(function () {
  'use strict';

  const API = '/api/invoice-price-audit';
  const FEATURE = 'reports.invoices.priceAudit';
  const MAX_EXPLANATION = 4000;
  const DEFAULT_STATUS = 'wrong';
  const FIELD_SIZING = !!(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));
  const BRANCH_SHORT = { hanoi: 'HN', saigon: 'SG' };
  const BRANCH_LABEL = { hanoi: 'Hà Nội', saigon: 'Sài Gòn' };
  const STATUS = { correct: ['Đúng giá', 'ok'], wrong: ['Sai giá', 'bad'] };
  const DECISION = { '': 'Chưa chốt', ok: 'Ok', penalty: 'Phạt' };
  const NO_SALE_LABEL = '(Chưa có sale)';
  const FILTER_IDS = {
    from: 'priceAuditFrom', to: 'priceAuditTo', sale: 'priceAuditSaleFilter', status: 'priceAuditStatusFilter',
    decision: 'priceAuditDecisionFilter', vat: 'priceAuditVatFilter', freight: 'priceAuditFreightFilter'
  };
  const UNSAVED_MESSAGE = 'Có nội dung "Sale giải thích" chưa lưu.\nBấm OK để BỎ nội dung chưa lưu và tiếp tục, Cancel để ở lại sửa tiếp.';
  const POPUP_NOTE = 'Hộp này là dữ liệu hóa đơn KiotViet hiện tại (đã đồng bộ), có thể khác bản đã ghi nhận lúc kiểm tra giá trong bảng.';
  const ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';

  const state = {
    columns: [], data: null, error: '', loading: false, seq: 0, loadedAt: 0, initialized: false,
    // Mặc định vào bảng: chỉ dòng Sai giá (chọn "Tất cả" = bỏ tham số status). Khớp option selected trong index.html.
    filters: { from: '', to: '', sale: '', status: DEFAULT_STATUS, decision: '', vat: '', freight: '', q: '' },
    page: 1, pageSize: 50, sort: '', dir: 'asc', sorts: [], salesSearch: '',
    editors: new Map() // rowKey -> { draft, saving, error }
  };

  const $ = id => document.getElementById(id);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const can = key => !!(window.TKSNav && typeof window.TKSNav.can === 'function' && window.TKSNav.can(key));
  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  // Tiền: không ký hiệu ₫, làm tròn số nguyên.
  const MONEY = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const isBlank = v => v === null || v === undefined || v === '';
  const fmtNumber = v => (isBlank(v) || !Number.isFinite(Number(v)) ? '—' : NUMBER.format(Number(v)));
  const fmtMoney = v => (isBlank(v) || !Number.isFinite(Number(v)) ? '—' : MONEY.format(Number(v)));
  const rowKey = r => r.branch + '/' + r.invoiceId + '/' + r.sourceLineNo;
  const muted = '<span class="muted">—</span>';

  function fmtLocal(value) {
    const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] + (m[4] ? ' ' + m[4] + ':' + m[5] : '') : (value ? String(value) : '—');
  }
  function fmtStamp(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function toast(message, type) {
    if (typeof window.showToast === 'function') window.showToast(message, type);
  }

  // ---------- trạng thái đầu bảng ----------
  function lastRunFailed(meta) {
    return !!(meta && meta.lastError && (!meta.lastSuccessAt || (meta.lastAttemptAt && meta.lastAttemptAt > meta.lastSuccessAt)));
  }

  function renderStatus() {
    const box = $('priceAuditStatus');
    const meta = state.data && state.data.meta;
    if (!meta) { box.innerHTML = state.loading ? '<div class="price-audit-meta">Đang tải…</div>' : ''; return; }
    if (!meta.available) {
      box.innerHTML = '<div class="debt-warning-item price-audit-empty"><strong>' + escape(meta.message || 'Chưa chạy kiểm tra giá') + '</strong>' +
        (meta.reason === 'not_migrated' ? '' : '<span> — bảng sẽ có dữ liệu sau lượt kiểm tra 23:00 đầu tiên chạy thành công.</span>') +
        (meta.lastError ? '<span class="price-audit-meta-error"> Lần chạy gần nhất (' + escape(fmtStamp(meta.lastAttemptAt)) + ') bị lỗi: ' + escape(meta.lastError) + '</span>' : '') +
        '</div>';
      return;
    }
    const stale = lastRunFailed(meta);
    box.innerHTML = '<div class="price-audit-meta' + (stale ? ' is-stale' : '') + '">' +
      '<span>Dữ liệu ngày bán <strong>' + escape(fmtLocal(meta.windowFrom)) + ' – ' + escape(fmtLocal(meta.windowTo)) + '</strong></span>' +
      '<span>Chạy thành công lúc ' + escape(fmtStamp(meta.lastSuccessAt)) + '</span>' +
      '<span>Bổ sung ' + escape(NUMBER.format(Number(meta.addedInvoiceCount) || 0)) + ' hóa đơn</span>' +
      '</div>' +
      (stale ? '<div class="debt-warning-item price-audit-stale" role="alert">Lần chạy kiểm tra giá lúc ' + escape(fmtStamp(meta.lastAttemptAt)) +
        ' bị lỗi: ' + escape(meta.lastError) + '. Bảng vẫn là dữ liệu của lần chạy thành công trước, <strong>không phải dữ liệu mới</strong>.</div>' : '');
  }

  function renderKpis() {
    const box = $('priceAuditKpis');
    const k = state.data && state.data.meta && state.data.meta.available ? state.data.kpis : null;
    if (!k) { box.innerHTML = ''; return; }
    const card = (span, label, value, accent, sub) => '<div class="kpi-card accent-' + accent + '"><div class="eyebrow">' + escape(label) +
      '</div><div class="value">' + escape(value) + '</div>' + (sub ? '<div class="sub">' + escape(sub) + '</div>' : '') + '</div>';
    box.innerHTML =
      card('col-4', 'Số hóa đơn', NUMBER.format(Number(k.invoiceCount) || 0), 'blue', 'không đếm trùng đơn nhiều dòng') +
      card('col-4', 'Dòng đúng giá', NUMBER.format(Number(k.correctLines) || 0), 'green', 'gồm dòng đã chốt Ok') +
      card('col-4', 'Dòng sai giá', NUMBER.format(Number(k.wrongLines) || 0), 'red') +
      card('col-6', 'Tiền chênh chưa chốt', fmtMoney(k.pendingAmount || 0), 'amber', 'dự kiến, chưa tính là phạt') +
      card('col-6', 'Tiền đã chốt Phạt', fmtMoney(k.penaltyAmount || 0), 'red');
  }

  // ---------- tiền phạt theo sale (cột phải mục 1) ----------
  // Dữ liệu = data.saleSummary do máy chủ cộng trên CÙNG bộ lọc với KPI (tổng mỗi cột = "Tiền chênh chưa chốt" /
  // "Tiền đã chốt Phạt"). Tìm theo tên sale chạy tại chỗ; sắp xếp + Cột hiển thị do table-controls.js lo.
  function salesRows() {
    const d = state.data;
    const all = d && d.meta && d.meta.available && Array.isArray(d.saleSummary) ? d.saleSummary : [];
    const query = state.salesSearch.trim();
    const fuzzy = window.TKSFuzzySearch;
    const shown = !query ? all : all.filter(r => (fuzzy ? fuzzy.matches(r.saleName || NO_SALE_LABEL, query)
      : String(r.saleName || NO_SALE_LABEL).toLowerCase().indexOf(query.toLowerCase()) >= 0));
    return { all, shown, query };
  }

  function renderSales() {
    const body = $('priceAuditSalesRows');
    const foot = $('priceAuditSalesFoot');
    if (!body) return;
    const d = state.data;
    const ok = !!(d && d.meta && d.meta.available);
    const { all, shown, query } = salesRows();
    $('tagPriceAuditSales').textContent = !ok ? '—' : query ? shown.length + '/' + all.length : String(all.length);
    $('priceAuditSalesSearchClear').hidden = !state.salesSearch;
    $('priceAuditSalesExportButton').hidden = !can('reports.export');
    foot.innerHTML = '';
    if (state.error) { body.innerHTML = '<tr><td colspan="3" class="table-note">' + escape(state.error) + '</td></tr>'; return; }
    if (!d) { body.innerHTML = '<tr><td colspan="3" class="table-note">Đang tải...</td></tr>'; return; }
    if (!ok) { body.innerHTML = '<tr><td colspan="3" class="table-note">' + escape((d.meta && d.meta.message) || 'Chưa chạy kiểm tra giá') + '</td></tr>'; return; }
    if (!shown.length) {
      body.innerHTML = '<tr><td colspan="3" class="table-note">' + (query ? 'Không có sale nào chứa “' + escape(query) + '”' : 'Không có sale nào có tiền phạt theo bộ lọc hiện tại') + '</td></tr>';
      return;
    }
    let pending = 0;
    let penalty = 0;
    body.innerHTML = shown.map(r => {
      const a = Number(r.pendingAmount) || 0;
      const b = Number(r.penaltyAmount) || 0;
      pending += a;
      penalty += b;
      return '<tr><td class="name-cell">' + escape(r.saleName || NO_SALE_LABEL) + '</td>' +
        '<td class="mono col-num" data-sort-value="' + a + '">' + escape(fmtMoney(a)) + '</td>' +
        '<td class="mono col-num debt-penalty-amount" data-sort-value="' + b + '">' + escape(fmtMoney(b)) + '</td></tr>';
    }).join('');
    foot.innerHTML = '<tr class="debt-penalty-total"><td>Tổng đang hiển thị</td><td class="mono col-num">' + escape(fmtMoney(pending)) +
      '</td><td class="mono col-num">' + escape(fmtMoney(penalty)) + '</td></tr>';
    // Giữ cột đang sắp xếp (bộ sắp xếp chung của trang) sau mỗi lần vẽ lại dòng.
    if (typeof window.applyActiveTableSorts === 'function') window.applyActiveTableSorts();
  }

  // ---------- bảng ----------
  // Cột lấy từ thead tĩnh trong index.html (sinh từ catalog priceAuditColumns.js; test khóa khớp catalog).
  function readColumns() {
    if (state.columns.length) return;
    state.columns = Array.from(document.querySelectorAll('#priceAuditHead th[data-column-key]')).map(th => ({
      key: th.dataset.columnKey, type: th.dataset.colType || 'text', wrap: th.dataset.colWrap === 'true'
    }));
  }

  function textCell(value, extraClass) {
    return '<td' + (extraClass ? ' class="' + extraClass + '"' : '') + '>' + (isBlank(value) ? muted : escape(value)) + '</td>';
  }

  // Ô "Sale giải thích" dùng chung kiểu ô Sale/QL phản hồi của tab Công nợ: textarea .debt-feedback-input luôn hiện
  // (tự giãn theo nội dung), dòng người lưu .debt-feedback-by bên dưới; chỉ khi đang gõ khác bản đã lưu mới hiện Lưu/Hủy
  // (giữ khóa lạc quan expectedVersion + xử lý 409 của Sai giá). Dòng không có quyền sửa chỉ đọc .debt-feedback-text.
  function explanationCell(r) {
    const key = rowKey(r);
    const editor = state.editors.get(key);
    const savedText = isBlank(r.saleExplanation) ? '' : String(r.saleExplanation);
    const by = r.explanationBy ? '<span class="debt-feedback-by">' + escape(r.explanationBy) + (r.explanationAt ? ' · ' + escape(fmtStamp(r.explanationAt)) : '') + '</span>' : '';
    const saved = savedText ? '<span class="debt-feedback-text">' + escape(savedText) + '</span>' + by : '';
    if (!r.canEditExplanation) return '<td class="price-audit-wrap">' + (saved || muted) + '</td>';
    const draft = editor ? editor.draft : savedText;
    const dirty = !!editor && (editor.draft !== savedText || !!editor.error || editor.saving);
    const busy = editor && editor.saving ? ' aria-busy="true" disabled' : '';
    const stale = !!(editor && editor.error && savedText);
    return '<td class="price-audit-wrap price-audit-editing">' +
      (stale ? '<div class="price-audit-current"><span class="price-audit-current-label">Nội dung hiện tại trên máy chủ:</span>' + saved + '</div>' : '') +
      '<textarea class="debt-feedback-input" rows="1" maxlength="' + MAX_EXPLANATION + '" data-action="draft" aria-label="Sale giải thích cho ' + escape(r.invoiceCode) + ' dòng ' + escape(r.sourceLineNo) + '"' + busy + '>' + escape(draft) + '</textarea>' +
      (stale ? '' : by) +
      '<div class="price-audit-edit-actions"' + (dirty ? '' : ' hidden') + '>' +
      '<button type="button" class="btn-primary price-audit-btn" data-action="save-explanation"' + busy + '>' + (editor && editor.saving ? 'Đang lưu…' : 'Lưu') + '</button>' +
      '<button type="button" class="btn-secondary price-audit-btn" data-action="cancel-explanation"' + (editor && editor.saving ? ' disabled' : '') + '>Hủy</button>' +
      '<span class="price-audit-count">' + draft.length + '/' + MAX_EXPLANATION + '</span></div>' +
      (editor && editor.error ? '<div class="price-audit-edit-error" role="alert">' + escape(editor.error) + '</div>' : '') +
      '</td>';
  }

  function decisionCell(r) {
    const current = r.decision || '';
    if (r.canDecide) {
      return '<td><select class="debt-status-select price-audit-decision" data-action="decision" data-status="' + escape(DECISION[current]) + '" aria-label="Chốt dòng ' + escape(r.invoiceCode) + '">' +
        Object.keys(DECISION).map(v => '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + DECISION[v] + '</option>').join('') +
        '</select></td>';
    }
    const locked = r.originalStatus !== 'wrong';
    return '<td><span class="price-audit-decision-text" data-status="' + escape(DECISION[current]) + '"' + (locked ? ' title="Chỉ dòng sai giá gốc mới được chốt"' : '') + '>' + escape(DECISION[current]) + '</span>' +
      (locked ? '<span class="price-audit-lock">' + ICON_LOCK + '</span>' : '') + '</td>';
  }

  function cellHtml(r, c) {
    const v = r[c.key];
    switch (c.key) {
      case 'invoiceCode':
        return '<td class="mono"><button type="button" class="price-audit-link" data-action="open-invoice" title="Mở chi tiết hóa đơn (dữ liệu KiotViet hiện tại)">' + escape(v) + '</button></td>';
      case 'saleExplanation': return explanationCell(r);
      case 'decision': return decisionCell(r);
      default: break;
    }
    switch (c.type) {
      case 'money': return '<td class="mono col-num">' + (isBlank(v) ? muted : escape(fmtMoney(v))) + '</td>';
      case 'number': return '<td class="mono col-num">' + (isBlank(v) ? muted : escape(fmtNumber(v))) + '</td>';
      case 'datetime': return '<td class="mono">' + escape(fmtLocal(v)) + '</td>';
      case 'timestamp': return '<td class="mono">' + (v ? escape(fmtStamp(v)) : muted) + '</td>';
      case 'branch': return '<td>' + escape(BRANCH_SHORT[v] || v || '—') + '</td>';
      case 'bool': return '<td>' + (v === true ? 'Có' : v === false ? 'Không' : muted) + '</td>';
      case 'status': return '<td>' + (STATUS[v] ? '<span class="pill ' + STATUS[v][1] + '">' + STATUS[v][0] + '</span>' : muted) + '</td>';
      default: return textCell(v, c.wrap ? 'price-audit-wrap' : (c.key === 'productName' || c.key === 'customerName' ? 'name-cell' : ''));
    }
  }

  function rowHtml(r) {
    const wrongClass = r.effectiveStatus === 'wrong' ? ' class="price-audit-row-wrong"' : '';
    return '<tr data-row-key="' + escape(rowKey(r)) + '"' + wrongClass + '>' + state.columns.map(c => cellHtml(r, c)).join('') + '</tr>';
  }

  function noteRow(message) {
    return '<tr><td colspan="' + Math.max(1, state.columns.length) + '" class="table-note">' + escape(message) + '</td></tr>';
  }

  function renderRows() {
    const body = $('priceAuditRows');
    const data = state.data;
    if (state.error) { body.innerHTML = noteRow(state.error); return; }
    if (!data) { body.innerHTML = noteRow('Đang tải...'); return; }
    if (!data.meta || !data.meta.available) { body.innerHTML = noteRow((data.meta && data.meta.message) || 'Chưa chạy kiểm tra giá'); return; }
    body.innerHTML = data.rows.length ? data.rows.map(rowHtml).join('') : noteRow('Không có dòng nào khớp bộ lọc.');
    autosize(body);
  }

  // Dự phòng cho trình duyệt chưa có field-sizing (giống autosizeDebtFeedbackInput của tab Công nợ).
  function autosize(scope) {
    if (FIELD_SIZING || !scope) return;
    scope.querySelectorAll('textarea.debt-feedback-input').forEach(el => {
      el.style.height = 'auto';
      if (el.scrollHeight > 0) el.style.height = el.scrollHeight + 2 + 'px';
    });
  }

  function rerenderRow(key) {
    const data = state.data;
    const row = data && data.rows.find(r => rowKey(r) === key);
    const tr = Array.from($('priceAuditRows').querySelectorAll('tr[data-row-key]')).find(el => el.dataset.rowKey === key);
    if (!row || !tr) return;
    tr.outerHTML = rowHtml(row);
    autosize($('priceAuditRows'));
  }

  function totalPages() {
    const d = state.data;
    return d && d.totalRows ? Math.max(1, Math.ceil(Number(d.totalRows) / state.pageSize)) : 1;
  }

  function renderPagination() {
    const d = state.data;
    const ok = d && d.meta && d.meta.available;
    const total = ok ? Number(d.totalRows) || 0 : 0;
    const pages = totalPages();
    $('tagPriceAudit').textContent = ok ? NUMBER.format(total) + ' dòng' : '—';
    $('priceAuditPagination').hidden = !ok || total === 0;
    $('priceAuditPageLabel').textContent = 'Trang ' + state.page + '/' + pages;
    $('priceAuditFirstPage').disabled = $('priceAuditPrevPage').disabled = state.page <= 1;
    $('priceAuditNextPage').disabled = $('priceAuditLastPage').disabled = state.page >= pages;
  }

  function renderFilters() {
    const d = state.data;
    const meta = d && d.meta;
    ['priceAuditFrom', 'priceAuditTo'].forEach(id => {
      const input = $(id);
      input.min = meta && meta.windowFrom ? meta.windowFrom : '';
      input.max = meta && meta.windowTo ? meta.windowTo : '';
    });
    const sales = (d && d.filters && d.filters.options && d.filters.options.sales) || [];
    const select = $('priceAuditSaleFilter');
    const options = ['<option value="">Tất cả sale</option>'].concat(sales.map(s => '<option value="' + escape(s) + '">' + escape(s) + '</option>'));
    if (state.filters.sale && sales.indexOf(state.filters.sale) < 0) options.push('<option value="' + escape(state.filters.sale) + '">' + escape(state.filters.sale) + '</option>');
    select.innerHTML = options.join('');
    select.value = state.filters.sale;
    Object.keys(FILTER_IDS).forEach(name => { if (name !== 'sale' && $(FILTER_IDS[name]).value !== state.filters[name]) $(FILTER_IDS[name]).value = state.filters[name]; });
    // Các ô lọc ảnh hưởng lẫn nhau: máy chủ đếm số dòng của từng giá trị theo CÁC ô khác (filters.facets); giá trị không còn
    // dòng nào thì khóa + ẩn (trừ giá trị đang chọn) để không ghép ra bảng rỗng.
    const facets = d && d.filters && d.filters.facets;
    if (facets) {
      Object.keys(FILTER_IDS).forEach(name => {
        const counts = facets[name];
        if (!counts) return;
        Array.prototype.forEach.call($(FILTER_IDS[name]).options, option => {
          if (!option.value) return;
          const blocked = !counts[option.value] && option.value !== state.filters[name];
          option.disabled = blocked;
          option.hidden = blocked;
        });
      });
    }
    $('priceAuditExportButton').hidden = !can('reports.export');
  }

  function render() {
    renderStatus();
    renderKpis();
    renderSales();
    renderFilters();
    renderRows();
    renderPagination();
  }

  // ---------- tải dữ liệu ----------
  function queryString(extra) {
    const params = new URLSearchParams();
    Object.keys(state.filters).forEach(k => { if (state.filters[k]) params.set(k, state.filters[k]); });
    if (state.sorts.length) params.set('sorts', JSON.stringify(state.sorts));
    if (state.sort) { params.set('sort', state.sort); params.set('dir', state.dir); }
    Object.keys(extra || {}).forEach(k => params.set(k, extra[k]));
    return params.toString();
  }

  async function readJson(res) {
    if (res.status === 401) {
      window.location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
      throw new Error('Phiên đăng nhập đã hết hạn.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((body && body.error) || 'HTTP ' + res.status), { status: res.status, body: body });
    return body;
  }

  function sectionVisible() {
    const section = $('priceAuditSection');
    const allowed = can(FEATURE);
    section.hidden = !allowed;
    return allowed;
  }

  async function fetchPage() {
    const seq = ++state.seq;
    state.loading = true;
    try {
      const data = await readJson(await fetch(API + '?' + queryString({ page: state.page, pageSize: state.pageSize }), { credentials: 'same-origin' }));
      if (seq !== state.seq) return;
      state.data = data;
      state.error = '';
      state.loadedAt = Date.now();
      // Trang hiện tại vượt quá số trang mới (vd vừa chốt làm dòng rời bộ lọc) → về trang cuối.
      if (data.meta && data.meta.available && !data.rows.length && state.page > 1 && Number(data.totalRows) > 0) {
        state.page = totalPages();
        return fetchPage();
      }
      // Bỏ trình soạn của dòng không còn trên trang (đã xác nhận bỏ ở guardUnsaved trước khi tải).
      const shown = new Set(data.rows.map(rowKey));
      Array.from(state.editors.keys()).forEach(key => { if (!shown.has(key)) state.editors.delete(key); });
    } catch (err) {
      if (seq !== state.seq) return;
      console.error('Không tải được bảng Kiểm tra giá bán:', err);
      state.error = err.status === 400 ? 'Bộ lọc không hợp lệ: ' + err.message : (err.message && err.status < 500 ? err.message : 'Không tải được bảng Kiểm tra giá bán.');
    } finally {
      if (seq === state.seq) { state.loading = false; render(); }
    }
  }

  // ---------- sắp xếp theo cột (ở máy chủ, trên toàn bộ tập đã lọc) ----------
  const SORT_GLYPH = { none: '▲▼', ascending: '▼', descending: '▲' };
  function paintSortHeaders() {
    window.TKSTables.syncSortHeaders(document.getElementById('priceAuditHead').closest('table'), state.sorts, th => th.dataset.sort);
  }

  function onSortClick(event) {
    const th = event.target.closest('th.sortable');
    if (!th) return;
    const key = th.dataset.sort;
    if (!guardUnsaved()) return;
    // Lần 1 tăng dần, lần 2 giảm dần, lần 3 bỏ sắp xếp (thứ tự mặc định: dòng sai trước, mới nhất trước).
    state.sorts = window.TKSTables.nextSorts(state.sorts, key, event.shiftKey);
    state.sort = state.sorts[0]?.key || '';
    state.dir = state.sorts[0]?.dir || 'asc';
    state.page = 1;
    paintSortHeaders();
    fetchPage();
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;
    readColumns();
    $('priceAuditHead').addEventListener('click', onSortClick);
    paintSortHeaders();
    Object.keys(FILTER_IDS).forEach(name => {
      $(FILTER_IDS[name]).addEventListener('change', event => applyFilter(name, event.target.value, event.target));
    });
    let timer = null;
    const search = $('priceAuditSearch');
    search.addEventListener('input', () => {
      clearTimeout(timer);
      // Gõ: chờ ~300ms rồi tìm; xóa trống (kể cả Backspace) gọi lại ngay.
      const run = () => applyFilter('q', search.value.trim(), search);
      if (!search.value.trim()) run();
      else timer = setTimeout(run, 300);
    });
    $('priceAuditPageSize').addEventListener('change', event => {
      const previous = state.pageSize;
      if (!guardUnsaved()) { event.target.value = String(previous); return; }
      state.pageSize = Number(event.target.value) || 50;
      state.page = 1;
      fetchPage();
    });
    const go = page => () => {
      const target = Math.min(Math.max(1, page()), totalPages());
      if (target === state.page || !guardUnsaved()) return;
      state.page = target;
      fetchPage();
    };
    $('priceAuditFirstPage').addEventListener('click', go(() => 1));
    $('priceAuditPrevPage').addEventListener('click', go(() => state.page - 1));
    $('priceAuditNextPage').addEventListener('click', go(() => state.page + 1));
    $('priceAuditLastPage').addEventListener('click', go(() => totalPages()));
    $('priceAuditExportButton').addEventListener('click', openExport);
    $('priceAuditSalesExportButton').addEventListener('click', openSalesExport);
    const salesSearch = $('priceAuditSalesSearch');
    salesSearch.addEventListener('input', () => { state.salesSearch = salesSearch.value; renderSales(); });
    salesSearch.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); clearSalesSearch(); } });
    $('priceAuditSalesSearchClear').addEventListener('click', clearSalesSearch);
    const body = $('priceAuditRows');
    body.addEventListener('click', onClick);
    body.addEventListener('change', onChange);
    body.addEventListener('input', onInput);
    window.addEventListener('beforeunload', event => {
      if (!hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  /** Mở tab Hóa đơn: tải nếu có quyền và dữ liệu đã cũ hơn 60 giây (force = luôn tải). */
  function load(force) {
    if (!$('priceAuditSection') || !sectionVisible()) return Promise.resolve();
    init();
    if (!force && (state.loading || Date.now() - state.loadedAt < 60000)) return Promise.resolve();
    if (!force && hasUnsaved()) return Promise.resolve(); // không tự tải lại đè lên nội dung đang gõ
    return fetchPage();
  }

  // ---------- bộ lọc + nội dung chưa lưu ----------
  function hasUnsaved() {
    const rows = (state.data && state.data.rows) || [];
    return Array.from(state.editors.entries()).some(([key, editor]) => {
      const row = rows.find(r => rowKey(r) === key);
      return editor.draft !== ((row && row.saleExplanation) || '');
    });
  }

  function guardUnsaved() {
    if (!hasUnsaved()) return true;
    if (!window.confirm(UNSAVED_MESSAGE)) return false;
    state.editors.clear();
    return true;
  }

  function applyFilter(name, value, control) {
    if (state.filters[name] === value) return;
    if (!guardUnsaved()) { control.value = state.filters[name]; return; }
    state.filters[name] = value;
    state.page = 1;
    fetchPage();
  }

  // ---------- sửa trong bảng ----------
  function rowFor(el) {
    const tr = el.closest('tr[data-row-key]');
    const key = tr && tr.dataset.rowKey;
    const row = key && state.data && state.data.rows.find(r => rowKey(r) === key);
    return row ? { key, row, tr } : null;
  }

  function onInput(event) {
    if (!event.target.matches('[data-action="draft"]')) return;
    const hit = rowFor(event.target);
    if (!hit) return;
    // Trình soạn tạo lười ở lần gõ đầu (ô luôn hiện như tab Công nợ); Lưu/Hủy chỉ hiện khi khác bản đã lưu.
    let editor = state.editors.get(hit.key);
    if (!editor) { editor = { draft: '', saving: false, error: '' }; state.editors.set(hit.key, editor); }
    editor.draft = event.target.value;
    const td = event.target.closest('td');
    const count = td.querySelector('.price-audit-count');
    if (count) count.textContent = editor.draft.length + '/' + MAX_EXPLANATION;
    const actions = td.querySelector('.price-audit-edit-actions');
    if (actions) actions.hidden = editor.draft === (hit.row.saleExplanation || '') && !editor.error;
  }

  function onClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const hit = rowFor(button);
    if (!hit) return;
    const action = button.dataset.action;
    if (action === 'open-invoice') { openInvoice(hit.row, button); return; }
    if (action === 'cancel-explanation') {
      const editor = state.editors.get(hit.key);
      if (editor && editor.draft !== (hit.row.saleExplanation || '') && !window.confirm('Bỏ nội dung giải thích chưa lưu?')) return;
      state.editors.delete(hit.key);
      rerenderRow(hit.key);
      return;
    }
    if (action === 'save-explanation') {
      const textarea = hit.tr.querySelector('textarea');
      const editor = state.editors.get(hit.key);
      if (editor && textarea) editor.draft = textarea.value;
      saveExplanation(hit.key);
    }
  }

  function replaceRow(key, fresh) {
    const rows = state.data.rows;
    const index = rows.findIndex(r => rowKey(r) === key);
    if (index >= 0 && fresh) rows[index] = fresh;
  }

  function rowUrl(row, action, query) {
    return API + '/' + encodeURIComponent(row.branch) + '/' + encodeURIComponent(row.invoiceId) + '/' + encodeURIComponent(row.sourceLineNo) + '/' + action + (query ? '?' + query : '');
  }

  async function saveExplanation(key) {
    const editor = state.editors.get(key);
    const row = state.data.rows.find(r => rowKey(r) === key);
    if (!editor || !row || editor.saving) return;
    if (editor.draft.length > MAX_EXPLANATION) {
      editor.error = 'Giải thích tối đa ' + MAX_EXPLANATION + ' ký tự.';
      rerenderRow(key);
      return;
    }
    editor.saving = true;
    editor.error = '';
    rerenderRow(key);
    try {
      const res = await fetch(rowUrl(row, 'explanation'), {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: editor.draft, expectedVersion: Number(row.version) })
      });
      const body = await readJson(res);
      replaceRow(key, body.row);
      state.editors.delete(key);
      toast('Đã lưu giải thích.', 'success');
    } catch (err) {
      // Lưu thất bại: giữ nguyên trình soạn + nội dung đang gõ, KHÔNG hiển thị như đã lưu.
      editor.saving = false;
      if (err.status === 409 && err.body && err.body.row) {
        replaceRow(key, err.body.row);
        editor.error = 'Dòng này vừa được người khác cập nhật. Nội dung mới nhất hiển thị ở trên; kiểm tra rồi bấm Lưu lại hoặc Hủy.';
        if (!err.body.row.canEditExplanation) {
          state.editors.delete(key);
          toast('Dòng đã thay đổi và bạn không còn quyền sửa giải thích.', 'error');
        }
      } else {
        editor.error = (err.status && err.status < 500 && err.message) ? err.message : 'Không lưu được giải thích. Nội dung chưa được lưu, vui lòng thử lại.';
        if (!/Không lưu được/.test(editor.error)) editor.error = 'Không lưu được: ' + editor.error;
      }
    }
    rerenderRow(key);
  }

  function onChange(event) {
    const select = event.target;
    if (!select.matches('select[data-action="decision"]')) return;
    const hit = rowFor(select);
    if (!hit) return;
    const decision = select.value || null;
    if ((hit.row.decision || null) === decision) return;
    const otherDrafts = hasUnsaved();
    if (otherDrafts && !guardUnsaved()) { select.value = hit.row.decision || ''; return; }
    saveDecision(hit, decision, select);
  }

  async function saveDecision(hit, decision, select) {
    select.disabled = true;
    select.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(rowUrl(hit.row, 'decision', queryString({ page: state.page, pageSize: state.pageSize })), {
        method: 'PATCH', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: decision, expectedVersion: Number(hit.row.version) })
      });
      await readJson(res);
      toast('Đã chốt: ' + DECISION[decision || ''] + '.', 'success');
    } catch (err) {
      if (err.status === 409) toast('Dòng này vừa được người khác cập nhật; đã tải lại dữ liệu mới nhất.', 'error');
      else toast(err.message && err.status < 500 ? err.message : 'Không lưu được Chốt.', 'error');
    }
    // Tải lại trang hiện tại để dòng chuyển đúng tập lọc và chỉ số khớp máy chủ.
    await fetchPage();
  }

  // ---------- popup hóa đơn ----------
  let popupObserver = null;
  function openInvoice(row, trigger) {
    if (typeof window.openDocumentDetail !== 'function') return;
    const item = { code: row.invoiceCode, branch: BRANCH_LABEL[row.branch] || '' };
    window.openDocumentDetail('endOfDay', item, trigger);
    const body = $('docModalBody');
    const backdrop = $('docModalBackdrop');
    if (!body) return;
    const ensureNote = () => {
      const current = typeof docDetail !== 'undefined' ? docDetail.item : item; // eslint-disable-line no-undef
      if ((backdrop && backdrop.hidden) || current !== item) { if (popupObserver) popupObserver.disconnect(); popupObserver = null; return; }
      if (body.querySelector('.price-audit-popup-note')) return;
      const note = document.createElement('div');
      note.className = 'doc-modal-note price-audit-popup-note';
      note.setAttribute('role', 'note');
      note.textContent = POPUP_NOTE;
      body.insertBefore(note, body.firstChild);
    };
    if (popupObserver) popupObserver.disconnect();
    popupObserver = new MutationObserver(ensureNote);
    popupObserver.observe(body, { childList: true });
    if (backdrop) popupObserver.observe(backdrop, { attributes: true, attributeFilter: ['hidden'] });
    ensureNote();
  }

  // ---------- xuất file ----------
  const EXPORT_SOURCE = {
    fields: (payload, request) => window.exportFetch(API + '/export/fields' + (payload.query ? '?' + payload.query : ''), null, request),
    file: (payload, request) => {
      const params = new URLSearchParams(payload.query);
      params.set('format', payload.format === 'html' ? 'html' : 'xlsx');
      const picked = payload.columns && (payload.columns[payload.kind] || Object.values(payload.columns)[0]);
      if (picked) params.set('columns', picked.join(','));
      return window.exportFetch(API + '/export?' + params.toString(), null, request);
    }
  };

  function openExport() {
    if (!can(FEATURE) || !can('reports.export') || typeof window.startExportDialog !== 'function') return;
    // Bộ lọc chốt lúc mở hộp thoại; máy chủ xuất TOÀN BỘ tập đã lọc (không phân trang).
    return window.startExportDialog({ kind: 'priceAudit', query: queryString() }, EXPORT_SOURCE);
  }

  // Xuất bảng "Tiền phạt theo sale": cùng bộ lọc với KPI + ô tìm của bảng này (file khớp các dòng đang hiển thị).
  const SALES_EXPORT_SOURCE = {
    fields: (payload, request) => window.exportFetch(API + '/export/sales/fields' + (payload.query ? '?' + payload.query : ''), null, request),
    file: (payload, request) => {
      const params = new URLSearchParams(payload.query);
      params.set('format', payload.format === 'html' ? 'html' : 'xlsx');
      const picked = payload.columns && (payload.columns[payload.kind] || Object.values(payload.columns)[0]);
      if (picked) params.set('columns', picked.join(','));
      return window.exportFetch(API + '/export/sales?' + params.toString(), null, request);
    }
  };

  function openSalesExport() {
    if (!can(FEATURE) || !can('reports.export') || typeof window.startExportDialog !== 'function') return;
    const search = state.salesSearch.trim();
    return window.startExportDialog({ kind: 'priceAuditSales', query: queryString(search ? { saleSearch: search } : null) }, SALES_EXPORT_SOURCE);
  }

  function clearSalesSearch() {
    state.salesSearch = '';
    $('priceAuditSalesSearch').value = '';
    renderSales();
    $('priceAuditSalesSearch').focus();
  }

  window.TKSPriceAudit = { load: load, hasUnsaved: hasUnsaved, openExport: openExport, openSalesExport: openSalesExport };
})();
