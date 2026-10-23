/* Báo cáo Marketing. Chỉ BC tháng cho sửa Khách mới/Ghi chú (ghi ngược Sheets, cần reports.marketing.edit). */
(function () {
  'use strict';
  const definitions = {
    monthly: { title: 'BC tháng', note: 'doanh số và khách chốt theo tháng đã chọn', monthKey: 'monthly', filters: ['page', 'employee', 'status', 'dataSource'], columns: [['sale','Sale'],['customer','Khách Kiot'],['phone','SĐT'],['page','Page'],['status','Tình trạng'],['dataSource','Nguồn data'],['closedAt','Ngày chốt'],['revenue','Doanh số','money'],['newCustomer','Khách mới'],['note','Ghi chú']] },
    'receipt-check': { title: 'Check tỷ lệ nhận số', note: 'số nhận, chào lại và tỷ lệ chốt theo nhân viên', monthKey: 'check', filters: ['page', 'employee'], columns: [['name','Nhân viên'],['page','Page'],['first','Lần đầu','number'],['repeat','Chào lại','number'],['equivalent','Quy đổi','number'],['closed','Khách chốt','number'],['rate','Tỷ lệ chốt','percent']] },
    phones: { title: 'Sao lưu SĐT', note: 'số điện thoại đã nhận theo page và nhân viên', filters: ['page', 'employee'], columns: [['phone','SĐT'],['page','Page'],['firstEmployee','Nhân viên lần đầu'],['currentEmployee','Nhân viên hiện tại'],['repeatEmployee','Nhân viên chào lại'],['firstAt','Ngày lần đầu'],['currentAt','Ngày hiện tại'],['repeatAt','Ngày chào lại']] },
    costs: { title: 'Báo cáo chi phí', note: 'chi phí quảng cáo, mess và SĐT theo ngày', monthKey: 'costs', beside: true, filters: ['page'], columns: [['page','Page'],['date','Ngày'],['adCost','Chi phí ADS','money'],['totalCost','Chi phí gồm phí thuê/VAT','money'],['totalLabel','Nhãn chi phí nguồn'],['messages','Mess','number'],['costPerMessage','Chi phí/mess','money'],['phones','SĐT','number'],['costPerPhone','Chi phí/SĐT','money']] }
  };
  const detailDefinitions = {'phone-source': {columns:[['phone','SĐT'],['page','Page'],['employeeRaw','Tên nhân viên nguồn'],['sourceCreatedAt','Tạo lúc','datetime'],['observedAt','Quan sát nhân viên lúc','datetime'],['sourceCreatedText','Ngày tạo nguyên bản'],['creditedDate','Ngày ghi nhận','date'],['origin','Nguồn'],['sourceOrder','Thứ tự nguồn','number'],['workbookId','Tệp nguồn'],['tab','Tab'],['rowNumber','Dòng nguồn','number'],['factId','Mã bản ghi'],['runId','Đợt đồng bộ'],['sourceKey','Tham chiếu nguồn']]}};
  const filterLabels = { page:'Page', employee:'Nhân viên', status:'Tình trạng', dataSource:'Nguồn data' };
  const filterKeys = { page:'pages', employee:'employees', status:'statuses', dataSource:'dataSources' };
  const sections = {};
  const chartInstances = new Map();
  let initialized = false, metadata = null, metadataRequest = null, detailSeq = 0, detailContext = null, opener = null;
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize = value => String(value == null ? '' : value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase();
  function format(value, type, showCurrency = true) {
    if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.startsWith('#'))) return '—';
    if (type === 'datetime') return time(value);
    if (type === 'date') { const match=String(value).match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? match[3]+'/'+match[2]+'/'+match[1] : String(value); }
    if (!type || !Number.isFinite(Number(value))) return String(value);
    return new Intl.NumberFormat('en-US', { maximumFractionDigits:type === 'money' ? 0 : 2 }).format(Number(value) * (type === 'percent' ? 100 : 1)) + (type === 'percent' ? '%' : type === 'money' && showCurrency ? ' ₫' : '');
  }
  // Tên nhân viên đuôi MKT hiện màu vàng (cột Sale/Nhân viên của mọi bảng).
  const NAME_KEYS = new Set(['sale','employee','firstEmployee','currentEmployee','repeatEmployee']);
  const isMkt = value => /(^|\s)MKT$/i.test(String(value == null ? '' : value).trim());
  const canEdit = () => !!window.TKSNav?.can?.('reports.marketing.edit');
  const database = () => metadata?.sourceMode === 'database';
  const canManage = () => database() && metadata?.canEdit === true && canEdit();
  const EDIT_KEYS = new Set(['newCustomer','note']);
  function time(value) { if (value == null || value === '') return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN', {timeZone:'Asia/Ho_Chi_Minh'}); }
  function kpis(items) {
    const cards = items || [], span = cards.length <= 2 ? 'col-6' : cards.length === 3 ? 'col-4' : 'col-3';
    return cards.map((k, i) => '<div class="kpi-card '+span+' accent-' + (i % 2 ? 'blue' : 'amber') + '"><div class="eyebrow">' + escape(k.label) + '</div><div class="value">' + escape(format(k.value,k.format || k.type)) + '</div></div>').join('');
  }
  // Tính lại thẻ chỉ số từ các dòng đang hiện của bảng (khi có từ khóa). Thẻ không nhận ra thì giữ nguyên số máy chủ.
  function localKpis(kind, items, found) {
    const total = key => found.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
    const distinct = key => new Set(found.map(row => row[key]).filter(value => value != null && value !== '')).size;
    return (items || []).map(card => {
      if (card.value == null) return card;
      const label = String(card.label || '');
      let value = card.value;
      if (kind === 'monthly') {
        if (/Doanh số/.test(label)) { if (found.some(row => typeof row.revenue === 'number')) value = total('revenue'); }
        else if (/Khách chốt/.test(label)) value = found.length;
        else if (/Số nhân viên/.test(label)) value = distinct('sale');
      } else if (kind === 'receipt-check') {
        const first = total('first'), repeat = total('repeat'), closed = total('closed'), equivalent = first + repeat / 5;
        if (/lần đầu/.test(label)) value = first;
        else if (/chào lại/.test(label)) value = repeat;
        else if (/Quy đổi/.test(label)) value = equivalent;
        else if (/Khách chốt/.test(label)) value = closed;
        else if (/Tỷ lệ/.test(label)) value = equivalent ? closed / equivalent : null;
      } else if (kind === 'phones') {
        if (/Dòng SĐT/.test(label)) value = found.length;
        else if (/^Page/.test(label)) value = distinct('page');
      } else if (kind === 'costs') {
        if (/Tổng chi phí/.test(label)) value = total('totalCost');
        else if (/mess/i.test(label)) value = total('messages');
        else if (/SĐT/.test(label)) value = total('phones');
      }
      return Object.assign({}, card, { value });
    });
  }
  // Hàng chỉ số tổng quan của hộp chi tiết (khung chung .dp-stats, xem shared/detail-panel.css).
  function detailStats(items) {
    const cards = items || [];
    if (!cards.length) return '';
    return '<div class="dp-stats">' + cards.map(k => '<div class="dp-stat"><div class="dp-stat-label">' + escape(k.label) + '</div><div class="dp-stat-value">' + escape(format(k.value,k.format || k.type)) + '</div></div>').join('') + '</div>';
  }
  async function request(path, params) {
    const response = await fetch('/api/marketing-report/' + path + '?' + params.toString(), { credentials:'same-origin' });
    if (response.status === 401) { window.location.href = '/login/?next=' + encodeURIComponent(location.pathname + location.hash); throw new Error('Phiên đăng nhập đã hết hạn.'); }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || payload.message || 'Không đọc được nguồn báo cáo.');
    return payload;
  }
  function active() { return document.getElementById('view-marketing')?.classList.contains('active') && !document.hidden && window.TKSNav?.can('reports.marketing'); }
  function initialize() {
    if (initialized) return;
    initialized = true;
    const root = document.getElementById('marketingSections');
    root.innerHTML = Object.entries(definitions).map(([kind, def], i) => '<section class="section marketing-section" id="marketing-' + kind + '"><div class="section-head"><span class="section-step">' + (i+1) + '</span><h2>' + def.title + ' <span class="section-note">' + def.note + '</span></h2></div><div class="debt-filter-controls marketing-filters" id="marketing-' + kind + '-filters" aria-label="Bộ lọc ' + def.title + '"></div><div class="marketing-status" id="marketing-' + kind + '-status" role="status" aria-live="polite">Chưa tải dữ liệu.</div><div class="marketing-warnings" id="marketing-' + kind + '-warnings" role="status"></div><div class="kpi-grid section-kpis" id="marketing-' + kind + '-kpis"></div>' + (def.split ? '<div class="marketing-split">' : '') + (def.beside ? '<div class="grid" id="marketing-' + kind + '-charts-wide"></div><div class="marketing-split">' : '') + '<div class="grid" id="marketing-' + kind + '-charts"></div>' + (def.split ? '</div>' : '') + '<div id="marketing-' + kind + '-rows"></div>' + (def.beside ? '</div>' : '') + '</section>').join('');
    Object.keys(definitions).forEach(kind => { sections[kind] = { seq:0, filters:{}, data:null, loadedAt:0, filtersEl:document.getElementById('marketing-' + kind + '-filters') }; });
    const dialog = document.getElementById('marketingDetailDialog');
    document.getElementById('marketingDetailClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => { const box = dialog.getBoundingClientRect(); if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close(); });
    dialog.addEventListener('close', () => {
      ++detailSeq; detailContext = null;
      if (opener?.isConnected) opener.focus();
      else if (opener?.dataset.detailKey) {
        const replacement = Array.from(document.querySelectorAll('#view-marketing [data-detail-key]')).find(row => row.dataset.detailKey === opener.dataset.detailKey);
        (replacement || document.getElementById('view-marketing')).focus?.();
      }
    });
    document.getElementById('marketingDetailRefresh').addEventListener('click', () => { if (detailContext) openDetail(detailContext.kind, detailContext.key, opener, true); });
    document.addEventListener('visibilitychange', () => { if (active()) load(false); });
    new MutationObserver(() => { if (active()) redrawCharts(); else if (dialog.open) dialog.close(); }).observe(document.getElementById('view-marketing'), { attributes:true, attributeFilter:['class'] });
    new MutationObserver(redrawCharts).observe(document.documentElement, { attributes:true, attributeFilter:['data-theme'] });
    setInterval(() => { if (active()) load(true); }, 300000);
  }
  function renderFilters(kind) {
    const section = sections[kind], def = definitions[kind], host = section.filtersEl;
    const monthValues = section.filters.dataset==='legacy'?Array.from({length:12},(_,i)=>i+1):database() && kind !== 'costs' && Array.isArray(metadata?.periods) ? metadata.periods.filter(period => Number(period.year) === Number(section.filters.year)).map(period => Number(period.month)) : metadata?.months?.[def.monthKey] || [];
    let html = def.monthKey ? '<div class="debt-filter-field"><label for="marketing-' + kind + '-month">Tháng</label><select id="marketing-' + kind + '-month" data-filter="month">' + [...new Set([Number(section.filters.month), ...monthValues.map(Number)])].filter(Boolean).sort((a,b) => a-b).map(month => '<option value="'+month+'"'+(Number(section.filters.month)===month?' selected':'')+'>Tháng '+month+(monthValues.map(Number).includes(month)?'':' · Chưa có dữ liệu')+'</option>').join('') + '</select></div>' : '';
    if (database() && def.monthKey && kind !== 'costs') html += '<div class="debt-filter-field"><label for="marketing-'+kind+'-year">Năm</label><input id="marketing-'+kind+'-year" type="number" min="2000" max="2100" data-filter="year" value="'+escape(section.filters.year)+'"></div>';
    if(metadata?.dataset==='pancake-independent'&&['monthly','phones','receipt-check'].includes(kind))html+='<div class="debt-filter-field"><label for="marketing-'+kind+'-dataset">Tập dữ liệu</label><select id="marketing-'+kind+'-dataset" data-filter="dataset"><option value="">Pancake độc lập</option><option value="legacy"'+(section.filters.dataset==='legacy'?' selected':'')+'>Lịch sử cũ (có nguồn Sheets)</option></select></div>';
    html += def.filters.map(name => '<div class="debt-filter-field"><label for="marketing-' + kind + '-filter-' + name + '">' + filterLabels[name] + '</label><select id="marketing-' + kind + '-filter-' + name + '" data-filter="' + name + '"><option value="">Tất cả</option>' + [...new Set([...(section.data?.filters?.[filterKeys[name]] || []), section.filters[name]])].filter(Boolean).map(value => '<option value="'+escape(value)+'"'+(section.filters[name]===value?' selected':'')+'>'+escape(value)+'</option>').join('')+'</select></div>').join('');
    host.innerHTML = html;
    host.querySelectorAll('select, input[data-filter]').forEach(select => select.addEventListener('change', () => { section.filters[select.dataset.filter] = select.value; loadSection(kind, true); }));
  }
  async function load(force) {
    if (!window.TKSNav?.can('reports.marketing')) return;
    initialize();
    if (!metadata) {
      if (!metadataRequest) metadataRequest = request('metadata',new URLSearchParams()).finally(() => { metadataRequest = null; });
      try { metadata = await metadataRequest; }
      catch(error) { document.getElementById('marketingSourceStatus').textContent = error.message; return; }
      Object.entries(definitions).forEach(([kind,def]) => { if (database() && def.monthKey && kind !== 'costs') sections[kind].filters.year = metadata.currentYear || new Date().getFullYear(); if (def.monthKey) sections[kind].filters.month = metadata.currentMonth || Number(new Intl.DateTimeFormat('en',{month:'numeric',timeZone:'Asia/Ho_Chi_Minh'}).format(new Date())); });
      document.getElementById('marketingSourceStatus').textContent = database() ? (metadata?.dataset==='pancake-independent'?'SĐT/KPI: Pancake độc lập · Khách chốt: BC tháng nhập web/DB · ADS/VAT/phí thuê: Sheets · Doanh số: KiotViet':'Báo cáo từ dữ liệu đồng bộ · Chi phí ADS từ Google Sheets · Doanh số KiotViet') : (canEdit() ? 'Đọc và ghi Khách mới/Ghi chú vào Google Sheets' : 'Chỉ đọc Google Sheets') + ' · tự cập nhật mỗi 5 phút';
    }
    await Promise.allSettled([...Object.keys(definitions).map(kind => loadSection(kind,force)), ...(database() ? [loadOperations()] : [])]);
  }
  async function loadSection(kind, force) {
    const section = sections[kind];
    if (!force && (section.pending || Date.now()-section.loadedAt < 300000)) return;
    const seq = ++section.seq, params = new URLSearchParams(section.filters);
    if (force) params.set('refresh','1');
    const status = document.getElementById('marketing-' + kind + '-status');
    section.pending = true;
    status.textContent = section.data ? 'Đang làm mới · Dữ liệu đọc lúc ' + time(section.data.computedAt) : (database() && kind !== 'costs' ? 'Đang đọc dữ liệu đồng bộ…' : 'Đang đọc Google Sheets…');
    document.getElementById('marketing-' + kind).setAttribute('aria-busy','true');
    try {
      const data = await request(kind,params);
      if (seq !== section.seq) return;
      section.data = data; section.loadedAt = Date.now();
      renderSection(kind);
    } catch(error) { if (seq === section.seq) status.textContent = error.message + (section.data ? ' · Giữ dữ liệu đọc lúc ' + time(section.data.computedAt) : ' · Bấm Làm mới để thử lại.'); }
    finally { if (seq === section.seq) { section.pending = false; document.getElementById('marketing-' + kind).setAttribute('aria-busy','false'); } }
  }
  function renderSection(kind) {
    const data = sections[kind].data;
    renderFilters(kind);
    document.getElementById('marketing-' + kind + '-status').textContent = 'Đọc nguồn lúc ' + time(data.computedAt) + (data.dataset==='pancake-independent'?' · Pancake độc lập':data.dataset==='legacy-db'?' · Lịch sử cũ, có nguồn Sheets':'');
    document.getElementById('marketing-' + kind + '-warnings').textContent = [...(data.warnings || []), ...(database() && kind !== 'costs' && definitions[kind].monthKey && Array.isArray(metadata?.periods) && !metadata.periods.some(period => Number(period.year) === Number(sections[kind].filters.year) && Number(period.month) === Number(sections[kind].filters.month)) ? ['Chưa có dữ liệu cho tháng/năm đã chọn.'] : [])].join(' · ');
    document.getElementById('marketing-' + kind + '-kpis').innerHTML = kpis(data.kpis);
    renderCharts(kind);
    mountTable(document.getElementById('marketing-' + kind + '-rows'), 'marketing-' + kind + '-data-table', definitions[kind].title, data.rows || [], definitions[kind].columns, kind === 'monthly' && canManage() && sections.monthly.filters.dataset!=='legacy' ? row => openMonthly(row) : kind === 'phones' || kind === 'receipt-check' ? row => openDetail(kind,row.key,document.activeElement) : null, { kind, table:'rows' }, (found, active) => {
      // Thẻ chỉ số tính lại theo từ khóa tìm trong bảng, trên toàn bộ dòng đã lọc; xóa từ khóa thì về số của máy chủ.
      document.getElementById('marketing-' + kind + '-kpis').innerHTML = kpis(active ? localKpis(kind, data.kpis, found) : data.kpis);
    });
    if (kind === 'monthly' && canManage() && sections.monthly.filters.dataset!=='legacy') { const button = document.createElement('button'); button.type='button'; button.className='mini-filter-apply'; button.textContent='Thêm khách chốt'; button.addEventListener('click', () => openMonthly()); document.querySelector('#marketing-monthly-rows .panel-head-actions').prepend(button); }
    // Thanh lọc nằm cạnh tên bảng (mountTable dựng lại bảng nên phải gắn lại sau mỗi lần vẽ).
    document.querySelector('#marketing-' + kind + '-rows .panel-head')?.insertBefore(sections[kind].filtersEl, document.querySelector('#marketing-' + kind + '-rows .panel-head-actions'));
  }
  // Biểu đồ theo ngày của mục có `beside` luôn là cột dọc, xếp riêng cả hàng phía trên.
  const wide = (chart, kind) => !!definitions[kind]?.beside && /ngày/i.test(chart.title || '');
  const horizontal = (chart, kind) => !wide(chart, kind) && (!!definitions[kind]?.horizontal || (chart.labels || []).length > 8);
  // Vệt sáng theo cột đang hover (dọc hoặc ngang tùy hướng biểu đồ), vẽ dưới các cột.
  const hoverBand = {
    id: 'hoverBand',
    beforeDatasetsDraw(chart) {
      const active = chart.getActiveElements();
      if (!active.length) return;
      const { ctx, chartArea } = chart, bar = active[0].element, hz = chart.options.indexAxis === 'y';
      const size = hz ? bar.height : bar.width, pad = 6;
      ctx.save(); ctx.fillStyle = 'rgba(148,163,184,0.14)';
      if (hz) ctx.fillRect(chartArea.left, bar.y - size / 2 - pad, chartArea.right - chartArea.left, size + pad * 2);
      else ctx.fillRect(bar.x - size / 2 - pad, chartArea.top, size + pad * 2, chartArea.bottom - chartArea.top);
      ctx.restore();
    }
  };
  function renderCharts(kind) {
    const host = document.getElementById('marketing-' + kind + '-charts'), wideHost = document.getElementById('marketing-' + kind + '-charts-wide');
    const charts = sections[kind].data?.charts || [];
    chartInstances.get(kind)?.forEach(chart => chart.destroy());
    const panel = (chart,i) => '<div class="panel '+(wide(chart,kind) || charts.length === 1 || definitions[kind].beside ? 'col-12' : 'col-6')+'"><div class="panel-head"><h2>'+escape(chart.title)+'</h2></div><div class="chart-box marketing-chart-scroll"><div class="marketing-chart-inner" style="height:'+(horizontal(chart,kind)?Math.max(260,(chart.labels||[]).length*24):260)+'px"><canvas id="marketing-'+kind+'-chart-'+i+'" role="img" aria-label="'+escape(chart.title)+'"></canvas></div></div></div>';
    host.innerHTML = charts.map((chart,i) => wide(chart,kind) ? '' : panel(chart,i)).join('');
    if (wideHost) wideHost.innerHTML = charts.map((chart,i) => wide(chart,kind) ? panel(chart,i) : '').join('');
    const style = getComputedStyle(document.documentElement), instances = [];
    charts.forEach((chart,i) => {
      if (typeof Chart === 'undefined') return;
      const palette = ['--blue','--amber','--green','--red'], color = style.getPropertyValue(palette[i % palette.length]).trim() || style.getPropertyValue('--primary').trim();
      const hz = horizontal(chart,kind), muted = style.getPropertyValue('--muted').trim(), grid = style.getPropertyValue('--border').trim();
      instances.push(new Chart(document.getElementById('marketing-'+kind+'-chart-'+i), {
        type:'bar',
        plugins:[hoverBand],
        data:{labels:chart.labels || [],datasets:[{label:chart.title,data:(chart.values || []).map(value => value == null || !Number.isFinite(Number(value)) ? null : Number(value)),backgroundColor:color,borderRadius:4,maxBarThickness:48}]},
        options:{responsive:true,maintainAspectRatio:false,animation:matchMedia('(prefers-reduced-motion: reduce)').matches ? false : {duration:200},interaction:{mode:'index',axis:hz?'y':'x',intersect:false},plugins:{legend:{display:false},tooltip:{mode:'index',axis:hz?'y':'x',intersect:false}},
          indexAxis:hz?'y':'x',scales:{[hz?'y':'x']:{ticks:{color:muted,autoSkip:false,maxRotation:hz?0:60},grid:{display:false}},[hz?'x':'y']:{beginAtZero:true,ticks:{color:muted},grid:{color:grid}}}
        }
      }));
    });
    chartInstances.set(kind,instances);
  }
  function redrawCharts() { if (initialized && active()) Object.keys(sections).forEach(kind => { if (sections[kind].data) renderCharts(kind); }); }
  function mountTable(host, id, title, rows, columns, onOpen, exportInfo, onFilter) {
    const saved = host._marketingState || { search:'', sort:null, direction:1, page:1 };
    host._marketingState = saved;
    host.innerHTML = '<div class="panel marketing-table"><div class="panel-head"><h2>'+escape(title)+'</h2><div class="panel-head-actions"><span class="drill-hint" data-count>—</span>'+(exportInfo?'<button class="export-button" type="button" id="'+id+'-export"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>Xuất file</button>':'')+'</div><div class="table-search-tools"><div class="table-search-input-wrap"><input class="table-search-input" id="'+id+'-search" type="search" autocomplete="off" aria-label="Tìm trong '+escape(title)+'" placeholder="Tìm kiếm không dấu…" value="'+escape(saved.search)+'"></div>'+'</div></div><div class="table-wrap marketing-table-scroll"><table data-table-key="'+id+'"'+(id === 'marketing-costs-data-table' ? ' data-table-fit="contain"' : '')+' aria-label="'+escape(title)+'"><thead></thead><tbody></tbody></table></div><div class="pagination-controls marketing-pages" hidden><button type="button" id="'+id+'-first" aria-label="Trang đầu" title="Trang đầu">&lt;&lt;</button><button type="button" id="'+id+'-prev" aria-label="Trang trước" title="Trang trước">&lt;</button><span data-page-label></span><button type="button" id="'+id+'-next" aria-label="Trang sau" title="Trang sau">&gt;</button><button type="button" id="'+id+'-last" aria-label="Trang cuối" title="Trang cuối">&gt;&gt;</button></div></div>';
    const editing = !!exportInfo && exportInfo.kind === 'monthly' && exportInfo.table === 'rows' && !database() && canEdit();
    function cellHtml(row, key, type, edit, index) {
      if (edit && EDIT_KEYS.has(key) && row.key) return '<td class="marketing-edit-cell"><textarea class="marketing-edit" rows="1" wrap="soft" maxlength="500" data-edit="'+key+'" data-edit-index="'+index+'" aria-label="'+escape(columns.find(c => c[0] === key)[1])+' của '+escape(row.customer || row.phone || 'dòng này')+'">'+escape(row[key] || '')+'</textarea></td>';
      const text = escape(format(row[key],type,false));
      if (NAME_KEYS.has(key) && isMkt(row[key])) return '<td><span class="mkt-name">'+text+'</span></td>';
      return '<td'+(type?' class="mono col-num"':'')+'>'+text+'</td>';
    }
    function draw() {
      const visible = columns;
      // Tìm gần đúng (bỏ dấu, nhiều từ); chuỗi rỗng = hiện đủ dòng. Khớp nhiều từ xếp trước khi chưa chọn cột sắp xếp.
      const rowText = row => Object.values(row).join(' ');
      let found = window.TKSFuzzySearch
        ? window.TKSFuzzySearch.filter(rows, saved.search, rowText)
        : rows.filter(row => normalize(rowText(row)).includes(normalize(saved.search)));
      if (saved.sort) found = found.slice().sort((a,b) => { const av=a[saved.sort], bv=b[saved.sort]; if(av==null) return 1; if(bv==null) return -1; return saved.direction * (typeof av === 'number' && typeof bv === 'number' ? av-bv : String(av).localeCompare(String(bv),'vi',{numeric:true})); });
      const pages = Math.max(1,Math.ceil(found.length/100)); saved.page = Math.min(saved.page,pages);
      host.querySelector('thead').innerHTML = '<tr>'+visible.map(([key,label,type]) => '<th data-column-key="'+key+'" data-column-type="'+(type || 'text')+'" class="sortable'+(type?' col-num':'')+'" aria-sort="'+(saved.sort===key?(saved.direction===1?'ascending':'descending'):'none')+'"><button type="button" class="sort-button" id="'+id+'-sort-'+key+'" data-sort="'+key+'"><span class="sort-label">'+escape(label)+'</span><span class="sort-indicator" aria-hidden="true">'+(saved.sort===key?(saved.direction===1?'▼':'▲'):'▲▼')+'</span></button></th>').join('')+'</tr>';
      const slice = found.slice((saved.page-1)*100,saved.page*100);
      host.querySelector('tbody').innerHTML = slice.length ? slice.map((row,i) => '<tr'+(onOpen&&row.key?' class="marketing-row-link" tabindex="0" data-detail-key="'+escape(row.key)+'" data-index="'+i+'" title="Bấm hoặc nhấn Enter để xem chi tiết"':'')+'>'+visible.map(([key,,type]) => cellHtml(row,key,type,editing,slice.indexOf(row))).join('')+'</tr>').join('') : '<tr><td colspan="'+Math.max(1,visible.length)+'" class="table-note">Chưa có dữ liệu phù hợp.</td></tr>';
      host.querySelector('[data-count]').textContent = found.length + ' dòng';
      if (onFilter) onFilter(found, !!String(saved.search || '').trim());
      host.querySelector('.marketing-pages').hidden = pages<=1;
      host.querySelector('[data-page-label]').textContent = 'Trang '+saved.page+'/'+pages;
      ['first','prev'].forEach(name => { host.querySelector('#'+id+'-'+name).disabled=saved.page<=1; });
      ['next','last'].forEach(name => { host.querySelector('#'+id+'-'+name).disabled=saved.page>=pages; });
      host.querySelectorAll('[data-sort]').forEach(button => {
        const selected = saved.sort === button.dataset.sort;
        button.title = selected ? (saved.direction === 1 ? 'Sắp xếp giảm dần' : 'Bỏ sắp xếp') : 'Sắp xếp tăng dần';
        button.addEventListener('click', () => {
          const key = button.dataset.sort;
          if (saved.sort !== key) { saved.sort = key; saved.direction = 1; }
          else if (saved.direction === 1) saved.direction = -1;
          else { saved.sort = null; saved.direction = 1; }
          saved.page=1; draw();
        });
      });
      host.querySelectorAll('[data-edit]').forEach(input => {
        const row = slice[Number(input.dataset.editIndex)];
        growEditor(input);
        input.addEventListener('input', () => growEditor(input));
        input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); input.blur(); } if (event.key === 'Escape') { event.preventDefault(); input.value = row[input.dataset.edit] || ''; growEditor(input); input.blur(); } });
        input.addEventListener('change', () => saveCell(input, row));
      });
      if (window.TKSTables) window.TKSTables.enhance(host.querySelector('table'), { key: id, columns: columns.map(([key, label]) => ({ key, label })) });
      host.querySelectorAll('[data-index]').forEach(element => { const open = () => { element.focus(); onOpen(slice[Number(element.dataset.index)]); }; element.addEventListener('click',open); element.addEventListener('keydown',event => { if(event.key==='Enter'||event.key===' ') { event.preventDefault(); open(); } }); });
    }
    host.querySelector('input[type="search"]').addEventListener('input',event => { saved.search=event.target.value; saved.page=1; draw(); });
    if (exportInfo) host.querySelector('#'+id+'-export').addEventListener('click', () => openExport(exportInfo.kind, exportInfo.table, saved.search, saved.sort ? { key: saved.sort, dir: saved.direction === 1 ? 'asc' : 'desc' } : null));
    host.querySelector('#'+id+'-first').addEventListener('click', () => { saved.page=1; draw(); });
    host.querySelector('#'+id+'-prev').addEventListener('click', () => { --saved.page; draw(); });
    host.querySelector('#'+id+'-next').addEventListener('click', () => { ++saved.page; draw(); });
    host.querySelector('#'+id+'-last').addEventListener('click', () => { saved.page=Infinity; draw(); }); draw();
  }
  function growEditor(input) { input.style.height = 'auto'; input.style.height = Math.max(30, input.scrollHeight) + 'px'; }
  // Sửa tại chỗ Khách mới / Ghi chú của BC tháng và ghi ngược Google Sheets.
  async function saveCell(input, row) {
    const field = input.dataset.edit, previous = row[field] || '', value = input.value.trim();
    const status = document.getElementById('marketing-monthly-status');
    if (value === previous) { input.value = previous; return; }
    input.disabled = true; input.classList.remove('is-error');
    try {
      const response = await fetch('/api/marketing-report/monthly/row', { method:'PUT', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ snapshotId:sections.monthly.data?.snapshotId, key:row.key, field, value }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Không ghi được vào Google Sheets.');
      row[field] = payload.value; input.value = payload.value;
      input.classList.add('is-saved'); setTimeout(() => input.classList.remove('is-saved'), 1500);
      status.textContent = 'Đã ghi vào Google Sheets lúc ' + time(Date.now());
    } catch (error) {
      input.value = previous; input.classList.add('is-error');
      status.textContent = error.message;
    } finally { input.disabled = false; growEditor(input); }
  }
  // Nguồn cho hộp thoại "Xuất file" dùng chung (startExportDialog/exportFetch ở index.html): bộ lọc chốt lúc mở.
  const EXPORT_SOURCE = {
    fields: (payload, request) => exportFetch('/api/marketing-report/export/fields?' + payload.query, null, request),
    file: (payload, request) => {
      const params = new URLSearchParams(payload.query);
      params.set('format', payload.format === 'html' ? 'html' : 'xlsx');
      const columns = payload.columns && payload.columns[payload.table];
      if (columns) params.set('columns', columns.join(','));
      return exportFetch('/api/marketing-report/export?' + params.toString(), null, request);
    }
  };
  function openExport(kind, table, search, sort) {
    if (!window.TKSNav?.can('reports.export') || typeof startExportDialog !== 'function') return;
    const params = new URLSearchParams({ ...sections[kind].filters, kind, table });
    if (search && search.trim()) params.set('q', search.trim());
    if (sort) { params.set('sortKey', sort.key); params.set('sortDir', sort.dir); }
    return startExportDialog({ kind, table, query: params.toString() }, EXPORT_SOURCE);
  }
  async function openDetail(kind,key,source,refresh,nested) {
    const section=sections[kind], dialog=document.getElementById('marketingDetailDialog'), seq=++detailSeq;
    if(!refresh) {
      detailContext={kind,key,filters:nested?{...detailContext.filters}:{...section.filters},snapshotId:nested?detailContext.snapshotId:section.data.snapshotId};
      if(!nested) opener=source;
    }
    const context=detailContext;
    const params=new URLSearchParams({...context.filters,kind,key});
    if(!refresh && context.snapshotId) params.set('snapshotId',context.snapshotId);
    if(refresh) params.set('refresh','1');
    document.getElementById('marketingDetailTitle').textContent=definitions[kind].title+' · Chi tiết';
    document.getElementById('marketingDetailSubtitle').textContent='Phạm vi theo bộ lọc khi mở · '+(context.filters.month?'Tháng '+context.filters.month:'Toàn bộ');
    const body=document.getElementById('marketingDetailBody');
    if(!refresh) body.innerHTML='<p role="status">Đang đọc chi tiết…</p>';
    document.getElementById('marketingDetailStatus').textContent=refresh?'Đang cập nhật chi tiết…':'';
    if(!dialog.open) dialog.showModal();
    try {
      const data=await request('detail',params);
      if(seq!==detailSeq||!dialog.open) return;
      context.snapshotId=data.snapshotId;
      document.getElementById('marketingDetailTitle').textContent=data.title || definitions[kind].title;
      document.getElementById('marketingDetailSubtitle').textContent=(data.subtitle || '')+' · Đọc nguồn lúc '+time(data.computedAt);
      document.getElementById('marketingDetailStatus').textContent='';
      body.innerHTML='<div class="marketing-warnings" role="status">'+escape((data.warnings||[]).join(' · '))+'</div>'+(data.formula?'<p class="marketing-status">Công thức quy đổi nguồn: '+escape(data.formula)+'</p>':'')+detailStats(data.kpis)+ (data.groups||[]).map((group,i)=>'<div id="marketing-detail-group-'+i+'"></div>').join('');
      (data.groups||[]).forEach((group,i) => {
        const groupKind=definitions[group.kind]||detailDefinitions[group.kind]?group.kind:kind;
        const navigatePhone=kind==='phones' && groupKind==='phones' && (group.rows || []).some(row=>row.key!==key) ? row=>openDetail('phones',row.key,null,false,true) : null;
        mountTable(document.getElementById('marketing-detail-group-'+i),'marketing-detail-'+groupKind+'-'+i,group.title,group.rows||[],(definitions[groupKind]||detailDefinitions[groupKind]).columns,navigatePhone);
      });
    } catch(error) { if(seq===detailSeq&&dialog.open) document.getElementById('marketingDetailStatus').textContent=error.message+(refresh?' · Giữ chi tiết trước lần cập nhật.':''); }
  }

  async function write(path, method, body) {
    const response = await fetch('/api/marketing-report/'+path, {method,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(response.status===409 ? 'Dòng này đã được sửa bởi người khác. Đóng và mở lại để xem phiên bản mới; nội dung đang nhập được giữ để đối chiếu.' : payload.error || 'Không lưu được dữ liệu.'); error.status=response.status; throw error; }
    return payload;
  }
  function editorDialog(title) {
    let dialog=document.getElementById('marketingEditorDialog');
    if (!dialog) { dialog=document.createElement('dialog'); dialog.id='marketingEditorDialog'; dialog.className='marketing-dialog'; document.body.append(dialog); }
    dialog.innerHTML='<div class="marketing-dialog-head"><h2>'+escape(title)+'</h2><button type="button" data-close aria-label="Đóng">Đóng</button></div><div class="marketing-dialog-body"></div>';
    dialog.querySelector('[data-close]').onclick=()=>dialog.close(); dialog.showModal(); return dialog;
  }
  async function openMonthly(row) {
    if (!canManage()) return;
    const dialog=editorDialog(row ? 'Sửa khách chốt' : 'Thêm khách chốt'), body=dialog.querySelector('.marketing-dialog-body');
    const fields=[['sale','Sale'],['customer','Khách KiotViet'],['phone','SĐT'],['page','Page'],['status','Tình trạng'],['dataSource','Nguồn data'],['closedAt','Ngày chốt','date'],['newCustomer','Khách mới'],['note','Ghi chú'],['reportMonth','Tháng báo cáo','number'],['reportYear','Năm báo cáo','number']];
    const initial={reportMonth:Number(sections.monthly.filters.month),reportYear:Number(sections.monthly.filters.year),...row};
    body.innerHTML='<form class="marketing-entry-form"><div class="marketing-entry-grid">'+fields.map(([key,label,type])=>key==='page' ? '<label>Page<select name="page" '+(row&&!row.page&&!row.pageId?'':'required')+'><option value=""'+(!initial.page?' selected':'')+'>Chưa chọn page</option>'+ [...new Set([...(metadata.pages||[]).map(page=>page.name),initial.page])].filter(Boolean).map(name=>'<option value="'+escape(name)+'"'+(name===initial.page?' selected':'')+'>'+escape(name)+'</option>').join('')+'</select></label>' : '<label>'+escape(label)+'<input name="'+key+'" type="'+(type||'text')+'" maxlength="500" '+(['reportMonth','reportYear','sale','customer','phone','page','status','dataSource','closedAt'].includes(key)?'required ':'')+(key==='reportMonth'?'min="1" max="12" ':key==='reportYear'?'min="2000" max="2100" ':'')+'value="'+escape(initial[key] ?? '')+'"></label>').join('')+'</div><div class="marketing-customer-search"><label>Tìm khách KiotViet<input type="search" data-customer-search placeholder="Tên hoặc mã khách"></label><button type="button" data-find>Tìm khách</button><div data-customers></div></div><p class="marketing-status" role="status" data-message>Tháng báo cáo được lưu riêng với ngày chốt.</p><button class="mini-filter-apply" type="submit">Lưu khách chốt</button></form><div data-audit></div>';
    const form=body.querySelector('form'), message=body.querySelector('[data-message]'); let selectedId=row?.customerDirectoryId || null, searchSeq=0;
    const current = () => dialog.open && body.isConnected;
    form.elements.customer.addEventListener('input',()=>{selectedId=null;});
    body.querySelector('[data-find]').onclick=async()=>{
      const seq=++searchSeq, host=body.querySelector('[data-customers]'); host.textContent='Đang tìm…';
      try { const result=await request('customers',new URLSearchParams({q:body.querySelector('[data-customer-search]').value})); if(seq!==searchSeq||!current())return;
        host.replaceChildren(); (result.customers||[]).forEach(customer=>{const button=document.createElement('button');button.type='button';button.textContent=customer.name+' · '+customer.code+' · '+customer.branch;button.onclick=()=>{selectedId=customer.id;form.elements.customer.value=customer.name;host.textContent='Đã chọn '+customer.name;};host.append(button);}); if(!host.children.length)host.textContent='Không tìm thấy khách.';
      } catch(error){if(seq===searchSeq)host.textContent=error.message;}
    };
    form.onsubmit=async event=>{
      event.preventDefault(); if(!canManage())return; if (!row && !selectedId) {message.textContent='Tìm và chọn khách KiotViet trước khi lưu.';return;} const values=Object.fromEntries(new FormData(form)); values.reportMonth=Number(values.reportMonth); values.reportYear=Number(values.reportYear); values.closedAt=values.closedAt||null;values.customerDirectoryId=selectedId;values.pageId=(metadata.pages||[]).find(page=>page.name===values.page)?.pageId || (row?.page===values.page ? row.pageId : null);if(row)values.version=row.version;
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;message.textContent='Đang lưu…';
      try { await write(row?'monthly/rows/'+encodeURIComponent(row.id):'monthly/rows',row?'PUT':'POST',values);dialog.close();try { metadata=await request('metadata',new URLSearchParams({refresh:'1'})); } catch(error) { document.getElementById('marketingSourceStatus').textContent='Đã lưu khách chốt · Chưa cập nhật được danh sách kỳ báo cáo: '+error.message; } await loadSection('monthly',true);await loadSection('receipt-check',true); }
      catch(error){message.textContent=error.message;if(error.status===409)submit.dataset.conflict='true';}
      finally{submit.disabled=submit.dataset.conflict==='true';}
    };
    if(row) { const audit=body.querySelector('[data-audit]');audit.textContent='Đang đọc lịch sử…';try {const result=await request('monthly/rows/'+encodeURIComponent(row.id)+'/audit',new URLSearchParams());if(!current())return;audit.innerHTML='<h3>Lịch sử chỉnh sửa</h3>';for(const item of result.audit||[]){const line=document.createElement('p');line.textContent=time(item.createdAt||item.changedAt)+' · '+(item.actorName||item.actor?.name||item.actor?.username||'')+' · '+fields.filter(([key])=>item.before?.[key]!==item.after?.[key]).map(([key,label])=>label+': '+(item.before?.[key] ?? '—')+' → '+(item.after?.[key] ?? '—')).join(' · ');audit.append(line);} }catch(error){audit.textContent=error.message;} }
  }
  async function loadOperations() {
    let host=document.getElementById('marketingOperations');if(!host){host=document.createElement('section');host.id='marketingOperations';host.className='panel marketing-operations';document.getElementById('marketingSections').prepend(host);}
    try {const result=await request('sync-status',new URLSearchParams());host.innerHTML='<h2>Đồng bộ Fanpage</h2>'+(result.latestRun?.status==='running'?'<p role="status">Đang đọc Pancake; chỉ công bố page đã hoàn tất kiểm tra dữ liệu.</p>':'')+'<div class="marketing-sync-grid">'+(result.pages||[]).map(page=>'<div><strong>'+escape(page.pageName||page.name||page.page)+'</strong><p>'+escape(({success:'Thành công',succeeded:'Thành công',failed:'Chưa thành công',error:'Chưa thành công',running:'Đang đồng bộ',pending:'Chưa đồng bộ'})[page.status]||page.status||'Chưa đồng bộ')+'</p><p>Thành công gần nhất: '+escape(time(page.lastSuccessAt))+'</p>'+(page.coverage?.complete?'<p>Đã đọc hết phân trang API · '+escape(page.coverage.conversationCount)+' hội thoại · '+escape(page.coverage.phoneMessageCount)+' tin có SĐT</p><p>Phạm vi tin có SĐT: '+escape(time(page.coverage.earliestSourceCreatedAt))+' – '+escape(time(page.coverage.latestSourceCreatedAt))+'</p>':'')+(page.lastError||page.errorCode?'<p class="marketing-warnings">'+escape(page.lastError || 'Lần đồng bộ gần nhất chưa thành công. Dữ liệu trước đó được giữ nguyên.')+'</p>':'')+'</div>').join('')+'</div>'+(canManage()?'<button type="button" data-aliases>Ánh xạ nhân viên</button>':'');host.querySelector('[data-aliases]')?.addEventListener('click',openAliases);}
    catch(error){host.textContent=error.message;}
  }
  async function openAliases() {
    if(!canManage())return;const dialog=editorDialog('Ánh xạ nhân viên'),body=dialog.querySelector('.marketing-dialog-body');body.textContent='Đang đọc…';
    try {const result=await request('aliases',new URLSearchParams());if(!dialog.open||!body.isConnected)return;body.innerHTML='<p>Tên chưa ánh xạ vẫn được giữ trong báo cáo.</p><div data-alias-list></div><form class="marketing-entry-form"><label>Tên Pancake<input name="rawName" required maxlength="500" list="marketing-unmapped"></label><datalist id="marketing-unmapped">'+(result.unmapped||[]).map(item=>'<option value="'+escape(typeof item==='string'?item:item.rawName)+'"></option>').join('')+'</datalist><label>Tên nhân viên báo cáo<input name="reportEmployee" required maxlength="500"></label><button type="submit">Lưu ánh xạ</button><p role="status" data-message></p></form>';const list=body.querySelector('[data-alias-list]');[...(result.aliases||[]),...(result.unmapped||[]).map(item=>typeof item==='string'?{rawName:item}:item)].forEach(item=>{const line=document.createElement('p');line.textContent=item.rawName+' → '+(item.reportEmployee||'Chưa ánh xạ');list.append(line);});const form=body.querySelector('form');form.onsubmit=async event=>{event.preventDefault();if(!canManage())return;const button=form.querySelector('button');button.disabled=true;try{await write('aliases','PUT',Object.fromEntries(new FormData(form)));dialog.close();await load(true);}catch(error){body.querySelector('[data-message]').textContent=error.message;}finally{button.disabled=false;}};
    }catch(error){body.textContent=error.message;}
  }

  window.TKSMarketing={load};
})();
