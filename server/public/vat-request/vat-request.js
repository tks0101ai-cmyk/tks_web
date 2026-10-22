// Kế toán – ORDER VAT (thay Google Form + sheet ORDER VAT 1).
// Mọi luật quyền / khóa / version nằm ở server (/api/vat-requests); trang chỉ ẩn nút cho tiện.
(function () {
  'use strict';

  const API = '/api/vat-requests';
  const PAGE_SIZE = 100;
  const TODO_STATUSES = ['pending', '3', '4'];
  const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const FIELD_LABELS = {
    customer_name: 'Khách hàng', customer_code: 'Mã khách', product_code: 'Mã SP', quantity: 'Số lượng',
    unit_price_excl_vat: 'Giá chưa VAT', full_vat: 'Full VAT', sale_note: 'Ghi chú', status: 'KT phản hồi',
    accountant_note: 'KT note cho sale', arrival_date: 'Ngày về'
  };
  const ACTION_LABELS = { create: 'Tạo yêu cầu', delete: 'Xóa yêu cầu', import: 'Nhập từ sheet cũ', update: 'Sửa' };

  const state = {
    user: null, canProcess: false, isManager: false, viewerId: null, exporting: false,
    rows: [], metrics: {}, sales: [], statuses: [], stockStatus: null, truncated: false,
    preset: 'all', saleFilter: '', query: '', from: '', to: '',
    groupByProduct: false, sortKey: '', sortDir: 'asc', page: 1, selected: new Set(), loading: false, error: '',
    editing: null, requestSeq: 0, grid: null, rowOrder: false,
    // statusSet: các chip trạng thái đang bật khi preset = 'custom'; keep: id dòng KT vừa sửa, giữ lại trên bảng
    // cho tới khi đổi bộ lọc; history: hoàn tác / làm lại (Ctrl+Z / Ctrl+Y), mất khi tải lại trang.
    statusSet: new Set(), keep: new Set(), history: { undo: [], redo: [] }, saving: false
  };

  // ---------- Tiện ích ----------
  function $(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function fmtNumber(value) { return value === null || value === undefined || value === '' ? '' : numberFormat.format(Number(value)); }
  function fmtDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
  }
  function fmtDateTime(iso) { return iso ? dateTimeFormat.format(new Date(iso)).replace(',', '') : ''; }
  function parseNumber(text) {
    const cleaned = String(text ?? '').replace(/,/g, '').replace(/\s/g, '');
    return cleaned === '' ? NaN : Number(cleaned);
  }
  function statusLabel(value) {
    const found = state.statuses.find(s => s.value === value);
    return found ? found.label : value;
  }
  function debounce(fn, ms) {
    let timer;
    return function () { const args = arguments; clearTimeout(timer); timer = setTimeout(() => fn.apply(null, args), ms); };
  }

  async function api(path, options = {}) {
    const response = await fetch(API + path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Lỗi ${response.status}`);
      error.status = response.status;
      error.data = data || {};
      throw error;
    }
    return data;
  }

  function setStatus(message, kind) {
    const status = $('vrStatus');
    status.textContent = message || '';
    status.dataset.kind = kind || '';
  }

  // ---------- Cột ----------
  // Độ rộng mặc định theo tỉ lệ đã chốt (ảnh 20/10/2026, khung ~1800px); khung rộng hơn thì table-controls giãn đều.
  // nowrap: số / mã / ngày không bao giờ xuống dòng giữa chừng — cột phải đủ rộng cho cả giá trị.
  function columns() {
    const list = [];
    if (state.canProcess) list.push({ key: 'select', label: 'Chọn', locked: true, width: 62 });
    list.push(
      { key: 'createdAt', label: 'Thời gian', width: 84, mobileHidden: true },
      { key: 'sale', label: 'Tên Sale', width: 100, mobileHidden: true },
      { key: 'customer', label: 'Khách hàng', width: 110 },
      { key: 'productCode', label: 'Mã SP', width: 110, locked: true, nowrap: true },
      { key: 'productName', label: 'Tên SP', width: 165, mobileHidden: true },
      { key: 'quantity', label: 'SL', width: 64, num: true },
      { key: 'unitPrice', label: 'Giá chưa VAT', width: 80, num: true, mobileHidden: true },
      { key: 'total', label: 'Tổng tiền', width: 92, num: true, mobileHidden: true },
      { key: 'fullVat', label: 'Full VAT', width: 88, mobileHidden: true },
      { key: 'saleNote', label: 'Ghi chú', width: 115, mobileHidden: true },
      { key: 'status', label: 'KT phản hồi', width: state.canProcess ? 150 : 128 },
      { key: 'accountantNote', label: 'KT note cho sale', width: 118, mobileHidden: true },
      { key: 'arrivalDate', label: 'Ngày về', width: state.canProcess ? 132 : 100, mobileHidden: true, nowrap: true }
    );
    // 5 cột số liệu chỉ dành cho KT (server cũng không gửi cho sale). Hàng về = cont chưa về sớm nhất; Trạng thái / Dự kiến
    // ngày về lấy từ cont đó (hết cont chưa về thì cont "4. Đã về" gần nhất) — như hộp chi tiết Hàng dự kiến.
    if (state.canProcess) {
      list.push(
        { key: 'vatStock', label: 'Tồn VAT', width: 74, num: true, mobileHidden: true },
        { key: 'pendingQty', label: 'SLG tổng cần khai', width: 74, num: true, mobileHidden: true },
        { key: 'incomingContainer', label: 'Dự kiến hàng về', width: 110, mobileHidden: true },
        { key: 'containerStatus', label: 'Trạng thái', width: 110, mobileHidden: true },
        { key: 'containerEta', label: 'Dự kiến ngày về gần nhất', width: 104, mobileHidden: true }
      );
    }
    list.push({ key: 'actions', label: 'Thao tác', width: 96, locked: true });
    return list;
  }

  function screenMode() { return window.innerWidth <= 600 ? 'mobile' : 'desktop'; }

  function renderHead() {
    const head = $('vrHeadRow');
    head.innerHTML = columns().map(col => {
      if (col.key === 'select') {
        return '<th scope="col" data-column-key="select" data-default-width="48"><input type="checkbox" id="vrSelectPage" aria-label="Chọn tất cả dòng trên trang"></th>';
      }
      if (col.key === 'actions') return `<th scope="col" data-column-key="actions" data-default-width="${col.width}">${escapeHtml(col.label)}</th>`;
      // Nút sắp xếp riêng (sắp TOÀN BỘ danh sách, không chỉ trang đang xem) — table-controls thấy .sort-button sẵn thì không gắn thêm.
      return `<th scope="col" data-column-key="${col.key}" data-default-width="${col.width}" aria-sort="none"${col.num ? ' class="num"' : ''}>` +
        `<button type="button" class="sort-button" data-sort="${col.key}"><span class="sort-label">${escapeHtml(col.label)}</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th>`;
    }).join('');
    updateSortHeaders();
    if (window.TKSTables) {
      const mobile = screenMode() === 'mobile';
      window.TKSTables.enhance($('vrTable'), {
        // v3: co Giá / Tổng tiền + chừa chỗ thanh cuộn dọc (22/10) -> bỏ bố cục cột đã lưu (đang tràn ngang 15px).
        key: 'vat-requests-v3-' + (state.canProcess ? 'kt-' : 'sale-') + screenMode(),
        button: $('vrColumnsButton'),
        columns: columns().map(col => ({ key: col.key, label: col.label, width: col.width, locked: !!col.locked, hidden: mobile && !!col.mobileHidden }))
      });
    }
  }

  // ---------- Ô dữ liệu ----------
  function metricFor(row) { return state.metrics[row.productKey] || null; }

  function cellHtml(col, row) {
    const m = metricFor(row);
    switch (col.key) {
      case 'select': {
        const box = `<input type="checkbox" data-select="${row.id}" aria-label="Chọn yêu cầu ${row.id}"${state.selected.has(row.id) ? ' checked' : ''}>`;
        if (!canDragRows()) return box;
        const grip = `<button type="button" class="vr-row-grip" data-row-drag="${row.id}" aria-label="Kéo để đổi thứ tự yêu cầu #${row.id}" title="Bấm để chọn dòng (Shift / Ctrl để chọn nhiều), kéo để đổi thứ tự; Alt+↑ / Alt+↓ dời 1 dòng"><svg viewBox="0 0 10 16" width="8" height="14" fill="currentColor" aria-hidden="true"><circle cx="2" cy="3" r="1.4"/><circle cx="8" cy="3" r="1.4"/><circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="2" cy="13" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg></button>`;
        return `<span class="vr-select-cell">${grip}${box}</span>`;
      }
      case 'createdAt': {
        // Năm ẩn cho gọn; kéo rộng cột thì hiện lại (container query trong vat-request.css).
        const text = fmtDateTime(row.createdAt);
        const match = /^(.*\d{2}\/\d{2})(\/\d{4})$/.exec(text);
        return match ? `<span class="vr-when">${escapeHtml(match[1])}<span class="vr-year">${escapeHtml(match[2])}</span></span>` : escapeHtml(text);
      }
      case 'sale':
        return escapeHtml(row.createdByName || '—') + (row.isLegacy ? ' <span class="vr-tag" title="Nhập từ sheet ORDER VAT 1">cũ</span>' : '');
      case 'customer': return escapeHtml(row.customerName);
      case 'productCode': return `<span class="vr-code" title="${escapeHtml(row.productCode)}">${escapeHtml(row.productCode)}</span>`;
      case 'productName': return escapeHtml(row.productName);
      case 'quantity': return fmtNumber(row.quantity);
      case 'unitPrice': return fmtNumber(row.unitPrice);
      case 'total': return fmtNumber(row.totalAmount);
      case 'fullVat': return row.fullVat ? '<span class="vr-tag vr-tag-strong">Full VAT</span>' : '<span class="vr-tag">Chưa VAT</span>';
      case 'saleNote': return escapeHtml(row.saleNote);
      // 3 cột KT hiện chữ như sale; KT nháy đúp / Enter / gõ phím mới mở ô sửa (editorHtml) — kiểu Google Sheet.
      case 'status': return `<span class="vr-badge" data-status="${escapeHtml(row.status)}">${escapeHtml(row.statusLabel)}</span>`;
      case 'accountantNote': return escapeHtml(row.accountantNote);
      case 'arrivalDate': return escapeHtml(fmtDate(row.arrivalDate));
      case 'vatStock':
        if (!m || !m.vatStock) return '<span class="vr-muted" title="Chưa khớp mã VAT hoặc chưa đọc được sheet tồn">—</span>';
        return `<button type="button" class="vr-link" data-stock="${escapeHtml(row.productKey)}" title="Xem tồn theo công ty">${fmtNumber(m.vatStock.total)}</button>`;
      case 'pendingQty': return m ? fmtNumber(m.pendingInsertQty) : '';
      case 'incomingContainer':
        if (!m) return '';
        return m.incomingContainer ? escapeHtml(m.incomingContainer) : '<span class="vr-muted" title="Không có cont chưa về">—</span>';
      case 'containerStatus':
        if (!m) return '';
        return m.containerStatus ? escapeHtml(m.containerStatus) : '<span class="vr-muted" title="Mã chưa có dòng CONT trong Hàng dự kiến">—</span>';
      case 'containerEta':
        if (!m) return '';
        return m.containerEta ? escapeHtml(m.containerEta) : '<span class="vr-muted">—</span>';
      case 'actions': {
        // Xóa nằm trong hộp sửa; nháy đúp / chuột phải vào dòng cũng mở hộp này.
        const lock = row.isLockedForSale
          ? '<svg class="vr-lock" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-label="Đã khóa với sale"><title>Đã khóa với sale (kế toán đã xử lý)</title><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>'
          : '';
        const button = row.canEditSale
          ? `<button type="button" class="vr-icon-btn" data-action="edit" data-id="${row.id}">Sửa</button>`
          : `<button type="button" class="vr-icon-btn" data-action="history" data-id="${row.id}">Lịch sử</button>`;
        return `<div class="vr-row-actions">${lock}${button}</div>`;
      }
      default: return '';
    }
  }

  function rowHtml(row, cols) {
    const classes = [row.isLockedForSale ? 'is-locked' : '', row.isMine ? 'is-mine' : '', state.canProcess && state.selected.has(row.id) ? 'is-picked' : ''].filter(Boolean).join(' ');
    const cellClass = col => [col.num ? 'num' : '', col.num || col.nowrap ? 'vr-nowrap' : ''].filter(Boolean).join(' ');
    const editable = col => (isGridEditable(col.key) ? ' data-editable="true" title="Nháy đúp hoặc Enter để sửa; kéo chấm góc để nhân bản"' : '');
    return `<tr data-id="${row.id}" tabindex="0"${classes ? ` class="${classes}"` : ''} title="Nháy đúp để ${row.canEditSale ? 'sửa' : 'xem lịch sử'}">` +
      cols.map(col => `<td data-field="${col.key}"${cellClass(col) ? ` class="${cellClass(col)}"` : ''}${editable(col)}>${cellHtml(col, row)}</td>`).join('') + '</tr>';
  }

  // ---------- Kéo dòng đổi thứ tự ưu tiên chung (KT, migration 0079) ----------
  // Chỉ ở thứ tự gốc: đang sắp xếp theo cột, gộp theo mã hay gõ tìm kiếm thì chỉ là cách xem tạm -> ẩn tay nắm.
  const coarsePointer = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  function canDragRows() {
    const searching = !!(window.TKSFuzzySearch && TKSFuzzySearch.tokens(state.query).length);
    return state.canProcess && state.rowOrder && !state.sortKey && !state.groupByProduct && !searching && !(coarsePointer && coarsePointer.matches);
  }

  function pageRowIds() { return [...$('vrRows').querySelectorAll('tr[data-id]')].map(tr => Number(tr.dataset.id)); }

  /**
   * Dời nhóm dòng `ids` (thứ tự trên -> dưới) thành 1 khối: `below` = id dòng nằm ngay dưới khối,
   * không có thì `above` = dòng ngay trên. Dòng rời nhau được gom lại, giữ thứ tự giữa chúng.
   */
  async function moveRows(ids, { below = null, above = null }) {
    const group = new Set(ids);
    const moving = ids.map(id => state.rows.find(r => r.id === id)).filter(Boolean);
    if (!moving.length || (!below && !above)) return;
    // Dời ngay trên màn hình (lạc quan), lỗi thì nạp lại.
    const rest = state.rows.filter(r => !group.has(r.id));
    const anchor = rest.findIndex(r => r.id === (below || above));
    if (anchor < 0) return;
    rest.splice(below ? anchor : anchor + 1, 0, ...moving);
    state.rows = rest;
    render();
    try {
      const result = await api('/position', { method: 'PATCH', body: below ? { ids, belowId: below } : { ids, aboveId: above } });
      const label = ids.length === 1 ? `chuyển yêu cầu #${ids[0]}` : `chuyển ${ids.length} yêu cầu`;
      if (result && result.before) pushHistory({ kind: 'order', label, before: result.before, after: result.after });
      notify(`Đã ${label}.`, 'ok', { undo: true });
    } catch (error) {
      await load(); // load() xóa thanh trạng thái -> báo lỗi sau khi nạp lại
      notify(error.message, 'error');
    }
  }

  /** Vị trí thả -> hàng xóm của khối sau khi thả, trong các dòng đang hiện trên trang (thứ tự DOM). */
  function dropNeighbors(ids, targetId, after) {
    const rest = pageRowIds().filter(rowId => !ids.includes(rowId));
    const index = rest.indexOf(targetId);
    if (index < 0) return null;
    const position = after ? index + 1 : index;
    return { below: rest[position] ?? null, above: position > 0 ? rest[position - 1] : null };
  }

  // ---------- Ô KT kiểu Google Sheet (vat-request-grid.js) ----------
  const GRID_EDITABLE = ['status', 'accountantNote', 'arrivalDate'];
  function isGridEditable(field) { return state.canProcess && GRID_EDITABLE.includes(field); }

  function editorHtml(field, row) {
    if (field === 'status') {
      return `<select class="vr-inline vr-status-select" data-inline="status" data-status="${escapeHtml(row.status)}" data-id="${row.id}" aria-label="Trạng thái yêu cầu ${row.id}">` +
        state.statuses.map(s => `<option value="${s.value}"${s.value === row.status ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('') + '</select>';
    }
    if (field === 'accountantNote') return `<input class="vr-inline" type="text" maxlength="1000" data-inline="accountantNote" data-id="${row.id}" value="${escapeHtml(row.accountantNote)}" aria-label="KT note yêu cầu ${row.id}">`;
    return `<input class="vr-inline" type="date" data-inline="arrivalDate" data-id="${row.id}" value="${escapeHtml(row.arrivalDate || '')}" aria-label="Ngày về yêu cầu ${row.id}">`;
  }

  /** Mở ô sửa trong ô KT; `text` = phím vừa gõ (ô chữ thay bằng phím đó, ô trạng thái chọn mục bắt đầu bằng phím đó). */
  function startEdit(td, { text } = {}) {
    const row = state.rows.find(r => r.id === Number(td.closest('tr').dataset.id));
    const field = td.dataset.field;
    if (!row || !isGridEditable(field) || td.querySelector('[data-inline]')) return;
    td.innerHTML = editorHtml(field, row);
    const control = td.querySelector('[data-inline]');
    if (text && field === 'accountantNote') control.value = text;
    if (text && field === 'status') {
      const match = state.statuses.find(s => s.label.toLowerCase().startsWith(text.toLowerCase()));
      if (match) { control.value = match.value; control.dataset.status = match.value; }
    }
    control.focus();
    if (control.type === 'text') control.setSelectionRange(control.value.length, control.value.length);
  }

  /** Chữ dán / gõ -> giá trị lưu; undefined = không hợp lệ (bỏ ô). */
  function parseCellText(field, text) {
    const value = String(text ?? '').trim();
    if (field === 'accountantNote') return value.slice(0, 1000);
    if (field === 'arrivalDate') {
      if (!value) return null;
      const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
      const vn = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
      if (!iso && !vn) return undefined;
      const [y, m, d] = (iso ? [iso[1], iso[2], iso[3]] : [vn[3].length === 2 ? '20' + vn[3] : vn[3], vn[2], vn[1]]).map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined;
      return date.toISOString().slice(0, 10);
    }
    if (!value) return undefined; // trạng thái không để trống được
    const lower = value.toLowerCase();
    const exact = state.statuses.find(s => s.value.toLowerCase() === lower || s.label.toLowerCase() === lower);
    if (exact) return exact.value;
    const digit = /^([0-9])(?:\D|$)/.exec(value);
    const byDigit = digit && state.statuses.find(s => s.value === digit[1]);
    return byDigit ? byDigit.value : undefined;
  }

  /** Chữ chép ra khi Ctrl+C: số trơn (không dấu phẩy), ngày dd/mm/yyyy, trạng thái theo nhãn. */
  function copyText(id, field) {
    const row = state.rows.find(r => r.id === id);
    if (!row) return '';
    const m = metricFor(row) || {};
    const plain = value => (value === null || value === undefined ? '' : String(value));
    switch (field) {
      case 'createdAt': return fmtDateTime(row.createdAt);
      case 'sale': return row.createdByName || '';
      case 'customer': return row.customerName || '';
      case 'productCode': return row.productCode || '';
      case 'productName': return row.productName || '';
      case 'quantity': return plain(row.quantity);
      case 'unitPrice': return plain(row.unitPrice);
      case 'total': return plain(row.totalAmount);
      case 'fullVat': return row.fullVat ? 'Full VAT' : 'Chưa VAT';
      case 'saleNote': return row.saleNote || '';
      case 'status': return statusLabel(row.status);
      case 'accountantNote': return row.accountantNote || '';
      case 'arrivalDate': return fmtDate(row.arrivalDate);
      case 'vatStock': return m.vatStock ? plain(m.vatStock.total) : '';
      case 'pendingQty': return plain(m.pendingInsertQty);
      case 'incomingContainer': return m.incomingContainer || '';
      case 'containerStatus': return m.containerStatus || '';
      case 'containerEta': return m.containerEta || '';
      default: return '';
    }
  }

  function gridCellValue(id, field) {
    const row = state.rows.find(r => r.id === id);
    return row ? row[field] ?? (field === 'arrivalDate' ? null : '') : undefined;
  }

  /** Kéo / dán / xóa nhiều ô: gom theo dòng, bỏ ô không đổi / không hợp lệ, lưu 1 lần qua PATCH /bulk. */
  async function applyGridEdits(edits, { skipped = 0 } = {}) {
    if (!state.canProcess) return;
    const byId = new Map();
    let invalid = skipped;
    for (const edit of edits) {
      const row = state.rows.find(r => r.id === edit.id);
      const value = 'value' in edit ? edit.value : parseCellText(edit.field, edit.text);
      if (!row || value === undefined) { invalid++; continue; }
      if ((row[edit.field] ?? '') === (value ?? '')) continue;
      if (!byId.has(row.id)) byId.set(row.id, { row, changes: {} });
      byId.get(row.id).changes[edit.field] = value;
    }
    const skippedNote = invalid ? ` Bỏ qua ${invalid} ô không hợp lệ hoặc nằm ngoài cột KT / trang này.` : '';
    if (!byId.size) { notify(`Không có ô nào thay đổi.${skippedNote}`, invalid ? 'warn' : ''); return; }
    const entries = [...byId.values()];
    const before = entries.map(({ row, changes }) => ({ id: row.id, changes: Object.fromEntries(Object.keys(changes).map(field => [field, gridCellValue(row.id, field)])) }));
    const after = entries.map(({ row, changes }) => ({ id: row.id, changes }));
    const label = `sửa ${entries.length} yêu cầu`;
    const entry = pushHistory({ kind: 'fields', label, before, after });
    notify(`Đã ${label}.${skippedNote}`, skippedNote ? 'warn' : 'ok', { undo: true });
    if (!await saveFields(after)) dropHistory(entry);
  }

  /**
   * Sửa trường KT như Sheet: áp NGAY lên bảng (lạc quan) rồi lưu nền qua PATCH /bulk, các lần lưu xếp hàng
   * tuần tự để version luôn đúng (entries = [{ id, changes }]). Dòng vừa sửa vào state.keep nên vẫn ở lại bảng
   * dù không còn khớp bộ lọc. Lưu lỗi -> nạp lại dữ liệu thật + báo. Trả Promise<true|false>.
   */
  let saveChain = Promise.resolve();
  function saveFields(entries) {
    for (const { id, changes } of entries) {
      const row = state.rows.find(r => r.id === id);
      if (row) Object.assign(row, changes, changes.status ? { statusLabel: statusLabel(changes.status) } : {});
      state.keep.add(id);
    }
    render();
    const send = async () => {
      try {
        // version lấy lúc gửi: lần lưu trước trong hàng đợi đã cập nhật; dòng không còn trên bảng thì hỏi máy chủ.
        const items = await Promise.all(entries.map(async ({ id, changes }) => {
          const row = state.rows.find(r => r.id === id) || await api('/' + id);
          return { id, version: row.version, changes };
        }));
        const result = await api('/bulk', { method: 'PATCH', body: { items } });
        // Chỉ lấy version mới: giá trị trên bảng có thể đã được sửa tiếp (đang chờ trong hàng đợi).
        for (const updated of result.rows || []) {
          const row = state.rows.find(r => r.id === updated.id);
          if (row) Object.assign(row, { version: updated.version, updatedAt: updated.updatedAt });
        }
        if (entries.some(({ changes }) => Object.hasOwn(changes, 'status'))) refreshMetrics(entries.map(e => e.id));
        return true;
      } catch (error) {
        await load(); // bảng đang hiện giá trị chưa lưu được -> lấy lại dữ liệu thật
        notify(error.message, error.status === 409 ? 'warn' : 'error');
        return false;
      }
    };
    const done = saveChain.then(send);
    saveChain = done;
    return done;
  }

  /** Đổi trạng thái làm đổi SLG cần khai: chỉ hỏi lại số liệu các mã liên quan (POST /lookup), không nạp lại cả bảng. */
  async function refreshMetrics(ids) {
    const codes = [...new Set(ids.map(id => (state.rows.find(r => r.id === id) || {}).productCode).filter(Boolean))];
    if (!codes.length) return;
    try {
      const { results } = await api('/lookup', { method: 'POST', body: { codes } });
      for (const [key, found] of Object.entries(results || {})) {
        if (!found.found || found.pendingInsertQty === undefined) continue;
        const { vatStock, pendingInsertQty, incomingContainer, containerStatus, containerEta, nearestArrivalDate } = found;
        state.metrics[key] = { vatStock, pendingInsertQty, incomingContainer, containerStatus, containerEta, nearestArrivalDate };
      }
      render();
    } catch (_) { /* số liệu phụ, lần tải sau sẽ đúng */ }
  }

  // ---------- Hoàn tác / làm lại (Ctrl+Z / Ctrl+Y), tối đa 20 bước, mất khi tải lại trang ----------
  // Mục: { kind: 'fields', label, before: [{ id, changes }], after } | { kind: 'order', label, before: { id: hạng }, after }.
  const HISTORY_LIMIT = 20;
  function pushHistory(entry) {
    state.history.undo.push(entry);
    if (state.history.undo.length > HISTORY_LIMIT) state.history.undo.shift();
    state.history.redo = [];
    return entry;
  }
  /** Lưu không được thì bỏ mục khỏi lịch sử (bảng đã nạp lại dữ liệu thật). */
  function dropHistory(entry) {
    for (const stack of [state.history.undo, state.history.redo]) {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    }
  }

  let orderBusy = false;
  async function stepHistory(direction) {
    if (!state.canProcess || orderBusy) return;
    const stack = state.history[direction];
    const entry = stack.pop();
    if (!entry) { notify(direction === 'undo' ? 'Không còn thao tác để hoàn tác.' : 'Không còn thao tác để làm lại.', ''); return; }
    const target = direction === 'undo' ? entry.before : entry.after;
    state.history[direction === 'undo' ? 'redo' : 'undo'].push(entry);
    const message = direction === 'undo' ? `Đã hoàn tác: ${entry.label}.` : `Đã làm lại: ${entry.label}.`;
    if (entry.kind === 'fields') {
      // Như Sheet: hiện ngay, lưu nền (saveFields).
      notify(message, 'ok', { undo: state.history.undo.length > 0, redo: state.history.redo.length > 0 });
      if (!await saveFields(target)) dropHistory(entry);
      return;
    }
    // ponytail: hoàn tác kéo dòng vẫn chờ máy chủ + nạp lại bảng (cần hạng của mọi dòng mới xếp lại tại chỗ được);
    // làm lạc quan khi danh sách trả kèm sort_rank.
    orderBusy = true;
    try {
      await api('/position/ranks', { method: 'PATCH', body: { ranks: target } });
      Object.keys(target).forEach(id => state.keep.add(Number(id)));
      await load();
      notify(message, 'ok', { undo: state.history.undo.length > 0, redo: state.history.redo.length > 0 });
    } catch (error) {
      dropHistory(entry);
      await load();
      notify(error.message, error.status === 409 ? 'warn' : 'error');
    } finally {
      orderBusy = false;
    }
  }

  /** Thông báo: thanh trạng thái + thông báo nổi góc dưới (tự ẩn sau 8 giây, rê chuột thì giữ). */
  let toastTimer = null;
  function notify(message, kind, { undo = false, redo = false } = {}) {
    setStatus(message, kind);
    const toast = $('vrToast');
    if (!toast) return;
    toast.dataset.kind = kind || '';
    toast.querySelector('.vr-toast-text').textContent = message;
    toast.querySelector('[data-toast="undo"]').hidden = !undo;
    toast.querySelector('[data-toast="redo"]').hidden = !redo;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (!toast.matches(':hover')) toast.hidden = true; }, 8000);
  }

  function mountToast() {
    if ($('vrToast')) return;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="vr-toast" id="vrToast" role="status" aria-live="polite" data-grid-keep hidden>' +
      '<span class="vr-toast-text"></span>' +
      '<button type="button" data-toast="undo" title="Ctrl+Z">Hoàn tác</button>' +
      '<button type="button" data-toast="redo" title="Ctrl+Y" hidden>Làm lại</button>' +
      '<button type="button" class="vr-toast-close" data-toast="close" aria-label="Đóng thông báo">×</button></div>');
    $('vrToast').addEventListener('click', event => {
      const button = event.target.closest('[data-toast]');
      if (!button) return;
      if (button.dataset.toast === 'close') $('vrToast').hidden = true;
      else stepHistory(button.dataset.toast);
    });
    $('vrToast').addEventListener('mouseleave', () => {
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { $('vrToast').hidden = true; }, 3000);
    });
  }

  function groupHeaderHtml(key, rows, cols) {
    const first = rows[0];
    const m = state.metrics[key];
    const pick = state.canProcess ? `<input type="checkbox" data-select-group="${escapeHtml(key)}" aria-label="Chọn cả mã ${escapeHtml(first.productCode)}"> ` : '';
    // Số liệu tồn / hàng về chỉ KT thấy (sale không nhận metrics).
    const meta = state.canProcess && m
      ? ` · Tồn VAT ${m.vatStock ? fmtNumber(m.vatStock.total) : '—'} · Cần khai ${fmtNumber(m.pendingInsertQty || 0)} · Cont ${escapeHtml(m.incomingContainer || '—')} · Lịch ${escapeHtml([m.containerStatus, m.containerEta].filter(Boolean).join(' ') || '—')}`
      : '';
    return `<tr class="vr-group-row"><td colspan="${cols.length}">${pick}<strong>${escapeHtml(first.productCode)}</strong> — ${escapeHtml(first.productName)}` +
      `<span class="vr-group-meta">${rows.length} yêu cầu${meta}</span></td></tr>`;
  }

  // ---------- Sắp xếp theo cột (toàn bộ danh sách) ----------
  const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  function sortValueOf(row, key) {
    const m = metricFor(row) || {};
    switch (key) {
      case 'createdAt': return row.createdAt || null;
      case 'sale': return row.createdByName || null;
      case 'customer': return row.customerName || null;
      case 'productCode': return row.productCode || null;
      case 'productName': return row.productName || null;
      case 'quantity': return row.quantity;
      case 'unitPrice': return row.unitPrice;
      case 'total': return row.totalAmount;
      case 'fullVat': return row.fullVat ? 1 : 0;
      case 'saleNote': return row.saleNote || null;
      case 'status': { const index = state.statuses.findIndex(s => s.value === row.status); return index < 0 ? null : index; }
      case 'accountantNote': return row.accountantNote || null;
      case 'arrivalDate': return row.arrivalDate || null;
      case 'vatStock': return m.vatStock ? m.vatStock.total : null;
      case 'pendingQty': return m.pendingInsertQty ?? null;
      case 'incomingContainer': return m.incomingContainer || null;
      // Ngày đọc được đứng trước theo ngày; lịch chưa có ngày xếp sau theo chữ.
      case 'containerStatus': return m.containerStatus || null;
      case 'containerEta': return m.containerEta ? (m.nearestArrivalDate ? 'a' + m.nearestArrivalDate : 'b' + m.containerEta) : null;
      default: return null;
    }
  }
  function compareBySort(a, b) {
    if (!state.sortKey) return 0;
    const x = sortValueOf(a, state.sortKey);
    const y = sortValueOf(b, state.sortKey);
    const emptyX = x === null || x === undefined || x === '';
    const emptyY = y === null || y === undefined || y === '';
    if (emptyX || emptyY) return emptyX === emptyY ? 0 : emptyX ? 1 : -1; // ô trống luôn nằm cuối
    const result = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
    return state.sortDir === 'desc' ? -result : result;
  }
  // Bấm lần lượt: tăng dần → giảm dần → về thứ tự gốc (mới nhất trước).
  function cycleSort(key) {
    if (state.sortKey !== key) { state.sortKey = key; state.sortDir = 'asc'; }
    else if (state.sortDir === 'asc') state.sortDir = 'desc';
    else state.sortKey = '';
    state.page = 1;
    render();
    $('vrScroll').scrollTop = 0;
  }
  // Chưa sắp ▲▼ · tăng dần ▼ · giảm dần ▲ (quy ước chung của hệ thống).
  function updateSortHeaders() {
    document.querySelectorAll('#vrHeadRow [data-sort]').forEach(button => {
      const active = state.sortKey === button.dataset.sort;
      button.closest('th').setAttribute('aria-sort', active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      button.querySelector('.sort-indicator').textContent = active ? (state.sortDir === 'asc' ? '▼' : '▲') : '▲▼';
      button.title = active ? (state.sortDir === 'asc' ? 'Sắp xếp giảm dần' : 'Về thứ tự gốc') : 'Sắp xếp tăng dần';
    });
  }

  // Tìm gần đúng ngay trên dòng đã tải (mã SP, tên SP, khách, ghi chú, sale); không gọi lại máy chủ.
  function searchedRows() {
    if (!window.TKSFuzzySearch || !TKSFuzzySearch.tokens(state.query).length) return state.rows;
    return TKSFuzzySearch.filter(state.rows, state.query, r => [r.productCode, r.productName, r.customerName, r.customerCode, r.saleNote, r.accountantNote, r.createdByName].join(' '));
  }
  function visibleRows() {
    const source = searchedRows();
    if (state.groupByProduct) {
      return source.slice().sort((a, b) => a.productKey.localeCompare(b.productKey, 'vi', { numeric: true }) || compareBySort(a, b) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    }
    if (!state.sortKey) return source;
    return source.slice().sort((a, b) => compareBySort(a, b) || b.id - a.id);
  }

  function render() {
    const cols = columns();
    const rows = visibleRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), pageCount);
    const start = (state.page - 1) * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);
    let html = '';
    if (state.groupByProduct) {
      let current = null;
      let bucket = [];
      const flush = () => { if (bucket.length) html += groupHeaderHtml(current, rows.filter(r => r.productKey === current), cols) + bucket.join(''); bucket = []; };
      for (const row of pageRows) {
        if (row.productKey !== current) { flush(); current = row.productKey; }
        bucket.push(rowHtml(row, cols));
      }
      flush();
    } else {
      html = pageRows.map(row => rowHtml(row, cols)).join('');
    }
    $('vrRows').innerHTML = html;
    $('vrTable').setAttribute('aria-busy', String(state.loading));
    $('vrReload').disabled = state.loading;
    $('vrReload').classList.toggle('is-loading', state.loading);
    // Chỉ ghi khi có điều cần báo — không xóa thông báo lưu / xung đột vừa hiện.
    if (!state.loading && !state.error) {
      if (!state.rows.length) setStatus('Không có yêu cầu phù hợp.');
      else if (state.truncated) setStatus('Chỉ hiện 5,000 dòng mới nhất — hãy lọc thêm.', 'warn');
    }
    const ready = !state.loading && rows.length > 0;
    $('vrPager').hidden = !ready;
    if (ready) {
      $('vrCount').textContent = `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} / ${rows.length} dòng`;
      $('vrPage').textContent = `Trang ${state.page} / ${pageCount}`;
      $('vrFirst').disabled = $('vrPrevious').disabled = state.page === 1;
      $('vrNext').disabled = $('vrLast').disabled = state.page === pageCount;
    }
    const pageSelect = $('vrSelectPage');
    if (pageSelect) pageSelect.checked = pageRows.length > 0 && pageRows.every(r => state.selected.has(r.id));
    updateSortHeaders();
    renderSource();
    if (window.TKSTables) window.TKSTables.refresh($('vrTable'));
    if (state.grid) state.grid.refresh();
    updateScrollButtons();
  }

  function renderSource() {
    const status = state.stockStatus;
    const el = $('vrSource');
    if (!status) { el.textContent = ''; el.dataset.kind = ''; return; }
    if (!status.available) {
      el.textContent = `Không đọc được sheet tồn VAT: ${status.error || 'lỗi không rõ'}. Cột Tồn VAT tạm để trống.`;
      el.dataset.kind = 'error';
      return;
    }
    el.dataset.kind = status.stale ? 'warn' : '';
    el.textContent = `Tồn VAT lấy từ Google Sheets${status.loadedAt ? ', cập nhật lúc ' + fmtDateTime(status.loadedAt) : ''}${status.stale ? ' (bản cũ do sheet đang lỗi)' : ''}. Dự kiến hàng về = cont chưa về sớm nhất ở Hàng dự kiến; Trạng thái / Dự kiến ngày về gần nhất lấy từ cont đó (hết cont chưa về thì cont đã về gần nhất).`;
  }

  function renderChips() {
    const presets = [
      { key: 'all', label: 'Tất cả' },
      ...(state.canProcess ? [{ key: 'todo', label: 'Cần xử lý' }] : []),
      ...state.statuses.map(s => ({ key: s.value, label: s.label }))
    ];
    $('vrStatusChips').innerHTML = presets.map(p =>
      `<button type="button" class="vr-chip" data-preset="${escapeHtml(p.key)}" aria-pressed="${p.key === state.preset || (state.preset === 'custom' && state.statusSet.has(p.key))}">${escapeHtml(p.label)}</button>`).join('');
  }

  function renderSaleFilter() {
    const select = $('vrSaleFilter');
    const options = ['<option value="">Tất cả sale</option>', `<option value="me">Của tôi</option>`]
      .concat(state.sales.filter(s => s.id !== state.viewerId).map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name || s.id)}</option>`));
    select.innerHTML = options.join('');
    select.value = state.saleFilter;
  }

  // ---------- Tải dữ liệu ----------
  function filterQuery(options = {}) {
    const params = new URLSearchParams();
    const statuses = state.preset === 'todo' ? TODO_STATUSES : state.preset === 'all' ? [] : [...state.statusSet];
    if (statuses.length) params.set('status', statuses.join(','));
    // Dòng KT vừa sửa: máy chủ vẫn trả về dù không còn khớp bộ lọc (không áp cho file Excel).
    if (options.keep && state.keep.size) params.set('keep', [...state.keep].slice(-500).join(','));
    const createdBy = state.saleFilter === 'me' ? state.viewerId : state.saleFilter;
    if (createdBy) params.set('createdBy', createdBy);
    if (state.from) params.set('from', state.from);
    if (state.to) params.set('to', state.to);
    if (options.withSearch && state.query) params.set('q', state.query);
    const text = params.toString();
    return text ? '?' + text : '';
  }

  async function load() {
    const seq = ++state.requestSeq;
    state.loading = true;
    state.error = '';
    setStatus('Đang tải yêu cầu…');
    render();
    try {
      const data = await api('/' + filterQuery({ keep: true }));
      if (seq !== state.requestSeq) return;
      state.rows = data.rows || [];
      state.metrics = data.metrics || {};
      state.sales = data.sales || [];
      state.statuses = data.statuses || state.statuses;
      state.stockStatus = data.stockStatus || null;
      state.truncated = !!data.truncated;
      state.rowOrder = data.rowOrder !== false;
      state.isManager = !!(data.viewer && data.viewer.isManager);
      $('vrExport').hidden = !(state.canProcess || state.isManager);
      setStatus('');
      const ids = new Set(state.rows.map(r => r.id));
      state.selected = new Set([...state.selected].filter(id => ids.has(id)));
      renderChips();
      renderSaleFilter();
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.rows = [];
      state.error = error.message;
      setStatus('Không tải được danh sách: ' + error.message, 'error');
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        render();
      }
    }
  }

  // ---------- Xuất Excel (KT / quản lý) ----------
  // Server dựng file từ cùng bộ lọc với danh sách: mọi dòng khớp (không gom), đủ mọi cột kể cả cột đang ẩn.
  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportExcel() {
    const button = $('vrExport');
    if (state.exporting) return;
    state.exporting = true;
    button.disabled = true;
    button.classList.add('is-loading');
    setStatus('Đang tạo file Excel…');
    try {
      const response = await fetch(API + '/export' + filterQuery({ withSearch: true }), { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        let data = null;
        try { data = await response.json(); } catch (error) { data = null; }
        throw new Error((data && data.error) || `Lỗi ${response.status}`);
      }
      const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '');
      downloadBlob(await response.blob(), match ? match[1] : 'order_vat.xlsx');
      if (response.headers.get('X-Export-Truncated') === '1') setStatus('Đã xuất Excel, nhưng chỉ gồm 5,000 dòng mới nhất — hãy lọc thêm nếu cần đủ.', 'warn');
      else setStatus('Đã xuất Excel.', 'ok');
    } catch (error) {
      setStatus('Không xuất được Excel: ' + error.message, 'error');
    } finally {
      state.exporting = false;
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }

  function replaceRow(updated) {
    const index = state.rows.findIndex(r => r.id === updated.id);
    if (index >= 0) state.rows[index] = updated;
  }

  // ---------- Sửa nhanh trên dòng (KT) ----------
  async function saveInline(input) {
    const id = Number(input.dataset.id);
    const row = state.rows.find(r => r.id === id);
    if (!row) return;
    const field = input.dataset.inline;
    const value = input.value;
    if ((row[field] ?? '') === value) return;
    const before = row[field] ?? (field === 'arrivalDate' ? null : '');
    const after = field === 'arrivalDate' ? (value || null) : value;
    const entry = pushHistory({ kind: 'fields', label: `sửa yêu cầu #${id}`, before: [{ id, changes: { [field]: before } }], after: [{ id, changes: { [field]: after } }] });
    notify(`Đã lưu yêu cầu #${id}.`, 'ok', { undo: true });
    if (!await saveFields(entry.after)) dropHistory(entry);
  }

  // ---------- Form tạo / sửa (sale) ----------
  const productOptions = new Map();
  const customerOptions = new Map();

  // Hộp sửa có 3 chế độ: 'create' (chỉ form), 'edit' (form + nút "Lịch sử" mở khung chat nổi bên phải + nút Xóa),
  // 'history' (không sửa được nữa: thân modal chỉ còn danh sách lịch sử).
  function setHistoryOpen(open) {
    const dialog = $('vrFormDialog');
    const show = !!open && dialog.dataset.mode === 'edit';
    dialog.dataset.historyOpen = String(show);
    $('vrHistoryToggle').setAttribute('aria-expanded', String(show));
    $('vrChat').hidden = !show;
  }

  function setSaving(saving) {
    state.saving = saving;
    const button = $('vrFormSubmit');
    button.disabled = saving;
    button.classList.toggle('is-loading', saving);
    button.setAttribute('aria-busy', String(saving));
    $('vrFormSubmitLabel').textContent = saving ? (state.editing ? 'Đang lưu…' : 'Đang gửi…') : (state.editing ? 'Lưu thay đổi' : 'Gửi yêu cầu');
  }

  function autosizeNote() {
    const note = $('vrNote');
    note.style.height = 'auto';
    note.style.height = Math.min(Math.max(note.scrollHeight, 44), 160) + 'px';
  }

  function openRequest(row) {
    if (!row) return;
    openForm(row, row.canEditSale ? 'edit' : 'history');
  }

  function openForm(row, mode = row ? 'edit' : 'create') {
    closeMenu();
    state.editing = row || null;
    const dialog = $('vrFormDialog');
    const editable = mode !== 'history';
    dialog.dataset.mode = mode;
    $('vrFormBody').hidden = !editable;
    $('vrHistoryInline').hidden = editable;
    $('vrHistoryToggle').hidden = mode !== 'edit';
    $('vrFormSubmit').hidden = !editable;
    $('vrFormCancel').textContent = editable ? 'Hủy' : 'Đóng';
    $('vrFormDelete').hidden = !(mode === 'edit' && row && row.canDelete);
    setHistoryOpen(false);
    $('vrFormTitle').textContent = !row ? 'Tạo ORDER VAT' : mode === 'history' ? `Lịch sử yêu cầu #${row.id}` : `Sửa yêu cầu #${row.id}`;
    $('vrFormSub').textContent = row ? requestSummary(row) : 'Gửi ORDER VAT cho kế toán.';
    $('vrHistoryTitle').textContent = row ? `Lịch sử yêu cầu #${row.id}` : 'Lịch sử yêu cầu';
    if (row) loadHistory(row.id);
    else { $('vrHistoryCount').textContent = ''; $('vrChatCount').textContent = ''; }
    setSaving(false);
    $('vrProduct').value = row ? row.productCode : '';
    $('vrCustomer').value = row ? row.customerName : '';
    $('vrQuantity').value = row && row.quantity !== null ? fmtNumber(row.quantity) : '';
    $('vrPrice').value = row && row.unitPrice !== null ? fmtNumber(row.unitPrice) : '';
    $('vrFullVat').value = row && row.fullVat ? 'true' : 'false';
    $('vrNote').value = row ? row.saleNote : '';
    $('vrFormError').textContent = '';
    $('vrProductInfo').innerHTML = '';
    ++infoSeq;
    ++priceSeq;
    $('vrPriceSuggestion').innerHTML = '';
    customerOptions.clear();
    if (row && row.customerCode) customerOptions.set(row.customerName, row.customerCode);
    updateTotal();
    showDialog(dialog);
    $('vrFormBody').scrollTop = 0;
    if (!editable) { $('vrFormCancel').focus(); return; }
    autosizeNote();
    if (row) loadProductInfo(row.productCode);
    $('vrProduct').focus();
  }

  function requestSummary(row) {
    const parts = [row.productCode, row.customerName, row.quantity !== null ? `${fmtNumber(row.quantity)} × ${fmtNumber(row.unitPrice) || '—'}` : '', row.statusLabel];
    const text = parts.filter(Boolean).join(' · ');
    return row.isLockedForSale && !row.canEditSale ? `${text} — đã khóa, chỉ xem lịch sử.` : text;
  }

  function historyValue(field, value) {
    if (value === null || value === undefined || value === '') return '(trống)';
    if (field === 'status') return statusLabel(value);
    if (field === 'full_vat') return value === 'true' ? 'Full VAT' : 'Chưa VAT';
    if (field === 'arrival_date') return fmtDate(value);
    if (field === 'quantity' || field === 'unit_price_excl_vat') return fmtNumber(value);
    return value;
  }

  // Mỗi sự kiện lịch sử là 1 "tin nhắn": icon + màu nhẹ theo loại (tạo / nhập sheet / trạng thái / sửa trường / xóa).
  const CHAT_ICONS = {
    create: '<path d="M12 5v14M5 12h14"></path>',
    import: '<path d="M12 3v12M7 10l5 5 5-5"></path><path d="M5 21h14"></path>',
    status: '<path d="M20 12 12 20l-9-9V3h8Z"></path><circle cx="7.5" cy="7.5" r="1.2"></circle>',
    edit: '<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
    delete: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"></path>'
  };
  function chatItemHtml(h) {
    const kind = h.field === 'status' ? 'status' : h.field ? 'edit' : (CHAT_ICONS[h.action] ? h.action : 'edit');
    const text = h.field
      ? `${h.field === 'status' ? 'Thay đổi trạng thái' : 'Cập nhật ' + escapeHtml((FIELD_LABELS[h.field] || h.field).toLowerCase())}: ` +
        `<span class="vr-chat-old">${escapeHtml(historyValue(h.field, h.oldValue))}</span> → <b>${escapeHtml(historyValue(h.field, h.newValue))}</b>`
      : escapeHtml(ACTION_LABELS[h.action] || h.action) + (h.action === 'import' && h.newValue ? ` <span class="vr-chat-old">(${escapeHtml(h.newValue)})</span>` : '');
    return `<li class="vr-chat-item" data-kind="${kind}">` +
      `<span class="vr-chat-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${CHAT_ICONS[kind]}</svg></span>` +
      `<div class="vr-chat-bubble"><div class="vr-chat-meta"><b>${escapeHtml(h.changedByName || '—')}</b><time datetime="${escapeHtml(h.changedAt || '')}">${escapeHtml(fmtDateTime(h.changedAt))}</time></div>` +
      `<div class="vr-chat-text">${text}</div></div></li>`;
  }

  let historySeq = 0;
  async function loadHistory(id) {
    const seq = ++historySeq;
    const lists = [$('vrHistoryList'), $('vrHistoryInlineList')];
    const fill = html => lists.forEach(list => { list.innerHTML = html; });
    const count = text => { $('vrHistoryCount').textContent = text; $('vrChatCount').textContent = text; };
    fill('<li class="vr-chat-empty">Đang tải…</li>');
    count('');
    try {
      const data = await api(`/${id}/history`);
      if (seq !== historySeq) return;
      const rows = data.rows || [];
      count(rows.length ? String(rows.length) : '');
      fill(rows.length ? rows.map(chatItemHtml).join('') : '<li class="vr-chat-empty">Chưa có lịch sử.</li>');
    } catch (error) {
      if (seq !== historySeq) return;
      fill(`<li class="vr-chat-empty vr-error-text">${escapeHtml(error.message)}</li>`);
    }
  }

  function updateTotal() {
    const qty = parseNumber($('vrQuantity').value);
    const price = parseNumber($('vrPrice').value);
    $('vrTotal').textContent = Number.isFinite(qty) && Number.isFinite(price) ? fmtNumber(qty * price) + ' ₫' : '—';
  }

  const suggestProducts = debounce(async query => {
    if (!query.trim()) { $('vrProductList').innerHTML = ''; productOptions.clear(); return; }
    try {
      const data = await api('/product-suggest?q=' + encodeURIComponent(query.trim()));
      if (query !== $('vrProduct').value) return;
      productOptions.clear();
      $('vrProductList').innerHTML = (data.results || []).map(p => {
        productOptions.set(p.code.toLowerCase(), p);
        return `<option value="${escapeHtml(p.code)}">${escapeHtml(p.name)}</option>`;
      }).join('');
    } catch (error) { /* gợi ý không bắt buộc */ }
  }, 250);

  const suggestCustomers = debounce(async query => {
    if (query.trim().length < 2) { $('vrCustomerList').innerHTML = ''; customerOptions.clear(); return; }
    try {
      const data = await api('/customer-suggest?q=' + encodeURIComponent(query.trim()) + '&limit=10');
      if (query !== $('vrCustomer').value) return;
      customerOptions.clear();
      $('vrCustomerList').innerHTML = (data.results || []).map(c => {
        if (c.code) customerOptions.set(c.name, c.code);
        const source = c.source === 'order-vat' ? 'Đã dùng trong VAT' : 'KiotViet';
        return `<option value="${escapeHtml(c.name)}" label="${escapeHtml([c.code, source].filter(Boolean).join(' · '))}"></option>`;
      }).join('');
    } catch (error) { /* gợi ý không bắt buộc */ }
  }, 300);

  let infoSeq = 0;
  let priceSeq = 0;
  async function loadPriceSuggestion(code) {
    const target = $('vrPriceSuggestion');
    const seq = ++priceSeq;
    target.innerHTML = code ? '<span class="vr-muted">Đang tìm giá từ yêu cầu VAT gần nhất…</span>' : '';
    if (!code) return;
    try {
      const data = await api('/price-suggest?code=' + encodeURIComponent(code));
      if (seq !== priceSeq) return;
      const recent = data.latestOrder;
      if (!recent || !Number.isFinite(Number(recent.price)) || Number(recent.price) <= 0) {
        target.innerHTML = '<span class="vr-muted">Chưa có giá VAT trước đó cho mã này.</span>';
        return;
      }
      const when = recent.createdAt ? fmtDateTime(recent.createdAt) : 'không rõ ngày';
      target.innerHTML = `<span>Giá từ yêu cầu VAT gần nhất · ${escapeHtml(when)}${recent.customerName ? ' · ' + escapeHtml(recent.customerName) : ''}</span>` +
        `<button type="button" data-price="${Number(recent.price)}">Dùng ${fmtNumber(recent.price)} ₫</button>`;
    } catch (error) {
      if (seq === priceSeq) target.innerHTML = '<span class="vr-muted">Chưa tải được giá tham khảo.</span>';
    }
  }

  async function loadProductInfo(code) {
    const target = $('vrProductInfo');
    const trimmed = String(code || '').trim();
    const seq = ++infoSeq;
    ++priceSeq;
    $('vrPriceSuggestion').innerHTML = '';
    if (!trimmed) { target.innerHTML = ''; return; }
    target.innerHTML = '<span class="vr-muted">Đang tra mã…</span>';
    try {
      const m = await api('/metrics?code=' + encodeURIComponent(trimmed));
      if (seq !== infoSeq) return;
      // Tồn / chờ khai / hàng về chỉ có khi là KT (server không gửi cho sale).
      const hasMetrics = m.pendingInsertQty !== undefined;
      target.innerHTML = `<strong>${escapeHtml(m.productName)}</strong>` + (hasMetrics
        ? `<span>Tồn VAT: <b>${m.vatStock ? fmtNumber(m.vatStock.total) : '—'}</b></span>` +
          `<span>Đang chờ khai: <b>${fmtNumber(m.pendingInsertQty)}</b></span>` +
          `<span>Dự kiến hàng về: <b>${escapeHtml(m.incomingContainer || '—')}</b></span>` +
          `<span>Trạng thái hàng: <b>${escapeHtml([m.containerStatus, m.containerEta].filter(Boolean).join(' ') || '—')}</b></span>`
        : '');
      target.dataset.valid = 'true';
      loadPriceSuggestion(trimmed);
    } catch (error) {
      if (seq !== infoSeq) return;
      target.dataset.valid = 'false';
      target.innerHTML = `<span class="vr-error-text">${escapeHtml(error.status === 404 ? 'Không tìm thấy mã SP này.' : error.message)}</span>`;
    }
  }

  function formPayload() {
    const customerName = $('vrCustomer').value.trim();
    return {
      productCode: $('vrProduct').value.trim(),
      customerName,
      customerCode: customerOptions.get(customerName) || null,
      quantity: parseNumber($('vrQuantity').value),
      unitPrice: parseNumber($('vrPrice').value),
      fullVat: $('vrFullVat').value === 'true',
      saleNote: $('vrNote').value.trim()
    };
  }

  function validateForm(payload) {
    if (!payload.productCode) return 'Chưa chọn mã SP.';
    if (!payload.customerName) return 'Chưa nhập khách hàng.';
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0) return 'Số lượng phải là số nguyên lớn hơn 0.';
    if (!Number.isFinite(payload.unitPrice) || payload.unitPrice <= 0) return 'Giá chưa VAT phải lớn hơn 0.';
    return '';
  }

  async function submitForm(event) {
    event.preventDefault();
    const payload = formPayload();
    const problem = validateForm(payload);
    if (state.saving) return;
    if (problem) { $('vrFormError').textContent = problem; return; }
    $('vrFormError').textContent = '';
    setSaving(true);
    try {
      let message;
      if (state.editing) {
        const row = state.editing;
        const before = { productCode: row.productCode, customerName: row.customerName, customerCode: row.customerCode || null, quantity: row.quantity, unitPrice: row.unitPrice, fullVat: row.fullVat, saleNote: row.saleNote };
        const changes = { version: row.version };
        for (const [key, value] of Object.entries(payload)) if (before[key] !== value) changes[key] = value;
        if (Object.keys(changes).length > 1) await api('/' + row.id, { method: 'PATCH', body: changes });
        message = `Đã lưu yêu cầu #${row.id}.`;
      } else {
        const created = await api('/', { method: 'POST', body: payload });
        message = `Đã gửi yêu cầu #${created.id}.`;
      }
      setSaving(false);
      closeDialog($('vrFormDialog'));
      await load();
      setStatus(message, 'ok');
    } catch (error) {
      if (error.status === 409 && error.data.latest) {
        const latest = error.data.latest;
        replaceRow(latest);
        render();
        if (latest.canEditSale) {
          state.editing = latest;
          $('vrFormError').textContent = 'Yêu cầu vừa được người khác cập nhật. Kiểm tra lại rồi lưu lần nữa.';
          loadHistory(latest.id);
        } else {
          openForm(latest, 'history');
          $('vrFormSub').textContent = 'Yêu cầu vừa bị kế toán khóa, không sửa được nữa. ' + requestSummary(latest);
        }
      } else {
        $('vrFormError').textContent = error.message;
      }
    } finally {
      if (state.saving) setSaving(false);
    }
  }

  // ---------- Hộp thoại ----------
  function showDialog(dialog) {
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function closeDialog(dialog) {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }
  function openInfo(title, html) {
    $('vrInfoTitle').textContent = title;
    $('vrInfoBody').innerHTML = html;
    showDialog($('vrInfoDialog'));
  }

  function openHistory(id) {
    const row = state.rows.find(r => r.id === id);
    if (row) openForm(row, 'history');
  }

  // ---------- Menu chuột phải trên dòng ----------
  let menuRowId = null;
  function openMenu(row, x, y) {
    const menu = $('vrRowMenu');
    menuRowId = row.id;
    menu.querySelector('[data-menu="edit"]').hidden = !row.canEditSale;
    menu.hidden = false;
    const { innerWidth, innerHeight } = window;
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + 'px';
    const first = [...menu.querySelectorAll('button')].find(b => !b.hidden);
    if (first) first.focus();
  }
  function closeMenu() {
    const menu = $('vrRowMenu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menuRowId = null;
  }

  // ---------- Nút cuộn ngang về cột đầu / cột cuối ----------
  function updateScrollButtons() {
    const scroll = $('vrScroll');
    const max = scroll.scrollWidth - scroll.clientWidth;
    $('vrScrollStart').hidden = !(max > 4 && scroll.scrollLeft > 4);
    $('vrScrollEnd').hidden = !(max > 4 && scroll.scrollLeft < max - 4);
  }
  function scrollTableTo(end) {
    const scroll = $('vrScroll');
    const left = end ? scroll.scrollWidth : 0;
    if (typeof scroll.scrollTo === 'function') scroll.scrollTo({ left, behavior: 'smooth' });
    else scroll.scrollLeft = left;
  }

  function openStock(productKey) {
    const m = state.metrics[productKey];
    const row = state.rows.find(r => r.productKey === productKey);
    if (!m || !m.vatStock) return;
    openInfo(`Tồn VAT · ${row ? row.productCode : productKey}`,
      '<table class="vr-mini-table" data-table-controls="off"><thead><tr><th>Công ty</th><th>Mã VAT</th><th class="num">Tồn đầu ngày</th></tr></thead><tbody>' +
      m.vatStock.byCompany.map(c => `<tr><td>${escapeHtml(c.company)}</td><td>${escapeHtml(c.vatCode)}</td><td class="num">${fmtNumber(c.stock)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><th colspan="2">Tổng</th><th class="num">${fmtNumber(m.vatStock.total)}</th></tr></tfoot></table>`);
  }

  // Xóa ngay trong hộp sửa (chỉ hiện khi server cho phép: chủ yêu cầu chưa khóa, hoặc Quản lý).
  async function deleteEditing() {
    const row = state.editing;
    if (!row) return; // xóa ngay, không hỏi lại (xóa mềm, vẫn còn trong lịch sử)
    $('vrFormDelete').disabled = true;
    try {
      await api(`/${row.id}?version=${row.version}`, { method: 'DELETE' });
      closeDialog($('vrFormDialog'));
      await load();
      setStatus(`Đã xóa yêu cầu #${row.id}.`, 'ok');
    } catch (error) {
      if (error.status === 409 && error.data.latest) {
        replaceRow(error.data.latest);
        render();
        openForm(error.data.latest, error.data.latest.canEditSale ? 'edit' : 'history');
        $('vrFormError').textContent = 'Yêu cầu vừa được người khác cập nhật, chưa xóa. Kiểm tra lại rồi thử lại.';
      } else {
        $('vrFormError').textContent = error.message;
      }
    } finally {
      $('vrFormDelete').disabled = false;
    }
  }

  // ---------- Giao diện chung ----------
  function syncTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    $('themeToggle').setAttribute('aria-pressed', String(light));
  }

  function bindEvents() {
    $('themeToggle').addEventListener('click', () => {
      const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem('tks-dashboard-theme', theme); } catch (error) { /* tùy chọn */ }
      syncTheme();
    });
    const toggleSidebar = () => {
      const open = $('sidebar').classList.toggle('open');
      $('backdrop').classList.toggle('show', open);
      $('menuBtn').setAttribute('aria-expanded', String(open));
    };
    $('menuBtn').addEventListener('click', toggleSidebar);
    $('backdrop').addEventListener('click', toggleSidebar);

    $('vrStatusChips').addEventListener('click', event => {
      const chip = event.target.closest('[data-preset]');
      if (!chip) return;
      // "Cần xử lý" / "Tất cả" chỉ chọn một mình; các chip trạng thái bật / tắt, chọn nhiều cái cùng lúc.
      const key = chip.dataset.preset;
      if (key === 'todo' || key === 'all') { state.preset = key; state.statusSet.clear(); }
      else {
        if (state.preset !== 'custom') { state.preset = 'custom'; state.statusSet = new Set([key]); }
        else if (state.statusSet.has(key)) state.statusSet.delete(key);
        else state.statusSet.add(key);
        if (!state.statusSet.size) state.preset = 'all';
      }
      resetView();
      renderChips();
      load();
    });
    // Đổi bộ lọc / tải lại: bỏ các dòng đang giữ lại sau khi sửa, về trang 1.
    const resetView = () => { state.keep.clear(); state.page = 1; };
    $('vrSaleFilter').addEventListener('change', event => { state.saleFilter = event.target.value; resetView(); load(); });
    $('vrFrom').addEventListener('change', event => { state.from = event.target.value; resetView(); load(); });
    $('vrTo').addEventListener('change', event => { state.to = event.target.value; resetView(); load(); });
    // Lọc tức thì trên dữ liệu đã tải; value rỗng (Backspace/cắt/nút X) cũng chạy và trả đủ dòng.
    $('vrSearch').addEventListener('input', event => { state.query = event.target.value.trim(); state.page = 1; render(); });
    $('vrGroupToggle').addEventListener('click', event => {
      state.groupByProduct = !state.groupByProduct;
      event.currentTarget.setAttribute('aria-pressed', String(state.groupByProduct));
      state.page = 1;
      render();
    });
    $('vrReload').addEventListener('click', () => { state.keep.clear(); load(); });
    $('vrExport').addEventListener('click', exportExcel);
    // Tạo mới = form nhiều dòng (vat-request-batch.js); hộp sửa 1 yêu cầu chỉ còn dùng để sửa / xem lịch sử.
    $('vrCreate').addEventListener('click', () => { if (state.batch) state.batch.open(); });

    ['First', 'Previous', 'Next', 'Last'].forEach(direction => {
      $('vr' + direction).addEventListener('click', () => {
        const pageCount = Math.max(1, Math.ceil(state.rows.length / PAGE_SIZE));
        if (direction === 'First') state.page = 1;
        else if (direction === 'Last') state.page = pageCount;
        else state.page += direction === 'Previous' ? -1 : 1;
        render();
        document.querySelector('.vr-scroll').scrollTop = 0;
      });
    });

    const table = $('vrTable');
    table.addEventListener('change', event => {
      const target = event.target;
      if (target.matches('[data-inline]')) {
        if (target.dataset.inline === 'status') target.dataset.status = target.value; // đổi màu ngay, không chờ lưu
        saveInline(target);
        return;
      }
      if (target.matches('[data-select]')) {
        const id = Number(target.dataset.select);
        if (target.checked) state.selected.add(id); else state.selected.delete(id);
        rowAnchor = id; // tick tay cũng làm mốc cho Shift+bấm tay nắm
        render();
        return;
      }
      if (target.matches('[data-select-group]')) {
        state.rows.filter(r => r.productKey === target.dataset.selectGroup).forEach(r => target.checked ? state.selected.add(r.id) : state.selected.delete(r.id));
        render();
        return;
      }
      if (target.id === 'vrSelectPage') {
        const start = (state.page - 1) * PAGE_SIZE;
        visibleRows().slice(start, start + PAGE_SIZE).forEach(r => target.checked ? state.selected.add(r.id) : state.selected.delete(r.id));
        render();
      }
    });
    table.addEventListener('click', event => {
      const sort = event.target.closest('[data-sort]');
      if (sort) { cycleSort(sort.dataset.sort); return; }
      const stock = event.target.closest('[data-stock]');
      if (stock) { openStock(stock.dataset.stock); return; }
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const id = Number(button.dataset.id);
      if (button.dataset.action === 'edit') openForm(state.rows.find(r => r.id === id), 'edit');
      else if (button.dataset.action === 'history') openHistory(id);
    });
    // Nháy đúp / Enter vào dòng: sửa được thì mở hộp sửa, không thì chỉ lịch sử. Bỏ qua ô nhập sửa nhanh của KT.
    const INTERACTIVE = 'input,select,textarea,button,a,label';
    const rowOf = target => {
      const tr = target.closest('tr[data-id]');
      return tr ? state.rows.find(r => r.id === Number(tr.dataset.id)) : null;
    };
    // Tay nắm ⋮⋮ ở cột Chọn, kiểu đầu dòng Google Sheet: bấm chọn cả dòng, Shift+bấm chọn đoạn liền, Ctrl/⌘+bấm
    // thêm / bỏ từng dòng (chung vùng chọn với ô tick -> thanh hàng loạt dùng được ngay). Kéo tay nắm của 1 dòng
    // đang chọn: cả nhóm (trên trang này) đi theo, dòng rời nhau gom thành 1 khối. Vạch xanh chỉ chỗ thả,
    // sát mép tự cuộn, Esc hủy.
    let rowDrag = null; // { ids, pressed, targetId, after }
    let rowAnchor = null; // dòng mốc cho Shift+bấm
    const clearDropMarks = () => table.querySelectorAll('.vr-drop-before, .vr-drop-after, .vr-row-dragging').forEach(tr => tr.classList.remove('vr-drop-before', 'vr-drop-after', 'vr-row-dragging'));
    const endRowDrag = () => { rowDrag = null; clearDropMarks(); table.classList.remove('vr-rows-dragging'); };
    table.addEventListener('mousedown', event => {
      const grip = event.button === 0 && event.target.closest('[data-row-drag]');
      if (!grip) return;
      event.preventDefault();
      const id = Number(grip.dataset.rowDrag);
      const pageIds = pageRowIds();
      if (event.shiftKey && rowAnchor !== null && pageIds.includes(rowAnchor)) {
        const [from, to] = [pageIds.indexOf(rowAnchor), pageIds.indexOf(id)].sort((a, b) => a - b);
        if (!(event.ctrlKey || event.metaKey)) state.selected.clear();
        pageIds.slice(from, to + 1).forEach(rowId => state.selected.add(rowId));
        render();
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
        rowAnchor = id;
        render();
        return;
      }
      if (!state.selected.has(id)) { state.selected = new Set([id]); render(); }
      rowAnchor = id;
      const ids = pageRowIds().filter(rowId => state.selected.has(rowId));
      rowDrag = { ids, pressed: id, targetId: null, after: false };
      ids.forEach(rowId => { const tr = $('vrRows').querySelector(`tr[data-id="${rowId}"]`); if (tr) tr.classList.add('vr-row-dragging'); });
      table.classList.add('vr-rows-dragging');
    });
    table.addEventListener('mousemove', event => {
      if (!rowDrag) return;
      const tr = event.target.closest('tr[data-id]');
      const scroller = $('vrScroll');
      const box = scroller.getBoundingClientRect();
      if (event.clientY < box.top + 40) scroller.scrollTop -= 24;
      else if (box.bottom && event.clientY > box.bottom - 40) scroller.scrollTop += 24;
      if (!tr) return;
      const rect = tr.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const targetId = Number(tr.dataset.id);
      if (rowDrag.targetId === targetId && rowDrag.after === after) return;
      Object.assign(rowDrag, { targetId, after });
      table.querySelectorAll('.vr-drop-before, .vr-drop-after').forEach(el => el.classList.remove('vr-drop-before', 'vr-drop-after'));
      if (!rowDrag.ids.includes(targetId)) tr.classList.add(after ? 'vr-drop-after' : 'vr-drop-before');
    });
    document.addEventListener('mouseup', () => {
      if (!rowDrag) return;
      const { ids, pressed, targetId, after } = rowDrag;
      endRowDrag();
      if (!targetId || ids.includes(targetId)) {
        // Bấm (không kéo đi đâu) vào 1 dòng trong vùng nhiều dòng -> chỉ chọn dòng đó, như Sheet.
        if (ids.length > 1 && (!targetId || targetId === pressed)) { state.selected = new Set([pressed]); render(); }
        return;
      }
      const neighbors = dropNeighbors(ids, targetId, after);
      if (!neighbors) return;
      // Thả lại đúng chỗ cũ (khối đã liền và không đổi vị trí) thì thôi.
      const current = pageRowIds();
      const rest = current.filter(rowId => !ids.includes(rowId));
      const at = neighbors.below ? rest.indexOf(neighbors.below) : rest.indexOf(neighbors.above) + 1;
      const next = [...rest.slice(0, at), ...ids, ...rest.slice(at)];
      if (next.every((rowId, i) => rowId === current[i])) return;
      moveRows(ids, neighbors);
    });
    document.addEventListener('keydown', event => { if (rowDrag && event.key === 'Escape') endRowDrag(); });
    // Bàn phím: Alt+↑ / Alt+↓ trên tay nắm dời 1 dòng.
    table.addEventListener('keydown', event => {
      const grip = event.target.closest('[data-row-drag]');
      if (!grip || !event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      const id = Number(grip.dataset.rowDrag);
      const ids = [...$('vrRows').querySelectorAll('tr[data-id]')].map(tr => Number(tr.dataset.id));
      const index = ids.indexOf(id);
      const target = ids[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (target === undefined) return;
      moveRows([id], dropNeighbors([id], target, event.key === 'ArrowDown')).then(() => {
        const again = $('vrRows').querySelector(`[data-row-drag="${id}"]`);
        if (again) again.focus();
      });
    });

    // Ô KT trên thiết bị cảm ứng: chạm là sửa (không có nháy đúp / kéo chọn vùng).
    const coarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
    table.addEventListener('click', event => {
      const td = event.target.closest('td[data-editable]');
      if (td && coarse && coarse.matches && !event.target.closest(INTERACTIVE)) startEdit(td);
    });
    table.addEventListener('dblclick', event => {
      if (event.target.closest(INTERACTIVE)) return;
      const editableCell = event.target.closest('td[data-editable]');
      if (editableCell) { startEdit(editableCell); return; }
      const row = rowOf(event.target);
      if (!row) return;
      if (window.getSelection) window.getSelection().removeAllRanges();
      openRequest(row);
    });
    table.addEventListener('contextmenu', event => {
      if (event.target.closest('input,select,textarea')) return;
      const row = rowOf(event.target);
      if (!row) return;
      event.preventDefault();
      let x = event.clientX, y = event.clientY;
      if (!x && !y) { const rect = event.target.closest('tr').getBoundingClientRect(); x = rect.left + 24; y = rect.top + rect.height / 2; }
      openMenu(row, x, y);
    });
    table.addEventListener('keydown', event => {
      if (event.target.matches('tr[data-id]') && event.key === 'Enter') { event.preventDefault(); openRequest(rowOf(event.target)); return; }
      const control = event.target.closest('td [data-inline]');
      if (!control) return;
      // Ô sửa: Enter lưu (blur -> change), Esc bỏ sửa. Vùng chọn giữ nguyên (grid.refresh sau render).
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); control.dataset.cancel = 'true'; render(); }
      else if (event.key === 'Enter') { event.preventDefault(); control.blur(); }
    });
    table.addEventListener('focusout', event => {
      const control = event.target.closest && event.target.closest('td [data-inline]');
      if (!control || control.disabled || control.dataset.cancel || !control.isConnected) return;
      const row = state.rows.find(r => r.id === Number(control.dataset.id));
      // Không đổi giá trị thì đóng ô sửa; có đổi thì sự kiện change đã gọi saveInline (tự vẽ lại).
      if (!row || (row[control.dataset.inline] ?? '') === control.value) render();
    });

    const menu = $('vrRowMenu');
    menu.addEventListener('click', event => {
      const item = event.target.closest('[data-menu]');
      if (!item) return;
      const row = state.rows.find(r => r.id === menuRowId);
      closeMenu();
      if (!row) return;
      if (item.dataset.menu === 'edit' && row.canEditSale) openForm(row, 'edit');
      else openForm(row, 'history');
    });
    menu.addEventListener('keydown', event => {
      const items = [...menu.querySelectorAll('button')].filter(b => !b.hidden);
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
      }
    });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('#vrRowMenu')) closeMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
    window.addEventListener('resize', () => { closeMenu(); updateScrollButtons(); });
    $('vrScroll').addEventListener('scroll', () => { closeMenu(); updateScrollButtons(); }, { passive: true });
    $('vrScrollStart').addEventListener('click', () => scrollTableTo(false));
    $('vrScrollEnd').addEventListener('click', () => scrollTableTo(true));

    $('vrHistoryToggle').addEventListener('click', () => setHistoryOpen($('vrFormDialog').dataset.historyOpen !== 'true'));
    $('vrChatClose').addEventListener('click', () => { setHistoryOpen(false); $('vrHistoryToggle').focus(); });
    $('vrFormClose').addEventListener('click', () => closeDialog($('vrFormDialog')));
    $('vrNote').addEventListener('input', autosizeNote);
    // Esc: đóng khung lịch sử trước, lần nữa mới đóng hộp sửa.
    $('vrFormDialog').addEventListener('cancel', event => {
      if ($('vrFormDialog').dataset.historyOpen === 'true') { event.preventDefault(); setHistoryOpen(false); $('vrHistoryToggle').focus(); }
    });
    $('vrFormDialog').addEventListener('close', () => setHistoryOpen(false));
    $('vrFormDelete').addEventListener('click', deleteEditing);

    // Ctrl+Z hoàn tác, Ctrl+Y / Ctrl+Shift+Z làm lại (KT). Đang gõ trong ô nhập thì để trình duyệt tự xử lý.
    document.addEventListener('keydown', event => {
      if (!state.canProcess || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused.matches('input,textarea,select,[contenteditable="true"]')) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      stepHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    });

    $('vrProduct').addEventListener('input', event => {
      const value = event.target.value;
      ++infoSeq;
      ++priceSeq;
      $('vrProductInfo').innerHTML = '';
      $('vrPriceSuggestion').innerHTML = '';
      suggestProducts(value);
      if (productOptions.has(value.trim().toLowerCase())) loadProductInfo(value);
    });
    $('vrProduct').addEventListener('change', event => loadProductInfo(event.target.value));
    $('vrCustomer').addEventListener('input', event => suggestCustomers(event.target.value));
    $('vrQuantity').addEventListener('input', updateTotal);
    $('vrPrice').addEventListener('input', updateTotal);
    $('vrPriceSuggestion').addEventListener('click', event => {
      const button = event.target.closest('button[data-price]');
      if (!button) return;
      $('vrPrice').value = fmtNumber(button.dataset.price);
      updateTotal();
      $('vrPrice').focus();
    });
    $('vrForm').addEventListener('submit', submitForm);
    $('vrFormCancel').addEventListener('click', () => closeDialog($('vrFormDialog')));
    $('vrInfoClose').addEventListener('click', () => closeDialog($('vrInfoDialog')));

    if (window.matchMedia) {
      const mobile = window.matchMedia('(max-width: 600px)');
      if (mobile.addEventListener) mobile.addEventListener('change', () => { renderHead(); render(); });
    }
  }

  async function init() {
    syncTheme();
    bindEvents();
    state.user = await window.TKSNav.authGuard();
    state.viewerId = state.user && state.user.id;
    state.canProcess = window.TKSNav.can('accounting.vatRequestProcess');
    window.TKSNav.renderTopSidebar($('sidebar'), 'accounting', state.user);
    // KT mở trang thấy ngay việc cần làm (Cần xử lý); mọi người mặc định xem tất cả sale.
    state.preset = state.canProcess ? 'todo' : 'all';
    state.saleFilter = ''; // mặc định xem tất cả sale; chọn 'Của tôi' ở bộ lọc Sale khi cần
    $('vrGroupToggle').hidden = !state.canProcess;
    $('vrSub').textContent = state.canProcess
      ? 'Lọc “Cần xử lý” để xem yêu cầu chờ khai; kéo chấm / dán như Sheet để sửa nhiều dòng (Ctrl+Z hoàn tác); kéo tay nắm ⋮⋮ để xếp thứ tự ưu tiên.'
      : 'Gửi ORDER VAT cho kế toán. Yêu cầu ở trạng thái 0, 1, 2 đã khóa, không sửa được.';
    if (window.TKSVatRequestBatch) {
      state.batch = window.TKSVatRequestBatch.createBatchForm({
        api, escapeHtml, fmtNumber, debounce, showDialog, closeDialog, userId: state.viewerId,
        onSubmitted: async result => {
          await load();
          setStatus(result.duplicate
            ? `${result.created} yêu cầu này đã được gửi trước đó, không tạo trùng.`
            : `Đã gửi ${result.created} yêu cầu.`, 'ok');
        }
      });
    }
    renderHead();
    if (state.canProcess) mountToast();
    if (window.TKSVatGrid) {
      state.grid = window.TKSVatGrid.attach($('vrTable'), {
        canEdit: () => state.canProcess, editable: isGridEditable, copyText, cellValue: gridCellValue, startEdit, apply: applyGridEdits
      });
    }
    await load();
  }

  window.TKSVatRequest = { init, parseNumber, fmtDate };
})();
