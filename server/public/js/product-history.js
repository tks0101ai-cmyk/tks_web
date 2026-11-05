(function () {
  'use strict';
  const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 6 });
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const day = value => value.slice(0, 10).split('-').reverse().join('/');
  const labels = { invoice: 'Hóa đơn', return: 'Trả hàng', order: 'Đơn hàng Phiếu tạm' };
  const columns = [
    ['time','Thời gian',145], ['type','Loại giao dịch',155], ['documentCode','Mã giao dịch',140],
    ['customerName','Khách hàng',170], ['quantity','Số lượng',100]
  ];
  let currentExportState = () => null;
  function mount(root, options) {
    let page = 1, generation = 0, timer, sort = '', dir = '', ready = false;
    const active = () => root.isConnected && options.isCurrent();
    root.innerHTML = '<div class="dp-section-head"><h3 class="dp-section-title">Lịch sử giao dịch 90 ngày</h3>' +
      '<button class="dp-btn" data-action="export" type="button" hidden disabled>Xuất Excel</button></div>' +
      '<div class="product-history-filters"><label>Tìm khách hàng<input type="search" placeholder="Nhập tên khách hàng…" autocomplete="off"></label>' +
      '<label>Loại giao dịch<select><option value="all">Tất cả</option><option value="invoice">Hóa đơn</option><option value="return">Trả hàng</option>' +
      '<option value="order">Đơn hàng Phiếu tạm</option></select></label></div><div class="product-history-results" aria-live="polite"></div>';
    const input = root.querySelector('input'), select = root.querySelector('select'), results = root.querySelector('.product-history-results');
    const exportButton = root.querySelector('[data-action="export"]');
    const canExport = () => !!(window.TKSNav && window.TKSNav.can('reports.export'));
    currentExportState = function () {
      if (!active() || !ready || !canExport()) return null;
      const table = results.querySelector('table');
      const state = window.TKSTables && window.TKSTables.getState ? window.TKSTables.getState(table) : null;
      const visible = state ? state.columns.filter(c => !c.hidden).map(c => c.key)
        : Array.from(table.querySelectorAll('th')).filter(th => th.dataset.columnDefaultHidden !== 'true').map(th => th.dataset.columnKey);
      const column = columns.find(c => c[0] === sort);
      return { context: { productCode: options.code, historyType: select.value, historyQuery: input.value },
        ...(column ? { tableSort: { label: column[1], direction: dir } } : {}), columns: { product_history: visible } };
    };
    function render(data) {
      const stats = [['purchaseQuantity','Số lượng mua'],['purchaseCount','Số lượt mua'],['returnQuantity','Số lượng trả'],
        ['orderQuantity','Số lượng đặt']];
      const cost = data.canViewCost === true;
      const heading = columns.map(([key,label,width]) => {
        const mode = sort === key ? dir : key === 'time' && !sort ? 'desc' : '';
        return '<th data-column-key="' + key + '" data-sort="' + key + '" data-min-width="' + width + '" aria-sort="' +
          (mode === 'asc' ? 'ascending' : mode === 'desc' ? 'descending' : 'none') + '"' + (key === 'quantity' ? ' class="num"' : '') +
          '><button class="sort-button" type="button" aria-label="Sắp xếp theo ' + label + '">' + label +
          '<span class="sort-indicator" aria-hidden="true">' + (mode === 'asc' ? '▼' : mode === 'desc' ? '▲' : '▲▼') + '</span></button></th>';
      }).join('');
      results.innerHTML = '<div class="dp-stats">' + stats.map(([key,label]) => '<div class="dp-stat is-' + key + '"><div class="dp-stat-label">' + label +
        '</div><div class="dp-stat-value" data-stat="' + key + '">' + number.format(data.summary[key] || 0) + '</div></div>').join('') + '</div>' +
        '<p class="dp-note">' + escape(day(data.from)) + ' – ' + escape(day(data.to)) + ' · ' + number.format(data.totalRows) + ' giao dịch' +
        (cost ? ' · Giá vốn một đơn vị lúc giao dịch; “—” khi nguồn chưa có dữ liệu.' : '') + '</p>' +
        '<div class="dp-table-wrap"><table class="dp-table" data-table-key="product-history" data-table-sort="off"><thead><tr>' + heading +
        (cost ? '<th data-column-key="unitCost" data-column-default-hidden="true" data-min-width="100" class="num">Giá vốn</th>' : '') + '</tr></thead><tbody>' +
        data.rows.map(row => '<tr><td>' + escape(day(row.time) + ' ' + row.time.slice(11,16)) + '</td><td><span class="dp-pill ' +
          (row.type === 'return' ? 'is-warn' : row.type === 'invoice' ? 'is-ok' : '') + '">' + escape(labels[row.type]) + '</span></td>' +
          '<td>' + escape(row.documentCode) + ' · ' + (row.branch === 'hanoi' ? 'HN' : 'SG') + '</td><td>' + escape(row.customerName) + '</td>' +
          '<td class="num">' + number.format(row.quantity) + '</td>' + (cost ? '<td class="num">' +
          (row.unitCost == null ? '—' : escape(number.format(row.unitCost) + 'đ')) + '</td>' : '') + '</tr>').join('') +
        '</tbody></table></div>' + (!data.rows.length ? '<p class="dp-state">Không có giao dịch phù hợp.</p>' : '') +
        '<div class="product-history-pages"><button class="dp-btn" data-action="prev" type="button">Trước</button><span></span>' +
        '<button class="dp-btn" data-action="next" type="button">Sau</button></div>';
      page = data.page;
      const totalPages = Math.max(1, Math.ceil(data.totalRows / data.pageSize));
      results.querySelector('.product-history-pages span').textContent = 'Trang ' + page + ' / ' + totalPages;
      results.querySelector('[data-action="prev"]').disabled = page <= 1;
      results.querySelector('[data-action="next"]').disabled = page >= totalPages;
      if (window.TKSTables) window.TKSTables.enhance(results.querySelector('table'), { sort: false });
      ready = true;
      exportButton.hidden = !canExport();
      exportButton.disabled = data.totalRows === 0;
    }
    function loading() {
      ready = false; exportButton.disabled = true;
      results.setAttribute('aria-busy', 'true');
      results.innerHTML = '<div class="dp-state">Đang tải lịch sử giao dịch…</div>';
    }
    async function load() {
      clearTimeout(timer);
      if (!active()) return;
      const request = ++generation;
      loading();
      const query = new URLSearchParams({ code: options.code, q: input.value, type: select.value, page: String(page), pageSize: '25' });
      if (sort) { query.set('sort', sort); query.set('dir', dir); }
      try {
        const response = await fetch('/api/product-report/history?' + query);
        if (!response.ok) throw new Error('history');
        const data = await response.json();
        if (!active() || request !== generation) return;
        render(data);
      } catch (_) {
        if (!active() || request !== generation) return;
        results.innerHTML = '<div class="dp-state">Không tải được lịch sử giao dịch.<br><button class="dp-btn" data-action="retry" type="button">Thử lại</button></div>';
      } finally {
        if (active() && request === generation) results.setAttribute('aria-busy', 'false');
      }
    }
    input.addEventListener('input', function () {
      page = 1; ++generation; clearTimeout(timer); loading(); timer = setTimeout(load, 180);
    });
    select.addEventListener('change', function () { page = 1; load(); });
    root.addEventListener('click', function (event) {
      const heading = event.target.closest('th[data-sort]');
      if (heading && (event.target.closest('button') || event.target === heading)) {
        const key = heading.dataset.sort;
        if (sort !== key) { sort = key; dir = 'asc'; }
        else if (dir === 'asc') dir = 'desc';
        else { sort = ''; dir = ''; }
        page = 1; load(); return;
      }
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      if (button.dataset.action === 'export') {
        if (currentExportState() && typeof window.openExportDialog === 'function') window.openExportDialog('products.productHistory');
        return;
      }
      if (button.dataset.action === 'prev') --page;
      if (button.dataset.action === 'next') ++page;
      load();
    });
    load();
  }
  window.TKSProductHistory = { mount: mount, exportState: () => currentExportState() };
}());
