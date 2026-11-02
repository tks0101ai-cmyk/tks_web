/* Trang Kiểm kê (/stocktake/): đối chiếu số đếm đơn TEAM với tồn KiotViet theo đợt.
   Dữ liệu tính ở máy chủ (GET board); trang chỉ lọc / sắp xếp / phân trang và gửi sửa kèm version.
   Người khác sửa -> SSE "stocktake-changed" -> tải lại bảng; lưu với version cũ -> 409 kèm bản mới. */
(function () {
  'use strict';

  const API = '/api/stocktake';
  const PAGE_SIZE = 100;
  const $ = id => document.getElementById(id);
  const COLUMNS = [
    { key: 'code', label: 'Mã hàng', width: 120, locked: true },
    { key: 'name', label: 'Tên hàng', width: 240 },
    { key: 'position', label: 'Vị trí gần nhất', width: 120 },
    { key: 'counted', label: 'Tổng kiểm', width: 96, num: true },
    { key: 'stock', label: 'Tồn KIOT', width: 96, num: true },
    { key: 'diffQty', label: 'SL chênh', width: 96, num: true },
    { key: 'diffValue', label: 'Giá trị chênh', width: 120, num: true },
    { key: 'cluster', label: 'Cụm SP', width: 140 },
    { key: 'clusterDiff', label: 'Chênh cụm', width: 96, num: true },
    { key: 'combo', label: 'Combo', width: 70 },
    { key: 'prevDiff', label: 'KK trước sai', width: 96, num: true },
    { key: 'recheck', label: 'Người kiểm lại', width: 140 },
    { key: 'status', label: 'Trạng thái', width: 130 },
    { key: 'reason', label: 'Chi tiết lý do', width: 220 },
    { key: 'updated', label: 'Sửa cuối', width: 140 }
  ];

  const state = {
    sessions: [], sessionId: null, board: null, canEdit: false, canClose: false,
    query: '', filter: 'mismatch', recheck: '', status: '', sort: 'value', page: 1, loadVersion: 0
  };
  const live = { source: null, timer: null };
  const detail = { code: null };
  let user = null;

  const fmt = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });
  const num = value => (value === null || value === undefined ? '' : fmt.format(value));
  // "HH:mm dd/MM" theo giờ VN (cố định +7, không phụ thuộc múi giờ máy).
  const time = iso => {
    if (!iso) return '';
    const vn = new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString();
    return vn.slice(11, 16) + ' ' + vn.slice(8, 10) + '/' + vn.slice(5, 7);
  };
  const dateVn = text => (text ? text.split('-').reverse().join('/') : '');
  const fold = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();

  async function request(path, options) {
    const response = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    let payload = {};
    try { payload = await response.json(); } catch (error) { /* tệp hoặc rỗng */ }
    return { response, payload };
  }
  const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function notify(text, isError) {
    const node = $('stNotice');
    node.textContent = text || '';
    node.dataset.error = String(!!isError);
  }

  // ---------- Đợt kiểm kê ----------
  async function loadSessions(selectId) {
    const { response, payload } = await request(API + '/sessions');
    if (!response.ok) throw new Error(payload.error || 'Không tải được danh sách đợt kiểm kê.');
    state.sessions = payload.sessions || [];
    state.canEdit = !!payload.canEdit;
    state.canClose = !!payload.canClose;
    const select = $('stSession');
    select.textContent = '';
    for (const session of state.sessions) {
      const option = document.createElement('option');
      option.value = String(session.id);
      option.textContent = session.name + ' · ' + (session.branch === 'hanoi' ? 'HN' : 'SG') + ' · ' + (session.status === 'closed' ? 'Đã đóng' : 'Đang mở');
      select.appendChild(option);
    }
    $('stCreateButton').hidden = !state.canEdit;
    $('stImportButton').hidden = !state.canClose || state.sessions.some(s => s.source === 'sheet_import');
    const wanted = selectId || Number(new URLSearchParams(window.location.hash.slice(1)).get('dot')) || (state.sessions[0] && state.sessions[0].id);
    const exists = state.sessions.some(s => s.id === wanted);
    state.sessionId = exists ? wanted : (state.sessions[0] ? state.sessions[0].id : null);
    if (state.sessionId) select.value = String(state.sessionId);
    if (!state.sessionId) {
      state.board = null;
      $('stStatus').textContent = state.canEdit ? 'Chưa có đợt kiểm kê nào. Bấm "Tạo đợt" để bắt đầu.' : 'Chưa có đợt kiểm kê nào.';
      render();
      return;
    }
    await loadBoard();
  }

  // forms: ghi đè ô nhập của hộp chi tiết bằng dữ liệu mới (sau khi chính mình lưu). Tải nền do SSE thì không,
  // để không xóa phần người dùng đang gõ; thay vào đó báo người khác vừa sửa.
  async function loadBoard({ background = false, forms = !background } = {}) {
    if (!state.sessionId) return;
    const version = ++state.loadVersion;
    const sessionId = state.sessionId;
    if (!background) { $('stStatus').textContent = 'Đang tải bảng đối chiếu…'; $('stStatus').dataset.error = 'false'; }
    try {
      const { response, payload } = await request(API + '/sessions/' + sessionId + '/board');
      if (version !== state.loadVersion) return;
      if (!response.ok) throw new Error(payload.error || 'Không tải được bảng đối chiếu.');
      state.board = payload;
      state.canEdit = !!payload.canEdit;
      state.canClose = !!payload.canClose;
      $('stStatus').textContent = '';
      window.history.replaceState(null, '', '#dot=' + sessionId);
      startLive(sessionId);
      render();
      if (detail.code) renderDetail({ forms });
    } catch (error) {
      if (version !== state.loadVersion) return;
      $('stStatus').textContent = error.message;
      $('stStatus').dataset.error = 'true';
    }
  }

  function startLive(sessionId) {
    if (live.source && live.source.sessionId === sessionId) return;
    stopLive();
    if (typeof window.EventSource !== 'function') return;
    const source = new window.EventSource(API + '/sessions/' + sessionId + '/events');
    source.sessionId = sessionId;
    live.source = source;
    source.addEventListener('stocktake-changed', () => {
      clearTimeout(live.timer);
      live.timer = setTimeout(() => loadBoard({ background: true }), 400);
    });
  }
  function stopLive() {
    if (live.source) live.source.close();
    live.source = null;
    clearTimeout(live.timer);
  }

  // ---------- Bảng ----------
  const employeeName = id => {
    if (id === null || id === undefined || !state.board) return '';
    const found = state.board.employees.find(e => e.id === id);
    return found ? found.name : '';
  };
  // Người kiểm lại: nhân sự trên web, hoặc tên chữ nạp từ sheet (biệt danh không khớp danh bạ).
  const recheckKey = note => {
    if (!note) return '';
    if (note.recheckEmployeeId !== null && note.recheckEmployeeId !== undefined) return 'id:' + note.recheckEmployeeId;
    return note.recheckName ? 'name:' + note.recheckName.trim().toUpperCase() : '';
  };
  const recheckLabel = note => (note ? employeeName(note.recheckEmployeeId) || note.recheckName || '' : '');

  function visibleRows() {
    if (!state.board) return [];
    const query = fold(state.query).trim();
    const rows = state.board.rows.filter(row => {
      if (state.filter === 'mismatch' && row.diffQty === 0) return false;
      if (state.filter === 'forgotten' && !row.forgotten) return false;
      if (state.filter === 'noted' && !row.note) return false;
      if (state.recheck && recheckKey(row.note) !== state.recheck) return false;
      if (state.status && (row.note ? row.note.statusText : '') !== state.status) return false;
      if (!query) return true;
      return fold([row.code, row.name, row.cluster, row.note && row.note.statusText, row.note && row.note.reasonText].join(' ')).includes(query);
    });
    const by = state.sort === 'code' ? (a, b) => a.code.localeCompare(b.code)
      : state.sort === 'qty' ? (a, b) => Math.abs(b.diffQty) - Math.abs(a.diffQty) || a.code.localeCompare(b.code)
        : (a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue) || a.code.localeCompare(b.code);
    return rows.sort(by);
  }

  function cellText(row, key) {
    const note = row.note || {};
    switch (key) {
      case 'code': return row.code;
      case 'name': return row.name || (row.inKiot ? '' : '(không có trên KiotViet)');
      case 'position': return row.latestPosition ? row.latestPosition.location : '';
      case 'counted': return num(row.counted);
      case 'stock': return num(row.stock);
      case 'diffQty': return num(row.diffQty);
      case 'diffValue': return num(row.diffValue);
      case 'cluster': return row.cluster;
      case 'clusterDiff': return num(row.clusterDiff);
      case 'combo': return row.isCombo ? 'X' : '';
      case 'prevDiff': return num(row.prevDiff);
      case 'recheck': return recheckLabel(row.note);
      case 'status': return note.statusText || '';
      case 'reason': return note.reasonText || '';
      case 'updated': return note.updatedByName ? note.updatedByName + ' · ' + time(note.updatedAt) : '';
      default: return '';
    }
  }

  function renderHead() {
    const tr = document.querySelector('#stTable thead tr');
    tr.textContent = '';
    for (const column of COLUMNS) {
      const th = document.createElement('th');
      th.dataset.field = column.key;
      th.textContent = column.label;
      if (column.num) th.className = 'num';
      tr.appendChild(th);
    }
    if (window.TKSTables) {
      window.TKSTables.enhance($('stTable'), {
        key: 'stocktake-board-v1', button: $('stColumnsButton'), sort: false,
        columns: COLUMNS.map(c => ({ key: c.key, label: c.label, width: c.width, locked: !!c.locked, hidden: c.key === 'updated' }))
      });
    }
  }

  function renderStats(node, items) {
    node.textContent = '';
    for (const [label, value, tone] of items) {
      const card = document.createElement('div');
      card.className = 'st-stat' + (tone ? ' st-' + tone : '');
      const b = document.createElement('b');
      b.textContent = value;
      const span = document.createElement('span');
      span.textContent = label;
      card.append(b, span);
      node.appendChild(card);
    }
  }

  function render() {
    const board = state.board;
    const session = board && board.session;
    $('stSessionMeta').textContent = session
      ? dateVn(session.dateFrom) + (session.dateTo !== session.dateFrom ? ' – ' + dateVn(session.dateTo) : '')
        + (session.status === 'closed' ? ' · Đóng bởi ' + (session.closedByName || '—') + ' ' + time(session.closedAt) : ' · Tồn theo KiotViet hiện tại')
      : '';
    $('stCloseButton').hidden = !(session && session.status === 'open' && state.canClose);
    $('stCreateButton').hidden = !state.canEdit;
    renderStats($('stStats'), board ? [
      ['mã trong đợt', num(board.totals.codes)],
      ['mã lệch', num(board.totals.mismatched), board.totals.mismatched ? 'warn' : ''],
      ['Quên KK', num(board.totals.forgotten), board.totals.forgotten ? 'warn' : ''],
      ['tổng giá trị chênh', num(board.totals.diffValue), board.totals.diffValue < 0 ? 'bad' : '']
    ] : []);
    renderFilters();
    renderRecheck();

    const rows = visibleRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount);
    const tbody = $('stRows');
    tbody.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const row of rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE)) {
      const tr = document.createElement('tr');
      tr.dataset.code = row.code;
      tr.tabIndex = 0;
      if (row.forgotten) tr.classList.add('st-forgotten');
      for (const column of COLUMNS) {
        const td = document.createElement('td');
        td.dataset.field = column.key;
        if (column.num) td.className = 'num';
        td.textContent = cellText(row, column.key);
        if ((column.key === 'diffQty' || column.key === 'diffValue' || column.key === 'clusterDiff') && row[column.key]) {
          td.classList.add(row[column.key] < 0 ? 'st-neg' : 'st-pos');
        }
        tr.appendChild(td);
      }
      fragment.appendChild(tr);
    }
    tbody.appendChild(fragment);
    if (board && !rows.length) $('stStatus').textContent = 'Không có mã nào khớp bộ lọc.';
    else if (board && $('stStatus').dataset.error !== 'true') $('stStatus').textContent = '';
    $('stPager').hidden = !board || rows.length <= PAGE_SIZE;
    $('stCount').textContent = num(rows.length) + ' mã';
    $('stPage').textContent = state.page + ' / ' + pageCount;
    $('stPrevious').disabled = state.page <= 1;
    $('stNext').disabled = state.page >= pageCount;
    if (window.TKSTables) window.TKSTables.refresh($('stTable'));
  }

  function fillSelect(select, firstLabel, entries, current) {
    select.textContent = '';
    const first = document.createElement('option');
    first.value = '';
    first.textContent = firstLabel;
    select.appendChild(first);
    for (const [value, label] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = entries.some(([value]) => value === current) ? current : '';
  }

  // Đếm số mã theo người kiểm lại: key -> { label, count }.
  function recheckCounts() {
    const counts = new Map();
    if (!state.board) return counts;
    for (const row of state.board.rows) {
      const key = recheckKey(row.note);
      if (!key) continue;
      const entry = counts.get(key) || { label: recheckLabel(row.note), count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return counts;
  }

  function renderFilters() {
    const board = state.board;
    const entries = [...recheckCounts()].map(([key, entry]) => [key, entry.label]).sort((a, b) => a[1].localeCompare(b[1]));
    fillSelect($('stRecheckFilter'), 'Mọi người kiểm lại', entries, state.recheck);
    state.recheck = $('stRecheckFilter').value;
    fillSelect($('stStatusFilter'), 'Mọi trạng thái', board ? board.suggestions.status.map(s => [s, s]) : [], state.status);
    state.status = $('stStatusFilter').value;
  }

  // Thay Sheet87: số mã mỗi người đang được giao kiểm lại trong đợt.
  function renderRecheck() {
    const list = $('stRecheckList');
    list.textContent = '';
    if (!state.board) return;
    const counts = recheckCounts();
    if (!counts.size) {
      list.textContent = 'Chưa giao mã nào.';
      return;
    }
    for (const [key, entry] of [...counts].sort((a, b) => b[1].count - a[1].count)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'st-chip';
      button.textContent = entry.label + ' · ' + entry.count;
      button.addEventListener('click', () => {
        state.recheck = key;
        state.filter = 'all';
        $('stFilter').value = 'all';
        state.page = 1;
        render();
      });
      list.appendChild(button);
    }
  }

  // ---------- Chi tiết mã ----------
  const rowOf = code => state.board && state.board.rows.find(row => row.code === code);
  const editable = () => state.canEdit && state.board && state.board.session.status === 'open';

  function openDetail(code) {
    detail.code = code;
    setDetailError('');
    $('stConflict').hidden = true;
    renderDetail({ forms: true });
    loadHistory();
    const dialog = $('stDetailDialog');
    if (!dialog.open) dialog.showModal();
  }

  function setDetailError(text) { $('stDetailError').textContent = text || ''; }

  // Người khác vừa đổi ghi chú / cụm của mã đang mở: báo thay vì ghi đè ô đang gõ.
  function checkStale(row) {
    const note = row.note || {};
    const noteChanged = String(note.version || '') !== $('stNoteForm').dataset.version;
    const tagChanged = String(row.tagVersion || '') !== $('stTagForm').dataset.version;
    if (!noteChanged && !tagChanged) return;
    const who = noteChanged ? note.updatedByName : '';
    $('stConflictText').textContent = (who ? who + ' vừa sửa' + (note.updatedAt ? ' lúc ' + time(note.updatedAt) : '') : 'Có người vừa sửa mã này') + '. Xem bản mới rồi lưu lại.';
    $('stConflict').hidden = false;
  }

  function renderDetail({ forms = true } = {}) {
    const row = rowOf(detail.code);
    if (!row) return;
    if (!forms) {
      checkStale(row);
      renderLines(row);
      return;
    }
    $('stDetailTitle').textContent = row.code;
    $('stDetailSubtitle').textContent = [row.name, row.latestPosition && ('Vị trí: ' + row.latestPosition.location)].filter(Boolean).join(' · ');
    const canEditNote = editable();
    const noteForm = $('stNoteForm');
    const note = row.note || {};
    const recheck = noteForm.elements.recheckEmployeeId;
    recheck.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— Chưa giao —';
    recheck.appendChild(none);
    for (const employee of state.board.employees) {
      const option = document.createElement('option');
      option.value = String(employee.id);
      option.textContent = employee.name + (employee.branch === 'saigon' ? ' (SG)' : '');
      recheck.appendChild(option);
    }
    recheck.value = note.recheckEmployeeId === null || note.recheckEmployeeId === undefined ? '' : String(note.recheckEmployeeId);
    noteForm.elements.statusText.value = note.statusText || '';
    noteForm.elements.reasonText.value = note.reasonText || '';
    noteForm.dataset.version = note.version ? String(note.version) : '';
    $('stNoteMeta').textContent = note.updatedByName ? 'Sửa cuối: ' + note.updatedByName + ' · ' + time(note.updatedAt) : '';
    for (const [id, values] of [['stStatusSuggestions', state.board.suggestions.status], ['stReasonSuggestions', state.board.suggestions.reason]]) {
      const list = $(id);
      list.textContent = '';
      for (const value of values) { const option = document.createElement('option'); option.value = value; list.appendChild(option); }
    }
    noteForm.querySelectorAll('input, select, button').forEach(el => { el.disabled = !canEditNote; });

    const tagForm = $('stTagForm');
    tagForm.elements.cluster.value = row.cluster || '';
    tagForm.elements.isCombo.checked = !!row.isCombo;
    tagForm.dataset.version = row.tagVersion ? String(row.tagVersion) : '';
    tagForm.querySelectorAll('input, button').forEach(el => { el.disabled = !state.canEdit; });
    renderLines(row);
  }

  function renderLines(row) {
    const canEditNote = editable();
    renderStats($('stDetailStats'), [
      ['Tổng kiểm', num(row.counted)], ['Tồn KIOT', num(row.stock)],
      ['SL chênh', num(row.diffQty), row.diffQty ? 'warn' : ''], ['Giá trị chênh', num(row.diffValue), row.diffValue < 0 ? 'bad' : ''],
      ['KK trước sai', row.prevDiff === null ? '—' : num(row.prevDiff)]
    ]);
    const closed = state.board.session.status === 'closed';
    $('stLinesSection').hidden = closed;
    $('stAddLineForm').hidden = !canEditNote;
    const tbody = $('stLineRows');
    tbody.textContent = '';
    for (const line of row.lines) {
      const tr = document.createElement('tr');
      if (line.removed) tr.classList.add('st-removed');
      const cells = [line.team, line.zone, line.spec, null, line.manual ? 'Thêm tay' : line.orderCode + (line.orderStatus ? ' · ' + line.orderStatus : ''),
        line.edit ? line.edit.updatedByName + ' · ' + time(line.edit.updatedAt) : ''];
      cells.forEach((value, index) => {
        const td = document.createElement('td');
        if (index === 3) {
          td.className = 'num';
          const input = document.createElement('input');
          input.type = 'number';
          input.min = '0';
          input.step = 'any';
          input.value = String(line.quantity);
          input.disabled = !canEditNote || line.removed;
          input.setAttribute('aria-label', 'Số lượng');
          input.addEventListener('change', () => saveLine(line, { quantity: input.value === '' ? null : Number(input.value) }));
          td.appendChild(input);
          if (line.original && line.original.quantity !== line.quantity) {
            const small = document.createElement('small');
            small.textContent = 'gốc ' + num(line.original.quantity);
            td.appendChild(small);
          }
        } else td.textContent = value || '';
        tr.appendChild(td);
      });
      const actions = document.createElement('td');
      if (canEditNote) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'vt-row-button';
        button.textContent = line.removed ? 'Lấy lại' : 'Bỏ dòng';
        button.addEventListener('click', () => saveLine(line, { removed: !line.removed }));
        actions.appendChild(button);
      }
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
    if (!row.lines.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'Không team nào đếm mã này.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  const ACTION_LABELS = { line_edit: 'Sửa dòng đếm', line_add: 'Thêm dòng', note: 'Kiểm lại', tag: 'Cụm / Combo', session_close: 'Đóng đợt', sheet_import: 'Nạp từ sheet' };
  function historyText(item) {
    const after = item.after || {};
    if (item.action === 'note') return [recheckLabel(after), after.statusText, after.reasonText].filter(Boolean).join(' · ');
    if (item.action === 'tag') return [after.cluster && 'Cụm: ' + after.cluster, after.isCombo ? 'Combo' : ''].filter(Boolean).join(' · ');
    if (item.action === 'line_edit' || item.action === 'line_add') {
      return [after.removed ? 'Bỏ dòng' : after.quantity !== null && after.quantity !== undefined ? 'SL ' + num(after.quantity) : '', after.zone, after.team].filter(Boolean).join(' · ');
    }
    return '';
  }

  async function loadHistory() {
    const list = $('stHistory');
    list.textContent = 'Đang tải…';
    const code = detail.code;
    const { response, payload } = await request(API + '/sessions/' + state.sessionId + '/codes/' + encodeURIComponent(code) + '/history');
    if (detail.code !== code) return;
    list.textContent = '';
    if (!response.ok) { list.textContent = payload.error || 'Không tải được lịch sử.'; return; }
    if (!payload.history.length) { list.textContent = 'Chưa có thay đổi.'; return; }
    for (const item of payload.history) {
      const li = document.createElement('li');
      const head = document.createElement('b');
      head.textContent = (ACTION_LABELS[item.action] || item.action) + ' — ' + (item.actorName || '—') + ' · ' + time(item.createdAt);
      const body = document.createElement('span');
      body.textContent = historyText(item);
      li.append(head, body);
      list.appendChild(li);
    }
  }

  // Lưu thất bại vì người khác vừa sửa: hiện tên + giờ, cho tải bản mới rồi người dùng tự lưu lại.
  function handleWriteError(payload) {
    if (payload.code === 'STOCKTAKE_CONFLICT') {
      $('stConflictText').textContent = payload.error;
      $('stConflict').hidden = false;
      return;
    }
    setDetailError(payload.error || 'Không lưu được.');
  }

  async function write(path, method, body) {
    setDetailError('');
    const { response, payload } = await request(path, jsonOptions(method, body));
    if (!response.ok) { handleWriteError(payload); return false; }
    $('stConflict').hidden = true;
    await loadBoard({ background: true, forms: true });
    loadHistory();
    return true;
  }

  function saveLine(line, patch) {
    const base = line.manual ? { editId: line.edit.id } : { orderId: line.orderId, lineNo: line.lineNo };
    return write(API + '/sessions/' + state.sessionId + '/lines', 'PATCH', Object.assign(base, patch, { version: line.edit ? line.edit.version : null }));
  }

  function bindDetail() {
    $('stRows').addEventListener('click', event => {
      const tr = event.target.closest('tr[data-code]');
      if (tr) openDetail(tr.dataset.code);
    });
    $('stRows').addEventListener('keydown', event => {
      const tr = event.target.closest('tr[data-code]');
      if (tr && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(tr.dataset.code); }
    });
    $('stDetailDialog').addEventListener('close', () => { detail.code = null; });
    $('stConflictReload').addEventListener('click', async () => {
      $('stConflict').hidden = true;
      await loadBoard({ background: true, forms: true });
      loadHistory();
    });
    $('stNoteForm').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target;
      write(API + '/sessions/' + state.sessionId + '/codes/' + encodeURIComponent(detail.code) + '/note', 'PUT', {
        recheckEmployeeId: form.elements.recheckEmployeeId.value ? Number(form.elements.recheckEmployeeId.value) : null,
        statusText: form.elements.statusText.value,
        reasonText: form.elements.reasonText.value,
        version: form.dataset.version ? Number(form.dataset.version) : null
      });
    });
    $('stTagForm').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target;
      write(API + '/sessions/' + state.sessionId + '/codes/' + encodeURIComponent(detail.code) + '/tag', 'PUT', {
        cluster: form.elements.cluster.value,
        isCombo: form.elements.isCombo.checked,
        version: form.dataset.version ? Number(form.dataset.version) : null
      });
    });
    $('stAddLineForm').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      if (form.elements.quantity.value === '') { setDetailError('Cần nhập số lượng.'); return; }
      const ok = await write(API + '/sessions/' + state.sessionId + '/lines', 'POST', {
        productCode: detail.code, team: form.elements.team.value, zone: form.elements.zone.value,
        spec: form.elements.spec.value, quantity: Number(form.elements.quantity.value)
      });
      if (ok) form.reset();
    });
  }

  // ---------- Hộp thoại ----------
  function confirmAction(title, message, okLabel) {
    const dialog = $('stConfirmDialog');
    $('stConfirmTitle').textContent = title;
    $('stConfirmMessage').textContent = message;
    $('stConfirmOk').textContent = okLabel || 'Đồng ý';
    dialog.showModal();
    return new Promise(resolve => {
      const done = value => () => { dialog.close(); cleanup(); resolve(value); };
      const ok = done(true);
      const cancel = done(false);
      const cleanup = () => { $('stConfirmOk').removeEventListener('click', ok); $('stConfirmCancel').removeEventListener('click', cancel); };
      $('stConfirmOk').addEventListener('click', ok);
      $('stConfirmCancel').addEventListener('click', cancel);
    });
  }

  function bindSessions() {
    document.querySelectorAll('[data-st-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
    $('stSession').addEventListener('change', event => {
      state.sessionId = Number(event.target.value);
      state.page = 1;
      loadBoard();
    });
    $('stCreateButton').addEventListener('click', () => {
      const form = $('stCreateForm');
      form.reset();
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      form.elements.dateFrom.value = today;
      form.elements.dateTo.value = today;
      form.elements.branch.value = user && user.branch === 'Sài Gòn' ? 'saigon' : 'hanoi';
      $('stCreateError').textContent = '';
      $('stCreateDialog').showModal();
    });
    $('stCreateForm').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const { response, payload } = await request(API + '/sessions', jsonOptions('POST', {
        name: form.elements.name.value, branch: form.elements.branch.value, dateFrom: form.elements.dateFrom.value, dateTo: form.elements.dateTo.value
      }));
      if (!response.ok) { $('stCreateError').textContent = payload.error || 'Không tạo được đợt.'; return; }
      $('stCreateDialog').close();
      await loadSessions(payload.session.id);
    });
    $('stCloseButton').addEventListener('click', async () => {
      const session = state.board && state.board.session;
      if (!session) return;
      const ok = await confirmAction('Đóng đợt ' + session.name + '?',
        'Web sẽ chụp lại tồn và chênh lệch của mọi mã ngay lúc này. Sau khi đóng, đợt chỉ xem được, không sửa được nữa, và là số "KK trước" cho đợt sau.', 'Đóng đợt');
      if (!ok) return;
      const { response, payload } = await request(API + '/sessions/' + session.id + '/close', jsonOptions('POST', { version: session.version }));
      if (!response.ok) { notify(payload.error || 'Không đóng được đợt.', true); return; }
      notify('Đã đóng đợt ' + session.name + '.');
      await loadSessions(session.id);
    });
    $('stImportButton').addEventListener('click', async () => {
      const ok = await confirmAction('Nạp đợt T10 từ sheet?',
        'Đọc tab KIỂM KÊ HN T10 (chỉ đọc) và lưu thành một đợt đã đóng, làm số "KK trước" cho đợt đầu tiên trên web. Chỉ nạp được một lần.', 'Nạp');
      if (!ok) return;
      notify('Đang đọc sheet…');
      const { response, payload } = await request(API + '/import-sheet', jsonOptions('POST', {}));
      if (!response.ok) { notify(payload.error || 'Không nạp được sheet.', true); return; }
      notify('Đã nạp ' + num(payload.codes) + ' mã (' + num(payload.mismatched) + ' mã lệch).');
      await loadSessions(payload.sessionId);
    });
    $('stExportButton').addEventListener('click', async () => {
      if (!state.board) return;
      const codes = visibleRows().map(row => row.code);
      const response = await fetch(API + '/sessions/' + state.sessionId + '/export', Object.assign({ credentials: 'same-origin' }, jsonOptions('POST', { codes })));
      if (!response.ok) { notify('Không xuất được Excel.', true); return; }
      const blob = await response.blob();
      const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = match ? match[1] : 'kiem-ke.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
  }

  function bindTable() {
    const rerender = () => { state.page = 1; render(); };
    $('stSearch').addEventListener('input', event => { state.query = event.target.value; rerender(); });
    $('stFilter').addEventListener('change', event => { state.filter = event.target.value; rerender(); });
    $('stRecheckFilter').addEventListener('change', event => { state.recheck = event.target.value; rerender(); });
    $('stStatusFilter').addEventListener('change', event => { state.status = event.target.value; rerender(); });
    $('stSort').addEventListener('change', event => { state.sort = event.target.value; rerender(); });
    $('stPrevious').addEventListener('click', () => { state.page -= 1; render(); });
    $('stNext').addEventListener('click', () => { state.page += 1; render(); });
  }

  function syncTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    $('themeToggle').setAttribute('aria-pressed', String(light));
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
    window.TKSNav.renderTopSidebar($('sidebar'), 'stockLocations', user);
    renderHead();
    bindSessions();
    bindTable();
    bindDetail();
    window.addEventListener('pagehide', stopLive);
    try {
      await loadSessions();
    } catch (error) {
      $('stStatus').textContent = error.message;
      $('stStatus').dataset.error = 'true';
    }
  }

  window.TKSStocktake = { init, visibleRows, cellText, state };
})();
