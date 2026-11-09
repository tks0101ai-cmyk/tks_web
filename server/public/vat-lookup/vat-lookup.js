// Kế toán – Tra cứu VAT (thay app Apps Script "Tra cứu VAT").
// Ghép dữ liệu + tìm kiếm chạy ở server (/api/vat-lookup); trang chỉ gửi ô tìm kiếm và vẽ 2 bảng.
(function () {
  'use strict';

  const API = '/api/vat-lookup';
  // Số lượng trong sheet dùng dấu phẩy phân cách hàng nghìn — giữ như app cũ (fmtSheetQuantity).
  const qtyFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

  const state = { mode: 'vat', result: null, loading: false, error: '', requestSeq: 0, pages:{vat:1,incoming:1}, sorts:{vat:[],incoming:[]}, timer:null, controller:null, query:'' };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  const fmtQty = n => qtyFormat.format(Number(n) || 0);

  async function api(path, options = {}) {
    const response = await fetch(API + path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: options.signal
    });
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Lỗi ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // ---------- Vẽ ----------
  function badge(kind, label) {
    return `<span class="vl-badge" data-kind="${kind}"><span class="vl-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
  }

  function emptyState(title, desc) {
    return `<div class="vl-empty"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(desc)}</p></div>`;
  }

  function feedbackHtml(result) {
    const notes = [];
    // Trang không còn dòng nguồn dữ liệu: chỉ báo khi Sheets lỗi và kết quả lấy từ bản đã lưu.
    if (result.meta && result.meta.stale) notes.push('<b>Sheets đang lỗi</b>, kết quả lấy từ dữ liệu đã lưu trước đó.');
    if (result.notFoundQueries.length) notes.push(`<b>Không tìm thấy ${result.notFoundQueries.length}:</b> ${result.notFoundQueries.map(escapeHtml).join(', ')}`);
    if (result.ignoredCount) notes.push(`<b>Chưa xử lý ${result.ignoredCount} dòng cuối</b> vì mỗi lượt tìm tối đa 100 dòng.`);
    return notes.length ? `<div class="vl-feedback" role="status">${notes.join('<br>')}</div>` : '';
  }

  function limitNote(shown, total) {
    return total > shown ? `<p class="vl-limit" role="status">Đang hiển thị ${shown}/${total} dòng đầu. Hãy dùng từ khóa cụ thể hơn để thu gọn kết quả.</p>` : '';
  }

  /** columns: { key, label, width, num?, cell(row) -> HTML, sort?(row) -> số } */
  function tableHtml(key, columns, rows) {
    const remote=Number.isFinite(state.result?.[state.mode]?.page);
    const head = columns.map(c => `<th scope="col" data-column-key="${c.key}" data-default-width="${c.width}"${c.num || remote ? ` class="${c.num?'num ':''}${remote?'sortable':''}"` : ''}>${remote ? `<button type="button" class="sort-button" data-sort="${c.key}"><span class="sort-label">${escapeHtml(c.label)}</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button>` : escapeHtml(c.label)}</th>`).join('');
    const body = rows.map(row => `<tr>${columns.map(c => {
      const sort = c.sort ? ` data-sort-value="${c.sort(row)}"` : '';
      return `<td${c.num ? ' class="num"' : ''}${sort}>${c.cell(row)}</td>`;
    }).join('')}</tr>`).join('');
    // Máy tính: lần đầu co / giãn các cột theo tỉ lệ cho vừa khung (không có thanh cuộn ngang);
    // điện thoại: giữ độ rộng, cuộn ngang trong khung bảng.
    const fit = window.innerWidth > 600 ? ' data-table-fit="fill"' : '';
    return `<div class="vl-scroll"><table class="vl-table" data-table-key="${key}"${remote ? '' : ' data-table-sort="local"'} data-columns-button="vlColumns"${fit}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  const mono = value => `<span class="vl-mono">${escapeHtml(value) || '—'}</span>`;
  const text = value => escapeHtml(value) || '—';

  const VAT_COLUMNS = [
    { key: 'maKiot', label: 'Mã Kiot', width: 90, cell: r => mono(r.maKiot) },
    { key: 'tenKiot', label: 'Tên Kiot', width: 190, cell: r => escapeHtml(r.tenKiot) || '<i>(chưa có tên)</i>' },
    { key: 'maVat', label: 'Mã VAT Kiot', width: 95, cell: r => mono(r.maVat) },
    { key: 'tenVat', label: 'Tên VAT Kiot', width: 190, cell: r => text(r.tenVat) },
    { key: 'tenHang', label: 'Tên hàng', width: 340, cell: r => text(r.tenHang) },
    { key: 'dvt', label: 'ĐVT', width: 70, cell: r => text(r.dvt) },
    { key: 'tongThueMat', label: 'TỔNG THUẾ MẤT (thuế xuất)', width: 150, num: true, cell: r => text(r.tongThueMat) },
    { key: 'tonDauNgay', label: 'Tồn đầu ngày', width: 140, num: true, cell: r => fmtQty(r.tonDauNgay), sort: r => r.tonDauNgay },
    { key: 'tonCoTheNhap', label: 'Tồn có thể nháp', width: 160, num: true, cell: r => fmtQty(r.tonCoTheNhap), sort: r => r.tonCoTheNhap },
    {
      key: 'trangThai', label: 'Trạng thái', width: 150, sort: r => (r.conVAT ? 1 : 0),
      cell: r => [r.conVAT ? badge('ok', 'Còn VAT') : badge('off', 'Không còn VAT'), r.hasIncoming ? badge('warn', 'Chuẩn bị về') : ''].join(' ')
    }
  ];

  function incomingColumns(extraKeys) {
    return [
      { key: 'cont', label: 'CONT', width: 120, cell: r => mono(r.cont) },
      { key: 'maKiot', label: 'Mã Kiot', width: 140, cell: r => mono(r.maKiot) },
      { key: 'tenKiot', label: 'Tên Kiot', width: 280, cell: r => text(r.tenKiot) },
      { key: 'trangThai', label: 'Trạng thái', width: 180, sort: r => r.trangThaiSo ?? 0, cell: r => badge('warn', r.trangThai || 'Chuẩn bị về') },
      { key: 'soLuong', label: 'Số lượng', width: 140, num: true, sort: r => r.soLuong || 0, cell: r => (r.hasSoLuong ? fmtQty(r.soLuong) : '—') },
      ...extraKeys.map((k, i) => ({ key: 'extra' + i, label: k, width: 200, cell: r => text(r.extra[k]) }))
    ];
  }

  function pager(data) {
    if(!Number.isFinite(data.page))return limitNote(data.rows.length,data.total);
    const pages=Math.max(1,Math.ceil(data.totalRows/data.pageSize));
    return `<div class="pagination-controls" aria-label="Phân trang"><button type="button" data-page="1" ${data.page<=1?'disabled':''} aria-label="Trang đầu">&lt;&lt;</button><button type="button" data-page="${data.page-1}" ${data.page<=1?'disabled':''} aria-label="Trang trước">&lt;</button><span>Trang ${data.page}/${pages} · ${data.totalRows} dòng</span><button type="button" data-page="${data.page+1}" ${data.page>=pages?'disabled':''} aria-label="Trang sau">&gt;</button><button type="button" data-page="${pages}" ${data.page>=pages?'disabled':''} aria-label="Trang cuối">&gt;&gt;</button></div>`;
  }

  function renderVat(result) {
    const vat = result.vat;
    return feedbackHtml(result)
      + tableHtml('vat-lookup-vat-v2', VAT_COLUMNS, vat.rows) + pager(vat);
  }

  function renderIncoming(result) {
    const incoming = result.incoming;
    if (!incoming.total) {
      const scope = result.queries.length > 1 ? `${result.productCount} sản phẩm đã tìm thấy` : `sản phẩm khớp “${result.queries[0]}”`;
      // Liệt kê dòng DK về 2 (mọi trạng thái) của các mã đã khớp để thấy ngay vì sao không có hàng sắp về.
      const debug = incoming.debug.length
        ? `<div class="vl-feedback" role="status">Sheet DK về 2 có ${incoming.debug.length} dòng cho mã Kiot khớp tìm kiếm, nhưng không dòng nào ở trạng thái 1–3:<br>`
          + incoming.debug.map(r => `Mã Kiot <b>${escapeHtml(r.maKiot)}</b> — Trạng thái: “${escapeHtml(r.trangThai) || '(trống)'}” (dòng ${r.rowNumber})`).join('<br>') + '</div>'
        : '';
      return feedbackHtml(result) + debug
        + emptyState('Không có hàng chuẩn bị về', `Không có ${scope} đang ở trạng thái chuẩn bị về (1–3).`);
    }
    return feedbackHtml(result)
      + tableHtml('vat-lookup-incoming-v2', incomingColumns(incoming.extraKeys), incoming.rows) + pager(incoming);
  }

  function render() {
    const box = $('vlResults');
    const result = state.result;
    $('vlCountVat').textContent = result && result.queries.length ? String(result.vat.total) : '';
    $('vlCountIncoming').textContent = result && result.queries.length ? String(result.incoming.total) : '';
    if (state.loading && !result) {
      box.innerHTML = '<div class="vl-empty"><div class="vl-spinner" aria-hidden="true"></div><h3>Đang tìm…</h3><p>Lần đầu cần đọc 3 sheet, có thể mất vài giây.</p></div>';
    } else if (state.error) {
      box.innerHTML = emptyState('Không đọc được dữ liệu', state.error);
    } else if (!result || !result.queries.length) {
      box.innerHTML = emptyState('Nhập mã Kiot hoặc tên Kiot để tra cứu', 'Ví dụ: nhập mã sản phẩm hoặc một phần tên, sau đó nhấn Enter.');
    } else if (!result.productCount) {
      const msg = result.queries.length > 1
        ? `Không có Mã Kiot hoặc Tên Kiot khớp với ${result.queries.length} từ khóa đã nhập. Hãy kiểm tra lại danh sách.`
        : `Không có Mã Kiot hoặc Tên Kiot khớp “${result.queries[0]}”. Hãy kiểm tra lại chính tả hoặc thử một phần tên khác.`;
      box.innerHTML = feedbackHtml(result) + emptyState('Không tìm thấy sản phẩm', msg);
    } else {
      box.innerHTML = state.mode === 'incoming' ? renderIncoming(result) : renderVat(result);
    }
    box.classList.toggle('is-loading', state.loading && !!result);
    const table = box.querySelector('table');
    $('vlColumns').hidden = !table;
    if (table && window.TKSTables) {
      window.TKSTables.refresh(table);
      if(Number.isFinite(result?.[state.mode]?.page)) {
        window.TKSTables.syncSortHeaders(table,state.sorts[state.mode],th=>th.dataset.columnKey);
        table.querySelectorAll('[data-sort]').forEach(button=>button.addEventListener('click',event=>{
          state.sorts[state.mode]=window.TKSTables.nextSorts(state.sorts[state.mode],button.dataset.sort,event.shiftKey);
          state.pages[state.mode]=1;search(false);
        }));
      }
    }
    box.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{
      state.pages[state.mode]=Number(button.dataset.page);search(false);
    }));
  }

  function setMode(mode) {
    state.mode = mode;
    ['vlTabVat', 'vlTabIncoming'].forEach(id => $(id).setAttribute('aria-selected', String($(id).dataset.mode === mode)));
    render();
  }

  // ---------- Dữ liệu ----------
  async function search(reset = true) {
    clearTimeout(state.timer);
    const seq = ++state.requestSeq;
    state.controller?.abort();state.controller=new AbortController();
    const q = $('vlQuery').value;
    if(reset || q!==state.query)state.pages={vat:1,incoming:1};
    state.query=q;
    if (!q.trim()) { state.result = null; state.error = ''; state.loading=false; $('vlSubmit').disabled=false; render(); return; }
    state.loading = true; state.error = '';
    $('vlSubmit').disabled = true;
    render();
    try {
      const data = await api('/search', { method: 'POST', signal:state.controller.signal, body: { q, vatPage:state.pages.vat,vatPageSize:100,vatSorts:state.sorts.vat,incomingPage:state.pages.incoming,incomingPageSize:100,incomingSorts:state.sorts.incoming } });
      if (seq !== state.requestSeq) return;
      state.result = data;
      for(const mode of ['vat','incoming'])if(Number.isFinite(data[mode]?.page))state.pages[mode]=data[mode].page;
    } catch (error) {
      if (seq !== state.requestSeq) return;
      state.error = error.message;
    } finally {
      if (seq === state.requestSeq) {
        state.loading = false;
        $('vlSubmit').disabled = false;
        render();
      }
    }
  }

  function syncTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    $('themeToggle').setAttribute('aria-pressed', String(light));
  }

  function autoGrow(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
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

    $('vlForm').addEventListener('submit', event => { event.preventDefault(); search(); });
    // Enter = tìm; Ctrl/⌘ + Enter = xuống dòng (giống app cũ). Dán nhiều dòng vẫn giữ nguyên.
    $('vlQuery').addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const input = event.currentTarget;
        input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        autoGrow(input);
        return;
      }
      search();
    });
    $('vlQuery').addEventListener('input', event => {
      autoGrow(event.currentTarget);++state.requestSeq;state.controller?.abort();clearTimeout(state.timer);
      if(!event.currentTarget.value.trim()){search();return;}
      state.timer=setTimeout(()=>search(),250);
    });
    $('vlTabVat').addEventListener('click', () => setMode('vat'));
    $('vlTabIncoming').addEventListener('click', () => setMode('incoming'));
  }

  async function init() {
    syncTheme();
    bindEvents();
    const user = await window.TKSNav.authGuard();
    window.TKSNav.renderTopSidebar($('sidebar'), 'accounting', user);
    window.TKSNav.renderAccountingTabs($('vlTabs'));
    render();
    $('vlQuery').focus();
    // Đọc trước 3 sheet (cache server 10 phút) để lượt tìm đầu nhanh; lỗi sẽ hiện khi tìm.
    await api('/meta').catch(() => {});
  }

  window.TKSVatLookup = { init };
})();
