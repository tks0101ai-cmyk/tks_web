/* Trang Kiểm kê (/stocktake/): đối chiếu số đếm đơn TEAM với tồn KiotViet theo đợt.
   Dữ liệu tính ở máy chủ (GET board); trang chỉ lọc / sắp xếp / phân trang và gửi sửa kèm version.
   Người khác sửa -> SSE "stocktake-changed" -> tải lại bảng; lưu với version cũ -> 409 kèm bản mới. */
(function () {
  'use strict';

  const API = '/api/stocktake';
  const PAGE_SIZE = 100;
  const $ = id => document.getElementById(id);
  // Đúng thứ tự tab "KIỂM KÊ HN T10" (A→W); đợt SG đổi nhãn otherDiff/otherRatio.
  const COLUMNS = [
    { key: 'code', label: 'Mã hàng', width: 120, locked: true, type: 'text' },
    { key: 'name', label: 'Tên hàng', width: 240, type: 'text' },
    { key: 'counted', label: 'Tổng kiểm', width: 96, num: true },
    { key: 'stock', label: 'Tồn KIOT', width: 96, num: true },
    { key: 'diffQty', label: 'SL chênh', width: 96, num: true },
    { key: 'diffValue', label: 'Giá trị chênh', width: 120, num: true },
    { key: 'status', label: 'Trạng thái', width: 130, type: 'text' },
    { key: 'reason', label: 'Chi tiết lý do', width: 220, type: 'text' },
    { key: 'printPage', label: 'Trang in', width: 80, type: 'text' },
    { key: 'printTime', label: 'Giờ in', width: 90, type: 'text' },
    { key: 'recheck', label: 'Người kiểm lại', width: 140, type: 'text' },
    { key: 'prevDiff', label: 'KK trước sai', width: 96, num: true },
    { key: 'otherDiff', label: 'Kiểm SG', width: 96, num: true },
    { key: 'cluster', label: 'Cụm SP', width: 140, type: 'text' },
    { key: 'clusterCount', label: 'Count', width: 70, num: true },
    { key: 'clusterDiff', label: 'Chênh cụm', width: 96, num: true },
    { key: 'prevRatio', label: 'Do KK trước', width: 96, num: true, percent: true },
    { key: 'clusterPrevRatio', label: 'Lẫn + KK trước', width: 110, num: true, percent: true },
    { key: 'otherRatio', label: 'Do kiểm SG', width: 96, num: true, percent: true },
    { key: 'forgotten', label: 'Quên KK', width: 80, type: 'flag' },
    { key: 'combo', label: 'Combo', width: 70, type: 'flag' },
    { key: 'position', label: 'Vị trí kho gần nhất', width: 130, type: 'text' },
    { key: 'cost', label: 'Giá vốn', width: 96, num: true },
    { key: 'updated', label: 'Cập nhật', width: 140, type: 'text' }
  ];
  const otherLabel = branch => (branch === 'saigon' ? 'HN' : 'SG');
  const labelOf = (column, branch) => (column.key === 'otherDiff' ? 'Kiểm ' + otherLabel(branch)
    : column.key === 'otherRatio' ? 'Do kiểm ' + otherLabel(branch) : column.label);

  const state = {
    sessions: [], sessionId: null, board: null, canEdit: false, canClose: false,
    query: '', filter: 'mismatch', recheck: '', status: '', sortKey: null, sortDir: null, headBranch: null, page: 1, loadVersion: 0
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
  const pct = value => (value === null || value === undefined ? '' : Math.round(value * 100) + '%');
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
    const imported = branch => state.sessions.some(s => s.source === 'sheet_import' && s.branch === branch);
    $('stImportT10Button').hidden = !state.canClose || imported('hanoi');
    $('stImportSgButton').hidden = !state.canClose || imported('saigon');
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

  // Giá trị để sort: số -> number, chữ -> chuỗi, đánh dấu -> 1/0; ô trống -> null (luôn nằm cuối).
  function sortValue(row, column) {
    const note = row.note || {};
    switch (column.key) {
      case 'name': return row.name || null;
      case 'status': return note.statusText || null;
      case 'reason': return note.reasonText || null;
      case 'printPage': return note.printPage || null;
      case 'printTime': return note.printTime || null;
      case 'recheck': return recheckLabel(row.note) || null;
      case 'cluster': return row.cluster || null;
      case 'position': return row.latestPosition ? row.latestPosition.location || null : null;
      case 'updated': return note.updatedAt || null;
      case 'forgotten': return row.forgotten ? 1 : 0;
      case 'combo': return row.isCombo ? 1 : 0;
      default: {
        const value = row[column.key];
        return value === null || value === undefined ? null : value;
      }
    }
  }
  const byDefault = (a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue) || a.code.localeCompare(b.code);
  function sortRows(rows) {
    const column = COLUMNS.find(c => c.key === state.sortKey);
    if (!column || !state.sortDir) return rows.sort(byDefault);
    const factor = state.sortDir === 'desc' ? -1 : 1;
    // Đánh dấu (Quên KK, Combo): "tăng" = có trước.
    const flagFactor = column.type === 'flag' ? -1 : 1;
    return rows.sort((a, b) => {
      const x = sortValue(a, column);
      const y = sortValue(b, column);
      if (x === null || y === null) return x === y ? a.code.localeCompare(b.code) : x === null ? 1 : -1;
      const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi');
      return diff * factor * flagFactor || a.code.localeCompare(b.code);
    });
  }

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
    return sortRows(rows);
  }

  function cellText(row, key) {
    const note = row.note || {};
    switch (key) {
      case 'code': return row.code;
      case 'name': return row.name || (row.inKiot ? '' : '(không có trên KiotViet)');
      case 'position': return row.latestPosition ? row.latestPosition.location : '';
      case 'printPage': return note.printPage || '';
      case 'printTime': return note.printTime || '';
      case 'otherDiff': return num(row.otherDiff);
      case 'clusterCount': return num(row.clusterCount);
      case 'prevRatio': return pct(row.prevRatio);
      case 'clusterPrevRatio': return pct(row.clusterPrevRatio);
      case 'otherRatio': return pct(row.otherRatio);
      case 'forgotten': return row.forgotten ? 'Quên' : '';
      case 'cost': return num(row.cost);
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

  function renderHead(branch) {
    state.headBranch = branch || 'hanoi';
    const tr = document.querySelector('#stTable thead tr');
    tr.textContent = '';
    for (const column of COLUMNS) {
      const th = document.createElement('th');
      th.dataset.field = column.key;
      if (column.num) th.className = 'num';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.dataset.stSort = column.key;
      const label = document.createElement('span');
      label.className = 'sort-label';
      label.textContent = labelOf(column, state.headBranch);
      const mark = document.createElement('span');
      mark.className = 'sort-indicator';
      mark.setAttribute('aria-hidden', 'true');
      button.append(label, mark);
      th.appendChild(button);
      tr.appendChild(th);
    }
    syncSortHeader();
    if (window.TKSTables) {
      window.TKSTables.enhance($('stTable'), {
        key: 'stocktake-board-v2', button: $('stColumnsButton'), sort: false,
        columns: COLUMNS.map(c => ({ key: c.key, label: labelOf(c, state.headBranch), width: c.width, locked: !!c.locked, hidden: c.key === 'updated' }))
      });
    }
  }
  function syncSortHeader() {
    document.querySelectorAll('#stTable thead th').forEach(th => {
      const on = th.dataset.field === state.sortKey && state.sortDir;
      th.setAttribute('aria-sort', on ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
      const mark = th.querySelector('.sort-indicator');
      if (mark) mark.textContent = on ? (state.sortDir === 'asc' ? '▼' : '▲') : '▲▼';
    });
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
    if (session && session.branch !== state.headBranch) renderHead(session.branch);
    $('stSessionMeta').textContent = session
      ? dateVn(session.dateFrom) + (session.dateTo !== session.dateFrom ? ' – ' + dateVn(session.dateTo) : '')
        + (session.status === 'closed' ? ' · Đóng bởi ' + (session.closedByName || '—') + ' ' + time(session.closedAt) : ' · Tồn theo KiotViet hiện tại')
      : '';
    $('stCloseButton').hidden = !(session && session.status === 'open' && state.canClose);
    $('stCreateButton').hidden = !state.canEdit;
    const counterpartField = $('stCounterpartField');
    counterpartField.hidden = !session;
    if (session) {
      fillCounterpartSelect($('stCounterpart'), session.branch, session.counterpartSessionId);
      $('stCounterpart').disabled = !(state.canEdit && session.status === 'open');
    }
    $('stPasteButton').hidden = !(session && session.status === 'open' && state.canEdit);
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
        if ((column.key === 'prevDiff' && row.prevDiffManual) || (column.key === 'otherDiff' && row.otherDiffManual)) {
          td.classList.add('st-manual');
          const auto = column.key === 'prevDiff' ? row.prevDiffAuto : row.otherDiffAuto;
          td.title = 'Số dán tay · web tự lấy: ' + (auto === null || auto === undefined ? 'trống' : num(auto));
        }
        if (['diffQty', 'diffValue', 'clusterDiff', 'prevDiff', 'otherDiff'].includes(column.key) && row[column.key]) {
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

  // Đợt cơ sở kia có khoảng ngày giao nhau; không có thì đợt có ngày cuối gần ngày bắt đầu nhất.
  function suggestCounterpart(branch, dateFrom, dateTo) {
    const others = state.sessions.filter(s => s.branch !== branch);
    const overlap = others.find(s => s.dateFrom <= dateTo && s.dateTo >= dateFrom);
    if (overlap) return overlap;
    const gap = s => Math.abs(Date.parse(s.dateTo) - Date.parse(dateFrom));
    return others.slice().sort((a, b) => gap(a) - gap(b))[0] || null;
  }
  function fillCounterpartSelect(select, branch, selected) {
    fillSelect(select, '— Không —', state.sessions.filter(s => s.branch !== branch)
      .map(s => [String(s.id), s.name + ' · ' + (s.branch === 'hanoi' ? 'HN' : 'SG')]), selected ? String(selected) : '');
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
    noteForm.elements.printPage.value = note.printPage || '';
    noteForm.elements.printTime.value = note.printTime || '';
    noteForm.elements.prevDiffManual.value = note.prevDiffManual === null || note.prevDiffManual === undefined ? '' : String(note.prevDiffManual);
    noteForm.elements.otherDiffManual.value = note.otherDiffManual === null || note.otherDiffManual === undefined ? '' : String(note.otherDiffManual);
    $('stOtherManualLabel').textContent = 'Kiểm ' + otherLabel(state.board.session.branch) + ' (dán tay)';
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
      ['KK trước sai', row.prevDiff === null ? '—' : num(row.prevDiff)],
      ['Kiểm ' + otherLabel(state.board.session.branch), row.otherDiff === null ? '—' : num(row.otherDiff)]
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

  const ACTION_LABELS = { line_edit: 'Sửa dòng đếm', line_add: 'Thêm dòng', note: 'Kiểm lại', tag: 'Cụm / Combo', session_close: 'Đóng đợt', sheet_import: 'Nạp từ sheet', paste: 'Dán cột', session_update: 'Đổi đối chiếu' };
  function historyText(item) {
    const after = item.after || {};
    if (item.action === 'note') return [recheckLabel(after), after.statusText, after.reasonText, after.printPage && 'Trang ' + after.printPage].filter(Boolean).join(' · ');
    if (item.action === 'paste') return 'Dán cột ' + ((window.TKSStocktakePaste.PASTE_COLUMNS[after.column] || {}).label || after.column);
    if (item.action === 'session_update') return 'Đổi đợt đối chiếu';
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
        printPage: form.elements.printPage.value,
        printTime: form.elements.printTime.value,
        prevDiffManual: form.elements.prevDiffManual.value.trim() === '' ? null : form.elements.prevDiffManual.value,
        otherDiffManual: form.elements.otherDiffManual.value.trim() === '' ? null : form.elements.otherDiffManual.value,
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
    const createForm = $('stCreateForm');
    const refill = () => {
      const s = suggestCounterpart(createForm.elements.branch.value, createForm.elements.dateFrom.value, createForm.elements.dateTo.value);
      fillCounterpartSelect(createForm.elements.counterpartSessionId, createForm.elements.branch.value, s && s.id);
    };
    ['branch', 'dateFrom', 'dateTo'].forEach(name => createForm.elements[name].addEventListener('change', refill));
    $('stCreateButton').addEventListener('click', () => {
      const form = $('stCreateForm');
      form.reset();
      const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
      form.elements.dateFrom.value = today;
      form.elements.dateTo.value = today;
      form.elements.branch.value = user && user.branch === 'Sài Gòn' ? 'saigon' : 'hanoi';
      $('stCreateError').textContent = '';
      refill();
      $('stCreateDialog').showModal();
    });
    $('stCreateForm').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.target;
      const { response, payload } = await request(API + '/sessions', jsonOptions('POST', {
        name: form.elements.name.value, branch: form.elements.branch.value, dateFrom: form.elements.dateFrom.value, dateTo: form.elements.dateTo.value,
        counterpartSessionId: form.elements.counterpartSessionId.value ? Number(form.elements.counterpartSessionId.value) : null
      }));
      if (!response.ok) { $('stCreateError').textContent = payload.error || 'Không tạo được đợt.'; return; }
      $('stCreateDialog').close();
      await loadSessions(payload.session.id);
    });
    $('stCloseButton').addEventListener('click', async () => {
      const session = state.board && state.board.session;
      if (!session) return;
      const ok = await confirmAction('Đóng đợt ' + session.name + '?',
        'Web sẽ chụp lại tồn và chênh lệch của mọi mã ngay lúc này. Sau khi đóng, đợt chỉ xem được, không sửa được nữa, và là số "KK trước" cho đợt sau và số "Kiểm ' + otherLabel(session.branch) + '" của đợt đối chiếu.', 'Đóng đợt');
      if (!ok) return;
      const { response, payload } = await request(API + '/sessions/' + session.id + '/close', jsonOptions('POST', { version: session.version }));
      if (!response.ok) { notify(payload.error || 'Không đóng được đợt.', true); return; }
      notify('Đã đóng đợt ' + session.name + '.');
      await loadSessions(session.id);
    });
    $('stCounterpart').addEventListener('change', async event => {
      const session = state.board && state.board.session;
      if (!session) return;
      const { response, payload } = await request(API + '/sessions/' + session.id, jsonOptions('PATCH', {
        counterpartSessionId: event.target.value ? Number(event.target.value) : null, version: session.version
      }));
      if (!response.ok) { notify(payload.error || 'Không đổi được đợt đối chiếu.', true); }
      await loadSessions(session.id);
    });
    const importSheet = (source, title, message) => async () => {
      if (!(await confirmAction(title, message, 'Nạp'))) return;
      notify('Đang đọc sheet…');
      const { response, payload } = await request(API + '/import-sheet', jsonOptions('POST', { source }));
      if (!response.ok) { notify(payload.error || 'Không nạp được sheet.', true); return; }
      notify('Đã nạp ' + num(payload.codes) + ' mã (' + num(payload.mismatched) + ' mã lệch).');
      await loadSessions(payload.sessionId);
    };
    $('stImportT10Button').addEventListener('click', importSheet('t10', 'Nạp đợt T10 Hà Nội từ sheet?',
      'Đọc tab KIỂM KÊ HN T10 (chỉ đọc) và lưu thành một đợt đã đóng. Chỉ nạp được một lần.'));
    $('stImportSgButton').addEventListener('click', importSheet('sg', 'Nạp KIỂM SG từ sheet?',
      'Đọc tab KIỂM SG (chỉ đọc) và lưu thành một đợt Sài Gòn đã đóng, tự đối chiếu với đợt T10 Hà Nội. Chỉ nạp được một lần.'));
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
    // Bấm tiêu đề: tăng -> giảm -> mặc định (giá trị chênh lớn trước). Sort toàn bộ dòng đã lọc rồi mới chia trang.
    document.querySelector('#stTable thead').addEventListener('click', event => {
      const button = event.target.closest('[data-st-sort]');
      if (!button || event.target.closest('.tks-column-resizer')) return;
      const key = button.dataset.stSort;
      if (state.sortKey !== key) { state.sortKey = key; state.sortDir = 'asc'; }
      else if (state.sortDir === 'asc') state.sortDir = 'desc';
      else { state.sortKey = null; state.sortDir = null; }
      syncSortHeader();
      rerender();
    });
    $('stPrevious').addEventListener('click', () => { state.page -= 1; render(); });
    $('stNext').addEventListener('click', () => { state.page += 1; render(); });
  }

  // ---------- Dán cột ----------
  const paste = { rows: [], plan: null };
  function pasteColumnLabel(key) {
    const spec = window.TKSStocktakePaste.PASTE_COLUMNS[key];
    return key === 'otherDiffManual' ? 'Kiểm ' + otherLabel(state.board.session.branch) : spec.label;
  }
  // Giá trị hiện tại của cột trên một dòng, cùng kiểu với normalizeValue để so "sẽ đổi".
  function currentValue(row, column) {
    const note = row.note || {};
    switch (column) {
      case 'recheck': return recheckLabel(row.note);
      case 'cluster': return row.cluster || '';
      case 'combo': return !!row.isCombo;
      case 'prevDiffManual': case 'otherDiffManual': return note[column] === undefined ? null : note[column];
      default: return note[column] || '';
    }
  }
  function previewPaste() {
    const lib = window.TKSStocktakePaste;
    const form = $('stPasteForm');
    const column = form.elements.column.value;
    const mode = form.elements.mode.value;
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    const { rows, duplicates } = lib.parsePasteText(form.elements.text.value, { isKnownCode: code => byCode.has(code), column });
    const plan = { send: [], matched: 0, notFound: [], changed: 0, invalid: 0, empty: 0, duplicates };
    for (const item of rows) {
      const row = byCode.get(item.code);
      if (!row) { plan.notFound.push(item.code); plan.send.push(item); continue; } // server trả notFound nếu mã không có trên KiotViet
      plan.matched += 1;
      const parsed = lib.normalizeValue(column, item.value);
      if (!parsed.ok) { plan.invalid += 1; continue; }
      if (parsed.empty && mode === 'skip') { plan.empty += 1; continue; }
      const before = currentValue(row, column);
      const same = column === 'recheck' ? lib.foldName(before) === lib.foldName(parsed.value) : before === parsed.value;
      if (!same) plan.changed += 1;
      plan.send.push(item);
    }
    paste.plan = plan;
    const lines = [
      num(plan.matched) + ' mã khớp với đợt · ' + num(plan.changed) + ' ô sẽ đổi',
      plan.invalid ? num(plan.invalid) + ' ô không hợp lệ (bỏ qua)' : '',
      plan.empty ? num(plan.empty) + ' ô trống (bỏ qua)' : '',
      plan.duplicates ? num(plan.duplicates) + ' mã lặp (lấy dòng cuối)' : '',
      plan.notFound.length ? num(plan.notFound.length) + ' mã không có trong đợt: ' + plan.notFound.slice(0, 20).join(', ') + (plan.notFound.length > 20 ? '…' : '') : ''
    ].filter(Boolean);
    const box = $('stPastePreview');
    box.textContent = '';
    for (const text of lines) { const p = document.createElement('p'); p.textContent = text; box.appendChild(p); }
    $('stPasteSave').disabled = !plan.send.length || (!plan.changed && !plan.notFound.length);
  }
  function bindPaste() {
    $('stPasteButton').addEventListener('click', () => {
      const form = $('stPasteForm');
      form.reset();
      const select = form.elements.column;
      select.textContent = '';
      for (const key of Object.keys(window.TKSStocktakePaste.PASTE_COLUMNS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = pasteColumnLabel(key);
        select.appendChild(option);
      }
      paste.plan = null;
      $('stPasteError').textContent = '';
      $('stPastePreview').textContent = '';
      $('stPasteSave').disabled = true;
      $('stPasteDialog').showModal();
    });
    $('stPasteForm').addEventListener('input', previewPaste);
    $('stPasteForm').addEventListener('change', previewPaste);
    $('stPasteForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (!paste.plan || !paste.plan.send.length) return;
      const form = event.target;
      $('stPasteSave').disabled = true;
      const { response, payload } = await request(API + '/sessions/' + state.sessionId + '/paste', jsonOptions('POST', {
        column: form.elements.column.value, mode: form.elements.mode.value, rows: paste.plan.send
      }));
      if (!response.ok) { $('stPasteError').textContent = payload.error || 'Không lưu được.'; $('stPasteSave').disabled = false; return; }
      $('stPasteDialog').close();
      const s = payload.skipped || {};
      notify('Đã dán ' + num(payload.changed) + ' ô' + (s.notFound ? ' · ' + num(s.notFound) + ' mã không có' : '') + (s.invalid ? ' · ' + num(s.invalid) + ' ô sai' : '')
        + (s.duplicates ? ' · ' + num(s.duplicates) + ' mã lặp' : '') + '.');
      await loadBoard({ background: true, forms: true });
    });
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
    renderHead('hanoi');
    bindSessions();
    bindTable();
    bindDetail();
    bindPaste();
    window.addEventListener('pagehide', stopLive);
    try {
      await loadSessions();
    } catch (error) {
      $('stStatus').textContent = error.message;
      $('stStatus').dataset.error = 'true';
    }
  }

  window.TKSStocktake = { init, visibleRows, cellText, sortRows, state };
})();
