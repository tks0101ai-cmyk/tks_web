(function () {
  'use strict';
  const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 6 });
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const day = value => value.slice(0, 10).split('-').reverse().join('/');
  function mount(root, options) {
    let page = 1, generation = 0, timer;
    const active = () => root.isConnected && options.isCurrent();
    root.innerHTML = '<div class="dp-section-head"><h3 class="dp-section-title">Lịch sử giao dịch 90 ngày</h3></div>' +
      '<div class="product-history-filters"><label>Tìm khách hàng<input type="search" placeholder="Nhập tên khách hàng…" autocomplete="off"></label>' +
      '<label>Loại giao dịch<select><option value="all">Tất cả</option><option value="invoice">Hóa đơn</option><option value="return">Trả hàng</option></select></label></div>' +
      '<div class="product-history-results" aria-live="polite"></div>';
    const input = root.querySelector('input'), select = root.querySelector('select'), results = root.querySelector('.product-history-results');
    function render(data) {
      const stats = [['purchaseQuantity','Số lượng mua'],['returnQuantity','Số lượng trả hàng'],['purchaseCount','Số lượt mua'],['returnCount','Số lượt trả hàng']];
      const cost = data.canViewCost === true;
      results.innerHTML = '<div class="dp-stats">' + stats.map(([key,label]) => '<div class="dp-stat"><div class="dp-stat-label">' + label +
        '</div><div class="dp-stat-value" data-stat="' + key + '">' + number.format(data.summary[key]) + '</div></div>').join('') + '</div>' +
        '<p class="dp-note">' + escape(day(data.from)) + ' – ' + escape(day(data.to)) + ' · ' + number.format(data.totalRows) + ' giao dịch' +
        (cost ? ' · Giá vốn một đơn vị lúc giao dịch; “—” khi nguồn chưa có dữ liệu.' : '') + '</p>' +
        '<div class="dp-table-wrap"><table class="dp-table" data-table-key="product-history" data-table-sort="off"><thead><tr>' +
        '<th data-column-key="time" data-min-width="145">Thời gian</th><th data-column-key="customer" data-min-width="170">Đối tượng</th><th data-column-key="type" data-min-width="145">Loại giao dịch</th>' +
        '<th data-column-key="quantity" data-min-width="100" class="num">Số lượng</th>' + (cost ? '<th data-column-key="unitCost" data-min-width="100" class="num">Giá vốn</th>' : '') + '</tr></thead><tbody>' +
        data.rows.map(row => '<tr><td>' + escape(day(row.time) + ' ' + row.time.slice(11,16)) + '</td><td>' + escape(row.customerName) +
          '</td><td><span class="dp-pill ' + (row.type === 'return' ? 'is-warn' : 'is-ok') + '">' + (row.type === 'return' ? 'Trả hàng' : 'Hóa đơn') +
          '</span><small class="product-history-document">' + escape(row.documentCode) + ' · ' + (row.branch === 'hanoi' ? 'HN' : 'SG') + '</small></td>' +
          '<td class="num">' + number.format(row.quantity) + '</td>' + (cost ? '<td class="num">' + (row.unitCost == null ? '—' : escape(number.format(row.unitCost) + 'đ')) + '</td>' : '') + '</tr>').join('') +
        '</tbody></table></div>' + (!data.rows.length ? '<p class="dp-state">Không có giao dịch phù hợp.</p>' : '') +
        '<div class="product-history-pages"><button class="dp-btn" data-action="prev" type="button">Trước</button><span></span>' +
        '<button class="dp-btn" data-action="next" type="button">Sau</button></div>';
      page = data.page;
      const totalPages = Math.max(1, Math.ceil(data.totalRows / data.pageSize));
      results.querySelector('.product-history-pages span').textContent = 'Trang ' + page + ' / ' + totalPages;
      results.querySelector('[data-action="prev"]').disabled = page <= 1;
      results.querySelector('[data-action="next"]').disabled = page >= totalPages;
      if (window.TKSTables) window.TKSTables.enhance(results.querySelector('table'), { sort: false });
    }
    function loading() {
      results.setAttribute('aria-busy', 'true');
      results.innerHTML = '<div class="dp-state">Đang tải lịch sử giao dịch…</div>';
    }
    async function load() {
      clearTimeout(timer);
      if (!active()) return;
      const request = ++generation;
      loading();
      const query = new URLSearchParams({ code: options.code, q: input.value, type: select.value, page: String(page), pageSize: '25' });
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
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      if (button.dataset.action === 'prev') --page;
      if (button.dataset.action === 'next') ++page;
      load();
    });
    load();
  }
  window.TKSProductHistory = { mount: mount };
}());
