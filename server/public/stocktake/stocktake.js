/* Trang Kiểm kê (/stocktake/): đối chiếu số đếm đơn TEAM với tồn KiotViet theo đợt.
   Dữ liệu tính ở máy chủ (GET board); trang chỉ lọc / sắp xếp / vẽ dần khi cuộn và gửi sửa kèm version.
   Người khác sửa -> SSE "stocktake-changed" -> tải lại bảng; lưu với version cũ -> 409 kèm bản mới. */
(function () {
  'use strict';

  const API = '/api/stocktake';
  // Danh sách liền mạch: vẽ từng đoạn CHUNK dòng khi cuộn gần cuối (4.000 mã × 24 cột vẽ một lần sẽ giật).
  const CHUNK = 200;
  const $ = id => document.getElementById(id);
  // Đúng thứ tự tab "KIỂM KÊ HN T10" (A→W); đợt SG đổi nhãn otherDiff/otherRatio.
  // Độ rộng gọn để cả bảng vừa một màn hình 1920px (khung ~1590px, không cần thanh cuộn ngang): đo từ dữ liệu T10 thật,
  // cột số đủ cho 99% giá trị của 4 đợt thật (Giá trị chênh, Giá vốn đủ cả số lớn nhất; số hiếm dài hơn thì "…"), cột chữ xuống dòng.
  const COLUMNS = [
    { key: 'code', label: 'Mã hàng', width: 100, locked: true, type: 'text' },
    { key: 'name', label: 'Tên hàng', width: 108, type: 'text' },
    { key: 'counted', label: 'Tổng kiểm', width: 70, num: true },
    { key: 'stock', label: 'Tồn KIOT', width: 70, num: true },
    { key: 'diffQty', label: 'SL chênh', width: 80, num: true },
    { key: 'diffValue', label: 'Giá trị chênh', width: 106, num: true },
    { key: 'status', label: 'Trạng thái', width: 72, type: 'text' },
    { key: 'reason', label: 'Chi tiết lý do', width: 104, type: 'text' },
    { key: 'printPage', label: 'Trang in', width: 48, type: 'text' },
    { key: 'printTime', label: 'Giờ in', width: 54, type: 'text' },
    { key: 'recheck', label: 'Người kiểm lại', width: 64, type: 'text' },
    { key: 'prevDiff', label: 'KK trước sai', width: 64, num: true },
    { key: 'otherDiff', label: 'Kiểm SG', width: 72, num: true },
    { key: 'cluster', label: 'Cụm SP', width: 68, type: 'text' },
    { key: 'clusterCount', label: 'Count', width: 44, num: true },
    { key: 'clusterDiff', label: 'Chênh cụm', width: 80, num: true },
    { key: 'prevRatio', label: 'Do KK trước', width: 70, num: true, percent: true },
    { key: 'clusterPrevRatio', label: 'Lẫn + KK trước', width: 66, num: true, percent: true },
    { key: 'otherRatio', label: 'Do kiểm SG', width: 76, num: true, percent: true },
    { key: 'forgotten', label: 'Quên KK', width: 54, type: 'flag' },
    { key: 'combo', label: 'Combo', width: 48, type: 'flag' },
    { key: 'cost', label: 'Giá vốn', width: 80, num: true },
    { key: 'updated', label: 'Cập nhật', width: 120, type: 'text' }
  ];
  const Search = window.TKSStocktakeSearch;
  // Chi muc tim kiem dung lai cho den khi bang tai lai (4.000 ma x Fuse, khong lap lai moi lan go).
  const finder = { board: null, index: null };
  function searchIndex() {
    if (finder.board !== state.board) {
      finder.board = state.board;
      finder.index = Search.buildIndex(state.board.rows.map(row => ({
        row, code: row.code, name: row.name,
        extra: [row.cluster, row.note && row.note.statusText, row.note && row.note.reasonText].filter(Boolean).join(' ')
      })), { Fuse: window.Fuse });
    }
    return finder.index;
  }
  const Grid = window.TKSStocktakeGrid;
  const Paste = window.TKSStocktakePaste;
  const Status = window.TKSStocktakeStatus;
  const MAX_CELLS = 10000;
  const UNDO_LIMIT = 50;
  // O nhap dang mo (de len 1 o) va cac buoc hoan tac cua chinh minh (chi trong bo nho trang).
  const editor = { input: null };
  const undoStack = [];
  const otherLabel = branch => (branch === 'saigon' ? 'HN' : 'SG');
  const labelOf = (column, branch) => (column.key === 'otherDiff' ? 'Kiểm ' + otherLabel(branch)
    : column.key === 'otherRatio' ? 'Do kiểm ' + otherLabel(branch) : column.label);

  const state = {
    sessions: [], sessionId: null, board: null, canEdit: false, canClose: false,
    query: '', filter: 'all', recheck: '', status: '', sortKey: null, sortDir: null, headBranch: null, loadVersion: 0
  };
  // view.rows: các dòng đã lọc + sort; view.drawn: số dòng đã vẽ.
  // view.order: ma theo thu tu dang hien; tai nen (sau luu / SSE) giu nguyen thu tu nay de dong vua sua khong nhay cho.
  const view = { rows: [], drawn: 0, observer: null, order: null };
  // Lan tim gan nhat chi ra ma gan giong (khong co ma khop dung) -> bao duoi thanh cong cu.
  let searchFuzzy = false;
  // Vùng chọn kiểu sheet: chỉ số dòng trong view.rows và chỉ số cột trong COLUMNS.
  const selection = { anchor: null, focus: null, dragging: false, painted: [] };
  const live = { source: null, timer: null };
  const detail = { code: null };
  let user = null;

  // Số kiểu sheet kiểm kê: phẩy ngăn hàng nghìn, chấm thập phân (163,200 · 1.5).
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
  const num = value => (value === null || value === undefined ? '' : fmt.format(value));
  // Tiền (giá vốn, giá trị chênh): làm tròn đồng — số lẻ thập phân từ công thức sheet chỉ làm cột rộng ra.
  const fmtMoney = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = value => (value === null || value === undefined ? '' : fmtMoney.format(Math.round(value)));
  // "HH:mm dd/MM" theo giờ VN (cố định +7, không phụ thuộc múi giờ máy).
  const time = iso => {
    if (!iso) return '';
    const vn = new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString();
    return vn.slice(11, 16) + ' ' + vn.slice(8, 10) + '/' + vn.slice(5, 7);
  };
  const pct = value => (value === null || value === undefined ? '' : Math.round(value * 100) + '%');
  const dateVn = text => (text ? text.split('-').reverse().join('/') : '');

  async function request(path, options) {
    const response = await fetch(path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    let payload = {};
    try { payload = await response.json(); } catch (error) { /* tệp hoặc rỗng */ }
    return { response, payload };
  }
  // Mã ngẫu nhiên của tab này: gửi kèm mỗi lệnh ghi để tín hiệu "đợt vừa đổi" do chính tab này gây ra không làm tải lại bảng lần nữa.
  const CLIENT_ID = window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : String(Math.random()).slice(2);
  const jsonOptions = (method, body) => ({ method, headers: { 'Content-Type': 'application/json', 'X-Stocktake-Client': CLIENT_ID }, body: JSON.stringify(body) });

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
      render({ keepOrder: background });
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
    source.addEventListener('stocktake-changed', event => {
      let by = '';
      try { by = JSON.parse(event.data).by || ''; } catch (error) { /* tin hieu cu khong co ma */ }
      if (by && by === CLIENT_ID) return; // chinh tab nay vua ghi: da cap nhat tai cho
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

  // Loc theo bo loc truoc; co tu khoa thi xep theo muc khop (tra-cuu-vi-tri), tru khi da bam sort cot.
  function visibleRows() {
    if (!state.board) return [];
    const rows = state.board.rows.filter(row => {
      if (!Grid.matchesFilter(row, state.filter)) return false;
      if (state.recheck && recheckKey(row.note) !== state.recheck) return false;
      if (state.status && Status.classify(row.note ? row.note.statusText : '') !== state.status) return false;
      return true;
    });
    searchFuzzy = false;
    if (!state.query.trim()) return sortRows(rows);
    const allowed = new Set(rows);
    const result = Search.search(searchIndex(), state.query);
    searchFuzzy = result.fuzzy;
    const found = result.rows.filter(row => allowed.has(row));
    return state.sortKey && state.sortDir ? sortRows(found) : found;
  }

  function cellText(row, key) {
    const note = row.note || {};
    switch (key) {
      case 'code': return row.code;
      case 'name': return row.name || (row.inKiot ? '' : '(không có trên KiotViet)');
      case 'printPage': return note.printPage || '';
      case 'printTime': return note.printTime || '';
      case 'otherDiff': return num(row.otherDiff);
      case 'clusterCount': return num(row.clusterCount);
      case 'prevRatio': return pct(row.prevRatio);
      case 'clusterPrevRatio': return pct(row.clusterPrevRatio);
      case 'otherRatio': return pct(row.otherRatio);
      case 'forgotten': return row.forgotten ? 'Quên' : '';
      case 'cost': return money(row.cost);
      case 'counted': return num(row.counted);
      case 'stock': return num(row.stock);
      case 'diffQty': return num(row.diffQty);
      case 'diffValue': return money(row.diffValue);
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
        key: 'stocktake-board-v6', button: $('stColumnsButton'), sort: false,
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

  // The tong theo trang thai: tinh tren toan dot (khong theo tim kiem / loc); bam = loc theo loai, bam lai = bo loc.
  function renderStatusCards(summary) {
    const box = $('stStatusCards');
    box.textContent = '';
    if (!summary) return;
    const branch = state.board.session.branch;
    for (const [key, total] of summary) {
      const type = Status.STATUS_TYPES.find(t => t.key === key);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'st-status-card';
      button.dataset.statusKey = key;
      if (type) button.style.setProperty('--st-status', type.color);
      button.setAttribute('aria-pressed', String(state.status === key));
      const name = document.createElement('span');
      name.className = 'st-status-name';
      name.textContent = Status.labelFor(key, branch);
      const count = document.createElement('span');
      count.className = 'st-status-count';
      count.textContent = num(total.count) + ' mã';
      const value = document.createElement('b');
      value.textContent = money(total.diffValue);
      if (total.diffValue < 0) value.className = 'st-neg';
      button.append(name, count, value);
      box.appendChild(button);
    }
  }

  // Giu tap dong + thu tu dang hien voi du lieu moi; ma moi them cuoi, ma khong con trong dot bi bo.
  function keptRows() {
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    const known = new Set(view.order);
    const kept = view.order.filter(code => byCode.has(code)).map(code => byCode.get(code));
    return kept.concat(visibleRows().filter(row => !known.has(row.code)));
  }

  function render({ keepOrder = false } = {}) {
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
      fillCounterpartSelect($('stCounterpart'), session.branch, session.counterpartSessionId, board.counterpart);
      $('stCounterpart').disabled = !(state.canEdit && session.status === 'open');
    }
    // Khung trên chỉ giữ tổng giá trị chênh; số mã / mã lệch / quên KK xem ở bảng và bộ lọc.
    renderStats($('stStats'), board ? [
      ['Tổng chênh', money(board.totals.diffValue), board.totals.diffValue < 0 ? 'bad' : '']
    ] : []);
    const summary = board ? Status.summarize(board.rows) : null;
    renderFilters(summary);
    renderStatusCards(summary);
    renderRecheck();

    // Tải nền (SSE / sau khi lưu) giữ số dòng đã vẽ và vùng chọn để không nhảy về đầu bảng.
    const keepDrawn = view.drawn;
    view.rows = keepOrder && view.order && board ? keptRows() : visibleRows();
    view.order = view.rows.map(row => row.code);
    view.drawn = 0;
    $('stRows').textContent = '';
    drawMore(Math.max(CHUNK, keepDrawn));
    paintSelection();
    if (board && !view.rows.length) $('stStatus').textContent = 'Không có mã nào khớp bộ lọc.';
    else if (board && searchFuzzy && $('stStatus').dataset.error !== 'true') { $('stStatus').textContent = 'Không có mã khớp đúng, đang hiện mã gần giống.'; $('stStatus').dataset.error = 'false'; }
    else if (board && $('stStatus').dataset.error !== 'true') $('stStatus').textContent = '';
    $('stCount').textContent = board ? num(view.rows.length) + ' mã' : '';
  }

  function rowElement(row, index) {
    const tr = document.createElement('tr');
    tr.dataset.code = row.code;
    tr.dataset.index = String(index);
    COLUMNS.forEach((column, col) => {
      const td = document.createElement('td');
      td.dataset.field = column.key;
      td.dataset.col = String(col);
      if (column.num) td.className = 'num';
      if (Grid.EDIT_COLUMNS[column.key]) td.dataset.editable = '';
      td.textContent = cellText(row, column.key);
      if ((column.key === 'prevDiff' && row.prevDiffManual) || (column.key === 'otherDiff' && row.otherDiffManual)) {
        td.classList.add('st-manual');
        const auto = column.key === 'prevDiff' ? row.prevDiffAuto : row.otherDiffAuto;
        td.title = 'Số dán tay · web tự lấy: ' + (auto === null || auto === undefined ? 'trống' : num(auto));
      }
      if (['diffQty', 'diffValue', 'clusterDiff', 'prevDiff', 'otherDiff'].includes(column.key) && row[column.key]) {
        td.classList.add(row[column.key] < 0 ? 'st-neg' : 'st-pos');
      }
      if (column.key === 'status') {
        // Mau theo loai trang thai (chu cu T10 cung xep loai); Chua XL / Khac khong to.
        const color = Status.colorOf(row.note ? row.note.statusText : '');
        if (color) {
          td.dataset.status = Status.classify(row.note.statusText);
          td.style.setProperty('--st-status', color);
        }
      }
      tr.appendChild(td);
    });
    return tr;
  }

  // Vẽ thêm count dòng; còn dòng thì gắn ô canh cuối để vẽ tiếp khi cuộn tới.
  function drawMore(count) {
    const tbody = $('stRows');
    const old = tbody.querySelector('.st-sentinel');
    if (old) old.remove();
    const fragment = document.createDocumentFragment();
    const end = Math.min(view.rows.length, view.drawn + count);
    for (let index = view.drawn; index < end; index++) fragment.appendChild(rowElement(view.rows[index], index));
    view.drawn = end;
    tbody.appendChild(fragment);
    if (view.drawn < view.rows.length) {
      const sentinel = document.createElement('tr');
      sentinel.className = 'st-sentinel';
      const td = document.createElement('td');
      td.colSpan = COLUMNS.length;
      td.textContent = 'Đang hiện ' + num(view.drawn) + ' / ' + num(view.rows.length) + ' mã — cuộn xuống để xem tiếp';
      sentinel.appendChild(td);
      tbody.appendChild(sentinel);
      watchSentinel(sentinel);
    }
    if (window.TKSTables) window.TKSTables.refresh($('stTable'));
    paintSelection();
  }

  function watchSentinel(sentinel) {
    if (typeof window.IntersectionObserver !== 'function') return;
    if (!view.observer) {
      view.observer = new window.IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) drawMore(CHUNK);
      }, { root: document.querySelector('.st-scroll'), rootMargin: '600px 0px' });
    }
    view.observer.disconnect();
    view.observer.observe(sentinel);
  }

  // Đổi bộ lọc / sort / đợt: vẽ lại từ đầu, bỏ vùng chọn, cuộn về đầu bảng.
  function resetView() {
    view.drawn = 0;
    view.order = null;
    selection.anchor = selection.focus = null;
    const scroller = document.querySelector('.st-scroll');
    if (scroller) scroller.scrollTop = 0;
  }

  // ---------- Chọn nhiều ô + copy như sheet ----------
  const cellPos = td => ({ row: Number(td.parentElement.dataset.index), col: Number(td.dataset.col) });
  function selectionRect() {
    if (!selection.anchor || !selection.focus) return null;
    return {
      top: Math.min(selection.anchor.row, selection.focus.row), bottom: Math.max(selection.anchor.row, selection.focus.row),
      left: Math.min(selection.anchor.col, selection.focus.col), right: Math.max(selection.anchor.col, selection.focus.col)
    };
  }
  function paintSelection() {
    for (const td of selection.painted) td.classList.remove('st-sel');
    selection.painted = [];
    const rect = selectionRect();
    if (!rect) { positionFill(); return; }
    const tbody = $('stRows');
    for (let index = rect.top; index <= Math.min(rect.bottom, view.drawn - 1); index++) {
      const tr = tbody.rows[index];
      if (!tr) break;
      for (let col = rect.left; col <= rect.right; col++) {
        const td = tr.cells[col];
        td.classList.add('st-sel');
        selection.painted.push(td);
      }
    }
    positionFill();
    renderSelectionSum(rect);
  }
  // Số của ô cho thanh tổng: chỉ cột số (bỏ cột tỷ lệ %, cộng tỷ lệ không có nghĩa); ô trống / chữ -> null.
  function cellNumber(row, column) {
    if (!column.num || column.percent) return null;
    const value = sortValue(row, column);
    return typeof value === 'number' ? value : null;
  }
  // Thanh tổng kiểu Excel ở góc dưới phải: Tổng · Trung bình · Đếm của vùng đang chọn (từ 2 ô trở lên, bỏ cột ẩn).
  function renderSelectionSum(rect) {
    const bar = $('stSelSum');
    if (!rect || (rect.bottom === rect.top && rect.right === rect.left)) { bar.hidden = true; return; }
    const cols = visibleColumnsIn(rect);
    const cells = [];
    for (let index = rect.top; index <= rect.bottom; index++) {
      const row = view.rows[index];
      if (!row) continue;
      for (const col of cols) cells.push({ text: cellText(row, COLUMNS[col].key), number: cellNumber(row, COLUMNS[col]) });
    }
    if (cells.length < 2) { bar.hidden = true; return; }
    const total = Grid.summarizeCells(cells);
    bar.textContent = '';
    const part = (label, value) => {
      const item = document.createElement('span');
      item.append(label + ': ');
      const b = document.createElement('b');
      b.textContent = value;
      item.appendChild(b);
      bar.appendChild(item);
    };
    if (total.numeric) {
      part('Tổng', num(total.sum));
      part('Trung bình', num(total.average));
    }
    part('Đếm', num(total.count));
    bar.hidden = false;
  }
  // Cột đang hiện (bỏ cột ẩn bằng "Cột hiển thị") trong vùng chọn.
  function visibleColumnsIn(rect) {
    const heads = document.querySelectorAll('#stTable thead th');
    const cols = [];
    for (let col = rect.left; col <= rect.right; col++) {
      if (!heads[col] || getComputedStyle(heads[col]).display !== 'none') cols.push(col);
    }
    return cols;
  }
  // Dán sang Google Sheets: tab giữa các cột, xuống dòng giữa các hàng; ô có tab / xuống dòng đổi thành dấu cách.
  function selectionText() {
    const rect = selectionRect();
    if (!rect) return '';
    const cols = visibleColumnsIn(rect);
    const lines = [];
    for (let index = rect.top; index <= rect.bottom; index++) {
      const row = view.rows[index];
      if (row) lines.push(cols.map(col => cellText(row, COLUMNS[col].key).replace(/[\t\r\n]+/g, ' ')).join('\t'));
    }
    return lines.join('\n');
  }
  function bindSelection() {
    const tbody = $('stRows');
    tbody.addEventListener('mousedown', event => {
      const td = event.target.closest('td[data-col]');
      if (!td || event.button !== 0) return;
      event.preventDefault(); // không bôi đen chữ khi kéo
      if (editor.input) closeEditor(!editor.options); // nhap chu: luu nhu Sheets; danh sach Trang thai: bam ra ngoai = khong luu
      const pos = cellPos(td);
      if (event.shiftKey && selection.anchor) selection.focus = pos;
      else selection.anchor = selection.focus = pos;
      selection.dragging = true;
      document.querySelector('.st-scroll').focus({ preventScroll: true });
      paintSelection();
    });
    tbody.addEventListener('mouseover', event => {
      if (fill.active) {
        const cell = event.target.closest('td[data-col]');
        if (cell) { fill.to = cellPos(cell).row; paintFillPreview(); }
        return;
      }
      if (!selection.dragging) return;
      const td = event.target.closest('td[data-col]');
      if (!td) return;
      const pos = cellPos(td);
      if (selection.focus && pos.row === selection.focus.row && pos.col === selection.focus.col) return;
      selection.focus = pos;
      paintSelection();
    });
    document.addEventListener('mouseup', () => { selection.dragging = false; endFill(); });
    document.addEventListener('mousemove', event => { if (fill.active) fill.lastY = event.clientY; });
    document.addEventListener('copy', event => {
      const active = document.activeElement;
      if (!selectionRect() || (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) || document.querySelector('dialog[open]')) return;
      event.clipboardData.setData('text/plain', selectionText());
      event.preventDefault();
      const rect = selectionRect();
      notify('Đã copy ' + num(rect.bottom - rect.top + 1) + ' dòng × ' + num(visibleColumnsIn(rect).length) + ' cột.');
    });
    // Ctrl+V kieu Sheets: khoi tu o tren-trai vung chon (hoac 1 o dien ca vung), ghi 1 lan /cells.
    document.addEventListener('paste', event => {
      const active = document.activeElement;
      const rect = selectionRect();
      if (editor.input || !rect || (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (!canWrite()) return;
      const block = Grid.parseClipboard(event.clipboardData.getData('text/plain'));
      if (pasteByCode(block, rect)) return;
      const targets = Grid.planPaste(block, rect, { rowCount: view.rows.length, visibleCols: visibleColumnIndexes() });
      if (!targets.length) return;
      if (targets.length > MAX_CELLS) { notify('Tối đa ' + num(MAX_CELLS) + ' ô mỗi lần.', true); return; }
      let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
      for (const t of targets) {
        if (t.row < top) top = t.row;
        if (t.row > bottom) bottom = t.row;
        if (t.col < left) left = t.col;
        if (t.col > right) right = t.col;
      }
      if (bottom >= view.drawn) drawMore(bottom - view.drawn + 1);
      selectRect(top, left, bottom, right);
      writeTargets(targets, 'Đã dán');
    });
    // Phim kieu sheet tren o dang chon. Khong chay khi dang mo o nhap, hop thoai, hoac focus o o nhap khac.
    document.addEventListener('keydown', event => {
      if (editor.input || document.querySelector('dialog[open]')) return;
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(active.tagName)) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
      if (!selection.focus) return;
      if (event.key === 'Escape') { selection.anchor = selection.focus = null; paintSelection(); return; }
      if (ctrl || event.altKey) return;
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (arrows[event.key]) { event.preventDefault(); moveFocus(arrows[event.key][0], arrows[event.key][1], event.shiftKey); return; }
      if (event.key === 'Tab') { event.preventDefault(); moveFocus(0, event.shiftKey ? -1 : 1, false); return; }
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); openEditor(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelectionCells(); return; }
      // Bo go tieng Viet kieu IME (Windows Telex) bao key "Process": mo o nhap rong, de phim roi vao o nhap.
      if (event.key === 'Process' || event.isComposing) { openEditor(''); return; }
      if (event.key.length === 1) { event.preventDefault(); openEditor(event.key); }
    });
    window.addEventListener('resize', positionFill);
  }

  // ---------- Sửa trên bảng ----------
  const editColumnOf = col => (COLUMNS[col] && Grid.EDIT_COLUMNS[COLUMNS[col].key]) || null;
  const cellAt = pos => {
    const tr = pos && $('stRows').rows[pos.row];
    return tr && tr.dataset.code ? tr.cells[pos.col] || null : null;
  };
  const expectedOf = (row, column) => Paste.columnValue(column, row.note, row, employeeName);
  function visibleColumnIndexes() {
    return visibleColumnsIn({ left: 0, right: COLUMNS.length - 1 });
  }
  function canWrite() {
    if (editable()) return true;
    const closed = state.board && state.board.session.status === 'closed';
    notify(closed ? 'Đợt đã đóng, không sửa được.' : 'Bạn không có quyền sửa đợt này.', true);
    return false;
  }
  function selectRect(top, left, bottom, right) {
    selection.anchor = { row: top, col: left };
    selection.focus = { row: bottom, col: right };
    paintSelection();
  }
  // O trong bang nam o vi tri nao trong khung cuon (de dat o nhap / nut keo).
  function boxIn(td) {
    const scroller = document.querySelector('.st-scroll');
    const box = td.getBoundingClientRect();
    const base = scroller.getBoundingClientRect();
    return { scroller, left: box.left - base.left + scroller.scrollLeft, top: box.top - base.top + scroller.scrollTop, width: box.width, height: box.height };
  }

  function cellsMessage(verb, payload, ignored) {
    const s = payload.skipped || {};
    const parts = [verb + ' ' + num(payload.applied.length) + ' ô'];
    const bad = ignored + (s.invalid || 0) + (s.notFound || 0);
    if (bad) parts.push(num(bad) + ' ô bỏ qua (cột không sửa được / giá trị sai)');
    if (payload.conflicts.length) parts.push(num(payload.conflicts.length) + ' ô người khác vừa sửa nên không ghi');
    return parts.join(' · ') + '.';
  }

  // Ghi gia tri moi vao du lieu bang ngay (truoc khi tai lai); note luon la object moi.
  function applyLocally(applied) {
    if (!state.board || !applied.length) return;
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    for (const { code, column, after } of applied) {
      const row = byCode.get(code);
      if (!row) continue;
      if (column === 'cluster') row.cluster = after;
      else if (column === 'combo') row.isCombo = after;
      else if (column === 'recheck') row.note = Object.assign({}, row.note, { recheckEmployeeId: null, recheckName: after });
      else row.note = Object.assign({}, row.note, { [column]: after });
    }
  }

  // Cot lam doi so may chu tinh (Count / Chenh cum / KK truoc sai / Kiem SG-HN va cac ty le): sua cac cot nay thi tai lai bang.
  const DERIVED_COLUMNS = new Set(['cluster', 'combo', 'prevDiffManual', 'otherDiffManual']);
  // Ban ghi may chu vua luu (kem version, nguoi sua): thay vao dong de hop chi tiet / lan sua sau dung version moi.
  function applySavedRecords(payload) {
    finder.board = null; // chi muc tim kiem co chu cum / trang thai / ly do: dung lai khi tim lan sau
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    for (const note of payload.notes || []) {
      const row = byCode.get(note.code);
      if (row) row.note = note;
    }
    for (const tag of payload.tags || []) {
      const row = byCode.get(tag.code);
      if (row) Object.assign(row, { cluster: tag.cluster, isCombo: tag.isCombo, tagVersion: tag.version });
    }
  }

  // Gui /cells: ve lai ngay theo gia tri dang gui, thanh cong thi thay ban ghi may chu tra ve (khong tai lai ca bang,
  // tru cot lam doi so tinh / co xung dot) va day buoc hoan tac (tru khi dang hoan tac).
  async function sendCells(cells, { undo = false } = {}) {
    if (!cells.length) return null;
    if (cells.length > MAX_CELLS) { notify('Tối đa ' + num(MAX_CELLS) + ' ô mỗi lần.', true); return null; }
    const sessionId = state.sessionId;
    // Cap nhat bang ngay theo gia tri dang gui: sua tiep o vua go (khi yeu cau chua ve) van gui dung `expected`.
    applyLocally(cells.map(cell => ({ code: cell.code, column: cell.column, parsed: Paste.normalizeValue(cell.column, cell.value) }))
      .filter(cell => cell.parsed.ok).map(cell => ({ code: cell.code, column: cell.column, after: cell.parsed.value })));
    render({ keepOrder: true });
    let response;
    let payload;
    try {
      ({ response, payload } = await request(API + '/sessions/' + sessionId + '/cells', jsonOptions('POST', { cells })));
    } catch (error) {
      notify('Không lưu được: mất kết nối máy chủ.', true);
      loadBoard({ background: true }); // gia tri tam o tren co the sai: tai lai tu may chu
      return null;
    }
    if (!response.ok) {
      notify(payload.error || 'Không lưu được.', true);
      loadBoard({ background: true });
      return null;
    }
    if (state.sessionId === sessionId) {
      applyLocally(payload.applied);
      applyLocally(payload.conflicts.map(c => ({ code: c.code, column: c.column, after: c.current })));
      applySavedRecords(payload);
    }
    if (!undo && payload.applied.length) {
      undoStack.push({ sessionId, cells: payload.applied });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    if (payload.conflicts.length || payload.applied.some(item => DERIVED_COLUMNS.has(item.column))) await loadBoard({ background: true, forms: true });
    else if (state.sessionId === sessionId) {
      render({ keepOrder: true });
      if (detail.code) renderDetail({ forms: true });
    }
    return payload;
  }

  const statusSkipText = count => 'Bỏ qua ' + num(count) + ' ô trạng thái không thuộc danh sách.';
  // targets: [{ row, col, raw }] theo chi so view.rows / COLUMNS. O cot khong sua duoc / gia tri sai -> bo qua.
  // Cot Trang thai: chu dan / keo -> ten loai chuan theo co so (chu cu "lẫn bình" -> "Lẫn"); khong xep duoc loai thi bo qua.
  // target: { row (chỉ số dòng đang hiện) | rowRef (dòng dữ liệu, dán theo mã), col, raw }. extra: câu báo thêm; warn: báo màu đỏ.
  async function writeTargets(targets, verb, { countIgnored = true, extra = '', warn = false } = {}) {
    const branch = state.board.session.branch;
    const cells = [];
    let ignored = 0;
    let badStatus = 0;
    for (const target of targets) {
      const column = editColumnOf(target.col);
      const row = target.rowRef || view.rows[target.row];
      let raw = target.raw;
      if (column === 'statusText') {
        raw = Status.canonical(raw, branch);
        if (raw === null) { badStatus += 1; continue; }
      }
      if (!column || !row || !Paste.normalizeValue(column, raw).ok) { ignored += 1; continue; }
      cells.push({ code: row.code, column, value: raw, expected: expectedOf(row, column) });
    }
    const tail = extra ? ' ' + extra + '.' : '';
    if (!cells.length) { notify((badStatus ? statusSkipText(badStatus) : 'Không có ô nào sửa được trong vùng này.') + tail, true); return; }
    const payload = await sendCells(cells);
    if (payload) {
      const text = cellsMessage(verb, payload, countIgnored ? ignored : 0) + (badStatus ? ' ' + statusSkipText(badStatus) : '') + tail;
      notify(text, payload.conflicts.length > 0 || badStatus > 0 || warn);
    }
  }

  // Dán theo mã hàng: khối có cột đầu là Mã hàng -> ghi đúng mã (không theo thứ tự dòng), kể cả mã đang bị lọc / tìm ẩn khỏi bảng.
  // Cột giá trị đầu tiên vào cột đang chọn (chọn ô Mã hàng thì vào cột ngay bên phải). Không phải khối theo mã -> false (dán theo vị trí).
  function pasteByCode(block, rect) {
    const visibleCols = visibleColumnIndexes();
    let startIndex = visibleCols.indexOf(rect.left);
    if (startIndex === -1) return false;
    if (COLUMNS[rect.left].key === 'code') startIndex += 1;
    const plan = Grid.planPasteByCode(block, { codes: state.board.rows.map(row => row.code), visibleCols, startIndex });
    if (!plan) return false;
    if (!plan.targets.length) { notify('Không có cột nào bên phải ô đang chọn để dán.', true); return true; }
    if (plan.targets.length > MAX_CELLS) { notify('Tối đa ' + num(MAX_CELLS) + ' ô mỗi lần.', true); return true; }
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    const extra = [num(plan.codes) + ' mã'];
    if (plan.missing.length) extra.push(num(plan.missing.length) + ' mã không có trong đợt: ' + plan.missing.slice(0, 5).join(', ') + (plan.missing.length > 5 ? '…' : ''));
    if (plan.duplicates) extra.push(num(plan.duplicates) + ' dòng trùng mã, lấy dòng dưới cùng');
    writeTargets(plan.targets.map(t => ({ rowRef: byCode.get(t.code), col: t.col, raw: t.raw })), 'Đã dán theo mã hàng', { extra: 'Khớp ' + extra.join(' · '), warn: plan.missing.length > 0 });
    return true;
  }

  async function undo() {
    const step = undoStack.pop();
    if (step && step.sessionId !== state.sessionId) undoStack.length = 0;
    if (!step || step.sessionId !== state.sessionId) { notify('Không còn gì để hoàn tác.'); return; }
    if (!canWrite()) { undoStack.push(step); return; }
    const payload = await sendCells(step.cells.map(cell => ({
      code: cell.code, column: cell.column, value: Paste.rawOf(cell.column, cell.before), expected: cell.after
    })), { undo: true });
    if (payload) {
      let message = cellsMessage('Đã hoàn tác', payload, 0).replace('nên không ghi', 'nên không hoàn tác được');
      const invalid = payload.skipped && payload.skipped.invalid;
      if (invalid) message += ` Không khôi phục được ${num(invalid)} ô (chữ trạng thái cũ không còn hợp lệ) — xem Lịch sử của mã.`;
      notify(message, payload.conflicts.length > 0 || Boolean(invalid));
    } else undoStack.push(step);
  }

  function clearSelectionCells() {
    const rect = selectionRect();
    if (!rect || !canWrite()) return;
    const targets = [];
    for (let row = rect.top; row <= rect.bottom; row++) {
      for (const col of visibleColumnsIn(rect)) if (editColumnOf(col)) targets.push({ row, col, raw: '' });
    }
    writeTargets(targets, 'Đã xóa', { countIgnored: false });
  }

  // Mo o nhap de len o dang chon. initial: ky tu vua go (thay noi dung); khong co = sua noi dung hien tai.
  function openEditor(initial) {
    const pos = selection.focus;
    if (!pos || editor.input || !canWrite()) return;
    const column = editColumnOf(pos.col);
    if (!column) { notify('Cột "' + labelOf(COLUMNS[pos.col], state.headBranch) + '" không sửa được.', true); return; }
    const td = cellAt(pos);
    const row = view.rows[pos.row];
    if (!td || !row) return;
    if (column === 'statusText') { openStatusMenu(td, row, initial); return; }
    const start = cellText(row, COLUMNS[pos.col].key);
    const box = boxIn(td);
    const input = document.createElement('input');
    input.className = 'st-editor';
    input.value = initial === undefined ? start : initial;
    Object.assign(input.style, { left: box.left + 'px', top: box.top + 'px', width: Math.max(box.width, 140) + 'px', height: Math.max(box.height, 30) + 'px' });
    Object.assign(editor, { input, code: row.code, column, start, expected: expectedOf(row, column), sessionId: state.sessionId });
    box.scroller.appendChild(input);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    positionFill();
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); closeEditor(true, [1, 0]); }
      else if (event.key === 'Tab') { event.preventDefault(); closeEditor(true, [0, event.shiftKey ? -1 : 1]); }
      else if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
    });
    input.addEventListener('blur', () => closeEditor(true));
  }

  // O Trang thai: mo danh sach 7 loai (thay o nhap) duoi o. Dung chung `editor` (editor.input = khung danh sach,
  // editor.options = cac lua chon) nen moi cho dang chan khi co o nhap mo cung chan khi danh sach mo.
  function openStatusMenu(td, row, initial) {
    const options = Status.optionsFor(state.board.session.branch);
    const current = Status.classify(row.note ? row.note.statusText : '');
    const box = boxIn(td);
    const list = document.createElement('div');
    list.className = 'st-status-menu';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Chọn trạng thái');
    list.tabIndex = -1;
    options.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'st-status-option';
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);
      item.style.setProperty('--st-status', option.color);
      item.textContent = option.label;
      list.appendChild(item);
    });
    Object.assign(list.style, { left: box.left + 'px', top: box.top + box.height + 'px', minWidth: Math.max(box.width, 140) + 'px' });
    Object.assign(editor, {
      input: list, code: row.code, column: 'statusText', start: (row.note && row.note.statusText) || '',
      expected: expectedOf(row, 'statusText'), sessionId: state.sessionId,
      options, index: Math.max(0, options.findIndex(option => option.key === current)), typed: '', typedAt: 0
    });
    box.scroller.appendChild(list);
    list.focus({ preventScroll: true });
    highlightStatusMenu();
    if (initial) typeInStatusMenu(initial);
    positionFill();
    list.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : editor.options.length - 1;
        editor.index = (editor.index + step) % editor.options.length;
        highlightStatusMenu();
      } else if (event.key === 'Enter') { event.preventDefault(); closeEditor(true, [1, 0]); }
      else if (event.key === 'Tab') { event.preventDefault(); closeEditor(true, [0, event.shiftKey ? -1 : 1]); }
      else if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); typeInStatusMenu(event.key); }
    });
    // mousedown + preventDefault: giu focus o danh sach (khong blur) roi luu lua chon vua bam.
    list.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      const item = event.target.closest('[data-index]');
      if (!item) return;
      editor.index = Number(item.dataset.index);
      closeEditor(true);
    });
    list.addEventListener('blur', () => closeEditor(false));
  }

  function highlightStatusMenu() {
    editor.input.querySelectorAll('[data-index]').forEach(item => {
      const on = Number(item.dataset.index) === editor.index;
      item.setAttribute('aria-selected', String(on));
      if (on) item.scrollIntoView({ block: 'nearest' });
    });
  }

  // Go chu khi danh sach mo: nhay toi lua chon dau tien bat dau bang chuoi da go (go lien trong 800 ms thi noi chuoi).
  function typeInStatusMenu(key) {
    const now = Date.now();
    editor.typed = (now - editor.typedAt < 800 ? editor.typed : '') + key;
    editor.typedAt = now;
    const wanted = Status.fold(editor.typed);
    if (!wanted) return;
    const found = editor.options.findIndex(option => Status.fold(option.label).startsWith(wanted));
    if (found >= 0) { editor.index = found; highlightStatusMenu(); }
  }

  async function closeEditor(save, move) {
    const { input, code, column, start, expected, sessionId, options, index } = editor;
    if (!input) return;
    editor.input = null;
    editor.options = null;
    // Danh sach Trang thai: gia tri = ten loai dang chon ("Chưa XL" = trong).
    const value = options ? (options[index].key === 'pending' ? '' : options[index].label) : input.value;
    input.remove();
    document.querySelector('.st-scroll').focus({ preventScroll: true });
    positionFill();
    if (move) moveFocus(move[0], move[1], false);
    if (!save || value === start || sessionId !== state.sessionId) return;
    const payload = await sendCells([{ code, column, value, expected }]);
    if (!payload) return;
    if (payload.conflicts.length) notify('Người khác vừa sửa ô này — bảng đang hiện giá trị của họ.', true);
    else if (payload.skipped.invalid) notify('Giá trị không hợp lệ cho cột ' + labelOf(COLUMNS.find(c => Grid.EDIT_COLUMNS[c.key] === column), state.headBranch) + '.', true);
  }

  // Doi o chon (mui ten / Enter / Tab); extend = Shift (mo rong vung). Dong chua ve thi ve them.
  function moveFocus(dr, dc, extend) {
    if (!view.rows.length) return;
    const from = selection.focus || { row: 0, col: 0 };
    const row = Math.max(0, Math.min(view.rows.length - 1, from.row + dr));
    const col = dc ? Grid.moveIndex(visibleColumnIndexes(), from.col, dc) : from.col;
    if (row >= view.drawn) drawMore(row - view.drawn + CHUNK);
    selection.focus = { row, col };
    if (!extend || !selection.anchor) selection.anchor = selection.focus;
    paintSelection();
    const td = cellAt(selection.focus);
    if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- Kéo nút góc (fill handle) ----------
  const fill = { handle: null, active: false, rect: null, to: null, painted: [], scrollTimer: null, lastY: 0 };
  function fillHandle() {
    if (!fill.handle) {
      fill.handle = document.createElement('button');
      fill.handle.type = 'button';
      fill.handle.className = 'st-fill';
      fill.handle.hidden = true;
      fill.handle.tabIndex = -1;
      fill.handle.setAttribute('aria-label', 'Kéo để nhân bản giá trị');
      document.querySelector('.st-scroll').appendChild(fill.handle);
      fill.handle.addEventListener('mousedown', startFill);
    }
    return fill.handle;
  }
  function positionFill() {
    const handle = fillHandle();
    const rect = selectionRect();
    const td = rect && cellAt({ row: rect.bottom, col: rect.right });
    const show = Boolean(td && editable() && !editor.input && !fill.active && visibleColumnsIn(rect).some(editColumnOf));
    handle.hidden = !show;
    if (!show) return;
    const box = boxIn(td);
    handle.style.left = box.left + box.width - 5 + 'px';
    handle.style.top = box.top + box.height - 5 + 'px';
  }
  function paintFillPreview() {
    for (const td of fill.painted) td.classList.remove('st-fill-preview');
    fill.painted = [];
    if (fill.to === null) return;
    const cols = visibleColumnsIn(fill.rect);
    for (const target of Grid.planFill(fill.rect, fill.to, cols)) {
      const td = cellAt({ row: target.row, col: target.col });
      if (td) { td.classList.add('st-fill-preview'); fill.painted.push(td); }
    }
  }
  function startFill(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!canWrite()) return;
    // preventDefault chan blur nen tu luu o nhap dang mo truoc khi doc gia tri nguon (sendCells va bang dong bo truoc await).
    if (editor.input) closeEditor(true);
    Object.assign(fill, { active: true, rect: selectionRect(), to: null, lastY: event.clientY });
    fill.handle.hidden = true;
    // Gan mep tren / duoi khung cuon thi tu cuon (dong chua ve se ve khi cuon toi canh).
    const scroller = document.querySelector('.st-scroll');
    fill.scrollTimer = setInterval(() => {
      const box = scroller.getBoundingClientRect();
      if (fill.lastY > box.bottom - 30) scroller.scrollTop += 24;
      else if (fill.lastY < box.top + 50) scroller.scrollTop -= 24;
    }, 50);
  }
  async function endFill() {
    if (!fill.active) return;
    clearInterval(fill.scrollTimer);
    fill.active = false;
    const { rect, to } = fill;
    fill.to = null;
    paintFillPreview();
    if (to === null || (to >= rect.top && to <= rect.bottom)) { positionFill(); return; }
    const cols = visibleColumnsIn(rect);
    // Nguon lay tu gia tri luu (khong phai chu hien thi); 2 cot so chi chep so nhap tay, o dang la so tu dong (null) thi bo qua.
    const targets = [];
    for (const target of Grid.planFill(rect, to, cols)) {
      const column = editColumnOf(target.col);
      if (!column) continue;
      const value = expectedOf(view.rows[target.fromRow], column);
      if ((column === 'prevDiffManual' || column === 'otherDiffManual') && value === null) continue;
      targets.push({ row: target.row, col: target.col, raw: Paste.rawOf(column, value) });
    }
    selectRect(Math.min(rect.top, to), rect.left, Math.max(rect.bottom, to), rect.right);
    if (targets.length) await writeTargets(targets, 'Đã nhân bản', { countIgnored: false });
    else notify('Không có ô nào cần nhân bản.');
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
  function fillCounterpartSelect(select, branch, selected, linked) {
    const label = s => s.name + ' · ' + (s.branch === 'hanoi' ? 'HN' : 'SG');
    const options = state.sessions.filter(s => s.branch !== branch).map(s => [String(s.id), label(s)]);
    // Đợt đối chiếu ngoài phạm vi của người xem: vẫn hiện đúng liên kết thay vì "— Không —".
    if (linked && !options.some(([id]) => id === String(linked.id))) options.push([String(linked.id), label(linked)]);
    fillSelect(select, '— Không —', options, selected ? String(selected) : '');
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

  function renderFilters(summary) {
    const entries = [...recheckCounts()].map(([key, entry]) => [key, entry.label]).sort((a, b) => a[1].localeCompare(b[1]));
    fillSelect($('stRecheckFilter'), 'Mọi người kiểm lại', entries, state.recheck);
    state.recheck = $('stRecheckFilter').value;
    // Loc Trang thai theo loai (dong bo voi the tong); "Khác" chi khi dot co chu khong xep duoc loai.
    const branch = state.board ? state.board.session.branch : 'hanoi';
    const kinds = Status.optionsFor(branch).map(option => [option.key, option.label]);
    if (summary && summary.has(Status.OTHER.key)) kinds.push([Status.OTHER.key, Status.OTHER.label]);
    fillSelect($('stStatusFilter'), 'Mọi trạng thái', kinds, state.status);
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
        resetView();
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

  // Hop chi tiet: 7 loai theo co so ("Chưa XL" = trong); chu cu (khong phai ten chuan) them 1 lua chon dau de luu lai khong doi.
  function fillStatusSelect(select, current) {
    const branch = state.board.session.branch;
    const entries = Status.optionsFor(branch).map(option => [option.key === 'pending' ? '' : option.label, option.label]);
    if (current && !Status.isValid(current, branch)) entries.unshift([current, '‹' + current + '›']);
    select.textContent = '';
    for (const [value, label] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = current;
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
    $('stDetailSubtitle').textContent = row.name || '';
    const canEditNote = editable();
    const noteForm = $('stNoteForm');
    const note = row.note || {};
    // Người kiểm lại gõ tay; gợi ý = nhân sự cùng cơ sở + các tên đã dùng trong đợt (biệt danh như "THÁI KHO").
    noteForm.elements.recheckName.value = recheckLabel(row.note);
    const names = new Set(state.board.employees.filter(e => e.branch === state.board.session.branch).map(e => e.name));
    for (const entry of recheckCounts().values()) names.add(entry.label);
    const list = $('stRecheckSuggestions');
    list.textContent = '';
    for (const name of [...names].filter(Boolean).sort((a, b) => a.localeCompare(b, 'vi'))) {
      const option = document.createElement('option');
      option.value = name;
      list.appendChild(option);
    }
    fillStatusSelect(noteForm.elements.statusText, note.statusText || '');
    noteForm.elements.reasonText.value = note.reasonText || '';
    noteForm.elements.printPage.value = note.printPage || '';
    noteForm.elements.printTime.value = note.printTime || '';
    noteForm.elements.prevDiffManual.value = note.prevDiffManual === null || note.prevDiffManual === undefined ? '' : String(note.prevDiffManual);
    noteForm.elements.otherDiffManual.value = note.otherDiffManual === null || note.otherDiffManual === undefined ? '' : String(note.otherDiffManual);
    // Hai ô này chỉ để GHI ĐÈ số web tự lấy; để trống thì cột trên bảng vẫn tự lấy (gợi ý ghi rõ số đang tự lấy).
    const other = otherLabel(state.board.session.branch);
    const autoText = value => (value === null || value === undefined ? 'trống' : num(value));
    $('stPrevManualLabel').textContent = 'KK trước sai — nhập tay';
    $('stOtherManualLabel').textContent = 'Kiểm ' + other + ' — nhập tay';
    noteForm.elements.prevDiffManual.placeholder = 'Để trống = tự lấy từ đợt trước: ' + autoText(row.prevDiffAuto);
    noteForm.elements.otherDiffManual.placeholder = state.board.counterpart
      ? 'Để trống = tự lấy từ đợt ' + other + ': ' + autoText(row.otherDiffAuto)
      : 'Chưa chọn đợt đối chiếu ' + other + ' — chỉ có số nhập tay';
    noteForm.dataset.version = note.version ? String(note.version) : '';
    $('stNoteMeta').textContent = note.updatedByName ? 'Sửa cuối: ' + note.updatedByName + ' · ' + time(note.updatedAt) : '';
    const reasons = $('stReasonSuggestions');
    reasons.textContent = '';
    for (const value of state.board.suggestions.reason) { const option = document.createElement('option'); option.value = value; reasons.appendChild(option); }
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
      ['SL chênh', num(row.diffQty), row.diffQty ? 'warn' : ''], ['Giá trị chênh', money(row.diffValue), row.diffValue < 0 ? 'bad' : ''],
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
  const actionLabel = item => (item.action === 'paste' && item.after && item.after.source === 'cells' ? 'Sửa trên bảng' : ACTION_LABELS[item.action] || item.action);
  function historyText(item) {
    const after = item.after || {};
    if (item.action === 'note') return [recheckLabel(after), after.statusText, after.reasonText, after.printPage && 'Trang ' + after.printPage].filter(Boolean).join(' · ');
    if (item.action === 'paste') {
      const label = (window.TKSStocktakePaste.PASTE_COLUMNS[after.column] || {}).label || after.column;
      return after.source === 'cells' ? label : 'Dán cột ' + label;
    }
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
      head.textContent = actionLabel(item) + ' — ' + (item.actorName || '—') + ' · ' + time(item.createdAt);
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
    // Nhấp một lần = chọn ô (như sheet); nhấp đúp = mở chi tiết mã.
    $('stRows').addEventListener('dblclick', event => {
      const tr = event.target.closest('tr[data-code]');
      if (tr) openDetail(tr.dataset.code);
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
        recheckName: form.elements.recheckName.value,
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
      if (editor.input) closeEditor(false);
      undoStack.length = 0;
      state.sessionId = Number(event.target.value);
      resetView();
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
    const rerender = () => { resetView(); render(); };
    let searchTimer = null;
    $('stSearch').addEventListener('input', event => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => { state.query = value; rerender(); }, 150);
    });
    $('stFilter').addEventListener('change', event => { state.filter = event.target.value; rerender(); });
    $('stRecheckFilter').addEventListener('change', event => { state.recheck = event.target.value; rerender(); });
    $('stStatusFilter').addEventListener('change', event => { state.status = event.target.value; rerender(); });
    $('stStatusCards').addEventListener('click', event => {
      const card = event.target.closest('[data-status-key]');
      if (!card) return;
      state.status = state.status === card.dataset.statusKey ? '' : card.dataset.statusKey;
      $('stStatusFilter').value = state.status;
      const key = card.dataset.statusKey;
      rerender();
      // The cards are rebuilt on render; give keyboard focus back to the same card.
      const again = $('stStatusCards').querySelector('[data-status-key="' + key + '"]');
      if (again) again.focus({ preventScroll: true });
    });
    // Bấm tiêu đề: tăng -> giảm -> mặc định (giá trị chênh lớn trước). Sort toàn bộ dòng đã lọc rồi mới vẽ.
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
    bindSelection();
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
