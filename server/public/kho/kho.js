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
    // Đưa ra thẳng <body>: .content có hiệu ứng làm position:fixed bị tính theo khung nội dung (lệch, thanh trên che hộp).
    document.body.appendChild(zoom);
    const zoomImg = zoom.querySelector('img');
    const caption = $('khoZoomCaption');
    const images = [...document.querySelectorAll('img[data-kho-img]')];
    let index = -1;
    let opener = null;
    const labelOf = img => {
      const figure = img.closest('figure');
      const title = figure && figure.querySelector('figcaption');
      return title ? title.textContent.trim() : img.alt;
    };
    const preload = i => { if (images[i]) { const pre = new Image(); pre.src = images[i].currentSrc || images[i].src; } };
    // Hiện ảnh thứ i (vòng tròn: hết ảnh cuối quay về ảnh đầu). Có 1 ảnh thì ẩn nút trước/sau.
    const show = i => {
      if (!images.length) return;
      index = (i + images.length) % images.length;
      const img = images[index];
      zoomImg.src = img.currentSrc || img.src;
      zoomImg.alt = img.alt;
      caption.textContent = labelOf(img) + ' · ' + (index + 1) + '/' + images.length;
      zoom.querySelectorAll('[data-kho-prev],[data-kho-next]').forEach(button => { button.hidden = images.length < 2; });
      preload(index + 1); preload(index - 1);
    };
    const step = delta => { if (!zoom.hidden) show(index + delta); };
    const open = img => {
      opener = img;
      zoom.hidden = false;
      document.body.style.overflow = 'hidden';
      show(images.indexOf(img));
      zoom.querySelector('[data-kho-close]').focus({ preventScroll: true });
    };
    const close = () => {
      zoom.hidden = true;
      zoomImg.removeAttribute('src');
      document.body.style.overflow = '';
      // Đóng ở ảnh nào thì trang cuộn về đúng ảnh đó (người dùng có thể đã lướt sang ảnh khác).
      const target = images[index] || opener;
      if (target && target.focus) target.focus({ preventScroll: false });
      opener = null;
      index = -1;
    };
    document.addEventListener('click', event => {
      const img = event.target.closest('img[data-kho-img]');
      if (img) { open(img); return; }
      if (zoom.hidden || !zoom.contains(event.target)) return;
      if (event.target.closest('[data-kho-prev]')) { step(-1); return; }
      if (event.target.closest('[data-kho-next]')) { step(1); return; }
      close();
    });
    document.addEventListener('keydown', event => {
      if (!zoom.hidden) {
        if (event.key === 'Escape') { close(); return; }
        if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); return; }
        if (event.key === 'ArrowRight') { event.preventDefault(); step(1); return; }
      }
      // Ảnh có tabindex: Enter/Space mở phóng to bằng bàn phím.
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches && event.target.matches('img[data-kho-img]')) {
        event.preventDefault();
        event.target.click();
      }
    });
    // Lướt ngang bằng 1 ngón: trái = ảnh sau, phải = ảnh trước. Chạm 2 ngón (zoom bằng tay) thì bỏ qua.
    const SWIPE_MIN = 50;
    let touch = null;
    zoom.addEventListener('touchstart', event => {
      touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    }, { passive: true });
    zoom.addEventListener('touchend', event => {
      if (!touch || event.changedTouches.length !== 1) { touch = null; return; }
      const dx = event.changedTouches[0].clientX - touch.x;
      const dy = event.changedTouches[0].clientY - touch.y;
      touch = null;
      if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    }, { passive: true });
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
