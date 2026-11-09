(function () {
  'use strict';
  // Đơn xuất kho của VT Hà Nội / VT Sài Gòn (migration 0104). Mỗi cơ sở có MỘT đơn tạm dùng chung: ghi lại hàng đã bốc thật (gõ theo tên,
  // gợi ý), CHƯA trừ tồn; bấm "Chốt đơn" (có hộp xác nhận) mới trừ tồn VT, cho phép ra số lượng âm. Đóng tab/mở lại đơn tạm vẫn còn.
  // Hộp có 3 tab: Đơn tạm · Danh sách đơn (đơn tạm + đơn đã chốt) · Xuất kho Excel (trừ tồn ngay theo file, logic nằm ở vt-positions.js).
  // Trang vt-positions.js truyền vào các hàm dùng chung (request, confirmBox, openDialog...) qua init(hooks).
  const API = '/api/stock-positions/stock-out-orders';
  const SUGGEST_API = '/api/stock-positions/code-suggestions';
  const POLL_MS = 15000;
  const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
  const state = { hooks: null, branch: '', order: null, canEdit: false, canExport: false, view: 'current', history: [], moreBefore: null, detail: null, returnView: 'list', search: '',
    historyPage: 1, historyTotal: 0, historySeq: 0, historyTimer: null, historyController: null, serverPaged: false,
    adding: false, editing: false, busy: false, timer: null, suggestions: [], suggestSeq: 0, suggestTimer: null, loadSeq: 0 };

  const $ = id => document.getElementById(id);
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  const formatNumber = value => (value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : NUMBER.format(Number(value)));
  const formatTime = iso => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return pad(date.getDate()) + '/' + pad(date.getMonth() + 1) + '/' + date.getFullYear() + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  };
  const setError = text => { $('vtOrderError').textContent = text || ''; };
  const keyOf = line => String(line.code).toLowerCase() + '|' + String(line.location).toUpperCase();

  async function call(path, options) {
    try { return await state.hooks.request(path, options); }
    catch (error) { return { response: { ok: false, status: 0 }, payload: { error: 'Không kết nối được máy chủ. Vui lòng thử lại.' } }; }
  }

  // ---------- Tải dữ liệu ----------
  async function loadCurrent({ quiet = false } = {}) {
    const seq = ++state.loadSeq;
    const { response, payload } = await call(API + '/current?branch=' + state.branch);
    if (seq !== state.loadSeq) return;
    if (!response.ok) { if (!quiet) setError(payload.error || 'Không tải được đơn xuất kho.'); return; }
    state.order = payload.order;
    state.canEdit = payload.canEdit === true;
    state.canExport = payload.canExport === true;
    render();
  }
  async function loadHistory(append) {
    clearTimeout(state.historyTimer); state.historyTimer = null;
    if (state.historyController) state.historyController.abort();
    state.historyController = new AbortController();
    const seq = ++state.historySeq;
    const nextPage = append ? state.historyPage + 1 : 1;
    const params = new URLSearchParams({ branch: state.branch, page: String(nextPage), pageSize: '50', q: state.search });
    const { response, payload } = await call(API + '?' + params, { signal: state.historyController.signal });
    if (seq !== state.historySeq) return;
    if (!response.ok) { setError(payload.error || 'Không tải được lịch sử đơn.'); return; }
    state.history = append ? [...new Map(state.history.concat(payload.orders || []).map(order => [order.id, order])).values()] : payload.orders || [];
    state.serverPaged = Number.isFinite(payload.totalRows);
    state.historyPage = Number(payload.page) || nextPage;
    state.historyTotal = Number(payload.totalRows) || 0;
    state.moreBefore = state.serverPaged ? (state.historyPage * 50 < state.historyTotal ? state.historyPage : null) : payload.orders.length >= 50 ? payload.orders[payload.orders.length - 1].id : null;
    setError('');
    render();
  }
  function queryHistory() {
    ++state.historySeq;
    if (state.historyController) state.historyController.abort();
    clearTimeout(state.historyTimer);
    if (!state.serverPaged) renderList();
    state.historyTimer = setTimeout(() => loadHistory(false), 300);
  }
  async function loadDetail(id) {
    const { response, payload } = await call(API + '/' + encodeURIComponent(id));
    if (!response.ok) { setError(payload.error || 'Không tải được đơn.'); return false; }
    state.detail = payload.order;
    state.canExport = payload.canExport === true;
    return true;
  }

  // Nhật ký thao tác của đơn tạm (mới nhất trước): dòng đã xóa vẫn còn ảnh chụp mã/vị trí/ghi chú.
  const AUDIT_ACTION = { add: 'Thêm dòng', update: 'Sửa dòng', delete: 'Xóa dòng', import: 'Import Excel', confirm: 'Chốt đơn' };
  const auditLine = snap => snap ? [snap.code, snap.location, snap.notes].filter(Boolean).join(' · ') : '';
  function auditText(event) {
    const d = event.detail || {};
    if (event.action === 'update') return auditLine(d.before) + ' → ' + auditLine(d.after);
    if (event.action === 'import') return (d.fileName || 'file') + ': thêm ' + (d.added || 0) + ' dòng' + (d.skipped ? ', bỏ qua ' + d.skipped : '');
    if (event.action === 'confirm') return (d.lines || 0) + ' dòng';
    return auditLine(d.before || d.after);
  }
  async function loadAudit() {
    const list = $('vtOrderAuditList');
    if (!list || !state.order) return;
    const { response, payload } = await call(API + '/' + state.order.id + '/events?limit=100');
    if (!response.ok) { setError(payload.error || 'Không tải được nhật ký thao tác.'); return; }
    list.replaceChildren();
    if (!payload.events.length) { list.appendChild(el('li', 'table-note', 'Chưa có thao tác nào được ghi lại.')); return; }
    payload.events.forEach(event => {
      const item = el('li', 'vt-order-audit-item is-' + event.action);
      item.append(el('span', 'vt-order-audit-time', formatTime(event.createdAt)), el('strong', '', event.userName || '—'),
        el('span', 'vt-order-audit-act', AUDIT_ACTION[event.action] || event.action), el('span', 'vt-order-audit-detail', auditText(event)));
      list.appendChild(item);
    });
  }

  // ---------- Dựng giao diện ----------
  function preview(line) { return line.preview || null; }

  function afterCell(line) {
    const td = el('td', 'vt-order-after');
    const info = preview(line);
    if (!info) return td;
    if (info.blocked) {
      td.appendChild(el('span', 'vt-order-tag is-error', 'Không trừ được'));
      td.title = info.reason || '';
      return td;
    }
    td.appendChild(el('span', info.negative ? 'vt-order-neg' : '', info.after));
    if (info.negative) td.appendChild(el('span', 'vt-order-tag is-neg', 'Âm'));
    if (info.held > 0) {
      const tag = el('span', 'vt-order-tag is-held', 'Giữ chỗ ' + formatNumber(info.held));
      tag.title = 'Vị trí này đang được đơn Đang bốc giữ chỗ';
      td.appendChild(tag);
    }
    return td;
  }

  function lineRow(line, index, editable) {
    const tr = el('tr', 'vt-order-row');
    tr.dataset.lineId = String(line.id);
    const info = preview(line);
    tr.appendChild(el('td', 'num', String(index + 1)));
    const name = el('td', 'vt-order-name');
    name.appendChild(el('span', 'vt-order-title', line.name || line.code));
    name.appendChild(el('span', 'vt-order-code', line.code));
    if (line.source === 'excel') name.appendChild(el('span', 'vt-order-tag', 'Excel'));
    tr.appendChild(name);
    const location = el('td', 'vt-order-loc');
    location.appendChild(el('span', 'vt-pill', line.location));
    const notes = el('td', 'vt-order-notes', line.notes);
    if (editable) {
      [[location, 'location'], [notes, 'notes']].forEach(([cell, field]) => {
        cell.dataset.editable = 'true';
        cell.dataset.field = field;
        cell.title = 'Bấm để sửa';
        cell.addEventListener('click', () => startEdit(cell, line, field));
      });
    }
    tr.appendChild(location);
    tr.appendChild(notes);
    tr.appendChild(el('td', 'num', formatNumber(line.quantity)));
    tr.appendChild(el('td', 'vt-order-before', info ? (info.missing ? 'Chưa có dòng VT' : info.before) : ''));
    tr.appendChild(afterCell(line));
    const actions = el('td', 'vt-order-actions');
    if (editable) {
      const remove = el('button', 'vt-row-button', 'Xóa');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Xóa dòng ' + line.code);
      remove.addEventListener('click', () => removeLine(line));
      actions.appendChild(remove);
    }
    tr.appendChild(actions);
    return tr;
  }

  function resultRow(line, index) {
    const tr = el('tr', 'vt-order-row');
    const result = line.result || {};
    tr.appendChild(el('td', 'num', String(index + 1)));
    const name = el('td', 'vt-order-name');
    name.appendChild(el('span', 'vt-order-title', line.name || line.code));
    name.appendChild(el('span', 'vt-order-code', line.code));
    tr.appendChild(name);
    const location = el('td', 'vt-order-loc');
    location.appendChild(el('span', 'vt-pill', line.location));
    tr.appendChild(location);
    tr.appendChild(el('td', 'vt-order-notes', line.notes));
    tr.appendChild(el('td', 'num', formatNumber(line.quantity)));
    tr.appendChild(el('td', 'vt-order-before', result.created ? 'Chưa có dòng VT' : (result.before || '')));
    const after = el('td', 'vt-order-after');
    after.appendChild(el('span', result.negative ? 'vt-order-neg' : '', result.after || ''));
    if (result.negative) after.appendChild(el('span', 'vt-order-tag is-neg', 'Âm'));
    tr.appendChild(after);
    tr.appendChild(el('td', 'vt-order-actions'));
    return tr;
  }

  function renderFoot(editable) {
    const foot = $('vtOrderFoot');
    foot.replaceChildren();
    if (!editable) return;
    const tr = el('tr', 'vt-order-addrow');
    if (!state.adding) {
      const td = el('td');
      td.colSpan = 8;
      const add = el('button', 'locations-columns-button vt-btn-primary vt-order-add', '+ Thêm dòng');
      add.type = 'button';
      add.id = 'vtOrderAdd';
      add.addEventListener('click', () => { state.adding = true; renderFoot(true); const input = $('vtOrderName'); if (input) input.focus(); });
      td.appendChild(add);
      tr.appendChild(td);
      foot.appendChild(tr);
      return;
    }
    tr.appendChild(el('td', 'num', '+'));
    const nameTd = el('td');
    const name = el('input');
    name.id = 'vtOrderName';
    name.type = 'text';
    name.autocomplete = 'off';
    name.placeholder = 'Gõ tên hoặc mã hàng…';
    name.setAttribute('list', 'vtOrderSuggestions');
    name.setAttribute('aria-label', 'Tên hàng');
    nameTd.appendChild(name);
    const locTd = el('td');
    const location = el('input');
    location.id = 'vtOrderLocation';
    location.type = 'text';
    location.autocomplete = 'off';
    location.placeholder = 'Vị trí';
    location.setAttribute('aria-label', 'Vị trí');
    locTd.appendChild(location);
    const notesTd = el('td');
    const notes = el('input');
    notes.id = 'vtOrderNotes';
    notes.type = 'text';
    notes.autocomplete = 'off';
    notes.placeholder = 'Ghi chú thùng, vd 5T x 100';
    notes.setAttribute('aria-label', 'Ghi chú thùng');
    notesTd.appendChild(notes);
    const errorTd = el('td', 'vt-order-add-error');
    errorTd.colSpan = 3;
    errorTd.id = 'vtOrderAddError';
    errorTd.setAttribute('role', 'alert');
    const actions = el('td', 'vt-order-actions');
    const save = el('button', 'locations-columns-button vt-btn-primary', 'Lưu');
    save.type = 'button';
    save.addEventListener('click', submitAdd);
    const cancel = el('button', 'locations-columns-button', 'Hủy');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { state.adding = false; renderFoot(true); });
    actions.append(save, cancel);
    tr.append(nameTd, locTd, notesTd, errorTd, actions);
    foot.appendChild(tr);
    name.addEventListener('input', onNameInput);
    name.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); location.focus(); } });
    location.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); notes.focus(); } });
    notes.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); submitAdd(); } });
    [name, location, notes].forEach(input => input.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); state.adding = false; renderFoot(true); } }));
  }

  function renderSubtitle() {
    const order = state.view === 'detail' ? state.detail : state.order;
    const parts = [state.branch === 'HN' ? 'VT Hà Nội' : 'VT Sài Gòn'];
    if (state.view === 'list') parts.push('Danh sách đơn');
    else if (state.view === 'excel') parts.push('Xuất kho Excel · trừ tồn ngay theo file Excel/CSV, không qua đơn tạm');
    else if (order) {
      parts.push(order.code);
      if (order.status === 'draft') parts.push('Đơn tạm · tạo bởi ' + (order.createdByName || '—') + ' · chưa trừ tồn');
      else parts.push('Đã chốt ' + formatTime(order.confirmedAt) + ' bởi ' + (order.confirmedByName || '—'));
    } else parts.push('Chưa có đơn tạm');
    $('vtOrderSubtitle').textContent = parts.join(' · ');
  }

  // Thống kê của đơn tạm để hiện cùng hàng với các đơn đã chốt: mỗi (mã, vị trí) chỉ tính một lần.
  function draftStats(order) {
    const last = new Map();
    order.lines.forEach(line => last.set(keyOf(line), line));
    const groups = [...last.values()];
    return { lineCount: order.lines.length, positions: groups.length, negative: groups.filter(line => preview(line) && preview(line).negative).length };
  }

  function listRow(item, draftOrder) {
    const tr = el('tr', 'vt-order-row is-link');
    tr.tabIndex = 0;
    const stats = draftOrder ? draftStats(item) : item.summary || {};
    const status = el('td');
    status.appendChild(el('span', draftOrder ? 'vt-order-tag is-draft' : 'vt-order-tag is-done', draftOrder ? 'Đơn tạm' : 'Đã chốt'));
    tr.append(el('td', 'vt-order-ordercode', item.code), status,
      el('td', '', formatTime(draftOrder ? item.createdAt : item.confirmedAt)), el('td', '', (draftOrder ? item.createdByName : item.confirmedByName) || '—'),
      el('td', 'num', formatNumber(draftOrder ? stats.lineCount : item.lineCount)), el('td', 'num', formatNumber(stats.positions)), el('td', 'num', formatNumber(stats.negative)));
    tr.title = draftOrder ? 'Bấm để mở đơn tạm' : 'Bấm để xem chi tiết đơn';
    const open = () => { if (draftOrder) setView('current'); else showDetail(item.id, 'list'); };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', event => { if (event.key === 'Enter') open(); });
    return tr;
  }

  function renderList() {
    const body = $('vtOrderListRows');
    body.replaceChildren();
    const term = state.search.trim().toLowerCase();
    const matches = item => !term || [item.code, item.createdByName, item.confirmedByName].some(value => String(value || '').toLowerCase().includes(term));
    // Đơn tạm tự được tạo khi mở hộp; chưa có dòng nào thì chưa phải một đơn nên không đưa vào danh sách (vẫn mở được ở tab Đơn tạm).
    const draftOrder = state.order && state.order.status === 'draft' && state.order.lines.length && matches(state.order) ? state.order : null;
    const done = state.serverPaged ? state.history : state.history.filter(matches);
    if (draftOrder) body.appendChild(listRow(draftOrder, true));
    done.forEach(item => body.appendChild(listRow(item, false)));
    if (!draftOrder && !done.length) {
      const tr = el('tr');
      const td = el('td', 'table-note', term ? 'Không có đơn nào khớp từ khóa.' : 'Chưa có đơn nào.');
      td.colSpan = 7;
      tr.appendChild(td);
      body.appendChild(tr);
    }
    $('vtOrderListNote').textContent = (draftOrder ? '1 đơn tạm · ' : '') + (state.serverPaged ? state.historyTotal : done.length) + ' đơn đã chốt' + (state.moreBefore !== null ? ' (còn nữa, bấm Tải thêm)' : '');
    $('vtOrderMore').hidden = state.moreBefore === null;
  }

  function render() {
    const view = state.view;
    $('vtOrderCurrent').hidden = view !== 'current';
    $('vtOrderList').hidden = view !== 'list';
    $('vtOrderDetail').hidden = view !== 'detail';
    $('vtOrderExcel').hidden = view !== 'excel';
    $('vtOrderExcelTab').hidden = !state.canEdit;
    document.querySelectorAll('[data-order-view]').forEach(button => {
      const active = button.dataset.orderView === (view === 'detail' ? state.returnView : view);
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    $('vtOrderBack').hidden = view !== 'detail';
    renderSubtitle();
    const order = state.order;
    const editable = state.canEdit && order && order.status === 'draft';
    $('vtOrderConfirm').hidden = !(view === 'current' && editable);
    $('vtOrderConfirm').disabled = state.busy || !order || !order.lines.length;
    $('vtOrderImport').hidden = !(view === 'current' && editable);
    $('vtOrderTemplate').hidden = $('vtOrderImport').hidden;
    const exportable = view === 'detail' ? state.detail : (view === 'current' ? order : null);
    $('vtOrderExport').hidden = !(state.canExport && exportable && exportable.lines.length);
    $('vtOrderHint').textContent = !state.canEdit
      ? 'Bạn chỉ xem được đơn. Người có quyền sửa VT mới thêm dòng và chốt đơn.'
      : 'Đơn tạm dùng chung: ghi hàng đã bốc thật (gõ theo tên). Tồn VT chỉ bị trừ khi bấm Chốt đơn; dòng nào trừ quá tồn sẽ thành số âm.';

    if (view === 'current') {
      const body = $('vtOrderRows');
      body.replaceChildren();
      const lines = order ? order.lines : [];
      lines.forEach((line, index) => body.appendChild(lineRow(line, index, editable)));
      if (!lines.length) {
        const tr = el('tr');
        const td = el('td', 'table-note', order ? 'Đơn chưa có dòng nào. Bấm "+ Thêm dòng" hoặc Import Excel (xuất file hàng ở CONT).' : 'Chưa có đơn tạm.');
        td.colSpan = 8;
        tr.appendChild(td);
        body.appendChild(tr);
      }
      if (!state.adding || !$('vtOrderName')) renderFoot(Boolean(editable));
    } else if (view === 'list') {
      renderList();
    } else if (view === 'detail' && state.detail) {
      const body = $('vtOrderDetailRows');
      body.replaceChildren();
      state.detail.lines.forEach((line, index) => body.appendChild(state.detail.status === 'confirmed' ? resultRow(line, index) : lineRow(line, index, false)));
      const stats = state.detail.summary;
      $('vtOrderDetailNote').textContent = stats
        ? `${stats.lines} dòng · ${stats.positions} vị trí · trừ ${formatNumber(stats.quantity)} · ${stats.negative} vị trí âm · ${stats.created} dòng VT tạo mới · ${stats.removed} dòng hết hàng đã xóa`
        : '';
    }
  }

  // ---------- Thao tác ----------
  async function guarded(work) {
    if (state.busy) return false;
    state.busy = true;
    setError('');
    try { return await work(); }
    finally { state.busy = false; if (state.order || state.view !== 'current') render(); }
  }

  async function afterFailure(payload) {
    if (payload.code === 'VERSION_CONFLICT' || payload.code === 'ORDER_CONFIRMED') {
      setError(payload.error || 'Đơn đã thay đổi.');
      await loadCurrent();
      return;
    }
    setError(payload.error || 'Không lưu được thay đổi.');
  }

  function parseNameInput(text) {
    const value = String(text || '').trim();
    const match = /\(([^()]+)\)\s*$/u.exec(value);
    const code = (match ? match[1] : value).trim();
    const hit = state.suggestions.find(item => item.code.toLowerCase() === code.toLowerCase());
    return hit ? { code: hit.code, name: hit.name } : null;
  }

  async function submitAdd() {
    const error = $('vtOrderAddError');
    const picked = parseNameInput($('vtOrderName').value);
    if (!picked) { error.textContent = 'Hãy chọn hàng trong danh sách gợi ý (gõ tên hoặc mã).'; $('vtOrderName').focus(); return; }
    const location = $('vtOrderLocation').value.trim();
    const notes = $('vtOrderNotes').value.trim();
    if (!location) { error.textContent = 'Vui lòng nhập vị trí.'; $('vtOrderLocation').focus(); return; }
    if (!notes) { error.textContent = 'Vui lòng nhập ghi chú thùng (vd 5T x 100).'; $('vtOrderNotes').focus(); return; }
    error.textContent = '';
    await guarded(async () => {
      const { response, payload } = await call(API + '/' + state.order.id + '/lines', state.hooks.jsonOptions('POST', { code: picked.code, name: picked.name, location, notes }));
      if (!response.ok) { error.textContent = payload.error || 'Không thêm được dòng.'; if (payload.code === 'ORDER_CONFIRMED') await afterFailure(payload); return false; }
      state.suggestions = [];
      state.adding = true;
      await loadCurrent();
      renderFoot(true);
      const name = $('vtOrderName');
      if (name) name.focus();
      return true;
    });
  }

  function startEdit(cell, line, field) {
    if (state.editing || state.busy) return;
    state.editing = true;
    const input = el('input', 'vt-order-inline');
    input.type = 'text';
    input.value = line[field];
    input.setAttribute('aria-label', field === 'notes' ? 'Ghi chú thùng' : 'Vị trí');
    const original = cell.textContent;
    cell.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async save => {
      if (done) return;
      done = true;
      state.editing = false;
      const value = input.value.trim();
      if (!save || value === line[field] || !value) { render(); return; }
      await guarded(async () => {
        const { response, payload } = await call(API + '/lines/' + line.id, state.hooks.jsonOptions('PATCH', { [field]: value, version: line.version }));
        if (!response.ok) { await afterFailure(payload); return false; }
        await loadCurrent();
        return true;
      });
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    cell.dataset.original = original;
  }

  async function removeLine(line) {
    await guarded(async () => {
      const { response, payload } = await call(API + '/lines/' + line.id + '?version=' + encodeURIComponent(line.version), { method: 'DELETE' });
      if (!response.ok) { await afterFailure(payload); return false; }
      await loadCurrent();
      return true;
    });
  }

  async function importFile(file) {
    if (!file) return;
    await guarded(async () => {
      const form = new window.FormData();
      form.append('file', file, file.name);
      const { response, payload } = await call(API + '/' + state.order.id + '/import', { method: 'POST', body: form });
      if (!response.ok) { await afterFailure(payload); return false; }
      const counts = payload.counts || {};
      const skipped = payload.errors || [];
      state.hooks.notify(`Đã nạp ${counts.added || 0} dòng từ ${payload.fileName || 'file'} vào đơn xuất kho` + (counts.skipped ? `, bỏ qua ${counts.skipped} dòng sai` : '') + '.', counts.skipped > 0);
      if (skipped.length) setError('Dòng bị bỏ qua: ' + skipped.slice(0, 5).map(item => `dòng ${item.row} (${item.code || '?'}): ${item.message}`).join('; ') + (skipped.length > 5 ? '…' : ''));
      await loadCurrent();
      return true;
    });
  }

  // Tóm tắt trước khi chốt: mỗi (mã, vị trí) chỉ tính một lần theo kết quả cuối cùng của nhóm.
  function confirmMessage(order) {
    const last = new Map();
    order.lines.forEach(line => last.set(keyOf(line), line));
    const groups = [...last.values()];
    const label = line => (line.name || line.code) + ' @ ' + line.location;
    const negatives = groups.filter(line => preview(line) && preview(line).negative);
    const missing = groups.filter(line => preview(line) && preview(line).missing);
    const held = groups.filter(line => preview(line) && preview(line).held > 0 && preview(line).quantity < preview(line).held);
    const list = items => items.slice(0, 5).map(label).join('; ') + (items.length > 5 ? '…' : '');
    const text = [`Chốt đơn ${order.code}: ${order.lines.length} dòng, ${groups.length} vị trí sẽ bị TRỪ tồn thật. Không hoàn tác được.`];
    if (negatives.length) text.push(`• ${negatives.length} vị trí sẽ ra số ÂM: ${list(negatives)}`);
    if (missing.length) text.push(`• ${missing.length} vị trí chưa có dòng VT, sẽ tạo mới với số âm: ${list(missing)}`);
    if (held.length) text.push(`• ${held.length} vị trí đang được đơn Đang bốc giữ chỗ, tồn sau chốt thấp hơn phần giữ: ${list(held)}`);
    return text.join('\n');
  }

  async function confirmOrder() {
    const order = state.order;
    if (!order || !order.lines.length || state.busy) return;
    if (!await state.hooks.confirmBox(confirmMessage(order), 'Chốt đơn')) return;
    await guarded(async () => {
      const { response, payload } = await call(API + '/' + order.id + '/confirm', state.hooks.jsonOptions('POST', { version: order.version }));
      if (!response.ok) { await afterFailure(payload); return false; }
      const stats = payload.stats || {};
      state.hooks.notify(`Đã chốt đơn ${order.code}: trừ ${formatNumber(stats.quantity)} tại ${stats.positions || 0} vị trí` + (stats.negative ? `, ${stats.negative} vị trí âm` : '') + '.');
      state.adding = false;
      await loadCurrent();
      if (state.hooks.onChanged) await state.hooks.onChanged();
      return true;
    });
  }

  // ---------- Gợi ý theo tên ----------
  function onNameInput(event) {
    clearTimeout(state.suggestTimer);
    const term = event.target.value.trim();
    state.suggestTimer = setTimeout(async () => {
      if (!term || /\([^()]+\)\s*$/u.test(term)) return;
      const seq = ++state.suggestSeq;
      const { response, payload } = await call(SUGGEST_API + '?branch=' + state.branch + '&q=' + encodeURIComponent(term));
      if (seq !== state.suggestSeq || !response.ok) return;
      state.suggestions = Array.isArray(payload.items) ? payload.items : [];
      const list = $('vtOrderSuggestions');
      list.replaceChildren(...state.suggestions.map(item => { const option = el('option'); option.value = (item.name || item.code) + ' (' + item.code + ')'; return option; }));
    }, 200);
  }

  // ---------- Chuyển màn hình ----------
  async function setView(view) {
    if (state.hooks.excel && state.hooks.excel.busy()) return; // đang trừ kho theo file: không cho rời tab
    if (view === 'excel' && !state.canEdit) return;
    state.view = view;
    setError('');
    if (view === 'list') { render(); await Promise.all([loadCurrent({ quiet: true }), loadHistory(false)]); }
    else if (view === 'current') { render(); await loadCurrent(); }
    else if (view === 'excel') { state.hooks.excel.enter(); render(); }
  }

  async function showDetail(id, returnView) {
    state.returnView = returnView || 'list';
    if (!await loadDetail(id)) return;
    state.view = 'detail';
    render();
  }

  function downloadTemplate() {
    const csv = '﻿Mã hàng,Ghi chú,Vị trí\r\nVASNAM,1T x 50,CONT\r\n';
    const url = URL.createObjectURL(new window.Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'mau-don-xuat-kho.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Xuất Excel đơn đang xem (đơn tạm ở tab Đơn tạm, đơn đã chốt ở màn chi tiết); tải qua fetch để giữ cookie đăng nhập.
  async function exportOrder() {
    const order = state.view === 'detail' ? state.detail : state.order;
    const button = $('vtOrderExport');
    if (!order || button.disabled) return;
    button.disabled = true;
    setError('');
    try {
      const response = await fetch(API + '/' + encodeURIComponent(order.id) + '/export', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setError(payload.error || 'Không xuất được file Excel.');
        return;
      }
      const blob = await response.blob();
      const disposition = String((response.headers && response.headers.get && response.headers.get('Content-Disposition')) || '');
      const named = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = named ? named[1].trim() : 'don-xuat-kho-' + order.code + '.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError('Không xuất được file Excel.');
    } finally {
      button.disabled = false;
    }
  }

  function startPolling() {
    stopPolling();
    state.timer = setInterval(() => {
      const dialog = $('vtOrderDialog');
      if (!dialog.open && !dialog.hasAttribute('open')) { stopPolling(); return; }
      if (state.view !== 'current' || state.adding || state.editing || state.busy) return;
      loadCurrent({ quiet: true });
    }, POLL_MS);
  }
  function stopPolling() { clearInterval(state.timer); state.timer = null; }

  async function open() {
    state.branch = state.hooks.branch();
    state.search = ''; $('vtOrderSearch').value = '';
    ++state.historySeq; clearTimeout(state.historyTimer); if (state.historyController) state.historyController.abort();
    state.history = []; state.moreBefore = null;
    state.view = 'current';
    state.adding = false;
    state.editing = false;
    state.order = null;
    state.suggestions = [];
    setError('');
    render();
    state.hooks.openDialog($('vtOrderDialog'));
    startPolling();
    await loadCurrent();
  }

  // Mở chi tiết một đơn đã chốt từ liên kết mã đơn trong Lịch sử cập nhật của VT.
  async function openDetail(id, branch) {
    state.branch = branch || state.hooks.branch();
    state.adding = false;
    state.editing = false;
    state.returnView = 'list';
    setError('');
    if (!await loadDetail(id)) { state.hooks.notify('Không mở được đơn xuất kho.', true); return; }
    state.canEdit = false;
    state.view = 'detail';
    render();
    const dialog = $('vtOrderDialog');
    if (!(dialog.open || dialog.hasAttribute('open'))) state.hooks.openDialog(dialog);
  }

  function init(hooks) {
    state.hooks = hooks;
    const button = $('vtOrderButton');
    if (!button) return;
    button.addEventListener('click', open);
    document.querySelectorAll('[data-order-view]').forEach(tab => tab.addEventListener('click', () => setView(tab.dataset.orderView)));
    $('vtOrderBack').addEventListener('click', () => { if (state.returnView === 'current') setView('current'); else if (state.history.length) { state.view = 'list'; render(); } else setView('list'); });
    $('vtOrderSearch').addEventListener('input', event => { state.search = event.target.value; if (state.view === 'list') queryHistory(); });
    $('vtOrderConfirm').addEventListener('click', confirmOrder);
    $('vtOrderAudit').addEventListener('toggle', event => { if (event.target.open) loadAudit(); });
    $('vtOrderMore').addEventListener('click', () => loadHistory(true));
    $('vtOrderImport').addEventListener('click', () => $('vtOrderFile').click());
    $('vtOrderFile').addEventListener('change', event => { const file = event.target.files && event.target.files[0]; event.target.value = ''; importFile(file); });
    $('vtOrderTemplate').addEventListener('click', downloadTemplate);
    $('vtOrderExport').addEventListener('click', exportOrder);
    $('vtOrderDialog').addEventListener('close', () => { stopPolling(); state.adding = false; state.editing = false; });
  }

  window.TKSVtStockOutOrder = { init, open, openDetail, confirmMessage };
})();
