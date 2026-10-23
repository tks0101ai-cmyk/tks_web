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
  function copyColumns(source) {
    var out = {};
    Object.keys(source).forEach(function (key) { out[key] = Object.assign({}, source[key]); });
    return out;
  }
  function applySaved(session, column) {
    var saved = session.dirty[column.key];
    if (!saved) return;
    if (typeof saved.width === 'number' && saved.width > 0) { column.width = Math.max(MIN_WIDTH, saved.width); session.fitted = true; }
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
      session.columns.forEach(function (column) { applySaved(session, column); if (column.locked) column.hidden = false; });
    });
    if (window.document && document.body) refreshAll();
  }
  // Biểu tượng sắp xếp dùng chung cả hệ thống (xem "Tiêu đề cột sắp xếp được" trong shared.css):
  // chưa sắp ▲▼ · tăng dần ▼ · giảm dần ▲.
  var SORT_GLYPH = { none: '▲▼', ascending: '▼', descending: '▲' };
  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line><line x1="15" y1="4" x2="15" y2="20"></line></svg>';

  function screenMode() { return window.innerWidth <= 600 ? 'mobile' : 'desktop'; }
  function labelOf(cell) {
    var copy = cell.cloneNode(true);
    copy.querySelectorAll('.tks-column-resizer,.sort-indicator,.sort-ind,.sort,.locations-sort-icon').forEach(function (node) { node.remove(); });
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
    ctrl.columns.forEach(function (column) { column.minWidth = MIN_WIDTH; });
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
          Array.from(select.options).forEach(function (option) {
            var label = option.label, key = textContext.font + '\u001f' + label;
            if (!measured.has(key)) measured.set(key, textContext.measureText(label).width);
            width = Math.max(width, measured.get(key) + Math.max(0, label.length - 1) * spacing);
          });
          width += horizontalSpace(style) + (style.appearance === 'none' ? 8 : 24);
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
  function fitOnce(ctrl) {
    if (ctrl.table.dataset.tableFit === 'off') return;
    if (ctrl.session.fitted || !hasLayout(ctrl.table)) return;
    var wrapper = ctrl.table.parentElement;
    var width = wrapper.clientWidth;
    var visible = ctrl.columns.filter(function (column) { return !column.hidden && !column.suppressed; });
    var total = visible.reduce(function (sum, column) { return sum + column.width; }, 0);
    if (width > total && total) visible.forEach(function (column) { column.width *= width / total; });
    // Bảng trong hộp chi tiết (.dp-table) nằm trong khung hẹp: co đều các cột cho vừa khung ở lần đầu,
    // không để mặc định 160px/cột làm bảng tràn ngang ngay khi mở hộp. Người dùng vẫn kéo rộng sau đó.
    else if (width && total > width && (ctrl.table.dataset.tableFit === 'fill' || ctrl.table.classList.contains('dp-table'))) {
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
        resize(current, col, col.width + (event.key === 'ArrowRight' ? 10 : -10));
      });
      handle.addEventListener('pointerdown', function (event) {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        finishDrag();
        var current = controllers.get(ctrl.table), col = current.columns.find(function (item) { return item.key === handle.dataset.columnKey; });
        drag = { ctrl: current, column: col, handle: handle, id: event.pointerId, x: event.clientX, width: col.width };
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
      shown.forEach(function (column, index) { changeStyle(group.children[index], 'width', column.width + 'px'); });
      ['width', 'min-width', 'max-width'].forEach(function (property) { changeStyle(table, property, Math.max(MIN_WIDTH, total) + 'px'); });
    }
    ctrl.columns.forEach(function (column, index) {
      if (ctrl.head.leaves[index].span === 1) attachHandle(ctrl, ctrl.head.leaves[index].cell, column);
    });
    table.querySelectorAll('textarea.marketing-edit').forEach(function (editor) {
      editor.style.height = 'auto';
      editor.style.height = Math.max(30, editor.scrollHeight) + 'px';
    });
  }
  function resize(ctrl, column, value) {
    if (!column) return;
    column.width = Math.max(column.minWidth || MIN_WIDTH, value); ctrl.session.fitted = true; apply(ctrl);
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
    event.preventDefault(); resize(drag.ctrl, drag.column, drag.width + event.clientX - drag.x);
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
  function sortValue(cell) {
    if (cell.hasAttribute('data-sort-value')) {
      var given = Number(cell.getAttribute('data-sort-value'));
      return { empty: !Number.isFinite(given), number: given, text: '' };
    }
    var text = cell.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text === '—' || text === '-') return { empty: true, number: null, text: '' };
    var number = parseDateText(text);
    if (number === null) number = parseNumberText(text);
    return { empty: false, number: number, text: text };
  }
  // Dòng được phép đổi chỗ: mọi ô đều đơn (không gộp cột) — dòng ghi chú "Không có dữ liệu", dòng nhóm đứng yên tại chỗ.
  function sortableRows(ctrl) {
    var body = ctrl.table.tBodies[0], count = ctrl.head.leaves.length;
    return body ? Array.from(body.rows).filter(function (row) {
      return row.cells.length === count && Array.from(row.cells).every(function (cell) { return (Number(cell.dataset.tksColspan) || cell.colSpan) === 1; });
    }) : [];
  }
  function sortHeaderState(ctrl) {
    ctrl.head.leaves.forEach(function (entry, index) {
      var button = entry.cell.querySelector(':scope > .sort-button[data-tks-sort]');
      if (!button) return;
      var dir = ctrl.sort && ctrl.sort.index === index ? ctrl.sort.dir : '';
      var state = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';
      var action = dir === 'asc' ? 'Sắp xếp giảm dần' : dir === 'desc' ? 'Bỏ sắp xếp' : 'Sắp xếp tăng dần';
      var label = ctrl.columns[index] ? ctrl.columns[index].label : '';
      var mark = button.querySelector('.sort-indicator');
      entry.cell.setAttribute('aria-sort', state);
      // Chỉ ghi khi đổi: ghi lại cùng chữ vẫn là 1 thay đổi DOM và sẽ kích hoạt MutationObserver vẽ lại vô hạn.
      if (mark.textContent !== SORT_GLYPH[state]) mark.textContent = SORT_GLYPH[state];
      button.title = action + ' theo ' + label;
      button.setAttribute('aria-label', action + ' theo cột ' + label);
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
    var sort = ctrl.sort, factor = sort && sort.dir === 'desc' ? -1 : 1;
    var keyed = movable.map(function (row) {
      return { row: row, order: Number(row.dataset.tksOrder), value: sort ? sortValue(row.cells[sort.index]) : null };
    });
    keyed.sort(function (a, b) {
      if (!sort) return a.order - b.order;
      if (a.value.empty !== b.value.empty) return a.value.empty ? 1 : -1; // ô trống luôn xuống cuối, cả 2 chiều
      var result = a.value.number !== null && b.value.number !== null ? a.value.number - b.value.number
        : a.value.text.localeCompare(b.value.text, 'vi', { numeric: true, sensitivity: 'base' });
      return result ? result * factor : a.order - b.order;
    });
    var queue = keyed.map(function (item) { return item.row; }), next = 0;
    var ordered = all.map(function (row) { return movableSet.has(row) ? queue[next++] : row; });
    var fragment = document.createDocumentFragment();
    ordered.forEach(function (row) { fragment.appendChild(row); });
    body.appendChild(fragment);
    ctrl.sortedRows = ordered;
  }
  function cycleSort(ctrl, index) {
    var current = ctrl.sort;
    if (!current || current.index !== index) ctrl.sort = { index: index, dir: 'asc' };
    else if (current.dir === 'asc') ctrl.sort = { index: index, dir: 'desc' };
    else ctrl.sort = null;
    ctrl.sortByUser = true;
    ctrl.session.sort = ctrl.sort && ctrl.columns[ctrl.sort.index] ? { key: ctrl.columns[ctrl.sort.index].key, dir: ctrl.sort.dir } : null;
    scheduleSave(ctrl.session);
    applySort(ctrl);
  }
  // Khôi phục sắp xếp đã lưu (theo khóa cột) trừ khi người dùng đã tự sắp xếp bảng này trong lần xem hiện tại.
  function restoreSort(ctrl) {
    if (ctrl.sortByUser) return;
    var saved = ctrl.session.sort, signature = saved ? saved.key + '|' + saved.dir : '';
    if (ctrl.sortRestored === signature) return;
    ctrl.sortRestored = signature;
    var index = saved ? ctrl.columns.findIndex(function (column) { return column.key === saved.key; }) : -1;
    ctrl.sort = index >= 0 ? { index: index, dir: saved.dir } : null;
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
      function toggle() {
        var current = controllers.get(ctrl.table), position = current.head.leaves.findIndex(function (item) { return item.cell === cell; });
        if (position >= 0) cycleSort(current, position);
      }
      button.addEventListener('click', function (event) { event.preventDefault(); toggle(); });
      // Bấm vào phần đệm của ô tiêu đề (ngoài nút) cũng sắp xếp, như các bảng chính.
      cell.addEventListener('click', function (event) { if (event.target === cell) toggle(); });
    });
    if (ctrl.sort && ctrl.sort.index >= ctrl.head.leaves.length) ctrl.sort = null;
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
      session = { columns: new Map(), fitted: false, key: key, mode: mode, dirty: copyColumns(savedColumns(key, mode)), sort: savedSort(key, mode) };
      sessions.set(sessionKey, session);
    }
    ctrl.key = key; ctrl.mode = mode; ctrl.session = session; ctrl.head = head;
    var used = new Set();
    ctrl.columns = head.leaves.map(function (entry, index) {
      var cell = entry.cell, metadata = ctrl.options.columns && ctrl.options.columns[index] || {};
      var label = metadata.label || labelOf(cell);
      var colKey = metadata.key || cell.dataset.columnKey || cell.dataset.field || cell.dataset.col || cell.dataset.sort || label;
      // Repeated headings remain distinct; explicit field keys take priority.
      if (used.has(colKey)) colKey += ':' + index; used.add(colKey);
      var column = session.columns.get(colKey);
      if (!column) {
        column = { key: colKey, width: Math.max(MIN_WIDTH, pxWidth(metadata.width) || pxWidth(cell.dataset.defaultWidth) || pxWidth(cell.style.width) || defaultWidth(colKey, label, cell)), hidden: !!metadata.hidden || cell.dataset.columnDefaultHidden === 'true', locked: !!metadata.locked };
        session.columns.set(colKey, column);
        applySaved(session, column);
      }
      column.label = label; column.locked = !!metadata.locked || cell.dataset.columnLocked === 'true';
      column.unlisted = cell.dataset.columnUnlisted === 'true';
      if (column.locked) column.hidden = false;
      return column;
    });
    if (ctrl.columns.every(function (column) { return column.hidden; })) ctrl.columns[0].hidden = false;
    table.classList.add('tks-controlled-table'); restoreSort(ctrl); installSort(ctrl); installButton(ctrl); dropdownMinimums(ctrl); numberMinimums(ctrl); apply(ctrl);
    if (active === ctrl && picker && !picker.hidden) renderPicker();
    return ctrl;
  }
  function refresh(table) { return enhance(table); }
  function refreshAll() {
    if (!window.document || !document.body) return;
    document.querySelectorAll('table').forEach(function (table) { enhance(table); });
    if (drag && !drag.handle.isConnected) finishDrag();
    if (active && !active.table.isConnected) closePicker();
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
      columns: ctrl.columns.map(function (col) { return { key: col.key, label: col.label, width: col.width, hidden: col.hidden, locked: col.locked }; })
    };
  }
  window.TKSTables = { enhance: enhance, refresh: refresh, refreshAll: refreshAll, getState: getState, loadPrefs: loadPrefs };
  function fetchPrefs() {
    if (typeof fetch !== 'function' || !/^https?:$/.test(window.location.protocol)) return;
    // Trang chưa đăng nhập trả 401: bỏ qua, bảng dùng mặc định và không gửi lưu.
    fetch(PREFS_URL, { credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (body) { if (body && body.tables) loadPrefs(body.tables); })
      .catch(function () { /* dùng cấu hình mặc định */ });
  }
  function start() {
    if (!window.document || !document.body) return;
    refreshAll();
    fetchPrefs();
    new MutationObserver(function (records) {
      if (records.some(function (record) {
        var target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (!target || target.closest('.tks-columns-overlay,.tks-table-tools,colgroup,.tks-column-resizer')) return false;
        if (record.type === 'attributes') return !target.closest('table.tks-controlled-table');
        return true;
      })) schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'open'] });
    window.addEventListener('resize', schedule);
    if (document.fonts) document.fonts.ready.then(schedule);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
