'use strict';

// Cache gia tri tung tab Google Sheet (mang 2 chieu) theo ten tab, TTL ngan.
// - Con han: tra cache. Het han: doc lai (moi tab chi 1 luot doc dang chay, cac request khac cho chung).
// - allowStale: het han nhung con ban cu -> tra NGAY ban cu va lam moi o nen (request khong phai cho Google).
//   Loi khi lam moi nen chi bao onBackgroundError, giu ban cu, lan sau thu lai.
// - staleIfErrorMs (mac dinh 0 = tat): doc lai LOI ma con ban tot chua qua chung nay -> tra ban cu thay vi nem loi
//   (bao onBackgroundError). Tranh 1 lan Google loi/qua han muc lam tab bi coi nhu RONG o tang tren.
// - invalidate(): bo het (ke ca ket qua cua luot doc dang chay) — dung ngay sau khi chinh server ghi sheet.
function createSheetValuesCache({ ttlMs, load, now = () => Date.now(), onBackgroundError = () => {}, staleIfErrorMs = 0 }) {
  let entries = new Map(); // sheetName -> { data, expiresAt, loading, fetchedAt }

  function refresh(sheetName) {
    const owner = entries;
    const previous = owner.get(sheetName);
    const loading = new Promise(resolve => resolve(load(sheetName))).then(values => {
      if (owner.get(sheetName)?.loading === loading) owner.set(sheetName, { data: values, expiresAt: now() + ttlMs, loading: null, fetchedAt: now() });
      return values;
    }, error => {
      const current = owner.get(sheetName);
      if (current?.loading === loading) {
        if (current.data) owner.set(sheetName, { data: current.data, expiresAt: 0, loading: null, fetchedAt: current.fetchedAt });
        else owner.delete(sheetName);
      }
      throw error;
    });
    owner.set(sheetName, { data: previous ? previous.data : null, expiresAt: 0, loading, fetchedAt: previous ? previous.fetchedAt : 0 });
    return loading;
  }

  async function get(sheetName, { allowStale = false } = {}) {
    const cached = entries.get(sheetName);
    if (cached && cached.data && now() < cached.expiresAt) return cached.data;
    if (allowStale && cached && cached.data) {
      if (!cached.loading) refresh(sheetName).catch(onBackgroundError);
      return cached.data;
    }
    const loading = cached && cached.loading ? cached.loading : refresh(sheetName);
    if (!staleIfErrorMs || !cached || !cached.data) return loading;
    const { data, fetchedAt } = cached;
    return loading.catch(error => {
      if (now() - fetchedAt > staleIfErrorMs) throw error;
      onBackgroundError(error);
      return data;
    });
  }

  function invalidate() { entries = new Map(); }

  return { get, invalidate };
}

module.exports = { createSheetValuesCache };
