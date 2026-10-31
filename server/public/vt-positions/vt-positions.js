(function () {
  'use strict';
  let pageSize = 100;
  const API = '/api/stock-positions';
  // "updated" = thời điểm cập nhật cuối (sắp xếp theo updatedAt); "updatedByName" = Người sửa cuối, cột riêng.
  const BASE_FIELDS = ['code', 'name', 'quantity', 'available', 'kiotQuantity', 'notes', 'arrivalDate', 'location', 'updated', 'updatedByName'];
  const LABELS = {
    code: 'Mã hàng', name: 'Tên hàng', quantity: 'SL kho', available: 'Có thể bốc', kiotQuantity: 'SL Kiot', notes: 'Ghi chú số thùng',
    arrivalDate: 'Ngày về', location: 'Vị trí', updated: 'Cập nhật', updatedByName: 'Người sửa cuối'
  };
  // Các trường sửa được trong hộp chi tiết của dòng (bấm vào dòng để mở).
  const DETAIL_FIELDS = ['notes', 'arrivalDate', 'location'];
  const NUMERIC = ['quantity', 'available', 'kiotQuantity'];
  const MOBILE_FIELDS = ['name', 'quantity', 'available', 'kiotQuantity', 'location'];
  const WIDTHS = {
    desktop: { code: 120, name: 220, quantity: 90, available: 100, kiotQuantity: 90, notes: 220, arrivalDate: 110, location: 110, updated: 150, updatedByName: 160 },
    mobile: { code: 100, name: 180, quantity: 70, available: 80, kiotQuantity: 70, notes: 200, arrivalDate: 100, location: 90, updated: 140, updatedByName: 130 }
  };
  // Đủ cho từ dài nhất của tiêu đề + nút sắp xếp + lề ô (≥ 80px), và cho nội dung cột bẻ dòng được.
  const MIN_WIDTHS = { code: 110, name: 150, quantity: 90, available: 100, kiotQuantity: 90, notes: 130, arrivalDate: 90, location: 80, updated: 140, updatedByName: 120 };
  const WARNING_LABELS = { multi: 'Nhiều quy cách', loose: 'Trừ lẻ', unreadable: 'Sai định dạng', badnumber: 'Số thùng sai', unknowncode: 'Mã SP lạ' };
  const ACTION_LABELS = {
    seed: 'Nhập dữ liệu đầu', create: 'Thêm dòng', edit: 'Sửa', delete: 'Xóa dòng', auto_delete: 'Tự xóa (hết hàng)',
    deduct: 'Trừ SL', import_replace: 'Import thay toàn bộ', import_add: 'Import bổ sung',
    pick: 'Nhặt hàng (đơn)', pick_revert: 'Hoàn tác nhặt (đơn)',
    ack: 'Đánh dấu Đã sửa', unack: 'Bỏ Đã sửa', history_purged: 'Xóa lịch sử',
    stock_out: 'Xuất kho'
  };
  const FIELD_LABELS = { code: 'Mã hàng', name: 'Tên hàng', notes: 'Ghi chú', arrivalDate: 'Ngày về', location: 'Vị trí', quantity: 'Số lượng' };
  const collator = new Intl.Collator('vi', { numeric: true, sensitivity: 'base' });
  // Cập nhật thời gian thực: debounce tín hiệu SSE, chu kỳ tải bù khi SSE lỗi, thời gian nháy ô vừa đổi.
  const LIVE = { debounceMs: 300, fallbackMs: 60000, flashMs: 1600 };
  // Chữ ký nội dung của dòng/ô lúc dựng (không đọc lại từ DOM vì table-controls có thể thêm thuộc tính).
  const signatures = new WeakMap();
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const QUANTITY_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
  const newState = () => ({ rows: [], query: '', page: 1, sortField: '', sortDirection: 'asc', loading: false, error: '', warnFilter: 'all', canEdit: null, canExport: false, canDeleteHistory: false });
  const state = { hn: newState(), sg: newState() };
  let user, activeTab, allowedTabs, requestVersion = 0;
  let screenMode, visibleFields, columnPreferences = {}, canEditPermission = false;
  const importState = { busy: false };
  const stockOutState = { busy: false };
  const history = { rows: [], nextBefore: null, branch: '', version: 0 };
  // Hộp chi tiết một dòng: row = bản đang mở (để lấy version), version chống tải lịch sử cũ ghi đè.
  const detail = { id: null, tab: '', row: null, fresh: null, rows: [], nextBefore: null, version: 0, busy: false };

  const $ = id => document.getElementById(id);
  const fields = () => BASE_FIELDS;
  const editable = () => canEditPermission && state[activeTab].canEdit !== false;

  function normalizeSearch(value) {
    return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Cảnh báo do máy chủ tính từ ghi chú (public/shared/carton.js); nhãn lấy từ PickingCarton khi có.
  const warningsOf = row => (Array.isArray(row.warnings) ? row.warnings : []);
  const warningText = row => warningsOf(row).map(code => WARNING_LABELS[code] || (window.PickingCarton && window.PickingCarton.WARNING_LABEL[code]) || code).join(', ');
  // Cảnh báo gốc (kể cả khi dòng đã "Đã sửa" nên warnings rỗng).
  const rawWarningsOf = row => (Array.isArray(row.rawWarnings) ? row.rawWarnings : warningsOf(row));
  const warningLabel = code => WARNING_LABELS[code] || (window.PickingCarton && window.PickingCarton.WARNING_LABEL[code]) || code;

  function formatNumber(value) {
    return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? '' : QUANTITY_FORMAT.format(Number(value));
  }

  // Giờ Việt Nam (Asia/Ho_Chi_Minh) dạng dd/MM/yyyy HH:mm.
  function formatTime(iso) {
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return '';
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).forEach(part => { parts[part.type] = part.value; });
    return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  }

  // warn: 'all' | 'warn' (chỉ dòng có cảnh báo) | 'valid' (chỉ dòng không cảnh báo); true = 'warn' để tương thích bản cũ dùng boolean.
  function filterRows(rows, query, warn) {
    const mode = warn === true ? 'warn' : typeof warn === 'string' ? warn : 'all';
    if (mode === 'warn') rows = rows.filter(row => warningsOf(row).length > 0);
    else if (mode === 'valid') rows = rows.filter(row => warningsOf(row).length === 0);
    else if (mode.startsWith('type:')) rows = rows.filter(row => warningsOf(row).includes(mode.slice(5)));
    const needle = normalizeSearch(query);
    if (!needle) return rows;
    const text = row => ['code', 'name', 'location'].map(field => row[field]).join(' ');
    if (window.TKSFuzzySearch) return window.TKSFuzzySearch.filter(rows, query, text);
    return rows.filter(row => normalizeSearch(text(row)).includes(needle));
  }

  function sortValue(row, field) {
    if (NUMERIC.includes(field)) { const value = row[field]; return value === null || value === undefined ? null : Number(value); }
    if (field === 'updated' || field === 'updatedAt') { const time = Date.parse(row.updatedAt); return Number.isNaN(time) ? null : time; }
    return String(row[field] ?? '').trim() || null;
  }

  function sortRows(rows, field, direction) {
    if (!BASE_FIELDS.includes(field)) return rows;
    const numeric = NUMERIC.includes(field) || field === 'updated';
    return rows.slice().sort((a, b) => {
      const left = sortValue(a, field), right = sortValue(b, field);
      if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
      const result = numeric ? left - right : collator.compare(left, right);
      return direction === 'desc' ? -result : result;
    });
  }

  function updateSortHeaders() {
    const current = state[activeTab];
    document.querySelectorAll('[data-sort-field]').forEach(button => {
      const selected = current.sortField === button.dataset.sortField;
      button.closest('th').setAttribute('aria-sort', selected ? current.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none');
      // Chưa sắp ▲▼ · tăng dần ▼ · giảm dần ▲ (như mọi bảng khác).
      button.querySelector('.sort-indicator').textContent = selected ? current.sortDirection === 'asc' ? '▼' : '▲' : '▲▼';
      button.title = selected ? current.sortDirection === 'asc' ? 'Sắp xếp giảm dần' : 'Về thứ tự gốc' : 'Sắp xếp tăng dần';
    });
  }

  function renderColumns() {
    const table = $('vtTable');
    const widths = WIDTHS[screenMode];
    const colgroup = table.querySelector('colgroup');
    const header = table.querySelector('thead tr');
    colgroup.replaceChildren();
    header.replaceChildren();
    table.style.setProperty('--locations-min-width', visibleFields.reduce((sum, field) => sum + widths[field], 0) + 'px');
    fields().forEach(field => {
      const col = document.createElement('col');
      col.style.width = widths[field] + 'px';
      colgroup.appendChild(col);
      const th = document.createElement('th');
      th.scope = 'col';
      th.dataset.field = field;
      th.dataset.columnKey = field;
      th.dataset.defaultWidth = widths[field];
      // Không cho kéo hẹp quá mức tối thiểu (chữ không bị xếp từng ký tự); table-controls cũng nâng độ rộng đã lưu lên mức này.
      th.dataset.minWidth = MIN_WIDTHS[field];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.dataset.sortField = field;
      const label = document.createElement('span');
      label.className = 'sort-label';
      label.textContent = LABELS[field];
      const icon = document.createElement('span');
      icon.className = 'sort-indicator';
      icon.setAttribute('aria-hidden', 'true');
      button.append(label, icon);
      th.appendChild(button);
      header.appendChild(th);
    });
    updateSortHeaders();
  }

  function enhanceColumns() {
    if (!window.TKSTables) return;
    const widths = WIDTHS[screenMode];
    window.TKSTables.enhance($('vtTable'), {
      key: 'vt-positions-v4-' + screenMode,
      button: $('vtColumnsButton'),
      columns: fields().map(field => ({ key: field, label: LABELS[field], width: widths[field], locked: field === 'name', hidden: !visibleFields.includes(field) })),
      onVisibilityChange: hiddenKeys => {
        visibleFields = fields().filter(field => field === 'name' || !hiddenKeys.includes(field));
        columnPreferences[screenMode] = visibleFields.slice();
        for (const current of Object.values(state)) if (!visibleFields.includes(current.sortField)) current.sortField = '';
        render();
      }
    });
  }

  function applyScreenMode(mobile) {
    screenMode = mobile ? 'mobile' : 'desktop';
    const saved = columnPreferences[screenMode];
    const base = Array.isArray(saved) ? fields().filter(field => field === 'name' || saved.includes(field)) : mobile ? MOBILE_FIELDS.slice() : BASE_FIELDS.slice();
    visibleFields = base;
    for (const current of Object.values(state)) if (!visibleFields.includes(current.sortField)) current.sortField = '';
    renderColumns();
    enhanceColumns();
    if (activeTab) render();
  }

  let noticeTimer = null;
  function notify(text, isError) {
    const node = $('vtNotice');
    clearTimeout(noticeTimer);
    node.textContent = text || '';
    node.dataset.error = String(!!isError);
  }

  // Sau khi xóa dòng: báo kèm nút Hoàn tác (tạo lại dòng từ ảnh chụp trước khi xóa), tự ẩn sau UNDO_MS.
  const UNDO_MS = 10000;
  function offerUndo(tab, row) {
    const snapshot = { code: row.code, notes: row.notes, arrivalDate: row.arrivalDate, location: row.location };
    notify('Đã xóa dòng ' + row.code + (row.location ? ' tại ' + row.location : '') + '. ');
    const node = $('vtNotice');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vt-row-button vt-undo';
    button.textContent = 'Hoàn tác';
    button.addEventListener('click', async () => {
      button.disabled = true;
      const { response, payload } = await request(API + '?branch=' + tab.toUpperCase(), jsonOptions('POST', snapshot));
      if (response.ok) {
        applyResult(tab, payload);
        notify('Đã hoàn tác, khôi phục dòng ' + row.code + '.');
        if (tab === activeTab) render();
      } else notify(payload.error || 'Không hoàn tác được.', true);
    });
    node.appendChild(button);
    noticeTimer = setTimeout(() => notify(''), UNDO_MS);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function svgIcon(className, paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(d => { const path = document.createElementNS(SVG_NS, 'path'); path.setAttribute('d', d); svg.appendChild(path); });
    return svg;
  }
  const WARN_ICON = ['M12 3 2 20h20L12 3Z', 'M12 10v4M12 17h.01'];

  // Bấm (hoặc Enter/Space) vào dòng để mở hộp chi tiết; ô Cập nhật gộp giờ + người cập nhật.
  function buildRow(row) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(row.id);
    tr.tabIndex = 0;
    tr.title = 'Bấm để xem chi tiết';
    const warnings = warningsOf(row);
    tr.className = 'vt-row' + (warnings.length ? ' vt-warning' : '');
    if (warnings.length) tr.dataset.warning = warnings.join(' ');
    fields().forEach(field => {
      const td = document.createElement('td');
      td.dataset.field = field;
      if (field === 'quantity' || field === 'available' || field === 'kiotQuantity') {
        td.textContent = formatNumber(row[field]);
        // Có thể bốc = SL kho − phần các đơn Đang bốc đang giữ chỗ; tooltip nói rõ phần giữ chỗ.
        if (field === 'available' && Number(row.held) > 0) td.title = 'Đang giữ chỗ ' + formatNumber(row.held) + ' cho các đơn Đang bốc';
      }
      else if (field === 'updated') {
        const time = document.createElement('span');
        time.className = 'vt-updated-time';
        time.textContent = formatTime(row.updatedAt);
        td.appendChild(time);
      } else if (field === 'location' && row.location) {
        const pill = document.createElement('span');
        pill.className = 'vt-pill';
        pill.textContent = String(row.location);
        td.appendChild(pill);
      } else td.textContent = String(row[field] ?? '');
      if (field === 'notes' && row.acknowledged === true) {
        // Đã sửa: nhãn xanh, tooltip giữ lý do cảnh báo gốc.
        const badge = document.createElement('span');
        badge.className = 'vt-badge is-ack';
        badge.textContent = 'Đã sửa';
        badge.title = rawWarningsOf(row).map(warningLabel).join(', ');
        td.appendChild(badge);
      } else if (field === 'notes' && warnings.length) {
        // Nhãn chữ kèm tooltip để không chỉ dựa vào màu.
        const badge = document.createElement('span');
        badge.className = 'vt-badge';
        badge.appendChild(svgIcon('vt-badge-icon', WARN_ICON));
        badge.appendChild(document.createTextNode(warningText(row)));
        badge.title = warningText(row);
        td.appendChild(badge);
      }
      tr.appendChild(td);
    });
    signatures.set(tr, tr.className + '\u0001' + (tr.dataset.warning || ''));
    Array.from(tr.children).forEach(td => signatures.set(td, td.innerHTML + '\u0001' + td.title));
    return tr;
  }

  function flashCell(cell) {
    cell.classList.add('vt-cell-flash');
    setTimeout(() => cell.classList.remove('vt-cell-flash'), LIVE.flashMs);
  }

  // Sửa dòng đang có cho khớp bản mới: chỉ ô nào chữ ký khác mới bị thay nội dung. Trả về true nếu có gì đổi.
  function syncRowCells(node, fresh, flash) {
    let changed = false;
    if (signatures.get(node) !== signatures.get(fresh)) {
      node.className = fresh.className;
      if (fresh.dataset.warning) node.dataset.warning = fresh.dataset.warning; else delete node.dataset.warning;
      signatures.set(node, signatures.get(fresh));
      changed = true;
    }
    Array.from(node.children).forEach((cell, index) => {
      const next = fresh.children[index];
      // Ô đang được gõ trực tiếp thì giữ nguyên (không ghi đè chữ người dùng đang nhập).
      if (!next || cell.classList.contains('is-editing') || signatures.get(cell) === signatures.get(next)) return;
      cell.replaceChildren(...Array.from(next.childNodes));
      if (next.title) cell.title = next.title; else cell.removeAttribute('title');
      signatures.set(cell, signatures.get(next));
      changed = true;
      if (flash) flashCell(cell);
    });
    return changed;
  }

  // Đối chiếu <tbody> theo data-id thay vì dựng lại: giữ node (focus, hover, cuộn) của dòng không đổi, chèn dòng mới đúng chỗ,
  // gỡ dòng không còn. Trả về true nếu DOM có thay đổi.
  function reconcileRows(body, rows, flash) {
    const existing = new Map();
    Array.from(body.children).forEach(node => existing.set(node.dataset.id, node));
    let cursor = body.firstElementChild;
    let changed = false;
    rows.forEach(row => {
      const fresh = buildRow(row);
      const node = existing.get(String(row.id));
      if (!node) { body.insertBefore(fresh, cursor); changed = true; return; }
      existing.delete(String(row.id));
      if (node === cursor) cursor = cursor.nextElementSibling;
      else { body.insertBefore(node, cursor); changed = true; }
      if (syncRowCells(node, fresh, flash)) changed = true;
    });
    existing.forEach(node => { node.remove(); changed = true; });
    return changed;
  }

  // Cập nhật nhãn/số đếm của bộ lọc cảnh báo tại chỗ (giữ node <option> để danh sách đang mở không bị đóng).
  function syncWarnOptions(select, current) {
    const wanted = new Set([...Object.keys(WARNING_LABELS), ...current.rows.flatMap(warningsOf)]);
    if (current.warnFilter.startsWith('type:')) wanted.add(current.warnFilter.slice(5));
    const existing = new Map();
    select.querySelectorAll('option[data-warning-type]').forEach(option => existing.set(option.dataset.warningType, option));
    existing.forEach((option, code) => { if (!wanted.has(code)) option.remove(); });
    wanted.forEach(code => {
      let option = existing.get(code);
      if (!option) {
        option = document.createElement('option');
        option.value = 'type:' + code;
        option.dataset.warningType = code;
        select.appendChild(option);
      }
      setText(option, warningLabel(code) + ' (' + formatNumber(current.rows.filter(row => warningsOf(row).includes(code)).length) + ')');
    });
  }

  function render(options = {}) {
    const current = state[activeTab];
    const canEdit = editable();
    $('vtAddButton').hidden = !canEdit;
    $('vtTable').dataset.editable = String(canEdit);
    $('vtImportButton').hidden = !canEdit;
    $('vtStockOutButton').hidden = !canEdit;
    $('vtExportButton').hidden = state[activeTab].canExport !== true;
    const rows = sortRows(filterRows(current.rows, current.query, current.warnFilter), current.sortField, current.sortDirection);
    updateSortHeaders();
    // Bộ lọc cảnh báo: số đếm tính trên toàn bộ dòng của cơ sở (không theo từ khóa tìm).
    const select = $('vtWarnFilter');
    const warned = current.rows.filter(row => warningsOf(row).length > 0).length;
    setText(select.querySelector('option[value="warn"]'), 'Cảnh báo (' + formatNumber(warned) + ')');
    setText(select.querySelector('option[value="valid"]'), 'Hợp lệ (' + formatNumber(current.rows.length - warned) + ')');
    syncWarnOptions(select, current);
    if (select.value !== current.warnFilter) select.value = current.warnFilter;
    select.parentElement.dataset.filter = current.warnFilter;
    select.disabled = current.loading || !!current.error;
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    if (!current.loading && !current.error) current.page = Math.min(current.page, pageCount);
    const start = (current.page - 1) * pageSize;
    const body = $('vtRows');
    const search = $('vtSearch');
    if (search.value !== current.query) search.value = current.query;
    search.disabled = current.loading || !!current.error;
    $('vtTable').setAttribute('aria-busy', String(current.loading));
    const status = $('vtStatus');
    status.dataset.error = String(!!current.error);
    status.textContent = current.loading ? 'Đang tải vị trí hàng…' : current.error ||
      (current.rows.length === 0 ? 'Chưa có dữ liệu vị trí hàng.' : rows.length === 0 ? (current.warnFilter === 'warn' ? 'Không có dòng cảnh báo.' : current.warnFilter === 'valid' ? 'Không có dòng hợp lệ.' : 'Không tìm thấy hàng phù hợp.') : '');
    const ready = !current.loading && !current.error && rows.length > 0;
    $('vtPager').hidden = !ready;
    if (!ready) { body.replaceChildren(); return; }

    const changed = reconcileRows(body, rows.slice(start, start + pageSize), options.background === true);
    // Cập nhật nền mà không đổi gì thì khỏi áp lại cấu hình bảng.
    if (window.TKSTables && (changed || options.background !== true)) window.TKSTables.refresh($('vtTable'));
    $('vtCount').textContent = `${formatNumber(start + 1)}–${formatNumber(Math.min(start + pageSize, rows.length))} / ${formatNumber(rows.length)} dòng`;
    $('vtPage').textContent = `Trang ${current.page} / ${pageCount}`;
    if ($('vtPageSize').value !== String(pageSize)) $('vtPageSize').value = String(pageSize);
    $('vtPrevious').disabled = current.page === 1;
    $('vtNext').disabled = current.page === pageCount;
    $('vtFirst').disabled = current.page === 1;
    $('vtLast').disabled = current.page === pageCount;
  }

  // ---------- Gọi API ----------
  async function request(path, options) {
    const response = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  }
  const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function applyResult(tab, payload) {
    const rows = state[tab].rows;
    if (payload.deleted) { state[tab].rows = rows.filter(row => String(row.id) !== String(payload.id)); return; }
    if (!payload.row) return;
    const index = rows.findIndex(row => String(row.id) === String(payload.row.id));
    if (index >= 0) rows[index] = payload.row;
    else rows.unshift(payload.row);
  }

  // 409 VERSION_CONFLICT: dòng đã bị người khác sửa → báo, đóng hộp chi tiết (đang giữ bản cũ) và tải lại; lỗi khác → báo tại chỗ.
  async function handleFailure(payload) {
    if (payload.code === 'VERSION_CONFLICT') {
      closeDialog($('vtDetailDialog'));
      notify('Dòng đã bị người khác sửa. Đã tải lại dữ liệu mới nhất.', true);
      await selectTab(activeTab);
    } else notify(payload.error || 'Không lưu được thay đổi.', true);
    return false;
  }

  // onError: nơi hiện lỗi (hộp chi tiết dùng ô lỗi trong hộp); bỏ trống thì báo ở dòng thông báo của trang.
  async function patchRow(tab, row, patch, confirmEmpty, onError) {
    notify('');
    const body = Object.assign({ version: row.version }, patch);
    if (confirmEmpty) body.confirmEmpty = true;
    const { response, payload } = await request(API + '/' + encodeURIComponent(row.id), jsonOptions('PATCH', body));
    if (response.ok) {
      applyResult(tab, payload);
      if (payload.deleted) offerUndo(tab, row);
      return true;
    }
    // Sửa tay làm hết hàng: hỏi lại rồi gửi lại kèm confirmEmpty.
    if (payload.code === 'WOULD_AUTO_DELETE') {
      if (await confirmBox('Ghi chú trống nghĩa là hết hàng nên dòng ' + row.code + (row.location ? ' tại ' + row.location : '') + ' sẽ bị xóa khỏi bảng. Bạn có chắc chắn muốn xóa không? (Hủy để giữ lại ghi chú cũ.)', 'Xóa dòng')) return patchRow(tab, row, patch, true, onError);
      return false;
    }
    if (onError && payload.code !== 'VERSION_CONFLICT') { onError(payload.error || 'Không lưu được thay đổi.'); return false; }
    return handleFailure(payload);
  }

  // ---------- Hộp thoại ----------
  function openDialog(dialog) {
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeDialog(dialog, force = false) {
    if (dialog.id === 'vtImportDialog' && importState.busy && !force) return;
    if (dialog.id === 'vtStockOutDialog' && stockOutState.busy && !force) return;
    if (dialog.close) dialog.close(); else dialog.removeAttribute('open');
  }

  function confirmBox(message, okLabel) {
    const dialog = $('vtConfirmDialog');
    return new Promise(resolve => {
      $('vtConfirmMessage').textContent = message;
      $('vtConfirmOk').textContent = okLabel || 'Đồng ý';
      const finish = value => { resolve(value); closeDialog(dialog); };
      $('vtConfirmOk').onclick = () => finish(true);
      $('vtConfirmCancel').onclick = () => finish(false);
      dialog.addEventListener('close', () => resolve(false), { once: true });
      openDialog(dialog);
    });
  }

  // onError: nơi hiện lỗi khi xóa thất bại (hộp chi tiết dùng ô lỗi trong hộp); trả true khi đã xóa.
  async function deleteRow(row, onError) {
    if (!await confirmBox(`Xóa dòng ${row.code}${row.location ? ' tại ' + row.location : ''}?`, 'Xóa dòng')) return false;
    const tab = activeTab;
    notify('');
    const { response, payload } = await request(API + '/' + encodeURIComponent(row.id) + '?version=' + encodeURIComponent(row.version), { method: 'DELETE' });
    if (response.ok) { applyResult(tab, payload.deleted ? payload : { deleted: true, id: row.id }); offerUndo(tab, row); if (tab === activeTab) render(); return true; }
    if (onError && payload.code !== 'VERSION_CONFLICT') { onError(payload.error || 'Không xóa được dòng.'); return false; }
    return handleFailure(payload);
  }

  // ---------- Hộp chi tiết một dòng (bấm vào dòng): thông số, sửa Ghi chú/Ngày về/Vị trí, lịch sử của dòng, Lưu/Xóa ----------
  const tabLabel = tab => 'VT ' + (tab === 'hn' ? 'Hà Nội' : 'Sài Gòn');
  const dash = value => (value === null || value === undefined || value === '' ? '—' : value);
  const setDetailError = message => { $('vtDetailError').textContent = message || ''; };

  function setDetailBusy(busy) {
    detail.busy = busy;
    $('vtDetailSave').disabled = busy;
    $('vtDetailDelete').disabled = busy;
    const ack = $('vtDetailAck');
    if (ack) ack.disabled = busy;
  }

  // SL thùng / SL chiếc tính từ ghi chú đang gõ, cùng bộ đọc quy cách với máy chủ (shared/carton.js); sai định dạng thì '—' kèm huy hiệu.
  function renderDetailStats() {
    const row = detail.row;
    if (!row) return;
    const form = $('vtDetailForm');
    const carton = window.PickingCarton;
    const notes = form.elements.notes.value;
    const spec = row.kiotQuantity != null && carton && carton.parseSpec ? carton.parseSpec(notes) : null;
    $('vtDetailCartons').textContent = spec ? formatNumber(spec.cartons) : '—';
    $('vtDetailPieces').textContent = spec ? formatNumber(spec.quantity) : '—';
    const held = Number(row.held) || 0;
    $('vtDetailAvailable').textContent = spec ? formatNumber(Math.max(0, spec.quantity - held)) : '—';
    $('vtDetailAvailable').closest('.dp-stat').title = held > 0 ? 'Đang giữ chỗ ' + formatNumber(held) + ' cho các đơn Đang bốc' : '';
    $('vtDetailKiot').textContent = dash(formatNumber(row.kiotQuantity));
    $('vtDetailStatLocation').textContent = dash(form.elements.location.value.trim());
    const codes = carton && carton.warnings ? carton.warnings(notes) : [];
    if (rawWarningsOf(row).includes('unknowncode')) codes.push('unknowncode');
    const box = $('vtDetailWarn');
    box.replaceChildren();
    const acked = row.acknowledged === true;
    if (codes.length || acked) {
      const text = codes.map(warningLabel).join(', ');
      const badge = document.createElement('span');
      badge.className = 'vt-badge' + (acked ? ' is-ack' : '');
      badge.title = text;
      if (acked) badge.textContent = 'Đã sửa' + (text ? ' · ' + text : '');
      else badge.append(svgIcon('vt-badge-icon', WARN_ICON), document.createTextNode(text));
      box.appendChild(badge);
    }
    if (editable() && (acked || codes.length)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.id = 'vtDetailAck';
      button.className = 'locations-columns-button vt-detail-ack';
      button.textContent = acked ? 'Bỏ đánh dấu Đã sửa' : 'Đánh dấu Đã sửa';
      button.disabled = detail.busy;
      button.addEventListener('click', ackDetail);
      box.appendChild(button);
    }
  }

  // Đổi cờ Đã sửa của dòng đang mở; dùng version mới nhất của dòng, cập nhật bảng + hộp chi tiết, tải lại lịch sử dòng.
  async function ackDetail() {
    if (detail.busy || !detail.row || !editable()) return;
    const row = detail.row, tab = detail.tab;
    let refocus = false;
    setDetailError('');
    setDetailBusy(true);
    try {
      const { response, payload } = await request(API + '/' + encodeURIComponent(row.id) + '/ack', jsonOptions('POST', { version: row.version, acknowledged: row.acknowledged !== true }));
      if (!response.ok) {
        if (payload.code === 'VERSION_CONFLICT') await handleFailure(payload);
        else setDetailError(payload.error || 'Không đổi được trạng thái Đã sửa.');
        return;
      }
      applyResult(tab, payload);
      if (tab === activeTab) render();
      // Người dùng đã đóng hộp / mở dòng khác trong lúc chờ: chỉ cập nhật bảng, không đụng hộp chi tiết đang mở.
      if (detail.id !== row.id) return;
      detail.row = payload.row;
      renderDetailStats();
      loadDetailHistory(false);
      refocus = true;
    } catch (error) {
      if (detail.id === row.id) setDetailError('Không đổi được trạng thái Đã sửa (lỗi kết nối).');
    } finally {
      setDetailBusy(false);
      // renderDetailStats dựng lại nút nên tiêu điểm bàn phím bị mất: trả lại sau khi nút hết khóa.
      if (refocus && detail.id === row.id) { const again = $('vtDetailAck'); if (again) again.focus(); }
    }
  }

  // message: chữ thay cho danh sách rỗng (đang tải / lỗi); bỏ trống thì hiện kết quả đã tải.
  function renderDetailHistory(message) {
    const body = $('vtDetailHistoryRows');
    body.replaceChildren();
    if (!detail.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.className = 'table-note';
      td.textContent = message || 'Chưa có lịch sử cho dòng này.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
    detail.rows.forEach(entry => {
      const tr = document.createElement('tr');
      const time = document.createElement('td');
      time.className = 'mono vt-hist-time';
      time.textContent = formatTime(entry.createdAt);
      const actor = document.createElement('td');
      actor.textContent = entry.actorName || '—';
      const kind = document.createElement('td');
      kind.appendChild(historyActionPill(entry.action));
      const change = document.createElement('td');
      change.className = 'vt-hist-change';
      change.appendChild(historyChange(entry));
      tr.append(time, actor, kind, change);
      body.appendChild(tr);
    });
    const more = detail.nextBefore !== null && detail.nextBefore !== undefined;
    $('vtDetailHistoryNote').textContent = detail.rows.length ? `${detail.rows.length} thay đổi${more ? ' đã tải' : ''}` : '';
    $('vtDetailHistoryMore').hidden = !more;
  }

  async function loadDetailHistory(append) {
    const version = ++detail.version;
    const id = detail.id;
    const before = append && detail.nextBefore ? '&before=' + encodeURIComponent(detail.nextBefore) : '';
    const { response, payload } = await request(API + '/history?branch=' + detail.tab.toUpperCase() + '&positionId=' + encodeURIComponent(id) + '&limit=50' + before);
    if (version !== detail.version || detail.id !== id) return;
    if (!response.ok) { renderDetailHistory(payload.error || 'Không tải được lịch sử.'); return; }
    detail.rows = append ? detail.rows.concat(payload.rows || []) : (payload.rows || []);
    detail.nextBefore = payload.nextBefore ?? null;
    renderDetailHistory();
  }

  function openDetail(row) {
    const canEdit = editable();
    detail.id = row.id;
    detail.tab = activeTab;
    detail.row = row;
    detail.fresh = null;
    detail.rows = [];
    detail.nextBefore = null;
    $('vtDetailCode').textContent = String(row.code ?? '');
    $('vtDetailName').textContent = row.name ? String(row.name) : '';
    $('vtDetailSubtitle').textContent = tabLabel(activeTab);
    const form = $('vtDetailForm');
    DETAIL_FIELDS.forEach(name => { form.elements[name].value = String(row[name] ?? ''); form.elements[name].readOnly = !canEdit; });
    $('vtDetailSave').hidden = !canEdit;
    $('vtDetailDelete').hidden = !canEdit;
    // Chỉ xem: chân hộp không còn nút nào (đóng bằng dấu ×), ẩn luôn cho khỏi trơ khung.
    $('vtDetailDialog').querySelector('.vt-detail-foot').style.display = canEdit ? '' : 'none';
    setDetailBusy(false);
    setDetailError('');
    $('vtDetailStale').hidden = true;
    renderDetailStats();
    renderDetailHistory('Đang tải lịch sử…');
    if (!$('vtDetailDialog').open) openDialog($('vtDetailDialog'));
    loadDetailHistory(false);
  }

  // Sau mỗi lần tải nền: hộp chi tiết đang mở KHÔNG bị đóng hay ghi đè. Dòng đổi version -> hiện dải + nút Xem bản mới;
  // dòng bị xóa -> báo đã xóa; version giữ nguyên nhưng số phái sinh (SL Kiot, giữ chỗ) đổi -> cập nhật thẳng.
  function syncOpenDetail() {
    if (detail.id === null || !detail.row || detail.tab !== activeTab) return;
    const fresh = state[activeTab].rows.find(item => String(item.id) === String(detail.id));
    const banner = $('vtDetailStale');
    const reload = $('vtDetailStaleReload');
    if (!fresh) {
      $('vtDetailStaleText').textContent = 'Dòng này vừa bị người khác xóa.';
      reload.hidden = true;
      banner.hidden = false;
      return;
    }
    if (fresh.version !== detail.row.version) {
      detail.fresh = fresh;
      $('vtDetailStaleText').textContent = 'Dòng này vừa được người khác sửa.';
      reload.hidden = false;
      banner.hidden = false;
      return;
    }
    detail.row = fresh;
    renderDetailStats();
  }

  // Chỉ gửi trường đã đổi; không đổi gì thì chỉ đóng hộp.
  async function saveDetail() {
    if (detail.busy || !detail.row || !editable()) return;
    const row = detail.row, tab = detail.tab, form = $('vtDetailForm');
    const patch = {};
    DETAIL_FIELDS.forEach(name => {
      const before = String(row[name] ?? '').trim();
      let value = form.elements[name].value.trim();
      // Xóa hết ô Ghi chú rồi chỉ gõ "+1t100": hiểu là cộng thêm vào ghi chú cũ.
      if (name === 'notes' && before && value.startsWith('+')) value = before + ' ' + value;
      if (value !== before) patch[name] = value;
    });
    setDetailError('');
    if (!Object.keys(patch).length) { closeDialog($('vtDetailDialog')); return; }
    setDetailBusy(true);
    try {
      if (!await patchRow(tab, row, patch, false, setDetailError)) return;
      closeDialog($('vtDetailDialog'));
      // Sửa ghi chú thành trống + xác nhận thì dòng đã bị xóa (patchRow đã báo kèm nút Hoàn tác).
      if (state[tab].rows.some(item => String(item.id) === String(row.id))) notify('Đã lưu dòng ' + row.code + '.');
      if (tab === activeTab) render();
    } finally {
      setDetailBusy(false);
    }
  }

  async function deleteDetail() {
    if (detail.busy || !detail.row || !editable()) return;
    setDetailError('');
    setDetailBusy(true);
    try {
      if (await deleteRow(detail.row, setDetailError)) closeDialog($('vtDetailDialog'));
    } finally {
      setDetailBusy(false);
    }
  }

  // Gợi ý mã hàng khi gõ ô Mã hàng (hộp Thêm dòng): chờ 200ms, bỏ kết quả của lần gõ cũ.
  let suggestTimer = null;
  let suggestSeq = 0;
  function suggestCodes() {
    clearTimeout(suggestTimer);
    const list = $('vtCodeSuggestions');
    const term = $('vtAddForm').elements.code.value.trim();
    if (!term) { list.replaceChildren(); return; }
    const tab = activeTab;
    suggestTimer = setTimeout(async () => {
      const seq = ++suggestSeq;
      try {
        const { response, payload } = await request(API + '/code-suggestions?branch=' + tab.toUpperCase() + '&q=' + encodeURIComponent(term));
        if (seq !== suggestSeq || !response.ok) return;
        list.replaceChildren(...(payload.items || []).map(item => {
          const option = document.createElement('option');
          option.value = item.code;
          option.label = item.name ? item.code + ' — ' + item.name : item.code;
          return option;
        }));
      } catch (error) { /* gợi ý chỉ là tiện ích, lỗi mạng thì bỏ qua */ }
    }, 200);
  }

  async function submitAdd(event) {
    event.preventDefault();
    const form = $('vtAddForm');
    const tab = activeTab;
    const body = Object.fromEntries(['code', 'notes', 'arrivalDate', 'location'].map(name => [name, form.elements[name].value.trim()]));
    if (!body.code) { $('vtAddError').textContent = 'Vui lòng nhập mã hàng.'; return; }
    const { response, payload } = await request(API + '?branch=' + tab.toUpperCase(), jsonOptions('POST', body));
    if (response.ok) {
      applyResult(tab, payload);
      closeDialog($('vtAddDialog'));
      notify(payload.merged ? 'Đã cộng thêm vào dòng ' + body.code + ' sẵn có ở vị trí này.' : 'Đã thêm dòng ' + body.code + '.');
      if (tab === activeTab) render();
    } else $('vtAddError').textContent = payload.error || 'Không thêm được dòng.';
  }

  // ---------- Import ----------
  const importMode = () => document.querySelector('input[name="vtImportMode"]:checked').value;
  function setImportBusy(busy) {
    importState.busy = busy;
    $('vtImportButton').disabled = busy;
    $('vtImportDialog').querySelectorAll('[data-vt-close]').forEach(button => { button.disabled = busy; });
    $('vtImportFile').disabled = busy;
    $('vtImportPick').disabled = busy;
    $('vtImportBack').disabled = busy;
    document.querySelectorAll('input[name="vtImportMode"]').forEach(radio => { radio.disabled = busy; });
    $('vtImportPreview').disabled = busy;
    $('vtImportConfirm').disabled = busy || !$('vtImportFile').files?.length || importState.stale || importState.editing || (importState.inputRows && !importState.inputRows.length);
    $('vtImportReview').querySelectorAll('button, input, select').forEach(control => { control.disabled = busy; });
    $('vtImportReview').querySelectorAll('.vt-import-row-actions button, #vtImportAdd').forEach(control => { control.disabled = busy || importState.stale || importState.editing; });
    $('vtImportRetry').hidden = !importState.stale;
    // Restore paging boundaries after unlocking controls.
    if (!busy && importState.rows?.length) updateImportPaging();
  }

  // Bước 1 = chọn file + chế độ; bước 2 = xem trước (bảng dòng đã chuẩn hóa); bước 3 chỉ thoáng qua vì hộp đóng ngay khi nhập xong.
  function setImportStep(step) {
    document.querySelectorAll('#vtImportSteps li').forEach(li => {
      const n = Number(li.dataset.step);
      li.classList.toggle('is-current', n === step);
      li.classList.toggle('is-done', n < step);
    });
    $('vtImportPickPanel').hidden = step !== 1;
    $('vtImportReview').hidden = step === 1;
    $('vtImportBack').hidden = step === 1;
    $('vtImportPreview').hidden = step !== 1;
    $('vtImportConfirm').hidden = step === 1;
  }

  function resetImport() {
    setImportBusy(false);
    setImportStep(1);
    importState.rows = [];
    importState.total = 0;
    importState.filter = 'all';
    importState.tab = activeTab;
    importState.warnFilter = 'all';
    importState.page = 0;
    importState.sortField = '';
    importState.sortDirection = 'asc';
    importState.inputRows = null;
    importState.errors = 0;
    importState.stale = false;
    importState.editing = false;
    $('vtImportSearch').value = '';
    $('vtImportWarnFilter').value = 'all';
    $('vtImportEditor').hidden = true;
    $('vtImportRetry').hidden = true;
    setImportBusy(false);
    $('vtImportResult').replaceChildren();
    $('vtImportPreviewBox').hidden = true;
    $('vtImportError').textContent = '';
    const file = $('vtImportFile').files && $('vtImportFile').files[0];
    $('vtImportFileName').textContent = file ? file.name : '';
    $('vtImportDrop').classList.toggle('has-file', Boolean(file));
  }

  const IMPORT_KINDS = { add: 'Thêm', update: 'Cập nhật', delete: 'Xóa', unchanged: 'Không đổi', skipped: 'Bỏ qua', error: 'Lỗi' };
  const IMPORT_PAGE_SIZE = 100;
  const importWarning = row => row.kind === 'error' || Boolean(row.warnings?.length);
  const importPriority = row => row.kind === 'error' ? 2 : importWarning(row) ? 1 : 0;
  const importKey = row => [row.code, row.location].map(value => String(value || '').replace(/\s+/gu, '').toLocaleUpperCase('vi')).join('|');

  const importWarningsText = row => [row.message, ...(row.warnings || []).map(key => WARNING_LABELS[key] || key)].filter(Boolean).join(' · ');
  function importSortValue(row, field) {
    if (field === 'kind') return IMPORT_KINDS[row.kind] || row.kind;
    if (field === 'warnings') return importWarningsText(row) || null;
    if (field === 'row' && row.sourceIndexes?.length > 1) {
      const numbers = row.sourceIndexes.map(i => importState.inputRows?.[i]?.row).filter(value => value != null);
      return numbers.length ? Math.min(...numbers) : null;
    }
    return row[field] === '' ? null : row[field] ?? null;
  }

  function initImportTable() {
    const table = $('vtImportPreviewTable');
    const fields = ['kind', 'row', 'code', 'notes', 'cartons', 'quantity', 'arrivalDate', 'location', 'warnings'];
    fields.forEach((field, index) => {
      const th = table.tHead.rows[0].cells[index];
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.dataset.importSort = field;
      const label = document.createElement('span');
      label.className = 'sort-label';
      label.textContent = th.textContent;
      const icon = document.createElement('span');
      icon.className = 'sort-indicator';
      icon.setAttribute('aria-hidden', 'true');
      button.append(label, icon);
      th.replaceChildren(button);
      button.addEventListener('click', () => {
        if (importState.sortField !== field) { importState.sortField = field; importState.sortDirection = 'asc'; }
        else if (importState.sortDirection === 'asc') importState.sortDirection = 'desc';
        else importState.sortField = '';
        importState.page = 0;
        renderImportPreviewRows();
      });
    });
    window.TKSTables?.enhance(table, { sort: false });
  }

  function filteredImportRows() {
    const needle = normalizeSearch($('vtImportSearch').value);
    return importState.rows.filter(row => (importState.filter === 'all' || row.kind === importState.filter)
      && (importState.warnFilter === 'all' || (importState.warnFilter === 'error' ? row.kind === 'error' : importWarning(row)))
      && (!needle || normalizeSearch([row.code, row.name, row.notes, row.location, row.arrivalDate].join(' ')).includes(needle)))
      .sort((a, b) => {
        const field = importState.sortField;
        if (!field) return importPriority(b) - importPriority(a);
        const left = importSortValue(a, field), right = importSortValue(b, field);
        if (left === null || right === null) return left === right ? 0 : left === null ? 1 : -1;
        const result = ['row', 'cartons', 'quantity'].includes(field) ? Number(left) - Number(right) : collator.compare(String(left), String(right));
        return importState.sortDirection === 'desc' ? -result : result;
      });
  }

  function updateImportPaging() {
    const count = filteredImportRows().length;
    const pages = Math.max(1, Math.ceil(count / IMPORT_PAGE_SIZE));
    importState.page = Math.min(importState.page || 0, pages - 1);
    $('vtImportPrevPage').disabled = importState.busy || importState.page === 0;
    $('vtImportNextPage').disabled = importState.busy || importState.page >= pages - 1;
    $('vtImportPage').textContent = `Trang ${importState.page + 1} / ${pages} · ${formatNumber(count)} dòng`;
  }

  function importButton(label, dataKey, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'locations-columns-button';
    button.textContent = label;
    button.dataset[dataKey] = '';
    button.disabled = importState.busy || importState.stale || importState.editing;
    button.addEventListener('click', action);
    return button;
  }

  function closeImportEditor() {
    importState.editing = false;
    $('vtImportEditor').hidden = true;
    setImportBusy(importState.busy);
  }

  function editImportRows(row) {
    if (importState.busy || importState.stale || importState.editing || !importState.inputRows) return;
    importState.editing = true;
    importState.editIndexes = row ? row.sourceIndexes : [-1];
    const fields = $('vtImportEditorFields');
    fields.replaceChildren();
    importState.editIndexes.forEach(index => {
      const source = index < 0 ? {} : importState.inputRows[index];
      const group = document.createElement('fieldset');
      group.dataset.sourceIndex = String(index);
      const legend = document.createElement('legend');
      legend.textContent = index < 0 ? 'Dòng mới' : source.row ? `Dòng file ${source.row}` : 'Dòng thêm thủ công';
      group.appendChild(legend);
      [['code', 'Mã hàng'], ['name', 'Tên hàng (mã chưa có)'], ['notes', 'Ghi chú số thùng'], ['arrivalDate', 'Ngày về'], ['location', 'Vị trí']].forEach(([key, label]) => {
        const wrapper = document.createElement('label');
        wrapper.textContent = label;
        const input = document.createElement('input');
        input.dataset.field = key;
        input.value = source[key] || '';
        wrapper.appendChild(input);
        group.appendChild(wrapper);
      });
      fields.appendChild(group);
    });
    $('vtImportEditorTitle').textContent = row ? 'Sửa dữ liệu nhập' : 'Thêm dòng import';
    $('vtImportEditor').hidden = false;
    setImportBusy(false);
    fields.querySelector('input')?.focus();
  }

  async function recheckImport() {
    if (importState.busy) return;
    importState.stale = true;
    setImportBusy(true);
    try { await runImport(false); }
    catch { $('vtImportError').textContent = 'Chưa kiểm tra được dữ liệu. Các chỉnh sửa vẫn được giữ; bấm Kiểm tra lại.'; }
    finally { setImportBusy(false); }
  }

  function saveImportRows() {
    if (importState.busy) return;
    $('vtImportEditorFields').querySelectorAll('fieldset').forEach(group => {
      const index = Number(group.dataset.sourceIndex);
      const source = index < 0 ? { row: null } : { ...importState.inputRows[index] };
      group.querySelectorAll('input[data-field]').forEach(input => { source[input.dataset.field] = input.value; });
      if (index < 0) importState.inputRows.push(source);
      else importState.inputRows[index] = source;
    });
    closeImportEditor();
    recheckImport();
  }

  function removeImportRows(row) {
    if (importState.busy || importState.stale || importState.editing) return;
    const indexes = new Set(row.sourceIndexes);
    importState.inputRows = importState.inputRows.filter((_, index) => !indexes.has(index));
    closeImportEditor();
    if (!importState.inputRows.length) {
      importState.rows = [];
      renderImportResult({ inputRows: [], rows: [], counts: {} });
      $('vtImportError').textContent = 'Danh sách trống. Hãy thêm ít nhất một dòng trước khi import.';
      setImportBusy(false);
      return;
    }
    recheckImport();
  }

  function importCell(text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
  }

  // "cũ → mới" khi giá trị đổi, chỉ giá trị mới (đậm) khi không.
  function importChange(oldValue, newValue, className) {
    const td = document.createElement('td');
    td.className = className;
    if (oldValue !== undefined && oldValue !== newValue) {
      const old = document.createElement('s');
      old.textContent = oldValue || '—';
      td.append(old, document.createTextNode(' → '));
    }
    const value = document.createElement('b');
    value.textContent = dash(newValue);
    td.appendChild(value);
    return td;
  }

  // Bảng "Các dòng sau khi chuẩn hóa": đúng giá trị sẽ được ghi (ghi chú đã chuẩn + cộng dồn, vị trí viết hoa không dấu cách).
  function renderImportPreviewRows() {
    $('vtImportPreviewTable').querySelectorAll('[data-import-sort]').forEach(button => {
      const selected = importState.sortField === button.dataset.importSort;
      button.closest('th').setAttribute('aria-sort', selected ? importState.sortDirection === 'asc' ? 'ascending' : 'descending' : 'none');
      button.querySelector('.sort-indicator').textContent = selected ? importState.sortDirection === 'asc' ? '▲' : '▼' : '▲▼';
      button.title = selected ? importState.sortDirection === 'asc' ? 'Sắp xếp giảm dần' : 'Về thứ tự ưu tiên lỗi' : 'Sắp xếp tăng dần';
    });
    const body = $('vtImportPreviewRows');
    body.replaceChildren();
    updateImportPaging();
    const rows = filteredImportRows().slice(importState.page * IMPORT_PAGE_SIZE, (importState.page + 1) * IMPORT_PAGE_SIZE);
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = importCell('Không có dòng nào.', 'table-note');
      td.colSpan = 10;
      tr.appendChild(td);
      body.appendChild(tr);
    }
    rows.forEach(row => {
      const tr = document.createElement('tr');
      tr.className = 'vt-import-row is-' + row.kind + (importWarning(row) ? ' has-warning' : '');
      const kind = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'vt-kind is-' + row.kind;
      pill.textContent = IMPORT_KINDS[row.kind] || row.kind;
      kind.appendChild(pill);
      const code = importCell(row.code, 'vt-import-code');
      if (row.name) {
        const name = document.createElement('small');
        name.textContent = row.name;
        code.appendChild(name);
      }
      tr.append(
        kind,
        importCell(row.sourceIndexes?.length > 1 ? row.sourceIndexes.map(i => importState.inputRows?.[i]?.row || 'Mới').join(', ') : row.row == null ? '—' : String(row.row), 'num'),
        code,
        importChange(row.before && row.before.notes, row.notes, 'vt-import-notes'),
        importCell(row.cartons == null ? '—' : formatNumber(row.cartons), 'num'),
        importCell(row.quantity == null ? '—' : formatNumber(row.quantity), 'num'),
        importCell(dash(row.arrivalDate)),
        importChange(row.before && row.before.location, row.location, 'vt-import-location')
      );
      const warnings = importWarningsText(row);
      tr.appendChild(importCell(warnings || '—', 'vt-import-warning'));
      const actions = document.createElement('td');
      actions.className = 'vt-import-row-actions';
      if (importState.inputRows && row.sourceIndexes?.length) {
        actions.append(importButton('Sửa', 'importEdit', () => editImportRows(row)), importButton('Xóa', 'importRemove', () => removeImportRows(row)));
      } else if (importState.inputRows && row.kind === 'delete') {
        const duplicate = importState.rows.some(other => ['add', 'update', 'unchanged'].includes(other.kind) && importKey(other) === importKey(row));
        if (duplicate) {
          const reason = document.createElement('small');
          reason.textContent = 'Trùng mã + vị trí; chỉ giữ một dòng.';
          actions.appendChild(reason);
        } else actions.appendChild(importButton('Giữ dòng', 'importKeep', () => {
          if (importState.busy || importState.stale || importState.editing) return;
          importState.inputRows.push({ row: null, code: row.code, name: row.name, notes: row.notes, arrivalDate: row.arrivalDate, location: row.location });
          closeImportEditor();
          recheckImport();
        }));
      }
      tr.appendChild(actions);
      body.appendChild(tr);
    });
    const shown = importState.rows.length;
    $('vtImportPreviewNote').textContent = importState.total > shown ? `Chỉ hiển thị ${formatNumber(shown)} / ${formatNumber(importState.total)} dòng đầu; khi xác nhận máy chủ vẫn nhập đủ.` : '';
  }

  function renderImportPreview(payload) {
    importState.rows = Array.isArray(payload.rows) ? payload.rows : [];
    importState.total = Number(payload.rowsTotal) || importState.rows.length;
    if (Array.isArray(payload.inputRows)) importState.inputRows = payload.inputRows;
    importState.errors = Number(payload.counts?.errors) || 0;
    importState.stale = false;
    $('vtImportPreviewBox').hidden = !importState.rows.length && !importState.inputRows;
    const filter = $('vtImportFilter');
    filter.replaceChildren();
    const tallies = { all: importState.rows.length };
    importState.rows.forEach(row => { tallies[row.kind] = (tallies[row.kind] || 0) + 1; });
    if (importState.filter !== 'all' && !tallies[importState.filter]) importState.filter = 'all';
    [['all', 'Tất cả'], ...Object.entries(IMPORT_KINDS)].filter(([key]) => key === 'all' || tallies[key]).forEach(([key, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vt-filter-chip' + (key === importState.filter ? ' is-active' : '');
      button.dataset.kind = key;
      button.textContent = `${label} (${formatNumber(tallies[key] || 0)})`;
      button.addEventListener('click', () => {
        importState.filter = key;
        importState.page = 0;
        filter.querySelectorAll('button').forEach(other => other.classList.toggle('is-active', other === button));
        renderImportPreviewRows();
      });
      filter.appendChild(button);
    });
    $('vtImportWarnFilter').options[1].textContent = `Có cảnh báo (${importState.rows.filter(importWarning).length})`;
    $('vtImportWarnFilter').options[2].textContent = `Có lỗi (${importState.rows.filter(row => row.kind === 'error').length})`;
    renderImportPreviewRows();
  }

  // File mẫu dựng ngay trên trình duyệt (CSV có BOM để Excel đọc đúng tiếng Việt); phần import nhận .csv.
  function downloadImportTemplate() {
    const csv = '﻿Mã hàng,Ghi chú,Ngày về,Vị trí\r\nVASNAM,7T x 600,4/10,42\r\n';
    const url = URL.createObjectURL(new window.Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mau-import-vi-tri-hang.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderImportResult(payload) {
    const box = $('vtImportResult');
    box.replaceChildren();
    setImportStep(2);
    renderImportPreview(payload);
    const counts = payload.counts || {};
    const items = [['added', 'Thêm'], ['updated', 'Cập nhật'], ['deleted', 'Xóa'], ['unchanged', 'Không đổi'], ['skippedEmpty', 'Bỏ qua (trống/lỗi)'], ['keptHeld', 'Giữ lại (đơn Đang bốc)'], ['errors', 'Lỗi']];
    const list = document.createElement('ul');
    list.className = 'vt-import-counts';
    items.forEach(([key, label]) => {
      const li = document.createElement('li');
      li.dataset.count = key;
      const value = document.createElement('b');
      value.textContent = formatNumber(counts[key] ?? 0);
      li.append(value, label);
      list.appendChild(li);
    });
    box.appendChild(list);
  }

  async function runImport(commit) {
    const file = $('vtImportFile').files && $('vtImportFile').files[0];
    $('vtImportError').textContent = '';
    if (!file) { $('vtImportError').textContent = 'Vui lòng chọn file .xlsx, .xls hoặc .csv.'; return null; }
    const tab = importState.tab || activeTab;
    const form = new window.FormData();
    form.append('file', file, file.name);
    if (importState.inputRows) form.append('rows', JSON.stringify(importState.inputRows));
    const query = `?branch=${tab.toUpperCase()}&mode=${importMode()}&commit=${commit ? 1 : 0}`;
    const { response, payload } = await request(API + '/import' + query, { method: 'POST', body: form });
    if (payload.counts) renderImportResult(payload);
    if (!response.ok) { $('vtImportError').textContent = payload.error || 'Không import được file.'; return null; }
    return { tab, payload };
  }

  async function previewImport() {
    if (importState.busy) return;
    setImportBusy(true);
    try {
      await runImport(false);
    } catch (error) {
      $('vtImportError').textContent = 'Không kết nối được máy chủ. Vui lòng thử lại.';
    } finally {
      setImportBusy(false);
    }
  }

  async function confirmImport() {
    if (importState.busy || importState.editing || importState.stale || (importState.inputRows && !importState.inputRows.length)) return;
    setImportBusy(true);
    try {
      const result = await runImport(true);
      if (!result) return;
      const counts = result.payload.counts || {};
      closeDialog($('vtImportDialog'), true);
      notify(`Đã import: thêm ${counts.added || 0}, cập nhật ${counts.updated || 0}, xóa ${counts.deleted || 0}.`);
      await selectTab(activeTab);
    } catch (error) {
      $('vtImportError').textContent = 'Không kết nối được máy chủ. Vui lòng thử lại.';
    } finally {
      setImportBusy(false);
    }
  }

  // ---------- Xuất kho: trừ SL theo file (một bước, kết quả hiển thị ngay trong hộp) ----------
  const stockOutFile = () => ($('vtStockOutFile').files && $('vtStockOutFile').files[0]) || null;
  function setStockOutBusy(busy) {
    stockOutState.busy = busy;
    $('vtStockOutButton').disabled = busy;
    $('vtStockOutDialog').querySelectorAll('[data-vt-close]').forEach(button => { button.disabled = busy; });
    $('vtStockOutFile').disabled = busy;
    $('vtStockOutPick').disabled = busy;
    $('vtStockOutBack').disabled = busy;
    $('vtStockOutRun').disabled = busy || Boolean(stockOutState.done) || !stockOutFile();
    $('vtStockOutRun').textContent = busy ? 'Đang trừ kho…' : 'Trừ kho';
  }
  // Về trạng thái chọn file (chưa trừ); giữ file đang chọn nếu có.
  function resetStockOut() {
    stockOutState.done = false;
    stockOutState.tab = activeTab;
    $('vtStockOutPickPanel').hidden = false;
    $('vtStockOutReview').hidden = true;
    $('vtStockOutResult').replaceChildren();
    $('vtStockOutErrorsBox').hidden = true;
    $('vtStockOutBack').hidden = true;
    $('vtStockOutRun').hidden = false;
    $('vtStockOutError').textContent = '';
    $('vtStockOutSubtitle').textContent = tabLabel(activeTab) + ' · trừ số lượng theo file Excel hoặc CSV';
    const file = stockOutFile();
    $('vtStockOutFileName').textContent = file ? file.name : '';
    $('vtStockOutDrop').classList.toggle('has-file', Boolean(file));
    setStockOutBusy(false);
  }
  // File mẫu dựng ngay trên trình duyệt (CSV có BOM để Excel đọc đúng tiếng Việt).
  function downloadStockOutTemplate() {
    const csv = '\ufeffMã hàng,Ghi chú,Vị trí\r\nVASNAM,1T x 50,42\r\n';
    const url = URL.createObjectURL(new window.Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mau-xuat-kho.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function renderStockOutResult(payload) {
    const counts = payload.counts || {};
    const box = $('vtStockOutResult');
    box.replaceChildren();
    const list = document.createElement('ul');
    list.className = 'vt-import-counts';
    [['applied', 'Dòng file đã trừ'], ['deleted', 'Dòng vị trí bị xóa (hết hàng)'], ['skipped', 'Dòng file bị bỏ qua'], ['quantity', 'Tổng SL đã trừ']].forEach(([key, label]) => {
      const li = document.createElement('li');
      li.dataset.count = key;
      const value = document.createElement('b');
      value.textContent = formatNumber(counts[key] ?? 0);
      li.append(value, label);
      list.appendChild(li);
    });
    box.appendChild(list);
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const body = $('vtStockOutErrorRows');
    body.replaceChildren();
    errors.forEach(item => {
      const tr = document.createElement('tr');
      const cell = (text, className) => { const td = document.createElement('td'); if (className) td.className = className; td.textContent = text; tr.appendChild(td); };
      cell(item.row === null || item.row === undefined ? '—' : String(item.row), 'num');
      cell(item.code || '—', 'vt-import-code');
      cell(item.location || '—', 'vt-import-location');
      cell(item.notes || '—', 'vt-stockout-notes');
      cell(item.message || '', 'vt-stockout-reason');
      body.appendChild(tr);
    });
    $('vtStockOutErrorsBox').hidden = !errors.length;
    $('vtStockOutErrorNote').textContent = payload.errorsTruncated
      ? `Chỉ hiển thị ${formatNumber(errors.length)} dòng đầu trong tổng ${formatNumber(counts.skipped || 0)} dòng bị bỏ qua. Các dòng hợp lệ đã được trừ.`
      : 'Các dòng hợp lệ đã được trừ; chỉ những dòng ở trên bị bỏ qua. Sửa file rồi xuất kho lại cho các dòng này nếu cần.';
  }
  async function runStockOut() {
    if (stockOutState.busy || stockOutState.done) return;
    const file = stockOutFile();
    $('vtStockOutError').textContent = '';
    if (!file) { $('vtStockOutError').textContent = 'Vui lòng chọn file .xlsx, .xls hoặc .csv.'; return; }
    const tab = stockOutState.tab || activeTab;
    setStockOutBusy(true);
    try {
      const form = new window.FormData();
      form.append('file', file, file.name);
      const { response, payload } = await request(API + '/stock-out?branch=' + tab.toUpperCase(), { method: 'POST', body: form });
      if (!response.ok) { $('vtStockOutError').textContent = payload.error || 'Không xuất kho được từ file này.'; return; }
      stockOutState.done = true;
      $('vtStockOutPickPanel').hidden = true;
      $('vtStockOutReview').hidden = false;
      $('vtStockOutBack').hidden = false;
      $('vtStockOutRun').hidden = true;
      renderStockOutResult(payload);
      const counts = payload.counts || {};
      notify(`Đã xuất kho: trừ ${counts.applied || 0} dòng, xóa ${counts.deleted || 0} dòng hết hàng, bỏ qua ${counts.skipped || 0} dòng.`);
      await selectTab(activeTab);
    } catch (error) {
      $('vtStockOutError').textContent = 'Không kết nối được máy chủ. Vui lòng thử lại.';
    } finally {
      setStockOutBusy(false);
    }
  }

  // ---------- Xuất Excel (toàn bộ dòng của cơ sở đang chọn, tải qua fetch để giữ cookie) ----------
  function exportFileName(disposition, tab) {
    const text = String(disposition || '');
    const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(text);
    if (utf8) { try { return decodeURIComponent(utf8[1].trim()); } catch (error) { /* dùng tên thường */ } }
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(text);
    return plain ? plain[1].trim() : 'vi-tri-hang-' + tab.toUpperCase() + '.xlsx';
  }

  async function exportExcel() {
    const tab = activeTab;
    notify('');
    $('vtExportButton').disabled = true;
    try {
      const current = state[tab];
      const rows = sortRows(filterRows(current.rows, current.query, current.warnFilter), current.sortField, current.sortDirection);
      const response = await fetch(API + '/export?branch=' + tab.toUpperCase(), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: rows.map(row => row.id) })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        notify(payload.error || 'Không xuất được file Excel.', true);
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(response.headers && response.headers.get && response.headers.get('Content-Disposition'), tab);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify('Không xuất được file Excel.', true);
    } finally {
      $('vtExportButton').disabled = false;
    }
  }

  // ---------- Lịch sử cập nhật ----------
  const vnDate = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  function historyValue(entry, side) {
    if (entry.summary && side === 'new') {
      const s = entry.summary, parts = [];
      [['added', 'Thêm'], ['updated', 'Đổi'], ['deleted', 'Xóa'], ['skippedEmpty', 'Bỏ qua'], ['keptHeld', 'Giữ lại']].forEach(([key, label]) => { if (s[key] !== undefined) parts.push(label + ' ' + s[key]); });
      if (s.rows !== undefined) parts.push(s.rows + ' dòng');
      if ('from' in s || 'to' in s) parts.push(s.from && s.to ? vnDate(s.from) + ' – ' + vnDate(s.to) : s.from ? 'từ ' + vnDate(s.from) : s.to ? 'đến ' + vnDate(s.to) : 'toàn bộ');
      if (Array.isArray(s.warnings) && s.warnings.length) parts.push(s.warnings.map(warningLabel).join(', '));
      if (Array.isArray(s.warnings) && typeof s.notes === 'string' && s.notes.trim()) parts.push('Ghi chú: ' + s.notes.trim());
      if (s.deducted !== undefined) parts.push('Trừ ' + s.deducted);
      if (s.removed === true) parts.push('Hết hàng, đã xóa dòng');
      if (s.picked !== undefined) parts.push('Nhặt ' + s.picked);
      if ('confirmedBy' in s) parts.push(s.confirmedBy ? 'Xác nhận: ' + s.confirmedBy : 'Job Kiot');
      if (s.fileName) parts.push(s.fileName);
      if (!parts.length && Array.isArray(s.warnings)) return 'Không có cảnh báo';
      return parts.length ? parts.join(' · ') : JSON.stringify(s);
    }
    return String((side === 'old' ? entry.oldValue : entry.newValue) ?? '');
  }

  function renderHistory() {
    const search = $('vtHistorySearch').value;
    const action = $('vtHistoryAction').value;
    let rows = history.rows.filter(entry => !action || entry.action === action);
    const text = entry => [entry.actorName, entry.code, entry.location, ACTION_LABELS[entry.action], FIELD_LABELS[entry.field] || entry.field, historyValue(entry, 'old'), historyValue(entry, 'new')].join(' ');
    if (search.trim()) rows = window.TKSFuzzySearch ? window.TKSFuzzySearch.filter(rows, search, text) : rows.filter(entry => normalizeSearch(text(entry)).includes(normalizeSearch(search)));
    const body = $('vtHistoryRows');
    body.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'table-note';
      td.textContent = history.rows.length ? 'Không có thay đổi khớp bộ lọc.' : 'Chưa có thay đổi nào.';
      tr.appendChild(td);
      body.appendChild(tr);
    }
    rows.forEach(entry => {
      const tr = document.createElement('tr');
      const time = document.createElement('td');
      time.className = 'mono vt-hist-time';
      time.textContent = formatTime(entry.createdAt);
      const actor = document.createElement('td');
      actor.textContent = entry.actorName || '—';
      const kind = document.createElement('td');
      kind.appendChild(historyActionPill(entry.action));
      const target = document.createElement('td');
      target.className = 'dp-cell-main';
      target.textContent = [entry.code, entry.location].filter(Boolean).join(' · ');
      const change = document.createElement('td');
      change.className = 'vt-hist-change';
      change.appendChild(historyChange(entry));
      tr.append(time, actor, kind, target, change);
      body.appendChild(tr);
    });
    const more = history.nextBefore !== null && history.nextBefore !== undefined;
    const count = rows.length === history.rows.length ? String(history.rows.length) : rows.length + '/' + history.rows.length;
    $('vtHistorySubtitle').textContent = `${count} thay đổi${more ? ' đã tải' : ''}`;
    $('vtHistoryMore').hidden = !more;
    $('vtHistoryExport').hidden = state[history.branch.toLowerCase()].canExport !== true;
    $('vtHistoryPurge').hidden = state[history.branch.toLowerCase()].canDeleteHistory !== true;
  }

  // Nhãn hành động dạng pill: màu theo loại (có chữ nên không chỉ dựa vào màu).
  const HISTORY_TONES = { edit: 'blue', create: 'green', import_add: 'green', delete: 'red', auto_delete: 'red', deduct: 'amber', pick: 'amber', pick_revert: 'blue', seed: 'neutral', import_replace: 'neutral', ack: 'green', unack: 'neutral', history_purged: 'red', stock_out: 'amber' };
  const HISTORY_ICONS = {
    blue: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"></path>',
    green: '<path d="M12 5v14M5 12h14"></path>',
    red: '<path d="M5 7h14M10 11v6M14 11v6M9 7V4h6v3M7 7l1 13h8l1-13"></path>',
    amber: '<path d="M5 12h14"></path>',
    neutral: '<path d="M7 3h8l4 4v14H7V3Z"></path><path d="M14 3v5h5"></path>'
  };
  function historyActionPill(action) {
    const tone = HISTORY_TONES[action] || 'neutral';
    const pill = document.createElement('span');
    pill.className = 'vt-hist-pill';
    pill.dataset.tone = tone;
    pill.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' + HISTORY_ICONS[tone] + '</svg>';
    pill.appendChild(document.createTextNode(ACTION_LABELS[action] || action || ''));
    return pill;
  }

  // Cột Thay đổi: tóm tắt import | cũ gạch ngang → mới | Tạo mới | Đã xóa; trường khác Ghi chú có nhãn đứng trước.
  function historyChange(entry) {
    const box = document.createDocumentFragment();
    const add = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; box.appendChild(node); return node; };
    if (entry.summary) {
      // Xuất kho: giữ cả ghi chú cũ → mới của dòng, rồi tóm tắt (số lượng trừ · file).
      if (entry.action === 'stock_out') {
        const was = String(entry.oldValue ?? ''), now = String(entry.newValue ?? '');
        if (was) add('del', 'vt-hist-old', was);
        if (was && now) add('span', 'vt-hist-arrow', ' → ');
        if (now) add('ins', 'vt-hist-new', now);
        add('span', 'vt-hist-summary', (was || now ? '  ' : '') + historyValue(entry, 'new'));
        return box;
      }
      add('span', 'vt-hist-summary', historyValue(entry, 'new'));
      return box;
    }
    const before = historyValue(entry, 'old'), after = historyValue(entry, 'new');
    if (!before && !after) { add('span', 'vt-hist-empty', '—'); return box; }
    if (entry.field && entry.field !== 'notes') add('span', 'vt-hist-field', (FIELD_LABELS[entry.field] || entry.field) + ': ');
    if (before && after) {
      add('del', 'vt-hist-old', before);
      add('span', 'vt-hist-arrow', ' → ');
      add('ins', 'vt-hist-new', after);
    } else if (after) {
      add('span', 'vt-hist-created', 'Tạo mới: ');
      add('ins', 'vt-hist-new', after);
    } else {
      add('span', 'vt-hist-created', 'Đã xóa: ');
      add('del', 'vt-hist-old', before);
    }
    return box;
  }

  // dd/mm/yyyy -> yyyy-mm-dd; '' khi để trống; null khi sai định dạng hoặc không phải ngày thật.
  function parseVnDate(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
    if (!match) return null;
    const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  function openPurge() {
    $('vtPurgeFrom').value = '';
    $('vtPurgeTo').value = '';
    $('vtPurgeError').textContent = '';
    $('vtPurgeSubtitle').textContent = 'VT ' + (history.branch === 'HN' ? 'Hà Nội' : 'Sài Gòn');
    openDialog($('vtPurgeDialog'));
  }

  // Xóa lịch sử của cơ sở đang xem theo khoảng ngày (trống = toàn bộ); thành công thì đóng hộp và tải lại danh sách lịch sử.
  async function runPurge() {
    const from = parseVnDate($('vtPurgeFrom').value), to = parseVnDate($('vtPurgeTo').value);
    const error = $('vtPurgeError');
    error.textContent = '';
    if (from === null || to === null) { error.textContent = 'Ngày không hợp lệ (cần dạng dd/mm/yyyy).'; return; }
    if (from && to && from > to) { error.textContent = 'Từ ngày phải trước hoặc bằng Đến ngày.'; return; }
    const params = new URLSearchParams({ branch: history.branch });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    $('vtPurgeOk').disabled = true;
    try {
      const { response, payload } = await request(API + '/history?' + params.toString(), { method: 'DELETE' });
      if (!response.ok) { error.textContent = payload.error || 'Không xóa được lịch sử.'; return; }
      closeDialog($('vtPurgeDialog'));
      await loadHistory(false);
      // loadHistory ghi đè dòng phụ, nên báo kết quả sau khi tải xong.
      $('vtHistorySubtitle').textContent = 'Đã xóa ' + (Number(payload.deleted) || 0) + ' dòng lịch sử • ' + $('vtHistorySubtitle').textContent;
    } catch (err) {
      error.textContent = 'Không xóa được lịch sử (lỗi kết nối).';
    } finally {
      $('vtPurgeOk').disabled = false;
    }
  }

  // Xuất Excel toàn bộ lịch sử của cơ sở theo hành động/từ khóa đang chọn (lọc ở máy chủ).
  async function exportHistory() {
    const button = $('vtHistoryExport');
    const branch = history.branch;
    const params = new URLSearchParams({ branch });
    if ($('vtHistoryAction').value) params.set('action', $('vtHistoryAction').value);
    if ($('vtHistorySearch').value.trim()) params.set('q', $('vtHistorySearch').value.trim());
    button.disabled = true;
    try {
      const response = await fetch(API + '/history/export?' + params.toString(), { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        $('vtHistorySubtitle').textContent = payload.error || 'Không xuất được file Excel.';
        return;
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = exportFileName(response.headers && response.headers.get && response.headers.get('Content-Disposition'), 'lich-su-' + branch.toLowerCase());
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (error) {
      $('vtHistorySubtitle').textContent = 'Không xuất được file Excel.';
    } finally {
      button.disabled = false;
    }
  }

  async function loadHistory(append) {
    const version = ++history.version;
    const before = append && history.nextBefore ? '&before=' + encodeURIComponent(history.nextBefore) : '';
    const { response, payload } = await request(API + '/history?branch=' + history.branch + '&limit=200' + before);
    if (version !== history.version) return;
    if (!response.ok) { $('vtHistorySubtitle').textContent = payload.error || 'Không tải được lịch sử.'; return; }
    history.rows = append ? history.rows.concat(payload.rows || []) : (payload.rows || []);
    history.nextBefore = payload.nextBefore ?? null;
    renderHistory();
  }

  function openHistory() {
    history.rows = [];
    history.nextBefore = null;
    history.branch = activeTab.toUpperCase();
    $('vtHistoryTitle').textContent = 'Lịch sử cập nhật · VT ' + (activeTab === 'hn' ? 'Hà Nội' : 'Sài Gòn');
    $('vtHistorySearch').value = '';
    const select = $('vtHistoryAction');
    if (select.options.length <= 1) Object.entries(ACTION_LABELS).forEach(([value, label]) => select.add(new Option(label, value)));
    select.value = '';
    $('vtHistorySubtitle').textContent = 'Đang tải…';
    $('vtHistoryRows').replaceChildren();
    $('vtHistoryMore').hidden = true;
    $('vtHistoryExport').hidden = state[activeTab].canExport !== true;
    $('vtHistoryPurge').hidden = state[activeTab].canDeleteHistory !== true;
    openDialog($('vtHistoryDialog'));
    loadHistory(false);
  }

  // ---------- Tải dữ liệu theo tab ----------
  async function selectTab(requested) {
    activeTab = allowedTabs.includes(requested) ? requested : allowedTabs[0];
    if (window.location.hash !== '#' + activeTab) window.history.replaceState(null, '', '#' + activeTab);
    const tab = activeTab;
    stopLive();
    document.querySelectorAll('[data-vt-tab]').forEach(link => {
      link.hidden = !allowedTabs.includes(link.dataset.vtTab);
      if (link.dataset.vtTab === tab) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    $('vtTableTitle').textContent = 'VT ' + (tab === 'hn' ? 'Hà Nội' : 'Sài Gòn');
    window.TKSNav.renderTopSidebar($('sidebar'), 'stockLocations', user);
    const current = state[tab];
    current.rows = [];
    current.loading = true;
    current.error = '';
    const version = ++requestVersion;
    render();
    try {
      const { response, payload } = await request(API + '?branch=' + tab.toUpperCase());
      if (version !== requestVersion) return;
      if (!response.ok) throw new Error(payload.error || 'Không tải được vị trí hàng.');
      if (payload.branch !== tab.toUpperCase() || !Array.isArray(payload.rows)) throw new Error('Dữ liệu vị trí hàng không hợp lệ.');
      current.rows = payload.rows;
      current.canEdit = typeof payload.canEdit === 'boolean' ? payload.canEdit : null;
      current.canExport = payload.canExport === true;
      current.canDeleteHistory = payload.canDeleteHistory === true;
    } catch (error) {
      if (version !== requestVersion) return;
      current.error = error.message || 'Lỗi kết nối, vui lòng tải lại trang.';
    } finally {
      if (version === requestVersion) { current.loading = false; render(); startLive(tab); }
    }
  }

  // Tải lại danh sách ở nền (không đặt loading, không xóa dòng) rồi vá bảng tại chỗ. Bỏ kết quả nếu đã đổi tab giữa chừng.
  // Một yêu cầu tại một thời điểm; tín hiệu đến lúc đang tải thì tải thêm một lần sau khi xong.
  const live = { busy: false, pending: false };
  async function refreshInBackground(tab) {
    if (!tab || tab !== activeTab) return;
    if (live.busy) { live.pending = true; return; }
    live.busy = true;
    const version = requestVersion;
    try {
      const { response, payload } = await request(API + '?branch=' + tab.toUpperCase());
      if (version !== requestVersion || tab !== activeTab) return;
      if (!response.ok || payload.branch !== tab.toUpperCase() || !Array.isArray(payload.rows)) return;
      const current = state[tab];
      current.rows = payload.rows;
      current.error = '';
      current.canEdit = typeof payload.canEdit === 'boolean' ? payload.canEdit : null;
      current.canExport = payload.canExport === true;
      current.canDeleteHistory = payload.canDeleteHistory === true;
      render({ background: true });
      syncOpenDetail();
    } catch (error) { /* lần tải bù sau sẽ thử lại */ } finally {
      live.busy = false;
      if (live.pending) { live.pending = false; refreshInBackground(activeTab); }
    }
  }

  // ---------- Thời gian thực (SSE) ----------
  // Máy chủ chỉ báo "cơ sở này vừa đổi"; ở đây gộp tín hiệu rồi tải nền. SSE lỗi -> tải bù định kỳ cho tới khi nối lại.
  const feed = { source: null, debounce: null, fallback: null, opened: false, missed: false };

  function scheduleRefresh() {
    clearTimeout(feed.debounce);
    feed.debounce = setTimeout(() => {
      if (document.hidden) { feed.missed = true; return; }
      refreshInBackground(activeTab);
    }, LIVE.debounceMs);
  }

  function stopFallback() { clearInterval(feed.fallback); feed.fallback = null; }

  function stopLive() {
    if (feed.source) feed.source.close();
    feed.source = null;
    feed.opened = false;
    clearTimeout(feed.debounce);
    stopFallback();
  }

  function startLive(tab) {
    stopLive();
    if (typeof window.EventSource !== 'function') return;
    const source = new window.EventSource(API + '/events?branch=' + tab.toUpperCase());
    feed.source = source;
    source.addEventListener('positions-changed', scheduleRefresh);
    source.addEventListener('open', () => {
      stopFallback();
      if (feed.opened) scheduleRefresh(); // nối lại sau khi ngắt: có thể đã lỡ tín hiệu
      feed.opened = true;
    });
    source.addEventListener('error', () => {
      if (!feed.fallback) feed.fallback = setInterval(() => { if (!document.hidden) refreshInBackground(activeTab); }, LIVE.fallbackMs);
    });
  }

  function syncTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    const button = $('themeToggle');
    button.setAttribute('aria-label', light ? 'Chuyển sang giao diện tối' : 'Chuyển sang giao diện sáng');
    button.setAttribute('aria-pressed', String(light));
  }

  // Vị trí về dạng chuẩn khi rời ô: bỏ mọi khoảng trắng, viết hoa ("a 05" -> "A05"); máy chủ cũng chuẩn hóa lại khi lưu.
  const normalizeLocation = value => String(value ?? '').replace(/\s+/g, '').toLocaleUpperCase('vi');

  function bindDialogs() {
    document.querySelectorAll('.vt-dialog [data-vt-close]').forEach(button => {
      button.addEventListener('click', () => closeDialog(button.closest('dialog')));
    });
    document.querySelectorAll('#vtAddForm [name="location"], #vtDetailForm [name="location"]').forEach(input => {
      input.addEventListener('blur', () => { input.value = normalizeLocation(input.value); });
    });
    $('vtAddButton').addEventListener('click', () => {
      $('vtAddForm').reset();
      $('vtAddError').textContent = '';
      $('vtAddSubtitle').textContent = 'VT ' + (activeTab === 'hn' ? 'Hà Nội' : 'Sài Gòn') + ' · mã hàng đã có trong KiotViet sẽ tự điền tên hàng.';
      openDialog($('vtAddDialog'));
      $('vtAddForm').elements.code.focus();
    });
    $('vtAddForm').addEventListener('submit', submitAdd);
    $('vtAddForm').elements.code.addEventListener('input', suggestCodes);
    $('vtImportButton').addEventListener('click', () => {
      if (importState.busy) return;
      $('vtImportFile').value = '';
      resetImport();
      openDialog($('vtImportDialog'));
    });
    $('vtImportFile').addEventListener('change', resetImport);
    $('vtImportPick').addEventListener('click', () => $('vtImportFile').click());
    $('vtImportBack').addEventListener('click', resetImport);
    $('vtImportTemplate').addEventListener('click', downloadImportTemplate);
    // Kéo thả file vào khung: gán vào ô chọn file rồi chạy như khi chọn bằng nút.
    const drop = $('vtImportDrop');
    ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); if (!importState.busy) drop.classList.add('is-over'); }));
    ['dragleave', 'dragend'].forEach(name => drop.addEventListener(name, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      drop.classList.remove('is-over');
      const files = event.dataTransfer && event.dataTransfer.files;
      if (importState.busy || !files || !files.length) return;
      $('vtImportFile').files = files;
      resetImport();
    });
    document.querySelectorAll('input[name="vtImportMode"]').forEach(radio => radio.addEventListener('change', resetImport));
    $('vtImportPreview').addEventListener('click', previewImport);
    $('vtImportConfirm').addEventListener('click', confirmImport);
    $('vtImportDialog').addEventListener('cancel', event => { if (importState.busy) event.preventDefault(); });
    $('vtImportAdd').addEventListener('click', () => editImportRows(null));
    $('vtImportSave').addEventListener('click', saveImportRows);
    $('vtImportCancelEdit').addEventListener('click', closeImportEditor);
    $('vtImportRetry').addEventListener('click', recheckImport);
    $('vtImportSearch').addEventListener('input', () => { importState.page = 0; renderImportPreviewRows(); });
    $('vtImportWarnFilter').addEventListener('change', () => { importState.warnFilter = $('vtImportWarnFilter').value; importState.page = 0; renderImportPreviewRows(); });
    $('vtImportPrevPage').addEventListener('click', () => { importState.page -= 1; renderImportPreviewRows(); });
    $('vtImportNextPage').addEventListener('click', () => { importState.page += 1; renderImportPreviewRows(); });
    $('vtStockOutButton').addEventListener('click', () => {
      if (stockOutState.busy) return;
      $('vtStockOutFile').value = '';
      resetStockOut();
      openDialog($('vtStockOutDialog'));
    });
    $('vtStockOutFile').addEventListener('change', resetStockOut);
    $('vtStockOutPick').addEventListener('click', () => $('vtStockOutFile').click());
    $('vtStockOutBack').addEventListener('click', () => { $('vtStockOutFile').value = ''; resetStockOut(); });
    $('vtStockOutTemplate').addEventListener('click', downloadStockOutTemplate);
    const stockOutDrop = $('vtStockOutDrop');
    ['dragenter', 'dragover'].forEach(name => stockOutDrop.addEventListener(name, event => { event.preventDefault(); if (!stockOutState.busy) stockOutDrop.classList.add('is-over'); }));
    ['dragleave', 'dragend'].forEach(name => stockOutDrop.addEventListener(name, () => stockOutDrop.classList.remove('is-over')));
    stockOutDrop.addEventListener('drop', event => {
      event.preventDefault();
      stockOutDrop.classList.remove('is-over');
      const files = event.dataTransfer && event.dataTransfer.files;
      if (stockOutState.busy || !files || !files.length) return;
      $('vtStockOutFile').files = files;
      resetStockOut();
    });
    $('vtStockOutRun').addEventListener('click', runStockOut);
    $('vtStockOutDialog').addEventListener('cancel', event => { if (stockOutState.busy) event.preventDefault(); });
    $('vtExportButton').addEventListener('click', exportExcel);
    $('vtHistoryButton').addEventListener('click', openHistory);
    $('vtHistorySearch').addEventListener('input', renderHistory);
    $('vtHistoryAction').addEventListener('change', renderHistory);
    $('vtHistoryMore').addEventListener('click', () => loadHistory(true));
    $('vtHistoryExport').addEventListener('click', exportHistory);
    $('vtHistoryPurge').addEventListener('click', openPurge);
    $('vtPurgeOk').addEventListener('click', runPurge);
  }

  // ---------- Nhập trực tiếp trong bảng (Ghi chú số thùng / Ngày về / Vị trí) ----------
  // Bấm vào ô → thành ô nhập; Enter hoặc rời ô → lưu, Esc → hủy, mũi tên → sang ô nhập kề bên.
  // Các lần lưu xếp hàng nối đuôi nhau để dòng luôn được gửi với version mới nhất.
  let saveChain = Promise.resolve();
  const rowById = (tab, id) => state[tab].rows.find(item => String(item.id) === String(id));
  const isVisible = node => node.offsetParent !== null;

  function restoreCell(td, row) {
    const index = Array.from(td.parentElement.children).indexOf(td);
    const next = buildRow(row).children[index];
    td.classList.remove('is-editing');
    td.replaceChildren(...Array.from(next.childNodes));
    if (next.title) td.title = next.title; else td.removeAttribute('title');
    signatures.set(td, signatures.get(next));
  }

  function startEdit(td) {
    if (!editable() || !DETAIL_FIELDS.includes(td.dataset.field)) return null;
    const existing = td.querySelector('input.vt-inline');
    if (existing) return existing;
    const row = rowById(activeTab, td.parentElement.dataset.id);
    if (!row) return null;
    const field = td.dataset.field;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vt-inline';
    input.autocomplete = 'off';
    input.value = String(row[field] ?? '');
    input.dataset.field = field;
    input.dataset.id = String(row.id);
    input.setAttribute('aria-label', LABELS[field] + ' ' + row.code);
    td.classList.add('is-editing');
    // Chỉ thay phần chữ bằng ô nhập (giữ nhãn cảnh báo / Đã sửa, viên Vị trí) để bố cục dòng không đổi.
    const holder = td.querySelector('.vt-pill') || td;
    const text = Array.from(holder.childNodes).find(node => node.nodeType === 3);
    if (text) text.replaceWith(input); else holder.insertBefore(input, holder.firstChild);
    input.addEventListener('keydown', inlineKeydown);
    input.addEventListener('blur', () => finishEdit(input, true));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    return input;
  }

  function finishEdit(input, save) {
    if (input.dataset.done) return;
    input.dataset.done = '1';
    const td = input.closest('td');
    const tab = activeTab, field = input.dataset.field, id = input.dataset.id, raw = input.value;
    const row = rowById(tab, id);
    if (td && row) {
      // Hiện ngay giá trị vừa gõ trong lúc chờ máy chủ; thất bại thì render() bên dưới trả về giá trị cũ.
      restoreCell(td, save ? Object.assign({}, row, { [field]: field === 'location' ? normalizeLocation(raw) : raw.trim() }) : row);
    }
    if (!save) return;
    saveChain = saveChain.then(async () => {
      const current = rowById(tab, id);
      if (!current) return;
      const before = String(current[field] ?? '').trim();
      let value = raw.trim();
      if (field === 'location') value = normalizeLocation(value);
      if (field === 'notes' && before && value.startsWith('+')) value = before + ' ' + value;
      if (value !== before) await patchRow(tab, current, { [field]: value }, false, message => notify(message, true));
      if (tab === activeTab) render();
    }).catch(() => notify('Không lưu được thay đổi.', true));
  }

  const caretAtEdge = (input, forward) => {
    if (input.selectionStart === 0 && input.selectionEnd === input.value.length) return true;
    if (input.selectionStart !== input.selectionEnd) return false;
    return forward ? input.selectionEnd === input.value.length : input.selectionStart === 0;
  };

  function neighborCell(td, key) {
    const tr = td.parentElement;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const step = key === 'ArrowUp' ? 'previousElementSibling' : 'nextElementSibling';
      for (let other = tr[step]; other; other = other[step]) {
        const cell = other.children[td.cellIndex];
        if (cell && isVisible(cell)) return cell;
      }
      return null;
    }
    const step = key === 'ArrowLeft' ? 'previousElementSibling' : 'nextElementSibling';
    for (let cell = td[step]; cell; cell = cell[step]) {
      if (DETAIL_FIELDS.includes(cell.dataset.field) && isVisible(cell)) return cell;
    }
    return null;
  }

  function inlineKeydown(event) {
    const input = event.target;
    if (event.isComposing) return;
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const tr = input.closest('tr');
      finishEdit(input, event.key === 'Enter');
      if (tr) tr.focus();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !caretAtEdge(input, event.key === 'ArrowRight')) return;
    const target = neighborCell(input.closest('td'), event.key);
    if (!target) return;
    event.preventDefault();
    startEdit(target); // lấy focus → ô cũ rời đi và tự lưu
  }

  // Bấm vào ô nhập liệu được → gõ ngay tại ô; bấm cột khác (hoặc Enter/Space trên dòng) → mở hộp chi tiết.
  // Đang bôi đen chữ để sao chép thì không làm gì.
  function bindTable() {
    const body = $('vtRows');
    const rowOf = tr => state[activeTab].rows.find(item => String(item.id) === tr.dataset.id);
    body.addEventListener('click', event => {
      const tr = event.target.closest('tr[data-id]');
      if (!tr) return;
      if (window.getSelection && window.getSelection().toString()) return;
      const cell = event.target.closest('td[data-field]');
      if (cell && editable() && DETAIL_FIELDS.includes(cell.dataset.field)) { startEdit(cell); return; }
      const row = rowOf(tr);
      if (row) openDetail(row);
    });
    body.addEventListener('keydown', event => {
      if (event.target.tagName !== 'TR' || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      const row = rowOf(event.target);
      if (row) openDetail(row);
    });
  }

  function bindDetail() {
    const dialog = $('vtDetailDialog');
    const form = $('vtDetailForm');
    dialog.addEventListener('close', () => { detail.id = null; detail.row = null; detail.version++; });
    // Esc đóng hộp (trình duyệt tự đóng khi Esc; xử lý thêm để nhất quán, đóng hai lần không sao).
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') closeDialog(dialog); });
    $('vtDetailSave').addEventListener('click', saveDetail);
    $('vtDetailDelete').addEventListener('click', deleteDetail);
    form.addEventListener('submit', event => { event.preventDefault(); saveDetail(); });
    form.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target.tagName === 'INPUT') { event.preventDefault(); saveDetail(); }
    });
    form.addEventListener('input', () => { renderDetailStats(); setDetailError(''); });
    $('vtDetailHistoryMore').addEventListener('click', () => loadDetailHistory(true));
    $('vtDetailStaleReload').addEventListener('click', () => { if (detail.fresh) openDetail(detail.fresh); });
  }

  async function init() {
    syncTheme();
    $('themeToggle').addEventListener('click', () => {
      const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = theme;
      try { localStorage.setItem('tks-dashboard-theme', theme); } catch (error) { /* storage optional */ }
      syncTheme();
    });
    const toggleSidebar = () => {
      const open = $('sidebar').classList.toggle('open');
      $('backdrop').classList.toggle('show', open);
      $('menuBtn').setAttribute('aria-expanded', String(open));
    };
    $('menuBtn').addEventListener('click', toggleSidebar);
    $('backdrop').addEventListener('click', toggleSidebar);
    user = await window.TKSNav.authGuard();
    canEditPermission = !!(window.TKSNav.can && window.TKSNav.can('stockLocationsV2.edit'));
    allowedTabs = user.branch === 'Hà Nội' ? ['hn'] : user.branch === 'Sài Gòn' ? ['sg'] : ['hn', 'sg'];
    const mobileQuery = window.matchMedia ? window.matchMedia('(max-width: 600px)') : null;
    activeTab = allowedTabs.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : allowedTabs[0];
    applyScreenMode(mobileQuery ? mobileQuery.matches : window.innerWidth <= 600);
    if (mobileQuery) mobileQuery.addEventListener('change', event => applyScreenMode(event.matches));
    bindDialogs();
    initImportTable();
    bindTable();
    bindDetail();
    document.querySelector('#vtTable thead').addEventListener('click', event => {
      const button = event.target.closest('[data-sort-field]');
      if (!button) return;
      const current = state[activeTab];
      const field = button.dataset.sortField;
      if (current.sortField !== field) { current.sortField = field; current.sortDirection = 'asc'; }
      else if (current.sortDirection === 'asc') current.sortDirection = 'desc';
      else current.sortField = '';
      current.page = 1;
      render();
      document.querySelector('.locations-scroll').scrollTop = 0;
    });
    $('vtWarnFilter').addEventListener('change', event => {
      const value = event.target.value;
      const current = state[activeTab];
      current.warnFilter = value === 'warn' || value === 'valid' || value.startsWith('type:') ? value : 'all';
      current.page = 1;
      render();
    });
    $('vtSearch').addEventListener('input', event => {
      state[activeTab].query = event.target.value;
      state[activeTab].page = 1;
      render();
    });
    $('vtPageSize').addEventListener('change', event => {
      const size = Number(event.target.value);
      if (![50, 100, 200].includes(size)) return;
      pageSize = size;
      for (const current of Object.values(state)) current.page = 1;
      render();
      document.querySelector('.locations-scroll').scrollTop = 0;
    });
    ['First', 'Previous', 'Next', 'Last'].forEach(direction => {
      $('vt' + direction).addEventListener('click', () => {
        const current = state[activeTab];
        const pageCount = Math.max(1, Math.ceil(filterRows(current.rows, current.query, current.warnFilter).length / pageSize));
        if (direction === 'First') current.page = 1;
        else if (direction === 'Last') current.page = pageCount;
        else current.page = Math.max(1, Math.min(pageCount, current.page + (direction === 'Previous' ? -1 : 1)));
        render();
        document.querySelector('.locations-scroll').scrollTop = 0;
      });
    });
    // Liên kết tab trong trang và mục VT Hà Nội / VT Sài Gòn ở sidebar (href /vt-positions/#hn|#sg).
    document.addEventListener('click', event => {
      const link = event.target.closest('[data-vt-tab], a[href^="/vt-positions/#"]');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const tab = link.dataset.vtTab || (link.getAttribute('href') || '').split('#')[1];
      if (!allowedTabs.includes(tab)) return;
      event.preventDefault();
      if (window.location.hash === '#' + tab) selectTab(tab);
      else window.location.hash = tab;
    });
    window.addEventListener('hashchange', () => selectTab(window.location.hash.slice(1)));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && feed.missed) { feed.missed = false; refreshInBackground(activeTab); }
    });
    window.addEventListener('pagehide', stopLive);
    await selectTab(window.location.hash.slice(1));
  }

  window.TKSVtPositions = { init, normalizeSearch, filterRows, sortRows, formatTime, refresh: () => refreshInBackground(activeTab), live: LIVE };
})();
