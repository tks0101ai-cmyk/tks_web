// ==========================================
// TTL SNAPSHOT CACHE — cache ngan han dung chung cho cac "snapshot" doc tu
// nguon ngoai (Postgres/Sheets...): doc nhanh (cache hit) hau het thoi gian,
// ghi o noi khac hien ra sau toi da freshTtlMs, va khi nguon ngoai loi tam
// thoi thi tra ban stale (con trong staleTtlMs) thay vi lam fail moi request.
//
// Tach ra tu logic da co san trong server/hr/employeeDirectory.js (fresh
// ~10s / stale-on-error ~15 phut) de server/auth/localUserStore.js dung lai
// dung mot cach hanh xu da duoc kiem chung, khong viet lai lan hai.
// ==========================================
'use strict';

function createTtlSnapshotCache(options = {}) {
  const {
    fetch,
    freshTtlMs = 10 * 1000,
    staleTtlMs = 15 * 60 * 1000,
    now = () => Date.now(),
    // true: het freshTtl van tra ngay ban cu (con trong staleTtl) va nap lai NGAM, request khong phai cho
    // 1 vong toi DB. Doi lai du lieu moi chi hien o request ke tiep sau khi nap xong.
    backgroundRefresh = false,
    onUnavailable = err => { throw err; }
  } = options;

  if (typeof fetch !== 'function') {
    throw new Error('createTtlSnapshotCache yêu cầu options.fetch là một hàm.');
  }

  let lastSuccess = null;
  let loading = null;

  async function get(getOptions = {}) {
    const forceRefresh = !!getOptions.forceRefresh;
    if (!forceRefresh && lastSuccess && now() - lastSuccess.loadedAt < freshTtlMs) {
      return lastSuccess;
    }
    const canServeStale = backgroundRefresh && !forceRefresh && lastSuccess && now() - lastSuccess.loadedAt <= staleTtlMs;
    if (loading) return canServeStale ? lastSuccess : loading;

    loading = fetch()
      .then(data => {
        const snapshot = { ...data, loadedAt: now(), stale: false };
        lastSuccess = snapshot;
        return snapshot;
      })
      .catch(err => {
        if (lastSuccess && now() - lastSuccess.loadedAt <= staleTtlMs) {
          // Lam moi nen: cac request sau (khong cho lan doc nay) cung phai biet ban dang tra la ban cu do nguon
          // loi -> ghi co stale vao chinh ban dang giu (giu loadedAt: van het han, lan sau doc lai). Lan doc sau
          // thanh cong thi thay ban moi (stale: false).
          if (backgroundRefresh) lastSuccess = { ...lastSuccess, stale: true };
          return { ...lastSuccess, stale: true };
        }
        return onUnavailable(err);
      })
      .finally(() => { loading = null; });

    if (canServeStale) {
      loading.catch(() => {});
      return lastSuccess;
    }
    return loading;
  }

  function clear() {
    lastSuccess = null;
    loading = null;
  }

  // Nap truc tiep 1 snapshot vao cache (khong goi fetch) — dung de seed du
  // lieu gia trong unit test (xem localUserStore.setInMemoryUsers).
  function set(data) {
    lastSuccess = { ...data, loadedAt: now(), stale: false };
    loading = null;
  }

  return { get, clear, set };
}

module.exports = { createTtlSnapshotCache };
