'use strict';

const BASE_URL = 'https://public.kiotapi.com';
const TOKEN_URL = 'https://id.kiotviet.vn/connect/token';
const PAGE_SIZE = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createKiotVietClient(config) {
  const {
    clientId,
    clientSecret,
    retailer,
    fetchImpl = global.fetch,
    now = Date.now,
    requestOptions = {}
  } = config;

  let cachedToken = null;
  let cachedTokenExpiresAt = 0;

  async function fetchJsonWithRetry(url, options = {}, opts = {}) {
    const { maxRetries = 5, baseDelayMs = 1000, timeoutMs = 45000 } = {...requestOptions,...opts};
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let response;
      try {
        response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined });
      } catch (err) {
        lastError = err;
        if (attempt < maxRetries) {
          await sleep(baseDelayMs * Math.pow(2, attempt - 1));
          continue;
        }
        break;
      }

      const text = await response.text();
      if (response.ok) return JSON.parse(text);

      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
      lastError.status = response.status;

      if (response.status !== 429 && response.status < 500) break;
      if (attempt < maxRetries) await sleep(baseDelayMs * Math.pow(2, attempt - 1));
    }

    throw lastError;
  }

  async function getAccessToken(forceRefresh = false) {
    if (!forceRefresh && cachedToken && now() < cachedTokenExpiresAt) {
      return cachedToken;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scopes: 'PublicApi.Access'
    }).toString();

    const data = await fetchJsonWithRetry(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });

    cachedToken = data.access_token;
    cachedTokenExpiresAt = now() + Math.min(86340, data.expires_in - 60) * 1000;
    return cachedToken;
  }

  async function authorizedRequest(path, searchParams) {
    const token = await getAccessToken();
    const url = `${BASE_URL}${path}?${searchParams.toString()}`;
    const headers = { Authorization: `Bearer ${token}`, Retailer: retailer };

    try {
      return await fetchJsonWithRetry(url, { method: 'GET', headers });
    } catch (err) {
      if (err.status === 401) {
        const freshToken = await getAccessToken(true);
        const retryHeaders = { Authorization: `Bearer ${freshToken}`, Retailer: retailer };
        return await fetchJsonWithRetry(url, { method: 'GET', headers: retryHeaders });
      }
      throw err;
    }
  }

  async function fetchAllPages(endpoint, query, onPage, options = {}) {
    const requestedPageSize = Number(query.pageSize);
    const pageSize = Number.isInteger(requestedPageSize) && requestedPageSize > 0 && requestedPageSize <= PAGE_SIZE
      ? requestedPageSize
      : PAGE_SIZE;
    let currentItem = options.startItem || 0;
    let total = Infinity;
    let pagesLoaded = 0;
    let recordsLoaded = 0;
    let snapshotTotal;

    while (currentItem < total) {
      const params = new URLSearchParams({ ...query, pageSize: String(pageSize), currentItem: String(currentItem) });
      const page = await authorizedRequest(`/${endpoint}`, params);
      const items = page.data || [];
      if (options.requireComplete) {
        const count = Number(page.total);
        if (page.total == null || !Number.isInteger(count) || count < 0 || !Array.isArray(page.data)
          || (snapshotTotal !== undefined && snapshotTotal !== count)
          || items.length !== Math.min(pageSize, Math.max(0, count - currentItem))) {
          throw new Error(`Incomplete ${endpoint} snapshot: invalid total or truncated page at ${currentItem}`);
        }
        snapshotTotal = count;
      }
      total = page.total || 0;
      pagesLoaded++;
      recordsLoaded += items.length;
      currentItem += pageSize;

      // nextItem la vi tri de tiep tuc neu tien trinh bi dung ngay sau trang
      // nay -- dung cho co che resume backfill (xem backfillProgressRepository.js).
      const removedIds = [page.removedIds, page.removeIds, page.removeId]
        .flatMap(ids => ids == null ? [] : Array.isArray(ids) ? ids : [ids]);
      await onPage(items, { pagesLoaded, recordsLoaded, total, nextItem: currentItem, removedIds });

      if (items.length === 0) break;
    }
  }

  async function fetchProductOnHand(code) {
    try {
      const params = new URLSearchParams({ includeInventory: 'true' });
      const product = await authorizedRequest(`/products/code/${encodeURIComponent(code)}`, params);
      const onHand = (product.inventories || []).reduce((sum, inv) => sum + (inv.onHand || inv.onhand || 0), 0);
      return { code, found: true, onHand };
    } catch (err) {
      if (err.status === 404) return { code, found: false, onHand: 0 };
      throw err;
    }
  }

  // Ghi len Kiot (PUT /orders/{id}): KHONG tu thu lai khi loi 5xx/mat ket noi -- lan dau co the da ghi, thu lai mu co the ghi chong.
  // 401 thi lay token moi roi gui lai dung 1 lan (chua xu ly gi nen an toan).
  async function authorizedWrite(method, path, body) {
    const send = async (token) => fetchJsonWithRetry(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Retailer: retailer, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { maxRetries: 1 });
    try {
      return await send(await getAccessToken());
    } catch (err) {
      if (err.status === 401) return send(await getAccessToken(true));
      throw err;
    }
  }

  async function fetchOrderById(id) {
    return authorizedRequest(`/orders/${encodeURIComponent(id)}`, new URLSearchParams());
  }

  async function updateOrder(id, body) {
    return authorizedWrite('PUT', `/orders/${encodeURIComponent(id)}`, body);
  }

  return { getAccessToken, fetchJsonWithRetry, fetchAllPages, fetchProductOnHand, fetchOrderById, updateOrder };
}

module.exports = { createKiotVietClient };
