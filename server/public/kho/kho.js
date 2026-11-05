// Trang sơ đồ kho (/kho-hn/, /kho-sg/): giao diện chung (theme, menu, sidebar), chip cuộn tới ảnh, bấm ảnh phóng to (Esc đóng).
(function () {
  'use strict';
  const $ = id => document.getElementById(id);

  function syncTheme() {
    const light = document.documentElement.dataset.theme === 'light';
    $('themeLabel').textContent = light ? 'Dark mode' : 'Light mode';
    $('themeToggle').setAttribute('aria-pressed', String(light));
  }

  function bindZoom() {
    const zoom = $('khoZoom');
    if (!zoom) return;
    const zoomImg = zoom.querySelector('img');
    let opener = null;
    const close = () => {
      zoom.hidden = true;
      zoomImg.removeAttribute('src');
      document.body.style.overflow = '';
      if (opener && opener.focus) opener.focus({ preventScroll: true });
      opener = null;
    };
    document.addEventListener('click', event => {
      const img = event.target.closest('img[data-kho-img]');
      if (img) {
        opener = img;
        zoomImg.src = img.currentSrc || img.src;
        zoomImg.alt = img.alt;
        zoom.hidden = false;
        document.body.style.overflow = 'hidden';
        zoom.querySelector('button').focus({ preventScroll: true });
        return;
      }
      if (!zoom.hidden && zoom.contains(event.target)) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !zoom.hidden) { close(); return; }
      // Ảnh có tabindex: Enter/Space mở phóng to bằng bàn phím.
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches && event.target.matches('img[data-kho-img]')) {
        event.preventDefault();
        event.target.click();
      }
    });
  }

  function bindChips() {
    document.querySelectorAll('[data-kho-chip]').forEach(chip => {
      chip.addEventListener('click', event => {
        const target = document.getElementById(chip.dataset.khoChip);
        if (!target) return;
        event.preventDefault();
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        if (window.history && window.history.replaceState) window.history.replaceState(null, '', '#' + target.id);
      });
    });
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
    const user = await window.TKSNav.authGuard();
    window.TKSNav.renderTopSidebar($('sidebar'), 'stockLocations', user);
    bindChips();
    bindZoom();
  }

  window.TKSKho = { init };
})();
