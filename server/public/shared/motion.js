/* Shared, progressive entrance motion. Content stays visible without JS/WAAPI.
 * Explicit hooks: data-motion="title|subtitle|kpi|panel|rows"; opt out with
 * data-motion="off" on any ancestor. Every element enters at most once.
 * 11/11/2026: bỏ số đếm chạy trên KPI (số thật hiện ngay) và tiêu đề hiện từng chữ (chỉ mờ dần nhẹ).
 */
(function () {
  'use strict';
  if (window.TKSMotion || !Element.prototype.animate) return;
  var media = window.matchMedia('(prefers-reduced-motion: reduce)');
  var seen = new WeakSet();
  var waiting = new WeakSet();
  var running = new Set();
  var timer;
  var selectors = {
    title: '[data-motion="title"],.view-title,.page-title,.section-head h2,.admin-header h2,.account-header h2,.hr-header h2,.locations-title,.vr-title,.vd-title,.vl-title,.lc-title,.login-card h2,.register-card h2,.card-404 h2',
    subtitle: '[data-motion="subtitle"],.view-sub,.page-sub,.page-subtitle,.section-note',
    kpi: '[data-motion="kpi"],.kpi-card,.kpi-stat,.vd-metric',
    panel: '[data-motion="panel"],.panel,.card,.locations-panel,.vr-panel,.vd-panel,.vd-card,.vd-qr-panel,.login-card,.register-card,.card-404',
    rows: '[data-motion="rows"],.content table tbody,main table tbody'
  };
  var selector = Object.keys(selectors).map(function (key) { return selectors[key]; }).join(',');
  var ease = 'cubic-bezier(0.22,1,0.36,1)';
  // Nhịp chuyển động (ms). Rút ngắn 11/2026: mọi lối vào xong trong khoảng 0,3–0,45 s.
  var TIMING = {
    titleMs: 220,
    kpiMs: 300, kpiStagger: 30,
    rowMs: 200, rowStagger: 15,
    panelMs: 280, panelStagger: 40,
    subtitleMs: 220, subtitleDelay: 40
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

  function enter(element) {
    if (seen.has(element) || !element.isConnected || !element.getClientRects().length ||
        element.closest('[data-motion="off"],[inert]')) return;
    // Loading/empty table placeholders should not consume the real rows' entrance.
    if (element.matches(selectors.rows) && (!element.children.length ||
        Array.from(element.children).every(function (row) { return row.children.length === 1 && row.firstElementChild.hasAttribute('colspan'); }))) return;
    seen.add(element);
    if (media.matches) return;
    if (element.matches(selectors.title)) {
      // Tiêu đề chỉ mờ dần nhẹ, không tách chữ (không đổi DOM, không đo bề rộng từng từ).
      play(element, [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], TIMING.titleMs, 0);
      return;
    }
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
      if (seen.has(element) || waiting.has(element) || element.closest('[data-motion="off"],[inert]')) return;
      if (intersection) { waiting.add(element); intersection.observe(element); }
      else enter(element);
    });
  }
  function schedule() {
    if (timer == null) timer = window.setTimeout(scan, 80);
  }
  function start() {
    scan();
    // Không theo dõi đổi chữ (characterData): chỉ phần tử mới / hiện ra mới cần lối vào; bảng cập nhật số liên tục
    // không còn kích hoạt quét lại cả trang.
    new MutationObserver(function (records) {
      if (records.some(function (record) {
        return record.type === 'attributes' || record.addedNodes.length > 0;
      })) schedule();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert'] });
  }
  function reduce() {
    if (media.matches) running.forEach(function (animation) { animation.cancel(); });
  }
  if (media.addEventListener) media.addEventListener('change', reduce);
  else if (media.addListener) media.addListener(reduce);
  window.TKSMotion = { refresh: schedule };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}());
