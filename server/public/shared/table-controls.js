/* Shared by the dashboard and standalone HTML reports. Choices live in this
   document; stable table/field keys survive DOM replacements. Column widths and
   hidden columns are also saved per account (endpoint me/table-prefs) once the
   saved preferences have loaded, so they outlive the session. */
(function () {
  'use strict';
  if (window.TKSTables) return;
  var sessions = new Map(), controllers = new WeakMap(), buttonControllers = new WeakMap();
  var wiredHandles = new WeakSet();
  var picker = null, active = null, opener = null, drag = null, queued = false;
  var MIN_WIDTH = 64;
  var textContext;
  // Cấu hình đã lưu của tài khoản: { [tableKey]: { [mode]: { columns: { [colKey]: { width?, hidden? } } } } }.
  var storedPrefs = {}, prefsReady = false, saveTimers = new Map();
  // Ghép từ mảnh để file HTML xuất ra (nhúng nguyên mã này) không chứa đường dẫn API nào.
  var PREFS_URL = ['', 'api', 'me', 'table-prefs'].join('/');
  var SAVE_DELAY = 800, MAX_SAVED_COLUMNS = 200, MAX_KEY_LENGTH = 200, MAX_SAVED_WIDTH = 2000;

  function savedColumns(key, mode) {
    var table = storedPrefs[key], prefs = table && table[mode];
    return prefs && prefs.columns && typeof prefs.columns === 'object' ? prefs.columns : {};
  }
  function savedSort(key, mode) {
    var table = storedPrefs[key], prefs = table && table[mode], sort = prefs && prefs.sort;
    return sort && typeof sort.key === 'string' && (sort.dir === 'asc' || sort.dir === 'desc') ? { key: sort.key, dir: sort.dir } : null;
  }
  function savedSorts(key, mode) {
    var prefs = storedPrefs[key] && storedPrefs[key][mode];
    if (prefs && Array.isArray(prefs.sorts)) return prefs.sorts.filter(function (sort) {
      return sort && typeof sort.key === 'string' && (sort.dir === 'asc' || sort.dir === 'desc');
    }).map(function (sort) { return { key: sort.key, dir: sort.dir }; });
    var legacy = savedSort(key, mode);
    return legacy ? [legacy] : [];
  }
  function copyColumns(source) {
    var out = {};
    Object.keys(source).forEach(function (key) { out[key] = Object.assign({}, source[key]); });
    return out;
  }
  function applySaved(session, column) {
    var saved = session.dirty[column.key];
    if (!saved) return;
    if (typeof saved.width === 'number' && saved.width > 0) { column.width = Math.max(column.floor || MIN_WIDTH, saved.width); session.fitted = true; }
    if (typeof saved.hidden === 'boolean') column.hidden = saved.hidden;
  }
  // Ghi nhận lựa chọn của người dùng (không ghi độ rộng tự co giãn) rồi lưu sau một nhịp.
  function remember(ctrl, column, patch) {
    var session = ctrl.session;
    session.dirty[column.key] = Object.assign({}, session.dirty[column.key], patch);
    scheduleSave(session);
  }
  function scheduleSave(session) {
    if (!prefsReady || typeof fetch !== 'function' || session.key.length > MAX_KEY_LENGTH) return;
    clearTimeout(saveTimers.get(session));
    saveTimers.set(session, setTimeout(function () { saveTimers.delete(session); save(session); }, SAVE_DELAY));
  }
  function save(session) {
    var columns = {}, count = 0;
    Object.keys(session.dirty).forEach(function (key) {
      if (key.length > MAX_KEY_LENGTH || count >= MAX_SAVED_COLUMNS) return;
      var item = session.dirty[key], out = {};
      if (typeof item.width === 'number' && isFinite(item.width)) out.width = Math.min(MAX_SAVED_WIDTH, Math.max(24, Math.round(item.width)));
      if (typeof item.hidden === 'boolean') out.hidden = item.hidden;
      if (Object.keys(out).length) { columns[key] = out; count++; }
    });
    var body = { columns: columns };
    if (session.sort && session.sort.key.length <= MAX_KEY_LENGTH) body.sort = { key: session.sort.key, dir: session.sort.dir };
    if (session.sorts && session.sorts.length) body.sorts = session.sorts;
    var url = PREFS_URL + '/' + encodeURIComponent(session.key) + '/' + session.mode;
    try {
      fetch(url, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .catch(function () { /* mất kết nối: bảng vẫn dùng bình thường, lần chỉnh sau sẽ lưu lại */ });
    } catch (_) { /* fetch không dùng được */ }
  }
  // Nạp cấu hình đã lưu; áp ngay cho các bảng đã dựng.
  function loadPrefs(tables) {
    storedPrefs = tables && typeof tables === 'object' ? tables : {};
    prefsReady = true;
    sessions.forEach(function (session) {
      session.dirty = copyColumns(savedColumns(session.key, session.mode));
      session.sort = savedSort(session.key, session.mode);
      session.sorts = savedSorts(session.key, session.mode);
      session.columns.forEach(function (column) { applySaved(session, column); if (column.locked) column.hidden = false; });
    });
    if (window.document && document.body) refreshAll();
  }
  // Common priority stack for locally sorted and server-paginated pages.
  function nextSorts(sorts, key, add) {
    var current = (sorts || []).find(function (sort) { return sort.key === key; });
    var next = add ? (sorts || []).map(function (sort) { return { key: sort.key, dir: sort.dir }; }) : current ? [{ key: key, dir: current.dir }] : [];
    if (!current) next.push({ key: key, dir: 'asc' });
    else if (current.dir === 'asc') next.find(function (sort) { return sort.key === key; }).dir = 'desc';
    else next = next.filter(function (sort) { return sort.key !== key; });
    return next;
  }
  function compareValues(a, b, dir) {
    var emptyA = a === null || a === undefined || a === '' || (typeof a === 'number' && !Number.isFinite(a));
    var emptyB = b === null || b === undefined || b === '' || (typeof b === 'number' && !Number.isFinite(b));
    if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
    var result = typeof a === 'number' && typeof b === 'number' ? a - b
      : String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'base' });
    return result * (dir === 'desc' ? -1 : 1);
  }
  function syncSortHeaders(table, sorts, keyOfHeader) {
    if (!table) return;
    Array.from(table.querySelectorAll('thead th')).forEach(function (th) {
      var key = keyOfHeader ? keyOfHeader(th) : th.dataset.sort || th.dataset.field || th.dataset.columnKey;
      if (key === undefined || key === null) return;
      var index = (sorts || []).findIndex(function (sort) { return sort.key === key; });
      var sort = sorts && sorts[index], button = th.querySelector('.sort-button'), mark = th.querySelector('.sort-indicator');
      if (!button || !mark) return;
      var text = sort ? (sort.dir === 'asc' ? '▲' : '▼') + (index + 1) : '▲▼';
      if (mark.textContent !== text) mark.textContent = text;
      th.setAttribute('aria-sort', index === 0 ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      th.dataset.sortActive = String(!!sort);
      var label = th.querySelector('.sort-label');
      var description = (label ? label.textContent.trim() : key) + (sort ? ', ưu tiên ' + (index + 1) + ', ' + (sort.dir === 'asc' ? 'tăng dần' : 'giảm dần') : '')
        + '. Bấm để sắp xếp; Shift + bấm để thêm hoặc đổi lớp sắp xếp.';
      button.title = description;
      button.setAttribute('aria-label', description);
    });
  }
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line><line x1="15" y1="4" x2="15" y2="20"></line></svg>';

  function screenMode() { return window.innerWidth <= 600 ? 'mobile' : 'desktop'; }
  function labelOf(cell) {
    var copy = cell.cloneNode(true);
    copy.querySelectorAll('.tks-column-resizer,.sort-indicator,.picking-sort-indicator,.sort-ind,.sort,.locations-sort-icon').forEach(function (node) { node.remove(); });
    return copy.textContent.replace(/[↕▲▼↑↓]+$/g, '').replace(/\s+/g, ' ').trim();
  }
  function defaultWidth(key, label, cell) {
    var text = (key + ' ' + label).toLowerCase();
    if (/note|ghi chú|nội dung|lý do|reason/.test(text)) return 280;
    if (/name|tên|khách hàng|customer|employee|nhân viên|sale|mặt hàng|hàng hóa/.test(text) && !/mã|code|id|tiền|doanh|số lượng/.test(text)) return 240;
    if (/quantity|qty|số lượng|(^|\s)sl(\s|$)|tồn kho|khách đặt/.test(text)) return 112;
    // Bảng trong hộp chi tiết: cột số chỉ cần vừa một số tiền, nhường chỗ cho cột tên.
    if (cell && cell.classList.contains('num') && cell.closest('.dp-table')) return 124;
    return 160;
  }
  // Remember the authored spans because visibility changes the DOM colSpan.
  // Build the logical grid independently for each header/body/footer group.
  function grid(section) {
    var occupied = [], entries = [], count = 0;
    if (!section) return { entries: entries, count: count };
    Array.from(section.rows).forEach(function (row, rowIndex) {
      var cursor = 0;
      Array.from(row.cells).forEach(function (cell) {
        if (!cell.dataset.tksColspan) cell.dataset.tksColspan = String(cell.colSpan);
        var span = Number(cell.dataset.tksColspan) || 1;
        while (occupied[cursor] > rowIndex) cursor++;
        var rowSpan = cell.rowSpan || (section.rows.length - rowIndex);
        entries.push({ cell: cell, start: cursor, span: span, row: row });
        for (var i = cursor; i < cursor + span; i++) occupied[i] = rowIndex + rowSpan;
        cursor += span; count = Math.max(count, cursor);
      });
    });
    return { entries: entries, count: count };
  }
  function headers(table) {
    var head = grid(table.tHead), leaves = [];
    for (var i = 0; i < head.count; i++) {
      var candidates = head.entries.filter(function (entry) { return entry.start <= i && entry.start + entry.span > i; });
      leaves.push(candidates.reverse().find(function (entry) { return entry.span === 1; }) || candidates[0]);
    }
    return { grid: head, leaves: leaves };
  }
  function tableKey(table) {
    if (table.dataset.tableKey) return table.dataset.tableKey;
    if (table.id) return table.id;
    var body = table.tBodies[0];
    if (body && body.id) return body.id;
    // Explicit keys on dynamic report tables avoid dependence on row data.
    var host = table.closest('[id]');
    var scope = host || document;
    return (host ? host.id : location.pathname) + ':table:' + Array.from(scope.querySelectorAll('table')).indexOf(table);
  }
  function pxWidth(value) {
    return /^\d+(\.\d+)?(px)?$/.test(String(value || '')) ? Number.parseFloat(value) : 0;
  }
  function changeStyle(node, property, value) {
    if (node.style.getPropertyValue(property) !== value || node.style.getPropertyPriority(property) !== 'important') node.style.setProperty(property, value, 'important');
  }
  function hasLayout(table) {
    return table.isConnected && table.getClientRects().length > 0;
  }
  // Native selects cannot wrap. Keep the longest option, arrow and cell padding
  // readable instead of letting a fixed-layout column shrink underneath them.
  function dropdownMinimums(ctrl) {
    ctrl.columns.forEach(function (column) { column.minWidth = column.floor || MIN_WIDTH; });
    var sections = [ctrl.table.tHead].concat(Array.from(ctrl.table.tBodies), [ctrl.table.tFoot]).filter(Boolean);
    var measured = new Map();
    function horizontalSpace(style) {
      return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(function (sum, key) { return sum + (parseFloat(style[key]) || 0); }, 0);
    }
    sections.forEach(function (section) {
      grid(section).entries.forEach(function (entry) {
        entry.cell.querySelectorAll('select:not([multiple])').forEach(function (select) {
          var style = window.getComputedStyle(select);
          if (select.hidden || style.display === 'none') return;
          if (textContext === undefined) textContext = document.createElement('canvas').getContext('2d');
          if (!textContext) return;
          textContext.font = style.font || [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
          var width = 0, spacing = parseFloat(style.letterSpacing) || 0;
          // Dense editable grids may size closed selects by their current value;
          // the native popup still contains every option. Other tables keep the default.
          var compact = ctrl.table.dataset.tableSelectWidth === 'selected';
          Array.from(compact ? select.selectedOptions : select.options).forEach(function (option) {
            var label = option.label, key = textContext.font + '\u001f' + label;
            if (!measured.has(key)) measured.set(key, textContext.measureText(label).width);
            width = Math.max(width, measured.get(key) + Math.max(0, label.length - 1) * spacing);
          });
          width += horizontalSpace(style) + (style.appearance === 'none' ? (compact ? 0 : 8) : 24);
          for (var parent = select.parentElement; parent; parent = parent.parentElement) {
            width += horizontalSpace(window.getComputedStyle(parent));
            if (parent === entry.cell) break;
          }
          for (var index = entry.start; index < entry.start + entry.span; index++) {
            if (ctrl.columns[index]) ctrl.columns[index].minWidth = Math.max(ctrl.columns[index].minWidth, Math.ceil(width / entry.span));
          }
        });
      });
    });
    ctrl.columns.forEach(function (column) { column.width = Math.max(column.width, column.minWidth); });
  }
  // Bảng trong hộp chi tiết: ô số / mã (td.num, td.dp-code) không bẻ dòng giữa chừng nên cột không được hẹp hơn
  // giá trị dài nhất của nó (kể cả khi co cột cho vừa khung lúc mở hộp hoặc người dùng kéo hẹp).
  function numberMinimums(ctrl) {
    if (!ctrl.table.classList.contains('dp-table')) return;
    if (textContext === undefined) textContext = document.createElement('canvas').getContext('2d');
    if (!textContext || typeof textContext.measureText !== 'function') return;
    var longest = new Map();
    Array.from(ctrl.table.tBodies).forEach(function (section) {
      grid(section).entries.forEach(function (entry) {
        if (entry.span !== 1 || !(entry.cell.classList.contains('num') || entry.cell.classList.contains('dp-code'))) return;
        var text = entry.cell.textContent.trim(), best = longest.get(entry.start);
        if (!best || text.length > best.text.length) longest.set(entry.start, { text: text, cell: best ? best.cell : entry.cell });
      });
    });
    function raise(column, width) {
      column.minWidth = Math.max(column.minWidth || MIN_WIDTH, Math.ceil(width) + 2);
      column.width = Math.max(column.width, column.minWidth);
    }
    function boxSpace(style) {
      return ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce(function (sum, key) { return sum + (parseFloat(style[key]) || 0); }, 0);
    }
    function fontOf(style) { return style.font || [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' '); }
    longest.forEach(function (best, index) {
      var column = ctrl.columns[index]; if (!column || !best.text) return;
      var style = window.getComputedStyle(best.cell);
      textContext.font = fontOf(style);
      raise(column, textContext.measureText(best.text).width + boxSpace(style));
    });
    // Tiêu đề: từ dài nhất của nhãn phải nằm gọn (cộng cột biểu tượng sắp xếp), không bị bẻ từng chữ khi cột hẹp.
    ctrl.head.leaves.forEach(function (entry, index) {
      var column = ctrl.columns[index], words = column && entry.span === 1 ? String(column.label || '').split(/\s+/).filter(Boolean) : [];
      if (!words.length) return;
      var style = window.getComputedStyle(entry.cell), word = words.reduce(function (a, b) { return b.length > a.length ? b : a; });
      if (style.textTransform === 'uppercase') word = word.toUpperCase();
      textContext.font = fontOf(style);
      var gutter = entry.cell.querySelector(':scope > .sort-button') ? 26 : 0; // gap 6 + .sort-indicator 20 (shared.css)
      raise(column, textContext.measureText(word).width + (parseFloat(style.letterSpacing) || 0) * word.length + boxSpace(style) + gutter);
    });
  }
  // Tiêu đề khai báo data-min-width="N": cột không hẹp hơn N px (nhãn/chấm không bẻ dòng được), kể cả độ rộng đã lưu.
  function declaredMinimums(ctrl) {
    ctrl.head.leaves.forEach(function (entry, index) {
      var column = ctrl.columns[index], min = parseFloat(entry.cell.dataset.minWidth);
      if (!column || !(min > 0)) return;
      column.minWidth = Math.max(column.minWidth || MIN_WIDTH, Math.ceil(min));
      column.width = Math.max(column.width, column.minWidth);
    });
  }
  function fitOnce(ctrl) {
    if (ctrl.table.dataset.tableFit === 'off') return;
    if (ctrl.session.fitted || !hasLayout(ctrl.table)) return;
    var wrapper = ctrl.table.parentElement;
    var width = wrapper.clientWidth;
    var visible = ctrl.columns.filter(function (column) { return !column.hidden && !column.suppressed; });
    var total = visible.reduce(function (sum, column) { return sum + column.width; }, 0);
    // Khung rộng hơn tổng các cột: không sửa độ rộng gốc ở đây — apply() đặt min-width:100% nên trình duyệt tự giãn đều
    // các cột đang hiện (ẩn/hiện cột hay đổi cỡ cửa sổ đều giãn lại đúng), còn độ rộng gốc vẫn là số người dùng đã chọn.
    // Bảng trong hộp chi tiết (.dp-table) nằm trong khung hẹp: co đều các cột cho vừa khung ở lần đầu,
    // không để mặc định 160px/cột làm bảng tràn ngang ngay khi mở hộp. Người dùng vẫn kéo rộng sau đó.
    if (width && total > width && (ctrl.table.dataset.tableFit === 'fill' || ctrl.table.classList.contains('dp-table'))) {
      // Cột chạm độ rộng tối thiểu thì giữ ở mức đó, phần thiếu chia cho các cột còn co được — tổng vẫn vừa khung.
      var flexible = visible.slice(), room = width;
      while (flexible.length) {
        var flexTotal = flexible.reduce(function (sum, column) { return sum + column.width; }, 0), scale = room / flexTotal;
        var pinned = flexible.filter(function (column) { return column.width * scale < (column.minWidth || MIN_WIDTH); });
        if (!pinned.length) { flexible.forEach(function (column) { column.width *= scale; }); break; }
        pinned.forEach(function (column) { column.width = column.minWidth || MIN_WIDTH; room -= column.width; });
        flexible = flexible.filter(function (column) { return pinned.indexOf(column) < 0; });
      }
    }
    ctrl.session.fitted = true;
  }
  // Bề rộng nội dung của khung chứa bảng (px) — đúng mốc mà min-width:100% của bảng lấy; 0 khi chưa có bố cục (tab ẩn, jsdom).
  function roomOf(ctrl) {
    var wrapper = ctrl.table.parentElement;
    if (!wrapper || !hasLayout(ctrl.table)) return 0;
    var style = window.getComputedStyle(wrapper);
    return Math.max(0, wrapper.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0));
  }
  // Độ rộng đang THẤY (px) của từng cột: bảng nào có tổng độ rộng gốc < khung thì mọi cột đang hiện được giãn cùng tỉ lệ cho đầy khung.
  function renderedWidths(ctrl) {
    var shown = ctrl.columns.filter(function (column) { return !column.hidden && !column.suppressed; });
    var total = shown.reduce(function (sum, column) { return sum + column.width; }, 0), room = roomOf(ctrl);
    var scale = total && room > total ? room / total : 1, out = new Map();
    ctrl.columns.forEach(function (column) { out.set(column, column.width * (shown.indexOf(column) >= 0 ? scale : 1)); });
    return out;
  }
  function attachHandle(ctrl, cell, column) {
    if (window.getComputedStyle(cell).position === 'static') cell.style.position = 'relative';
    var handle = cell.querySelector(':scope > .tks-column-resizer');
    if (!handle) {
      handle = document.createElement('span');
      handle.className = 'tks-column-resizer'; handle.tabIndex = 0;
      handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
      cell.appendChild(handle);
    }
    if (!wiredHandles.has(handle)) {
      wiredHandles.add(handle);
      handle.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); });
      handle.addEventListener('dblclick', function (event) { event.preventDefault(); event.stopPropagation(); });
      handle.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); event.stopPropagation();
        var current = controllers.get(ctrl.table), col = current.columns.find(function (item) { return item.key === handle.dataset.columnKey; });
        var seen = renderedWidths(current);
        resize(current, col, seen.get(col) + (event.key === 'ArrowRight' ? 10 : -10), seen);
      });
      handle.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        finishDrag();
        var current = controllers.get(ctrl.table), col = current.columns.find(function (item) { return item.key === handle.dataset.columnKey; });
        // Chụp độ rộng đang thấy lúc bắt đầu kéo: mỗi lần di chuột các cột khác được tính lại từ ảnh chụp này (kéo qua lại không trôi).
        var seen = renderedWidths(current);
        drag = { ctrl: current, column: col, handle: handle, id: event.pointerId, x: event.clientX, width: seen.get(col), seen: seen };
        current.session.fitted = true;
        document.body.classList.add('tks-table-resizing');
        if (handle.setPointerCapture) { try { handle.setPointerCapture(event.pointerId); } catch (_) { /* detached pointer */ } }
      });
      handle.addEventListener('lostpointercapture', finishDrag);
    }
    handle.dataset.columnKey = column.key;
    handle.setAttribute('aria-label', 'Độ rộng cột ' + column.label);
    handle.setAttribute('aria-valuemin', String(column.minWidth || MIN_WIDTH));
    handle.setAttribute('aria-valuenow', String(Math.round(column.width)));
  }
  function preserveTextLines(table) {
    var walker = document.createTreeWalker(table, window.NodeFilter.SHOW_TEXT), multiline = [], node;
    while ((node = walker.nextNode())) {
      if (!/[\r\n]/.test(node.data) || !/\S/.test(node.data)) continue;
      if (!node.parentElement.closest('th,td') || node.parentElement.closest('.tks-cell-text,textarea,select,option,script,style,svg')) continue;
      multiline.push(node);
    }
    multiline.forEach(function (text) {
      var span = document.createElement('span'); span.className = 'tks-cell-text';
      text.parentNode.insertBefore(span, text); span.appendChild(text);
    });
  }
  function apply(ctrl) {
    var table = ctrl.table;
    preserveTextLines(table);
    var sections = [table.tHead].concat(Array.from(table.tBodies), [table.tFoot]).filter(Boolean);
    // Remove our visibility before reading application-specific hidden columns.
    ctrl.columns.forEach(function (column, index) {
      var cell = ctrl.head.leaves[index].cell;
      cell.classList.remove('tks-column-hidden');
      column.suppressed = cell.hidden || cell.style.display === 'none' || window.getComputedStyle(cell).display === 'none';
    });
    fitOnce(ctrl);
    var visible = ctrl.columns.map(function (col) { return !col.hidden && !col.suppressed; });
    sections.forEach(function (section) {
      var logical = grid(section), rowsVisible = new Map();
      logical.entries.forEach(function (entry) {
        var span = 0;
        for (var i = entry.start; i < entry.start + entry.span; i++) if (visible[i]) span++;
        entry.cell.classList.toggle('tks-column-hidden', span === 0);
        if (entry.cell.colSpan !== Math.max(1, span)) entry.cell.colSpan = Math.max(1, span);
        if (span) rowsVisible.set(entry.row, true);
      });
      Array.from(section.rows).forEach(function (row) { row.classList.toggle('tks-row-hidden', !rowsVisible.has(row)); });
    });
    var group = table.querySelector(':scope > colgroup');
    if (!group) { group = document.createElement('colgroup'); table.insertBefore(group, table.tHead || table.tBodies[0]); }
    // The browser sees only visible columns; logical indices remain in cells.
    var shown = ctrl.columns.filter(function (_, index) { return visible[index]; });
    var signature = shown.map(function (column) { return column.key; }).join('\u001f');
    if (group.dataset.tksColumns !== signature) {
      group.replaceChildren();
      shown.forEach(function (column) { var col = document.createElement('col'); col.dataset.columnKey = column.key; group.appendChild(col); });
      group.dataset.tksColumns = signature;
    }
    var total = shown.reduce(function (sum, column) { return sum + column.width; }, 0);
    if (table.dataset.tableFit === 'contain') {
      // Luôn vừa khung (không cuộn ngang): độ rộng cột là TỈ LỆ; kéo rộng 1 cột thì các cột còn lại co lại.
      shown.forEach(function (column, index) { changeStyle(group.children[index], 'width', (total ? column.width / total * 100 : 0) + '%'); });
      changeStyle(table, 'width', '100%'); changeStyle(table, 'min-width', '0px'); changeStyle(table, 'max-width', '100%');
    } else {
      // Bảng rộng đúng tổng cột (nhiều cột thì tràn khung và cuộn ngang) nhưng KHÔNG BAO GIỜ hẹp hơn khung chứa:
      // min-width:100% khiến trình duyệt chia phần dư theo tỉ lệ cho các cột đang hiện (ẩn cột / kéo hẹp cột đều giãn lại).
      shown.forEach(function (column, index) { changeStyle(group.children[index], 'width', column.width + 'px'); });
      changeStyle(table, 'width', Math.max(MIN_WIDTH, total) + 'px');
      changeStyle(table, 'min-width', '100%'); changeStyle(table, 'max-width', 'none');
    }
    ctrl.columns.forEach(function (column, index) {
      if (ctrl.head.leaves[index].span === 1) attachHandle(ctrl, ctrl.head.leaves[index].cell, column);
    });
    table.querySelectorAll('textarea.marketing-edit').forEach(function (editor) {
      editor.style.height = 'auto';
      editor.style.height = Math.max(30, editor.scrollHeight) + 'px';
    });
  }
  // Đổi độ rộng 1 cột, `seen` = độ rộng đang thấy của mọi cột trước khi đổi (renderedWidths).
  // Kéo hẹp: bảng hụt so với khung nên các cột còn lại giãn ra bù (tổng vẫn bằng khung, tay kéo bám đúng con trỏ).
  // Kéo rộng: các cột khác giữ nguyên, bảng rộng hơn khung thì khung cuộn ngang.
  function resize(ctrl, column, value, seen) {
    if (!column) return;
    seen = seen || renderedWidths(ctrl);
    var target = Math.max(column.minWidth || MIN_WIDTH, value), room = roomOf(ctrl);
    var others = ctrl.columns.filter(function (item) { return item !== column && !item.hidden && !item.suppressed; });
    var othersTotal = others.reduce(function (sum, item) { return sum + seen.get(item); }, 0);
    var scale = room && othersTotal && target + othersTotal < room ? (room - target) / othersTotal : 1;
    column.width = target; ctrl.session.fitted = true;
    others.forEach(function (item) {
      var next = seen.get(item) * scale;
      if (Math.abs(next - item.width) < 0.01) return;
      item.width = next; remember(ctrl, item, { width: next });
    });
    apply(ctrl);
    remember(ctrl, column, { width: column.width });
  }
  function finishDrag() {
    if (!drag) return;
    var current = drag; drag = null;
    document.body.classList.remove('tks-table-resizing');
    if (current.handle.releasePointerCapture) { try { current.handle.releasePointerCapture(current.id); } catch (_) { /* capture already released */ } }
  }
  document.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault(); resize(drag.ctrl, drag.column, drag.width + event.clientX - drag.x, drag.seen);
  }, { passive: false });
  document.addEventListener('pointerup', function (event) { if (drag && event.pointerId === drag.id) finishDrag(); });
  document.addEventListener('pointercancel', function (event) { if (drag && event.pointerId === drag.id) finishDrag(); });
  window.addEventListener('blur', finishDrag);

  function closePicker() {
    if (!picker || picker.hidden) return;
    picker.hidden = true; picker.parentElement.hidden = true;
    if (opener) { opener.setAttribute('aria-expanded', 'false'); if (opener.isConnected) opener.focus(); }
    active = null;
  }
  function setHidden(ctrl, hidden) {
    var next = new Set(hidden);
    ctrl.columns.forEach(function (col) { if (col.locked) next.delete(col.key); });
    if (ctrl.columns.every(function (col) { return next.has(col.key) || col.suppressed; })) {
      var first = ctrl.columns.find(function (col) { return !col.suppressed; });
      if (first) next.delete(first.key);
    }
    ctrl.columns.forEach(function (col) {
      var hide = next.has(col.key);
      if (col.hidden !== hide) remember(ctrl, col, { hidden: hide });
      col.hidden = hide;
    });
    apply(ctrl);
    if (ctrl.options.onVisibilityChange) ctrl.options.onVisibilityChange(ctrl.columns.filter(function (col) { return col.hidden; }).map(function (col) { return col.key; }));
    if (active === ctrl) renderPicker();
  }
  function makePicker() {
    var overlay = document.createElement('div'); overlay.className = 'tks-columns-overlay'; overlay.hidden = true;
    picker = document.createElement('div'); picker.className = 'tks-columns-picker'; picker.hidden = true;
    picker.setAttribute('role', 'dialog'); picker.setAttribute('aria-modal', 'true'); picker.setAttribute('aria-labelledby', 'tksColumnsTitle');
    picker.innerHTML = '<div class="tks-columns-heading"><h3 id="tksColumnsTitle">Cột hiển thị</h3><button type="button" data-action="close" aria-label="Đóng">✕</button></div><p>Chọn cột để hiện, bỏ chọn để ẩn. Lựa chọn giữ trong lần xem này.</p><div class="tks-columns-actions"><button type="button" data-action="show-all">Chọn tất cả</button><button type="button" data-action="hide-all">Bỏ chọn</button></div><div class="tks-columns-list"></div>';
    overlay.appendChild(picker); document.body.appendChild(overlay);
    overlay.addEventListener('click', function (event) { if (event.target === overlay || event.target.closest('[data-action="close"]')) closePicker(); });
    picker.addEventListener('click', function (event) {
      var button = event.target.closest('[data-action]'); if (!button || !active) return;
      if (button.dataset.action === 'show-all') setHidden(active, []);
      if (button.dataset.action === 'hide-all') setHidden(active, active.columns.map(function (col) { return col.key; }));
    });
    picker.addEventListener('change', function (event) {
      if (!active || !event.target.matches('input[data-column-key]')) return;
      var hidden = active.columns.filter(function (col) { return col.hidden; }).map(function (col) { return col.key; });
      var key = event.target.dataset.columnKey;
      setHidden(active, event.target.checked ? hidden.filter(function (item) { return item !== key; }) : hidden.concat(key));
    });
    picker.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); return; }
      if (event.key !== 'Tab') return;
      var focusables = Array.from(picker.querySelectorAll('button,input:not(:disabled)'));
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }
  function renderPicker() {
    var list = picker.querySelector('.tks-columns-list');
    // Cột có data-column-unlisted="true" (ví dụ cột giá chỉ vai trò được phép mới thấy) không xuất hiện trong danh sách chọn.
    var listed = active.columns.filter(function (column) { return !column.unlisted; });
    var signature = listed.map(function (column) { return column.key + ':' + column.label; }).join('\u001f');
    if (list.dataset.columns !== signature) {
      list.replaceChildren();
      listed.forEach(function (column) {
        var label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
        input.type = 'checkbox'; input.dataset.columnKey = column.key; text.textContent = column.label;
        label.append(input, text); list.appendChild(label);
      });
      list.dataset.columns = signature;
    }
    var count = active.columns.filter(function (column) { return !column.hidden && !column.suppressed; }).length;
    list.querySelectorAll('input').forEach(function (input, index) {
      var col = listed[index]; input.checked = !col.hidden;
      input.disabled = col.locked || col.suppressed || (count === 1 && !col.hidden);
      input.closest('label').title = col.locked ? 'Cột bắt buộc hiển thị' : '';
    });
  }
  function openPicker(ctrl, button) {
    if (!picker) makePicker();
    var parent = ctrl.table.closest('dialog[open]') || document.body;
    if (picker.parentElement.parentElement !== parent) parent.appendChild(picker.parentElement);
    if (opener) opener.setAttribute('aria-expanded', 'false');
    active = ctrl; opener = button; renderPicker();
    picker.hidden = false; picker.parentElement.hidden = false; button.setAttribute('aria-expanded', 'true');
    picker.querySelector('[data-action="close"]').focus();
  }
  // Đầu khối .dp-section-head đứng ngay trên bảng (liền trước khung cuộn, hoặc là đầu của .dp-section chỉ có đúng 1 bảng).
  function dialogSectionHead(table, wrapper) {
    var previous = wrapper.previousElementSibling;
    if (previous && previous.classList.contains('dp-section-head')) return previous;
    var section = table.closest('.dp-section');
    return section && section.querySelectorAll('table').length === 1 ? section.querySelector(':scope > .dp-section-head') : null;
  }
  function installButton(ctrl) {
    var table = ctrl.table, button = ctrl.options.button || (table.dataset.columnsButton && document.getElementById(table.dataset.columnsButton));
    if (!button) {
      var wrapper = table.parentElement;
      if (!wrapper.classList.contains('tks-table-scroll') && !/scroll|table-wrap/.test(wrapper.className)) {
        var scroll = document.createElement('div'); scroll.className = 'tks-table-scroll';
        wrapper.insertBefore(scroll, table); scroll.appendChild(table); wrapper = scroll;
      }
      var panel = table.closest('.panel,.card');
      var header = panel && panel.querySelectorAll('table').length === 1 && panel.querySelector(':scope > .panel-head,:scope > .card-head');
      var toolbar = header && header.querySelector(':scope > .panel-head-actions,:scope > .card-head-actions');
      if (header && !toolbar) {
        toolbar = document.createElement('div'); toolbar.className = 'panel-head-actions';
        var search = header.querySelector(':scope > .table-search-tools');
        header.insertBefore(toolbar, search);
      }
      if (toolbar) header.querySelectorAll(':scope > button.export-button:not([data-not-export])').forEach(function (exportButton) { toolbar.appendChild(exportButton); });
      var previous = wrapper.previousElementSibling;
      // Hộp chi tiết: nút nằm ngay trên đầu khối (cạnh tiêu đề "Hàng hóa", "Khách hàng"…), không thêm 1 hàng công cụ riêng.
      var sectionHead = !toolbar && dialogSectionHead(table, wrapper);
      var tools = toolbar || sectionHead || (previous && previous.classList.contains('tks-table-tools') ? previous : null);
      if (!tools) {
        tools = document.createElement('div'); tools.className = 'tks-table-tools';
        wrapper.parentElement.insertBefore(tools, wrapper);
      }
      button = tools.querySelector('.tks-columns-button');
      if (!button) {
        button = document.createElement('button');
        if (sectionHead) tools.appendChild(button);
        else tools.insertBefore(button, tools.querySelector('button.export-button') || tools.firstChild);
      }
    }
    if (ctrl.button && ctrl.button !== button && ctrl.button.dataset.tksGenerated === 'true') {
      var oldTools = ctrl.button.parentElement; ctrl.button.remove(); if (oldTools.classList.contains('tks-table-tools') && !oldTools.childElementCount) oldTools.remove();
    }
    if (!button.classList.contains('tks-columns-button')) {
      button.classList.add('tks-columns-button'); button.type = 'button'; button.innerHTML = ICON + 'Cột hiển thị';
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
      button.title = 'Chọn cột hiển thị trong bảng';
      if (!ctrl.options.button && !table.dataset.columnsButton) button.dataset.tksGenerated = 'true';
      button.addEventListener('click', function (event) { event.preventDefault(); openPicker(buttonControllers.get(button), button); });
    }
    buttonControllers.set(button, ctrl);
    ctrl.button = button;
  }
  // ---- Sắp xếp tại chỗ cho bảng tĩnh trong hộp chi tiết (.dp-table hoặc data-table-sort="local") ----
  // Bảng chính của từng trang (phân trang / sắp xếp ở máy chủ) tự sắp xếp bằng mã riêng của trang nhưng dùng cùng
  // quy ước tiêu đề + biểu tượng (shared.css); data-table-sort="off" tắt hẳn (vd bảng tính cước có dòng tổng).
  function sortEnabled(ctrl) {
    var mode = ctrl.table.dataset.tableSort;
    if (ctrl.options.sort === false || mode === 'off') return false;
    return ctrl.options.sort === true || mode === 'local' || ctrl.table.classList.contains('dp-table');
  }
  // dd/MM/yyyy[ HH:mm[:ss]] hoặc yyyy-MM-dd[ HH:mm[:ss]] → epoch ms tính trên đúng số hiển thị (không lệch múi giờ).
  function parseDateText(text) {
    var year, month, day, match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (match) { day = Number(match[1]); month = Number(match[2]); year = Number(match[3]); }
    else {
      match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
      if (!match) return null;
      year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
    }
    var hour = Number(match[4] || 0), minute = Number(match[5] || 0), second = Number(match[6] || 0);
    var time = Date.UTC(year, month - 1, day, hour, minute, second), check = new Date(time);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null;
    return time;
  }
  // Số kiểu en-US: 1,234,567 · -12.5 · 45% · 1,200đ · 3.25 m³ → number; không phải số → null.
  // Vẫn đọc được dạng cũ 1.234.567 / 12,5 (không mơ hồ) để dữ liệu chữ cũ không sort sai.
  function parseNumberText(text) {
    var match = text.match(/^([+\-−–]?)\s*(\d[\d.,\s]*?)\s*(?:%|đ|₫|vnđ|vnd|m³|kg|ngày|lần)?$/i);
    if (!match) return null;
    var digits = match[2].replace(/\s/g, '');
    if (/^0\d{8,}$|^\d{11,}$/.test(digits)) return null; // số điện thoại / mã vạch: so sánh như chữ
    if (digits.indexOf('.') >= 0 && digits.indexOf(',') >= 0) {
      // Dấu đứng sau cùng là dấu thập phân; dấu còn lại là phân cách nghìn.
      digits = digits.lastIndexOf('.') > digits.lastIndexOf(',') ? digits.replace(/,/g, '') : digits.replace(/\./g, '').replace(',', '.');
    }
    else if (digits.indexOf(',') >= 0) digits = /^\d{1,3}(,\d{3})+$/.test(digits) ? digits.replace(/,/g, '') : digits.replace(',', '.');
    else if (/^\d{1,3}(\.\d{3}){2,}$/.test(digits)) digits = digits.replace(/\./g, '');
    var value = Number(digits);
    if (!Number.isFinite(value)) return null;
    return match[1] === '-' || match[1] === '−' || match[1] === '–' ? -value : value;
  }
  // Ô nhập liệu / dropdown: textContent rỗng (input) hoặc gộp mọi option (select) → lấy giá trị đang hiển thị.
  function cellText(cell) {
    var field = cell.querySelector('select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]), textarea');
    if (field) {
      var shown = field.tagName === 'SELECT'
        ? (field.selectedIndex >= 0 ? field.options[field.selectedIndex].textContent : '')
        : field.value;
      return String(shown || '').replace(/\s+/g, ' ').trim();
    }
    return cell.textContent.replace(/\s+/g, ' ').trim();
  }
  function sortValue(cell) {
    var field = cell.querySelector('select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]), textarea');
    if (!field && cell.hasAttribute('data-sort-text')) {
      var label = cell.getAttribute('data-sort-text').trim();
      return { empty: !label || label === '—', number: null, text: label };
    }
    if (!field && cell.hasAttribute('data-sort-value')) {
      var raw = cell.getAttribute('data-sort-value').trim();
      var given = raw === '' ? NaN : Number(raw);
      return { empty: !Number.isFinite(given), number: given, text: '' };
    }
    var text = cellText(cell);
    if (!text || text === '—' || text === '-') return { empty: true, number: null, text: '' };
    var number = field && field.tagName === 'INPUT' && /^(number|range|date|datetime-local|time|month|week)$/.test(field.type) && Number.isFinite(field.valueAsNumber)
      ? field.valueAsNumber : parseDateText(text);
    if (number === null) number = parseNumberText(text);
    return { empty: false, number: number, text: text };
  }
  // Dòng được phép đổi chỗ: mọi ô đều đơn (không gộp cột) — dòng ghi chú "Không có dữ liệu", dòng nhóm đứng yên tại chỗ.
  function sortableRows(ctrl) {
    var body = ctrl.table.tBodies[0], count = ctrl.head.leaves.length;
    return body ? Array.from(body.rows).filter(function (row) {
      return !row.hasAttribute('data-sort-fixed') && row.cells.length === count && Array.from(row.cells).every(function (cell) { return (Number(cell.dataset.tksColspan) || cell.colSpan) === 1; });
    }) : [];
  }
  function sortHeaderState(ctrl) {
    syncSortHeaders(ctrl.table, ctrl.sorts || [], function (th) {
      if (!th.querySelector(':scope > .sort-button[data-tks-sort]')) return undefined;
      return ctrl.head.leaves.findIndex(function (entry) { return entry.cell === th; });
    });
  }
  function applySort(ctrl) {
    sortHeaderState(ctrl);
    var body = ctrl.table.tBodies[0]; if (!body) return;
    var all = Array.from(body.rows), movable = sortableRows(ctrl), movableSet = new Set(movable);
    ctrl.sortedRows = all;
    if (movable.length < 2) return;
    // Thứ tự gốc (để "Bỏ sắp xếp" trả lại đúng như máy chủ gửi): đánh số 1 lần trước lần sắp đầu tiên.
    movable.forEach(function (row) { if (!row.dataset.tksOrder) row.dataset.tksOrder = String(ctrl.sortSeq = (ctrl.sortSeq || 0) + 1); });
    var sorts = ctrl.sorts || [];
    var keyed = movable.map(function (row) {
      return { row: row, order: Number(row.dataset.tksOrder), values: sorts.map(function (sort) { return sortValue(row.cells[sort.key]); }) };
    });
    keyed.sort(function (a, b) {
      for (var i = 0; i < sorts.length; i++) {
        var x = a.values[i], y = b.values[i];
        if (x.empty || y.empty) {
          if (x.empty === y.empty) continue;
          return x.empty ? 1 : -1;
        }
        var result = x.number !== null && y.number !== null ? x.number - y.number
          : x.text.localeCompare(y.text, 'vi', { numeric: true, sensitivity: 'base' });
        if (result) return result * (sorts[i].dir === 'desc' ? -1 : 1);
      }
      return a.order - b.order;
    });
    var queue = keyed.map(function (item) { return item.row; }), next = 0;
    var ordered = all.map(function (row) { return movableSet.has(row) ? queue[next++] : row; });
    var fragment = document.createDocumentFragment();
    ordered.forEach(function (row) { fragment.appendChild(row); });
    body.appendChild(fragment);
    ctrl.sortedRows = ordered;
  }
  function cycleSort(ctrl, index, add) {
    ctrl.sorts = nextSorts(ctrl.sorts || [], index, add);
    ctrl.sort = ctrl.sorts.length ? { index: ctrl.sorts[0].key, dir: ctrl.sorts[0].dir } : null;
    ctrl.sortByUser = true;
    ctrl.session.sort = ctrl.sort && ctrl.columns[ctrl.sort.index] ? { key: ctrl.columns[ctrl.sort.index].key, dir: ctrl.sort.dir } : null;
    ctrl.session.sorts = ctrl.sorts.map(function (sort) { return { key: ctrl.columns[sort.key].key, dir: sort.dir }; });
    scheduleSave(ctrl.session);
    applySort(ctrl);
  }
  // Khôi phục sắp xếp đã lưu (theo khóa cột) trừ khi người dùng đã tự sắp xếp bảng này trong lần xem hiện tại.
  function restoreSort(ctrl) {
    if (ctrl.sortByUser) return;
    var saved = ctrl.session.sorts || [], signature = JSON.stringify(saved);
    if (ctrl.sortRestored === signature) return;
    ctrl.sortRestored = signature;
    ctrl.sorts = saved.map(function (sort) {
      return { key: ctrl.columns.findIndex(function (column) { return column.key === sort.key; }), dir: sort.dir };
    }).filter(function (sort) { return sort.key >= 0; });
    ctrl.sort = ctrl.sorts.length ? { index: ctrl.sorts[0].key, dir: ctrl.sorts[0].dir } : null;
  }
  function rowsChanged(ctrl) {
    var body = ctrl.table.tBodies[0], rows = body ? body.rows : [], previous = ctrl.sortedRows || [];
    if (rows.length !== previous.length) return true;
    for (var i = 0; i < rows.length; i++) if (rows[i] !== previous[i]) return true;
    return false;
  }
  function installSort(ctrl) {
    if (!sortEnabled(ctrl)) return;
    ctrl.head.leaves.forEach(function (entry) {
      var cell = entry.cell;
      if (entry.span !== 1 || cell.hasAttribute('data-no-sort') || cell.querySelector(':scope > .sort-button')) return;
      var button = document.createElement('button'), label = document.createElement('span'), mark = document.createElement('span');
      button.type = 'button'; button.className = 'sort-button'; button.dataset.tksSort = '1';
      label.className = 'sort-label'; mark.className = 'sort-indicator'; mark.setAttribute('aria-hidden', 'true');
      Array.from(cell.childNodes).forEach(function (node) {
        if (!(node.nodeType === 1 && node.classList.contains('tks-column-resizer'))) label.appendChild(node);
      });
      button.append(label, mark);
      cell.insertBefore(button, cell.firstChild);
      cell.classList.add('sortable');
      function toggle(event) {
        var current = controllers.get(ctrl.table), position = current.head.leaves.findIndex(function (item) { return item.cell === cell; });
        if (position >= 0) cycleSort(current, position, event.shiftKey);
      }
      button.addEventListener('click', function (event) { event.preventDefault(); toggle(event); });
      // Bấm vào phần đệm của ô tiêu đề (ngoài nút) cũng sắp xếp, như các bảng chính.
      cell.addEventListener('click', function (event) { if (event.target === cell) toggle(event); });
    });
    ctrl.sorts = (ctrl.sorts || []).filter(function (sort) { return sort.key < ctrl.head.leaves.length; });
    ctrl.sort = ctrl.sorts.length ? { index: ctrl.sorts[0].key, dir: ctrl.sorts[0].dir } : null;
    if (ctrl.sort && rowsChanged(ctrl)) applySort(ctrl); // bảng giữ nguyên nhưng trang vẽ lại các dòng (vd lọc) → sắp lại
    else sortHeaderState(ctrl);
  }

  function enhance(table, options) {
    // Bang trong van ban quy dinh va trinh soan thao rich-text la noi dung tai lieu,
    // khong phai bang du lieu cua dashboard. Khong chen UI "Cot hien thi" vao DOM
    // rich-text vi editor se serialize no va co the luu nhan dieu khien thanh van ban.
    if (!table || !table.tHead || table.dataset.tableControls === 'off'
      || table.closest('#ruleDocTextBody, .rte-editor')) return;
    var head = headers(table); if (!head.leaves.length || head.leaves.some(function (entry) { return !entry; })) return;
    var ctrl = controllers.get(table);
    if (!ctrl) { ctrl = { table: table, options: {} }; controllers.set(table, ctrl); }
    if (options) Object.assign(ctrl.options, options);
    var key = ctrl.options.key || tableKey(table), mode = screenMode(), sessionKey = key + '\u001e' + mode;
    var session = sessions.get(sessionKey);
    if (!session) {
      session = { columns: new Map(), fitted: false, key: key, mode: mode, dirty: copyColumns(savedColumns(key, mode)), sort: savedSort(key, mode), sorts: savedSorts(key, mode) };
      sessions.set(sessionKey, session);
    }
    ctrl.key = key; ctrl.mode = mode; ctrl.session = session; ctrl.head = head;
    var used = new Set();
    // data-min-column-width="N" tren bang: muc toi thieu rieng (bang nhieu cot so ngan can hep hon 64px).
    var floor = parseFloat(table.dataset.minColumnWidth) > 0 ? parseFloat(table.dataset.minColumnWidth) : MIN_WIDTH;
    ctrl.columns = head.leaves.map(function (entry, index) {
      var cell = entry.cell, metadata = ctrl.options.columns && ctrl.options.columns[index] || {};
      var label = metadata.label || labelOf(cell);
      var colKey = metadata.key || cell.dataset.columnKey || cell.dataset.field || cell.dataset.col || cell.dataset.sort || label;
      // Repeated headings remain distinct; explicit field keys take priority.
      if (used.has(colKey)) colKey += ':' + index; used.add(colKey);
      var column = session.columns.get(colKey);
      if (!column) {
        column = { key: colKey, floor: floor, width: Math.max(floor, pxWidth(metadata.width) || pxWidth(cell.dataset.defaultWidth) || pxWidth(cell.style.width) || defaultWidth(colKey, label, cell)), hidden: !!metadata.hidden || cell.dataset.columnDefaultHidden === 'true', locked: !!metadata.locked };
        session.columns.set(colKey, column);
        applySaved(session, column);
      }
      column.label = label; column.locked = !!metadata.locked || cell.dataset.columnLocked === 'true';
      column.unlisted = cell.dataset.columnUnlisted === 'true';
      if (column.locked) column.hidden = false;
      return column;
    });
    if (ctrl.columns.every(function (column) { return column.hidden; })) ctrl.columns[0].hidden = false;
    table.classList.add('tks-controlled-table'); restoreSort(ctrl); installSort(ctrl); installButton(ctrl); dropdownMinimums(ctrl); numberMinimums(ctrl); declaredMinimums(ctrl); apply(ctrl);
    if (active === ctrl && picker && !picker.hidden) renderPicker();
    return ctrl;
  }
  function refresh(table) { return enhance(table); }
  function refreshAll() {
    if (!window.document || !document.body) return;
    document.querySelectorAll('table').forEach(function (table) { enhance(table); });
    if (drag && !drag.handle.isConnected) finishDrag();
    if (active && !active.table.isConnected) closePicker();
    validateSelection(); // trang vẽ lại bảng / lọc / sắp xếp dòng: vùng chọn cũ không còn đúng ô nên bỏ
  }
  function schedule() {
    if (!window.document || !document.body) return;
    if (queued) return; queued = true;
    (window.requestAnimationFrame || window.setTimeout)(function () { queued = false; refreshAll(); });
  }
  function getState(table) {
    var ctrl = controllers.get(table); if (!ctrl) return null;
    var sorted = ctrl.sort && ctrl.columns[ctrl.sort.index];
    return {
      key: ctrl.key, screenMode: ctrl.mode,
      sort: sorted ? { key: sorted.key, direction: ctrl.sort.dir } : null,
      sorts: (ctrl.sorts || []).map(function (sort) { return { key: ctrl.columns[sort.key].key, dir: sort.dir }; }),
      columns: ctrl.columns.map(function (col) { return { key: col.key, label: col.label, width: col.width, hidden: col.hidden, locked: col.locked }; })
    };
  }
  window.TKSTables = { enhance: enhance, refresh: refresh, refreshAll: refreshAll, getState: getState, loadPrefs: loadPrefs,
    nextSorts: nextSorts, compareValues: compareValues, syncSortHeaders: syncSortHeaders,
    parseClipboardTable: parseClipboardTable, clearEditHistory: clearEditHistory,
    getSelection: function () { return sel ? { table: sel.table, cells: Array.from(sel.painted), regions: sel.rects.length } : null; },
    clearSelection: clearSelection };
  function fetchPrefs() {
    if (typeof fetch !== 'function' || !/^https?:$/.test(window.location.protocol)) return;
    // Trang chưa đăng nhập trả 401: bỏ qua, bảng dùng mặc định và không gửi lưu.
    fetch(PREFS_URL, { credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) { if (body && body.tables) loadPrefs(body.tables); })
      .catch(function () { /* dùng cấu hình mặc định */ });
  }
  // Phím mũi tên trong ô nhập của bảng: lên/xuống sang cùng cột ở dòng trên/dưới, trái/phải (khi con trỏ ở mép chữ)
  // sang ô nhập kề bên. Trang tự xử lý (đã preventDefault) thì bỏ qua.
  var GRID_INPUT_TYPES = /^(text|search|tel|email|url|number|date)$/;
  function gridInputOf(cell) {
    var input = cell && cell.querySelector('input,textarea');
    if (!input || input.disabled || input.readOnly || input.hidden || (input.tagName === 'INPUT' && !GRID_INPUT_TYPES.test(input.type || 'text'))) return null;
    return input.offsetParent === null ? null : input;
  }
  function caretAtEdge(input, forward) {
    if (typeof input.selectionStart !== 'number' || input.type === 'number') return true;
    if (input.selectionStart === 0 && input.selectionEnd === input.value.length) return true;
    if (input.selectionStart !== input.selectionEnd) return false;
    return forward ? input.selectionEnd === input.value.length : input.selectionStart === 0;
  }
  function gridNeighbor(input, key) {
    var cell = input.closest('td,th'); var row = cell && cell.parentElement;
    if (!row || !row.closest('table')) return null;
    var next;
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      var step = key === 'ArrowUp' ? 'previousElementSibling' : 'nextElementSibling';
      for (var other = row[step]; other; other = other[step]) {
        next = gridInputOf(other.cells[cell.cellIndex]);
        if (next) return next;
      }
      return null;
    }
    var sibling = key === 'ArrowLeft' ? 'previousElementSibling' : 'nextElementSibling';
    for (var cur = cell[sibling]; cur; cur = cur[sibling]) {
      next = gridInputOf(cur);
      if (next) return next;
    }
    return null;
  }
  function onGridKeydown(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    var key = event.key;
    if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    var input = event.target;
    if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA') || !gridInputOf(input.closest('td,th'))) return;
    // Ô nhiều dòng (textarea): lên/xuống chỉ chuyển ô khi con trỏ đã ở đầu/cuối chữ, còn lại để di chuyển giữa các dòng.
    var forward = key === 'ArrowRight' || key === 'ArrowDown';
    if ((key === 'ArrowLeft' || key === 'ArrowRight' || input.tagName === 'TEXTAREA') && !caretAtEdge(input, forward)) return;
    var next = gridNeighbor(input, key);
    if (!next) return;
    event.preventDefault();
    next.focus();
    if (next.select) next.select();
  }

  // ---- Chọn vùng ô kiểu Excel cho MỌI bảng (trừ data-table-select="off", vd bảng Kiểm kê có bộ chọn riêng) ----
  // Kéo chuột qua nhiều ô = chọn khối hàng × cột; Shift+bấm nối dài khối; Ctrl/⌘+kéo (hoặc +bấm) thêm khối khác;
  // thanh góc dưới phải hiện Tổng · Trung bình · Đếm của các ô đang chọn (từ 2 ô); Ctrl+C chép dạng TSV dán sang Excel/Sheets;
  // Ctrl+A chọn cả bảng; Esc / bấm ra ngoài bảng bỏ chọn. Kéo trong MỘT ô vẫn là bôi đen chữ như thường.
  var SELECT_SKIP = 'a[href],button,input,select,textarea,label,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="combobox"],[role="menuitem"],[draggable="true"],.tks-column-resizer,[data-no-cell-select]';
  var sel = null, gesture = null, selFrame = 0, selTimer = 0, suppressClick = false, selBar = null, selNoteTimer = 0;
  var selNumber = typeof Intl !== 'undefined' ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }) : null;

  function selectableTable(table) {
    return !!table && !table.closest('[data-table-select="off"],#ruleDocTextBody,.rte-editor');
  }
  // Dòng thân bảng đang hiện (không tính tiêu đề / chân bảng); chỉ số dòng trong danh sách này là toạ độ hàng của vùng chọn.
  function bodyRows(table) {
    var rows = [];
    Array.from(table.tBodies).forEach(function (body) {
      Array.from(body.rows).forEach(function (row) {
        if (!row.hidden && !row.classList.contains('tks-row-hidden') && row.style.display !== 'none') rows.push(row);
      });
    });
    return rows;
  }
  function indexRows(rows) {
    var map = new Map();
    rows.forEach(function (row, index) { map.set(row, index); });
    return map;
  }
  function sameRows(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  function cellHidden(cell) {
    return cell.hidden || cell.classList.contains('tks-column-hidden') || cell.style.display === 'none';
  }
  // Ô (của đúng bảng đang chọn) chứa node; ô của bảng lồng bên trong thì leo lên ô ngoài cùng của bảng này.
  function cellFrom(node, state) {
    var element = node && (node.nodeType === 1 ? node : node.parentElement);
    var cell = element && element.closest('td,th');
    while (cell && cell.closest('table') !== state.table) {
      var up = cell.parentElement;
      cell = up && up.closest('td,th');
    }
    return cell && state.rowIndex.has(cell.parentElement) ? cell : null;
  }
  function positionOf(cell, state) { return { row: state.rowIndex.get(cell.parentElement), col: cell.cellIndex }; }
  function rectBetween(a, b) {
    return { r1: Math.min(a.row, b.row), r2: Math.max(a.row, b.row), c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) };
  }
  function isSingle(rect, pos) { return rect.r1 === rect.r2 && rect.c1 === rect.c2 && rect.r1 === pos.row && rect.c1 === pos.col; }

  function clearSelection() {
    if (selFrame) { (window.cancelAnimationFrame || clearTimeout)(selFrame); selFrame = 0; }
    if (!sel) return;
    sel.painted.forEach(function (cell) { cell.classList.remove('tks-cell-selected'); });
    sel = null;
    if (selBar) selBar.hidden = true;
  }
  function validateSelection() {
    if (!sel || gesture) return;
    if (!sel.table.isConnected || !sameRows(sel.rows, bodyRows(sel.table))) clearSelection();
  }
  function sumBarFor(table) {
    var parent = table.closest('dialog[open]') || document.body;
    if (!selBar) {
      selBar = document.createElement('div');
      selBar.className = 'tks-sel-sum'; selBar.setAttribute('role', 'status'); selBar.setAttribute('aria-live', 'polite'); selBar.hidden = true;
    }
    if (selBar.parentElement !== parent) parent.appendChild(selBar);
    return selBar;
  }
  function formatSelNumber(value) { return selNumber ? selNumber.format(value) : String(value); }
  function selCellText(cell) {
    var text = cellText(cell);
    return text === '—' || text === '-' ? '' : text;
  }
  // Số của ô cho thanh tổng: chỉ đọc chữ đang hiển thị; ô tỷ lệ % không cộng (cộng tỷ lệ không có nghĩa), ngày/mã dài không phải số.
  function selNumberOf(text) {
    return /%\s*$/.test(text) ? null : parseNumberText(text);
  }
  function renderSum() {
    if (!sel) return;
    var bar = sumBarFor(sel.table);
    if (selNoteTimer) return; // đang hiện thông báo "Đã sao chép"
    if (sel.painted.size < 2) { bar.hidden = true; return; }
    var count = 0, numbers = 0, total = 0;
    sel.painted.forEach(function (cell) {
      var text = selCellText(cell);
      if (!text) return;
      count++;
      var value = selNumberOf(text);
      if (value !== null) { numbers++; total += value; }
    });
    bar.textContent = '';
    function part(label, value) {
      var item = document.createElement('span'), strong = document.createElement('b');
      strong.textContent = value; item.append(label + ': ', strong); bar.appendChild(item);
    }
    if (numbers) { part('Tổng', formatSelNumber(total)); part('Trung bình', formatSelNumber(total / numbers)); }
    part('Đếm', formatSelNumber(count));
    bar.hidden = false;
  }
  function renderSelection() {
    selFrame = 0;
    if (!sel) return;
    var next = new Set();
    sel.rects.forEach(function (rect) {
      for (var r = rect.r1; r <= rect.r2; r++) {
        var row = sel.rows[r];
        if (!row) continue;
        for (var c = rect.c1; c <= rect.c2; c++) {
          var cell = row.cells[c];
          if (cell && !cellHidden(cell)) next.add(cell);
        }
      }
    });
    sel.painted.forEach(function (cell) { if (!next.has(cell)) cell.classList.remove('tks-cell-selected'); });
    next.forEach(function (cell) { if (!sel.painted.has(cell)) cell.classList.add('tks-cell-selected'); });
    sel.painted = next;
    renderSum();
  }
  function scheduleSelection() {
    if (!selFrame) selFrame = (window.requestAnimationFrame || window.setTimeout)(renderSelection);
  }
  function selectionText() {
    if (!sel) return '';
    var blocks = [];
    sel.rects.forEach(function (rect) {
      var lines = [];
      for (var r = rect.r1; r <= rect.r2; r++) {
        var row = sel.rows[r], cells = [];
        if (!row) continue;
        for (var c = rect.c1; c <= rect.c2; c++) {
          var cell = row.cells[c];
          if (cell && !cellHidden(cell)) cells.push(selCellText(cell).replace(/[\t\r\n]+/g, ' '));
        }
        if (cells.length) lines.push(cells.join('\t'));
      }
      if (lines.length) blocks.push(lines.join('\n'));
    });
    return blocks.join('\n');
  }

  // Khung cuộn gần nhất của bảng (null = cuộn cả trang).
  function scrollParentOf(element) {
    for (var node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      var style = window.getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)) return node;
    }
    return null;
  }
  function edgeDelta(pointer, low, high) {
    var edge = 40, max = 28;
    if (pointer < low + edge) return -Math.min(max, Math.ceil(((low + edge - pointer) / edge) * max));
    if (pointer > high - edge) return Math.min(max, Math.ceil(((pointer - (high - edge)) / edge) * max));
    return 0;
  }
  function moveFocus(pos) {
    if (!gesture || !sel || !pos) return;
    if (gesture.focus && gesture.focus.row === pos.row && gesture.focus.col === pos.col) return;
    if (!gesture.claimed) {
      if (pos.row === gesture.anchor.row && pos.col === gesture.anchor.col) return; // vẫn trong ô đầu: để bôi đen chữ như thường
      claimGesture();
    }
    gesture.focus = pos;
    sel.rects[sel.rects.length - 1] = rectBetween(gesture.anchor, pos);
    scheduleSelection();
  }
  // Con trỏ đã sang ô khác: từ đây là chọn vùng — bỏ bôi đen chữ của trình duyệt, khoá bôi đen mới, bật tự cuộn ở mép khung.
  function claimGesture() {
    gesture.claimed = true;
    var native = window.getSelection && window.getSelection();
    if (native && native.removeAllRanges) native.removeAllRanges();
    document.body.classList.add('tks-selecting');
    gesture.scroller = scrollParentOf(gesture.table);
    if (!selTimer) selTimer = setInterval(selectionTick, 30);
  }
  function selectionTick() {
    if (!gesture || !gesture.claimed || !sel) return;
    var scroller = gesture.scroller, viewW = window.innerWidth, viewH = window.innerHeight, box, barX, barY;
    if (scroller) {
      var rect = scroller.getBoundingClientRect();
      box = { left: Math.max(rect.left, 0), right: Math.min(rect.right, viewW), top: Math.max(rect.top, 0), bottom: Math.min(rect.bottom, viewH) };
      barX = scroller.offsetWidth - scroller.clientWidth; barY = scroller.offsetHeight - scroller.clientHeight;
    } else {
      box = { left: 0, right: viewW, top: 0, bottom: viewH };
      barX = viewW - document.documentElement.clientWidth; barY = viewH - document.documentElement.clientHeight;
    }
    box.right -= Math.max(0, barX); box.bottom -= Math.max(0, barY);
    var top = box.top, head = gesture.table.tHead;
    if (head) {
      // Hàng tiêu đề đang dính ở mép trên thì phần dùng được bắt đầu dưới nó.
      var headBox = head.getBoundingClientRect();
      if (headBox.height && headBox.top <= box.top + 1 && headBox.bottom > box.top) top = headBox.bottom;
    }
    var dy = edgeDelta(gesture.y, top, box.bottom), dx = edgeDelta(gesture.x, box.left, box.right);
    if (dy || dx) {
      if (scroller) { scroller.scrollTop += dy; scroller.scrollLeft += dx; } else window.scrollBy(dx, dy);
    }
    if (typeof document.elementFromPoint !== 'function') return;
    var x = Math.min(Math.max(gesture.x, box.left + 1), box.right - 1), y = Math.min(Math.max(gesture.y, top + 1), box.bottom - 1);
    var cell = cellFrom(document.elementFromPoint(x, y), sel);
    if (cell) moveFocus(positionOf(cell, sel));
  }
  function endGesture() {
    if (!gesture) return;
    var done = gesture;
    gesture = null;
    clearInterval(selTimer); selTimer = 0;
    document.body.classList.remove('tks-selecting');
    if (done.claimed) {
      // Cú kéo qua nhiều ô không được kích hoạt thao tác "bấm dòng" của trang (mở chi tiết, v.v.).
      suppressClick = true; setTimeout(function () { suppressClick = false; }, 0);
    } else if (done.toggleAt && sel) {
      // Ctrl+bấm lên ô đã chọn riêng lẻ: bỏ chọn ô đó.
      sel.rects = sel.rects.filter(function (rect) { return !isSingle(rect, done.toggleAt); });
      if (!sel.rects.length) { clearSelection(); return; }
    }
    if (sel) renderSelection();
  }

  function onSelectionDown(event) {
    if (event.button !== 0) return;
    var target = event.target && (event.target.nodeType === 1 ? event.target : event.target.parentElement);
    if (!target || target.closest('.tks-sel-sum')) return;
    var table = target.closest('table');
    if (!selectableTable(table) || target.closest(SELECT_SKIP)) { clearSelection(); return; }
    var rows = bodyRows(table), state = { table: table, rows: rows, rowIndex: indexRows(rows) };
    var cell = cellFrom(target, state);
    if (!cell) { clearSelection(); return; }
    var pos = positionOf(cell, state);
    if (sel && (sel.table !== table || !sameRows(sel.rows, rows))) clearSelection();
    var additive = event.ctrlKey || event.metaKey, extend = event.shiftKey && sel && sel.anchor;
    var toggleAt = null;
    if (extend) {
      event.preventDefault(); // Shift+bấm không bôi đen chữ giữa hai ô
      sel.rects[sel.rects.length - 1] = rectBetween(sel.anchor, pos);
    } else if (additive) {
      event.preventDefault();
      if (!sel) sel = { table: table, rows: rows, rowIndex: state.rowIndex, rects: [], painted: new Set(), anchor: null };
      if (sel.rects.some(function (rect) { return isSingle(rect, pos); })) toggleAt = pos;
      sel.anchor = pos; sel.rects.push(rectBetween(pos, pos));
    } else {
      clearSelection();
      sel = { table: table, rows: rows, rowIndex: state.rowIndex, rects: [rectBetween(pos, pos)], painted: new Set(), anchor: pos };
    }
    gesture = { table: table, anchor: sel.anchor, focus: pos, claimed: false, x: event.clientX, y: event.clientY, toggleAt: toggleAt };
    if (extend) claimGesture();
    renderSelection();
  }
  function onSelectionMove(event) {
    if (!gesture || !sel) return;
    if (!(event.buttons & 1)) { endGesture(); return; } // nhả chuột ngoài cửa sổ: không có mouseup
    gesture.x = event.clientX; gesture.y = event.clientY;
    var cell = cellFrom(event.target, sel);
    if (cell) moveFocus(positionOf(cell, sel));
  }
  function onSelectionKey(event) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && !event.defaultPrevented) {
      var historyKey = String(event.key).toLowerCase();
      var historyDir = historyKey === 'z' ? (event.shiftKey ? 'redo' : 'undo') : (historyKey === 'y' && !event.shiftKey ? 'redo' : '');
      if (historyDir && !selectionFieldFocused() && runEditHistory(historyDir)) { event.preventDefault(); return; }
    }
    if (!sel) return;
    if (event.key === 'Escape') { clearSelection(); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.isComposing) {
      if (event.defaultPrevented || cellEditOff() || selectionFieldFocused()) return;
      event.preventDefault();
      editSelection('clear', null);
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || String(event.key).toLowerCase() !== 'a') return;
    if (selectionFieldFocused()) return;
    event.preventDefault();
    var cols = 0;
    sel.rows.forEach(function (row) { cols = Math.max(cols, row.cells.length); });
    if (!sel.rows.length || !cols) return;
    sel.rects = [{ r1: 0, r2: sel.rows.length - 1, c1: 0, c2: cols - 1 }];
    sel.anchor = { row: 0, col: 0 };
    renderSelection();
  }
  function onSelectionCopy(event) {
    if (!sel || !sel.painted.size || !event.clipboardData) return;
    if (selectionFieldFocused()) return;
    // Mới chọn 1 ô mà người dùng đang bôi đen chữ trong ô đó: để trình duyệt chép đúng đoạn chữ.
    if (sel.painted.size < 2 && window.getSelection && String(window.getSelection())) return;
    event.clipboardData.setData('text/plain', selectionText());
    event.preventDefault();
    selNote('Đã sao chép ' + formatSelNumber(sel.painted.size) + ' ô');
  }
  // Thông báo ngắn trên thanh Tổng/TB/Đếm (Đã sao chép / Đã dán / Đã xóa…); hết giờ thì trả thanh về số liệu.
  function selNote(text, table) {
    table = table || (sel && sel.table);
    if (!table) return;
    var bar = sumBarFor(table);
    clearTimeout(selNoteTimer);
    bar.textContent = text; bar.hidden = false;
    selNoteTimer = setTimeout(function () { selNoteTimer = 0; renderSum(); }, 2600);
  }
  function onSelectionCut(event) {
    if (event.defaultPrevented || !sel || !sel.painted.size || !event.clipboardData || cellEditOff() || selectionFieldFocused()) return;
    if (sel.painted.size < 2 && window.getSelection && String(window.getSelection())) return;
    event.clipboardData.setData('text/plain', selectionText());
    event.preventDefault();
    editSelection('clear', null);
  }
  // ---- Xóa / Cắt / Dán vào vùng ô đang chọn (kiểu Excel) ----
  // Delete·Backspace = xóa nội dung các ô; Ctrl+X = chép rồi xóa; Ctrl+V = dán khối TSV (Excel/Sheets) từ ô trên-trái của vùng chọn,
  // dán 1 ô vào vùng nhiều ô thì điền đầy cả vùng. Ô chỉ-xem (chữ thuần) bị bỏ qua và được báo lại.
  // Cách ghi giá trị: (1) bảng/trang tự xử lý qua sự kiện 'tks:cells-edit' (nổi bọt từ ô lên tr/tbody/table; detail = { action: 'clear'|'paste', table,
  // edits: [{ cell, row, col, value, handled }] }; xử lý ô nào thì đặt edit.handled = true) — dùng cho ô sửa-tại-chỗ phải lưu về máy chủ;
  // (2) ô còn lại có sẵn input / textarea / select / contenteditable thì ghi thẳng vào đó và bắn input + change để trang tự lưu.
  // Ô đánh dấu data-cell-editable được tính là sửa được dù chưa có input (trang sẽ mở ô nhập khi cần).
  // Hoàn tác / Làm lại: Ctrl/⌘+Z hoàn tác lần Xóa·Cắt·Dán gần nhất, Ctrl/⌘+Y hoặc Ctrl/⌘+Shift+Z làm lại (tối đa 50 lần, cấp module,
  // không cần còn vùng chọn; đang gõ trong ô nhập thì phím là của trình duyệt; thao tác sửa mới xóa danh sách "làm lại").
  // Ô ghi thẳng bởi bước (2) tự được nhớ giá trị trước/sau. Ô do trang xử lý (1) chỉ vào lịch sử nếu trang đặt thêm trên edit:
  //   edit.revert()  → boolean | Promise<boolean>  trả ô về giá trị TRƯỚC khi sửa; false (hoặc ném lỗi) = không làm được → bị bỏ qua;
  //   edit.reapply() → boolean | Promise<boolean>  áp lại đúng thao tác đó (cho Ctrl+Y), cùng quy ước kết quả.
  // Edit không có revert thì không được hoàn tác. Bảng đã bị gỡ khỏi DOM thì mục lịch sử của nó bị bỏ.
  var EDIT_CONFIRM_OVER = 20;
  var EDIT_HISTORY_MAX = 50;
  var editUndo = [], editRedo = [], editHistoryBusy = false;
  // Bảng có bộ sửa ô riêng (vd lưới Yêu cầu VAT) đặt data-cell-edit="off": Delete / Cắt / Dán chung bỏ qua, vẫn chọn vùng + Ctrl+C.
  function cellEditOff() { return !!(sel && sel.table.closest('[data-cell-edit="off"]')); }
  function selectionFieldFocused() {
    var active = document.activeElement;
    return !!(active && (/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable));
  }
  function fieldOf(cell) {
    var field = cell.querySelector('textarea, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=image]), [contenteditable]:not([contenteditable="false"])');
    if (!field || field.disabled || field.readOnly || field.hidden) return null;
    return field;
  }
  function editableCell(cell) { return cell.hasAttribute('data-cell-editable') || !!fieldOf(cell); }

  // TSV → mảng dòng × cột; hiểu ô bọc ngoặc kép của Excel (xuống dòng / tab / "" bên trong).
  function parseClipboardTable(text) {
    var source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var rows = [], row = [], field = '', quoted = false;
    for (var i = 0; i < source.length; i++) {
      var ch = source.charAt(i);
      if (quoted) {
        if (ch === '"') { if (source.charAt(i + 1) === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      } else if (ch === '"' && field === '') quoted = true;
      else if (ch === '\t') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function setNativeValue(field, value) {
    var proto = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement : window.HTMLInputElement;
    var desc = proto && Object.getOwnPropertyDescriptor(proto.prototype, 'value');
    if (desc && desc.set) desc.set.call(field, value); else field.value = value;
  }
  function fire(field, type) { field.dispatchEvent(new window.Event(type, { bubbles: true })); }
  // Ghi value vào ô có sẵn trường nhập; trả true nếu ghi được (kể cả khi giá trị không đổi), false nếu không hợp lệ cho trường đó.
  function writeField(field, value) {
    if (field.tagName === 'SELECT') {
      var text = String(value).trim().toLowerCase(), found = -1;
      Array.from(field.options).forEach(function (option, index) {
        if (found < 0 && (option.value.toLowerCase() === text || option.textContent.trim().toLowerCase() === text)) found = index;
      });
      if (found < 0 && text === '') found = Array.from(field.options).findIndex(function (option) { return option.value === ''; });
      if (found < 0) return false;
      if (field.selectedIndex === found) return true;
      field.selectedIndex = found; fire(field, 'input'); fire(field, 'change');
      return true;
    }
    if (field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA') { // contenteditable
      if (field.textContent === value) return true;
      field.textContent = value; fire(field, 'input'); fire(field, 'change');
      return true;
    }
    var next = String(value);
    if (field.type === 'number') {
      next = next.trim().replace(/,/g, '');
      if (next !== '' && !isFinite(Number(next))) return false;
    } else if (field.maxLength > 0 && next.length > field.maxLength) next = next.slice(0, field.maxLength);
    if (field.value === next) return true;
    setNativeValue(field, next); fire(field, 'input'); fire(field, 'change');
    return true;
  }
  // Trạng thái của trường để hoàn tác: select = selectedIndex, input/textarea = value, contenteditable = textContent.
  function fieldState(field) {
    if (field.tagName === 'SELECT') return field.selectedIndex;
    if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') return field.value;
    return field.textContent;
  }
  // Đặt lại trạng thái đã lưu (bắn input + change như writeField); false nếu trường đã rời DOM / bị khóa.
  function applyFieldState(field, state) {
    if (!field.isConnected || field.disabled || field.readOnly) return false;
    if (field.tagName === 'SELECT') {
      if (field.selectedIndex !== state) { field.selectedIndex = state; fire(field, 'input'); fire(field, 'change'); }
      return true;
    }
    if (field.tagName !== 'INPUT' && field.tagName !== 'TEXTAREA') {
      if (field.textContent !== state) { field.textContent = state; fire(field, 'input'); fire(field, 'change'); }
      return true;
    }
    if (field.value !== state) { setNativeValue(field, state); fire(field, 'input'); fire(field, 'change'); }
    return true;
  }
  function pushHistory(stack, entry) {
    stack.push(entry);
    while (stack.length > EDIT_HISTORY_MAX) stack.shift();
  }
  function clearEditHistory() { editUndo.length = 0; editRedo.length = 0; }
  // Chạy mục trên cùng của ngăn undo/redo; trả true nếu có mục để chạy (để phím được preventDefault).
  function runEditHistory(dir) {
    var from = dir === 'undo' ? editUndo : editRedo, to = dir === 'undo' ? editRedo : editUndo;
    while (from.length && !from[from.length - 1].table.isConnected) from.pop();
    if (!from.length) return false;
    if (editHistoryBusy) return true;
    var entry = from.pop(), undo = dir === 'undo';
    var items = undo ? entry.items.slice().reverse() : entry.items.slice();
    var results = items.map(function (item) {
      if (item.field) return applyFieldState(item.field, undo ? item.before : item.after);
      var fn = undo ? item.edit.revert : item.edit.reapply;
      if (typeof fn !== 'function') return false;
      try { return fn.call(item.edit); } catch (error) { return false; }
    });
    function settle(oks) {
      var kept = [], skipped = 0;
      items.forEach(function (item, index) { if (oks[index]) kept.push(item); else skipped++; });
      if (undo) kept.reverse();
      if (kept.length) pushHistory(to, { table: entry.table, items: kept });
      else pushHistory(from, entry); // không ô nào làm được: để mục lại
      selNote((kept.length ? (undo ? 'Đã hoàn tác ' : 'Đã làm lại ') + formatSelNumber(kept.length) + ' ô' : (undo ? 'Không hoàn tác được ô nào' : 'Không làm lại được ô nào'))
        + (skipped ? ' · bỏ qua ' + formatSelNumber(skipped) + (undo ? ' ô không hoàn tác được' : ' ô không làm lại được') : ''), entry.table);
    }
    if (!results.some(function (result) { return result && typeof result.then === 'function'; })) {
      settle(results.map(function (result) { return result !== false; }));
      return true;
    }
    editHistoryBusy = true;
    Promise.all(results.map(function (result) {
      return Promise.resolve(result).then(function (ok) { return ok !== false; }, function () { return false; });
    })).then(function (oks) { editHistoryBusy = false; settle(oks); }, function () { editHistoryBusy = false; settle(items.map(function () { return false; })); });
    return true;
  }
  function buildEdits(action, matrix) {
    var edits = [], seen = new Set();
    function add(r, c, value) {
      var row = sel.rows[r], cell = row && row.cells[c];
      if (!cell || cellHidden(cell) || seen.has(cell)) return;
      seen.add(cell); edits.push({ cell: cell, row: r, col: c, value: value, handled: false });
    }
    function eachCell(visit) {
      sel.rects.forEach(function (rect) {
        for (var r = rect.r1; r <= rect.r2; r++) for (var c = rect.c1; c <= rect.c2; c++) visit(r, c);
      });
    }
    if (action === 'clear') {
      eachCell(function (r, c) { add(r, c, ''); });
      return { edits: edits, extent: null };
    }
    var rect = sel.rects[sel.rects.length - 1], height = matrix.length, width = 0;
    matrix.forEach(function (line) { width = Math.max(width, line.length); });
    if (height === 1 && width === 1 && sel.painted.size > 1) {
      // 1 giá trị dán vào vùng nhiều ô: điền đầy mọi ô đang chọn.
      eachCell(function (r, c) { add(r, c, matrix[0][0]); });
      return { edits: edits, extent: null };
    }
    for (var j = 0; j < height && rect.r1 + j < sel.rows.length; j++) {
      var row = sel.rows[rect.r1 + j], visible = [];
      for (var k = rect.c1; k < row.cells.length; k++) if (!cellHidden(row.cells[k])) visible.push(k);
      for (var i = 0; i < matrix[j].length && i < visible.length; i++) add(rect.r1 + j, visible[i], matrix[j][i]);
    }
    var extent = null;
    edits.forEach(function (edit) {
      if (!extent) extent = { r1: edit.row, r2: edit.row, c1: edit.col, c2: edit.col };
      extent.r1 = Math.min(extent.r1, edit.row); extent.r2 = Math.max(extent.r2, edit.row);
      extent.c1 = Math.min(extent.c1, edit.col); extent.c2 = Math.max(extent.c2, edit.col);
    });
    return { edits: edits, extent: extent };
  }
  function editSelection(action, matrix) {
    if (!sel || !sel.painted.size) return;
    var built = buildEdits(action, matrix), edits = built.edits;
    if (!edits.length) return;
    var table = sel.table, verb = action === 'clear' ? 'Xóa' : 'Dán';
    var likely = edits.filter(function (edit) { return editableCell(edit.cell); }).length;
    if (!likely) { selNote('Bảng này chỉ để xem — các ô không sửa được.'); return; }
    if (likely > EDIT_CONFIRM_OVER && typeof window.confirm === 'function'
        && !window.confirm(verb + ' ' + formatSelNumber(likely) + ' ô? Thay đổi được lưu ngay.')) return;
    // detail.pending: trang đẩy Promise vào đây nếu việc lưu cần hỏi/đợi; edit.cancelled = true nếu người dùng từ chối giữa chừng.
    var detail = { action: action, table: table, edits: edits, pending: [] };
    edits[0].cell.dispatchEvent(new window.CustomEvent('tks:cells-edit', { bubbles: true, detail: detail }));
    var autoWrites = new Map(); // edit → { field, before, after } cho ô ghi thẳng mà giá trị có đổi
    edits.forEach(function (edit) {
      if (edit.handled) return;
      var field = fieldOf(edit.cell);
      if (!field) return;
      var before = fieldState(field);
      if (!writeField(field, edit.value)) return;
      edit.handled = true;
      var after = fieldState(field);
      if (after !== before) autoWrites.set(edit, { field: field, before: before, after: after });
    });
    function finish() {
      var items = [];
      edits.forEach(function (edit) {
        if (edit.cancelled) return;
        if (autoWrites.has(edit)) items.push(autoWrites.get(edit));
        else if (edit.handled && typeof edit.revert === 'function') items.push({ edit: edit });
      });
      if (items.length) { pushHistory(editUndo, { table: table, items: items }); editRedo.length = 0; }
      var done = 0, skipped = 0;
      edits.forEach(function (edit) { if (edit.handled && !edit.cancelled) done++; else skipped++; });
      if (built.extent && sel && sel.table === table) { sel.rects = [built.extent]; sel.anchor = { row: built.extent.r1, col: built.extent.c1 }; renderSelection(); }
      selNote((done ? (action === 'clear' ? 'Đã xóa ' : 'Đã dán ') + formatSelNumber(done) + ' ô' : (action === 'clear' ? 'Không xóa được ô nào' : 'Không dán được ô nào'))
        + (skipped ? ' · bỏ qua ' + formatSelNumber(skipped) + ' ô không sửa được' : ''), table);
    }
    if (detail.pending.length) Promise.all(detail.pending).then(finish, finish); else finish();
  }
  function onSelectionPaste(event) {
    if (event.defaultPrevented || !sel || !sel.painted.size || !event.clipboardData || cellEditOff() || selectionFieldFocused()) return;
    var text = event.clipboardData.getData('text/plain');
    if (text === '' || text == null) return;
    event.preventDefault();
    editSelection('paste', parseClipboardTable(text));
  }
  function installSelection() {
    document.addEventListener('mousedown', onSelectionDown, true);
    document.addEventListener('mousemove', onSelectionMove, true);
    document.addEventListener('mouseup', endGesture, true);
    document.addEventListener('selectstart', function (event) { if (gesture && gesture.claimed) event.preventDefault(); }, true);
    document.addEventListener('click', function (event) {
      if (!suppressClick) return;
      suppressClick = false; event.stopPropagation(); event.preventDefault();
    }, true);
    document.addEventListener('keydown', onSelectionKey);
    document.addEventListener('copy', onSelectionCopy);
    document.addEventListener('cut', onSelectionCut);
    document.addEventListener('paste', onSelectionPaste);
    window.addEventListener('blur', endGesture);
  }

  function start() {
    if (!window.document || !document.body) return;
    document.addEventListener('keydown', onGridKeydown);
    installSelection();
    refreshAll();
    fetchPrefs();
    new MutationObserver(function (records) {
      if (records.some(function (record) {
        var target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target || target.closest('.tks-columns-overlay,.tks-table-tools,colgroup,.tks-column-resizer,.tks-sel-sum')) return false;
        if (record.type === 'attributes') {
          // Tô / bỏ tô ô đang chọn (tks-cell-selected, tks-selecting) là việc của chính ta: không dựng lại cả trang vì nó.
          if (record.attributeName === 'class' && /tks-cell-selected|tks-selecting/.test((record.oldValue || '') + ' ' + target.className)) return false;
          return !target.closest('table.tks-controlled-table');
        }
        return true;
      })) schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['hidden', 'class', 'style', 'open'] });
    window.addEventListener('resize', schedule);
    if (document.fonts) document.fonts.ready.then(schedule);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
