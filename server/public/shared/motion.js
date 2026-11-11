/* Shared, progressive entrance motion. Content stays visible without JS/WAAPI.
 * Explicit hooks: data-motion="title|subtitle|kpi|panel|rows"; opt out with
 * data-motion="off" on any ancestor. Every element enters at most once.
 */
(function () {
  'use strict';
  if (window.TKSMotion || !Element.prototype.animate) return;
  var media = window.matchMedia('(prefers-reduced-motion: reduce)');
  var seen = new WeakSet();
  var waiting = new WeakSet();
  var running = new Set();
  var counters = new Set();
  var counted = new WeakSet();
  var timer;
  var selectors = {
    title: '[data-motion="title"],.view-title,.page-title,.section-head h2,.admin-header h2,.account-header h2,.hr-header h2,.locations-title,.vr-title,.vd-title,.vl-title,.lc-title,.login-card h2,.register-card h2,.card-404 h2',
    subtitle: '[data-motion="subtitle"],.view-sub,.page-sub,.page-subtitle,.section-note',
    kpi: '[data-motion="kpi"],.kpi-card,.kpi-stat,.vd-metric',
    panel: '[data-motion="panel"],.panel,.card,.locations-panel,.vr-panel,.vd-panel,.vd-card,.vd-qr-panel,.login-card,.register-card,.card-404',
    rows: '[data-motion="rows"],.content table tbody,main table tbody',
    count: '[data-motion-count],.kpi-card .value,.kpi-stat .val'
  };
  var selector = Object.keys(selectors).map(function (key) { return selectors[key]; }).join(',');
  var ease = 'cubic-bezier(0.22,1,0.36,1)';
  // Nhịp chuyển động (ms). Rút ngắn 11/2026: tiêu đề dài từng chạy ~1,3 s, thẻ KPI chờ tới 0,75 s rồi lật, số đếm che giá
  // trị thật 0,75 s -> người dùng thấy thông tin hiện chậm. Nay mọi lối vào xong trong khoảng 0,3–0,45 s, giữ nguyên kiểu hiệu ứng.
  var TIMING = {
    titleMs: 260, titleStagger: 12, titleMaxDelay: 180,
    kpiMs: 300, kpiStagger: 30,
    rowMs: 200, rowStagger: 15,
    panelMs: 280, panelStagger: 40,
    subtitleMs: 220, subtitleDelay: 40,
    countMs: 400
  };

  function play(element, frames, duration, delay) {
    try {
      var animation = element.animate(frames, {
        duration: duration, delay: delay || 0, easing: ease, fill: 'backwards'
      });
      running.add(animation);
      animation.finished.then(function () { running.delete(animation); }, function () { running.delete(animation); });
      return animation;
    } catch (_) { return null; }
  }

  function siblingIndex(element, query) {
    if (!element.parentElement) return 0;
    return Array.prototype.filter.call(element.parentElement.children, function (child) {
      return child.matches(query) && child.getClientRects().length;
    }).indexOf(element);
  }

  function title(element) {
    var letters = [];
    var replacements = [];
    // Touch direct text nodes only; preserve subtitle nodes, icons and listeners.
    Array.from(element.childNodes).forEach(function (node) {
      if (node.nodeType !== 3 || !node.textContent.trim()) return;
      var original = node.textContent;
      var holder = document.createElement('span');
      var offset = 0;
      original.split(/(\s+)/).forEach(function (word) {
        var start = offset;
        offset += word.length;
        if (/^\s+$/.test(word)) { holder.appendChild(document.createTextNode(word)); return; }
        var wrapper = document.createElement('span');
        wrapper.style.whiteSpace = 'nowrap';
        // Reserve the original word width so temporary letter wrappers do not
        // change heading wraps when kerning is interrupted by inline blocks.
        var range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, offset);
        if (range.getBoundingClientRect) {
          var width = range.getBoundingClientRect().width;
          if (width > 0) { wrapper.style.display = 'inline-block'; wrapper.style.width = width + 'px'; }
        }
        Array.from(word).forEach(function (letter) {
          var span = document.createElement('span');
          span.textContent = letter;
          span.style.display = 'inline-block';
          wrapper.appendChild(span);
          letters.push(span);
        });
        holder.appendChild(wrapper);
      });
      node.replaceWith(holder);
      replacements.push({ holder: holder, original: original });
    });
    letters.forEach(function (letter, i) {
      play(letter, [
        { opacity: 0, transform: 'translateY(-20px) scale(0.96)', offset: 0 },
        { opacity: 1, transform: 'translateY(4px) scale(1.01)', offset: 0.65 },
        { opacity: 1, transform: 'none', offset: 1 }
      ], TIMING.titleMs, Math.min(i * TIMING.titleStagger, TIMING.titleMaxDelay));
    });
    // Keep the original text/semantics after motion; never overwrite a live update.
    window.setTimeout(function () {
      replacements.forEach(function (item) {
        if (item.holder.parentNode === element && item.holder.textContent === item.original) {
          item.holder.replaceWith(document.createTextNode(item.original));
        }
      });
    }, TIMING.titleMs + 20 + Math.min(letters.length * TIMING.titleStagger, TIMING.titleMaxDelay));
  }

  function count(element) {
    if (counted.has(element) || element.childElementCount || media.matches ||
        !window.CSS || !CSS.supports('content', 'attr(data-tks-count-display) / ""')) return;
    var original = element.textContent;
    // Existing dashboard uses en-US. Recognize unambiguous vi-VN values too;
    // explicit locale resolves inherently ambiguous single-separator values.
    var formats = [
      { locale: 'en-US', pattern: /^(-?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\s*[₫%]?)$/, grouping: /,/g, decimal: '.' },
      { locale: 'vi-VN', pattern: /^(-?)(\d{1,3}(?:\.\d{3})+|\d+)(,\d+)?(\s*[₫%]?)$/, grouping: /\./g, decimal: ',' }
    ];
    if (element.getAttribute('data-motion-locale') === 'vi-VN') formats.reverse();
    var selected;
    var match;
    formats.some(function (candidate) {
      match = original.trim().match(candidate.pattern);
      if (match) { selected = candidate; return true; }
      return false;
    });
    if (!match) return;
    var value = Number(match[1] + match[2].replace(selected.grouping, '') + (match[3] || '').replace(selected.decimal, '.'));
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return;
    if (!value) return;
    counted.add(element);
    var decimals = match[3] ? match[3].length - 1 : 0;
    var format = new Intl.NumberFormat(selected.locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    var previousColor = element.style.getPropertyValue('--tks-count-color');
    var computed = getComputedStyle(element);
    var previousPosition = element.style.position;
    var needsPosition = computed.position === 'static' || !computed.position;
    element.style.setProperty('--tks-count-color', computed.color);
    if (needsPosition) element.style.position = 'relative';
    var started;
    var frame;
    function finish() {
      window.cancelAnimationFrame(frame);
      element.classList.remove('tks-motion-count');
      element.removeAttribute('data-tks-count-display');
      if (previousColor) element.style.setProperty('--tks-count-color', previousColor);
      else element.style.removeProperty('--tks-count-color');
      if (needsPosition && element.style.position === 'relative') element.style.position = previousPosition;
      counters.delete(finish);
    }
    function tick(now) {
      if (!element.isConnected || element.textContent !== original || media.matches) { finish(); return; }
      if (started == null) started = now;
      var progress = Math.min((now - started) / TIMING.countMs, 1);
      if (progress === 1) { finish(); return; }
      element.setAttribute('data-tks-count-display', format.format(value * (1 - Math.pow(1 - progress, 3))) + match[4]);
      frame = window.requestAnimationFrame(tick);
    }
    counters.add(finish);
    element.setAttribute('data-tks-count-display', format.format(0) + match[4]);
    element.classList.add('tks-motion-count');
    frame = window.requestAnimationFrame(tick);
  }

  function enter(element) {
    if (element.matches(selectors.count)) { count(element); return; }
    if (seen.has(element) || !element.isConnected || !element.getClientRects().length ||
        element.closest('[data-motion="off"],[inert]')) return;
    // Loading/empty table placeholders should not consume the real rows' entrance.
    if (element.matches(selectors.rows) && (!element.children.length ||
        Array.from(element.children).every(function (row) { return row.children.length === 1 && row.firstElementChild.hasAttribute('colspan'); }))) return;
    seen.add(element);
    if (media.matches) return;
    if (element.matches(selectors.title)) { title(element); return; }
    if (element.matches(selectors.kpi)) {
      play(element, [
        { opacity: 0, transform: 'perspective(900px) rotateY(-90deg) translateY(12px)' },
        { opacity: 1, transform: 'perspective(900px) rotateY(0deg) translateY(0)' }
      ], TIMING.kpiMs, Math.min(Math.max(0, siblingIndex(element, selectors.kpi)), 5) * TIMING.kpiStagger);
      return;
    }
    if (element.matches(selectors.rows)) {
      Array.from(element.children).slice(0, 12).forEach(function (row, i) {
        if (!row.getClientRects().length) return;
        play(row, [{ opacity: 0, transform: 'translateY(7px)' }, { opacity: 1, transform: 'none' }], TIMING.rowMs, i * TIMING.rowStagger);
      });
      return;
    }
    var subtitle = element.matches(selectors.subtitle);
    play(element, [
      { opacity: 0, transform: 'translateY(' + (subtitle ? 6 : 16) + 'px)' },
      { opacity: 1, transform: 'none' }
    ], subtitle ? TIMING.subtitleMs : TIMING.panelMs,
    subtitle ? TIMING.subtitleDelay : Math.min(Math.max(0, siblingIndex(element, selectors.panel)), 4) * TIMING.panelStagger);
  }

  var intersection = window.IntersectionObserver ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      intersection.unobserve(entry.target);
      waiting.delete(entry.target);
      enter(entry.target);
    });
  }, { threshold: 0.04 }) : null;

  function scan() {
    timer = null;
    document.querySelectorAll(selector).forEach(function (element) {
      if (seen.has(element) || counted.has(element) || waiting.has(element) || element.closest('[data-motion="off"],[inert]')) return;
      if (intersection) { waiting.add(element); intersection.observe(element); }
      else enter(element);
    });
  }
  function schedule() {
    if (timer == null) timer = window.setTimeout(scan, 80);
  }
  function start() {
    var style = document.createElement('style');
    style.textContent = '.tks-motion-count{color:transparent!important}' +
      '.tks-motion-count::after{content:attr(data-tks-count-display) / "";position:absolute;inset:0;color:var(--tks-count-color);pointer-events:none;white-space:inherit;overflow-wrap:inherit;word-break:inherit}' +
      '@media(prefers-reduced-motion:reduce){.tks-motion-count{color:var(--tks-count-color)!important}.tks-motion-count::after{content:none}}';
    document.head.appendChild(style);
    scan();
    new MutationObserver(function (records) {
      if (records.some(function (record) {
        return record.type === 'attributes' || record.type === 'characterData' || record.addedNodes.length > 0;
      })) schedule();
    }).observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] });
  }
  function reduce() {
    if (media.matches) running.forEach(function (animation) { animation.cancel(); });
    if (media.matches) counters.forEach(function (finish) { finish(); });
  }
  if (media.addEventListener) media.addEventListener('change', reduce);
  else if (media.addListener) media.addListener(reduce);
  window.TKSMotion = { refresh: schedule };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());
