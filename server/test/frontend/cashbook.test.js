"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const file = path.join(__dirname, "../../public/cashbook/index.html");
const html = fs.existsSync(file)
  ? fs.readFileSync(file, "utf8")
  : "<html></html>";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const summary = {
  groupBalances: [
    { name: "Anh Quân", balance: -1234.5 }, { name: "Chị Nguyệt", balance: 0 },
    { name: "Anh Duy", balance: 0 }, { name: "Công ty", balance: 0 }, { name: "Khác", balance: 0 },
  ],
  balances: [
    {
      fund: "-1,7",
      accountIds: ["-1", "7"],
      name: "Bank cũ",
      accountGroup: "Anh Quân",
      accountNo: "001",
      description: "TK chính",
      balanceHanoi: -1534.5,
      balanceSaigon: 300,
      balance: -1234.5,
    },
    {
      fund: "cash",
      accountIds: [],
      name: "Tiền mặt",
      accountNo: "",
      description: "",
      balanceHanoi: 0,
      balanceSaigon: 0,
      balance: 0,
    },
  ],
  totalBalance: -1234.5,
  kpis: {
    totalReceipts: 10,
    totalPayments: 20,
    closingBalance: null,
  },
  syncedAt: "2026-10-05T18:30:00Z",
  revision: "v1",
};
const entries = {
  entries: [
    {
      id: "1",
      branch: "hanoi",
      code: "<img src=x>",
      transDate: "2026-10-05T18:30:00Z",
      docType: "payment",
      group: "Khác",
      partnerName: "Alice",
      partnerPhone: "123",
      fund: "-1",
      fundName: "Bank cũ",
      creatorName: "Lan",
      staffName: "Lan",
      amount: -10,
      runningBalance: -1234.5,
      status: "paid",
      note: "",
    },
  ],
  total: 201,
  page: 1,
  pageSize: 100,
  totalPages: 3,
};
const options = {
  funds: summary.balances.map(
    ({ balance, balanceHanoi, balanceSaigon, ...fund }) => fund,
  ),
  groups: [{ key: "name:Chi%20kh%C3%A1c", label: "Chi khác" }],
  creators: [{ id: "9", label: "Lan" }],
  staff: [{ id: "9", label: "Lan" }],
  supportedFilters: {
    debt: false,
    partnerType: false,
    partnerCode: false,
    partnerName: true,
    partnerId: true,
    partnerPhone: true,
  },
};
async function setup(t, { hash = "", fetcher, captureTimers = false } = {}) {
  const dom = new JSDOM(html, {
    url: "https://tokosi.test/cashbook/" + hash,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  const timers = new Map();
  if (captureTimers) {
    let nextTimer = 0;
    w.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
    w.clearTimeout = (id) => timers.delete(id);
  }
  w.TKSNav = {
    authGuard: async () => ({ permissions: ["cashbook.view"] }),
    can: (key) => key === "cashbook.view",
  };
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new w.Event("close"));
  };
  const calls = [];
  w.fetch = async (url, init = {}) => {
    const parsed = new URL(url, w.location.href);
    calls.push({ url: parsed, init });
    if (fetcher) {
      const answer = await fetcher(parsed, init);
      if (answer) return answer;
    }
    const data = parsed.pathname.endsWith("filter-options")
      ? options
      : parsed.pathname.endsWith("summary")
        ? summary
        : { ...entries, page: +(parsed.searchParams.get("page") || 1) };
    return { ok: true, json: async () => data };
  };
  const script = w.document.getElementById("cashbook-script");
  w.eval(require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/shared/fuzzy-search.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8'));
  if (script) w.eval(script.textContent);
  assert.ok(
    w.TKSCashbook,
    "Trang phải cung cấp logic Sổ quỹ để kiểm thử từ HTML",
  );
  return {
    w,
    doc: w.document,
    api: w.TKSCashbook,
    calls,
    timers,
    init: () => w.TKSCashbook.init(),
  };
}

test('5 ô số dư theo nhóm đúng thứ tự, giữ số âm và tìm tài khoản theo nhóm', async t => {
  const {init, doc, w, calls} = await setup(t);
  await init();
  const cards = [...doc.querySelectorAll('#groupBalances .kpi-card')];
  assert.deepEqual(cards.map(card => card.querySelector('.eyebrow').textContent),
    ['Anh Quân', 'Chị Nguyệt', 'Anh Duy', 'Công ty', 'Khác']);
  assert.deepEqual(cards.map(card => card.querySelector('.value').textContent), ['-1,234.5', '0', '0', '0', '0']);
  assert.ok(cards[0].querySelector('.value').classList.contains('negative'));
  assert.equal(doc.querySelector('#balancesBody [data-field="accountGroup"]').textContent, 'Anh Quân');
  const count = calls.length;
  const search = doc.getElementById('balancesSearch');
  search.value = 'anh quan';
  search.dispatchEvent(new w.Event('input', {bubbles: true}));
  assert.deepEqual([...doc.querySelectorAll('#balancesBody tr[data-fund]')].map(row => row.dataset.fund), ['-1,7']);
  assert.equal(calls.length, count);
  assert.equal(cards[0].querySelector('.value').textContent, '-1,234.5');
});

test("tiền null khác số 0, dấu âm và chuỗi thập phân giữ chính xác", async (t) => {
  const { api } = await setup(t);
  assert.equal(api.money(null), "—");
  assert.equal(api.money(0), "0");
  assert.equal(api.money(-1234567.5), "-1,234,567.5");
  assert.equal(api.money(1e-21), "0.000000000000000000001");
  assert.equal(
    api.money("9007199254740990.123456789"),
    "9,007,199,254,740,990.123456789",
  );
});
test("query giữ danh sách rỗng và quỹ -1, mã nhóm không bị decode hai lần", async (t) => {
  const { api, w } = await setup(t);
  const p = new w.URLSearchParams(
    api.query({
      fund: "-1",
      preset: "thisMonth",
      docTypes: [],
      groups: ["name:Chi%20kh%C3%A1c"],
      staff: [],
      partnerQ: "Lan & #9",
    }),
  );
  assert.equal(p.get("fund"), "-1");
  assert.equal(p.get("docTypes"), "");
  assert.equal(p.get("staff"), "");
  assert.equal(p.get("groups"), "name:Chi%20kh%C3%A1c");
  assert.equal(p.get("partnerQ"), "Lan & #9");
  assert.equal(p.has("creators"), false);
});
test("query ngày tùy chỉnh loại bỏ preset và không gửi khóa không hỗ trợ", async (t) => {
  const { api, w } = await setup(t);
  const p = new w.URLSearchParams(
    api.query({
      preset: "custom",
      from: "2026-10-01",
      to: "2026-10-06",
      debt: "all",
      partnerType: "customer",
      partnerCode: "K1",
    }),
  );
  assert.equal(p.get("from"), "2026-10-01");
  assert.equal(p.get("to"), "2026-10-06");
  for (const k of ["preset", "debt", "partnerType", "partnerCode"])
    assert.equal(p.has(k), false);
});
test("hash roundtrip phân biệt empty và default khi F5", async (t) => {
  const { api } = await setup(t);
  const f = api.readHash(
    "#fund=&docTypes=&statuses=&staff=&partnerQ=Lan%20%26%20Hoa",
  );
  assert.equal(f.fund, "");
  assert.equal(f.docTypes.length, 0);
  assert.equal(f.staff.length, 0);
  const round = api.readHash(api.writeHash(f));
  assert.equal(round.statuses.length, 0);
  assert.equal(round.partnerQ, "Lan & Hoa");
  assert.equal(api.readHash("").fund, "all");
  assert.equal(api.readHash("").preset, "thisYear");
  assert.equal(Object.hasOwn(api.readHash(""), "staff"), false);
});
test("ngày VN độc lập múi giờ máy khách", async (t) => {
  const { api } = await setup(t);
  assert.equal(api.vnLocal("2026-10-05T18:30:15.123Z"), "2026-10-06T01:30:15");
  assert.match(api.dateText("2026-10-05T18:30:15Z"), /06\/10\/2026/);
});
test("lũy kế luôn hiện theo số máy chủ trả về, ô trống khi không có số", async (t) => {
  const { api } = await setup(t);
  assert.equal(api.runningText({ runningBalance: 10 }), "10");
  assert.equal(api.runningText({ runningBalance: -1234.5 }), "-1,234.5");
  assert.equal(api.runningText({ runningBalance: null }), "");
});
test("khởi tạo render API thật, tồn quỹ HN/SG/tổng, negative đỏ và text không thành HTML", async (t) => {
  const { init, doc } = await setup(t);
  await init();
  const row = doc.querySelector('#balancesBody tr[data-fund="-1,7"]');
  assert.equal(row.querySelector('[data-field="balanceHanoi"]').textContent, "-1,534.5");
  assert.equal(row.querySelector('[data-field="balanceSaigon"]').textContent, "300");
  assert.equal(
    doc.querySelector('#balancesBody tr[data-fund="cash"] [data-field="balance"]').textContent,
    "0",
  );
  assert.equal(
    doc.querySelector('#balancesBody [data-field="balance"]').textContent,
    "-1,234.5",
  );
  assert.ok(
    doc
      .querySelector('#balancesBody [data-field="balance"]')
      .classList.contains("negative"),
  );
  assert.match(
    doc.getElementById("balanceTotal").textContent,
    /Tổng tồn quỹ HN \+ SG: -1,234\.5/,
  );
  assert.equal(doc.querySelector("#entriesBody img"), null);
  assert.match(doc.getElementById("entriesBody").textContent, /<img src=x>/);
  assert.equal(
    doc.querySelector('#entriesBody [data-field="runningBalance"]').textContent,
    "-1,234.5",
  );
  assert.equal(doc.getElementById("checkpointsBody"), null);
});
test("click tài khoản lịch sử lọc đúng quỹ và giữ partner/hash; pager gọi server", async (t) => {
  const { init, doc, w, calls } = await setup(t, { hash: "#partnerQ=Lan" });
  await init();
  doc.querySelector('[data-select-fund="-1,7"]').click();
  await tick();
  assert.match(w.location.hash, /fund=-1%2C7/);
  assert.match(w.location.hash, /partnerQ=Lan/);
  doc.getElementById("entriesNext").click();
  await tick();
  const last = calls
    .filter((c) => c.url.pathname.endsWith("entries"))
    .at(-1).url;
  assert.equal(last.searchParams.get("page"), "2");
  assert.equal(last.searchParams.get("fund"), "-1,7");
});
test("bỏ tick hết gửi danh sách rỗng, reset khôi phục all mà không bóp ngân hàng -1", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  for (const input of doc.querySelectorAll('[name="docTypes"]')) {
    input.checked = false;
    input.dispatchEvent(new w.Event("change", { bubbles: true }));
  }
  await tick();
  assert.equal(
    calls
      .filter((c) => c.url.pathname.endsWith("entries"))
      .at(-1)
      .url.searchParams.get("docTypes"),
    "",
  );
  doc.getElementById("resetFilters").click();
  await tick();
  assert.equal(
    calls
      .filter((c) => c.url.pathname.endsWith("entries"))
      .at(-1)
      .url.searchParams.has("docTypes"),
    false,
  );
});
test("ô text debounce 300ms và hash ghi giá trị mới", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  const scheduled = new Map();
  let id = 0;
  w.setTimeout = (fn, ms) => {
    scheduled.set(++id, { fn, ms });
    return id;
  };
  w.clearTimeout = (value) => scheduled.delete(value);
  doc.querySelector('[data-search-mode="partner"]').click();
  const before = calls.length,
    input = doc.getElementById("entriesSearch");
  input.value = "L";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  input.value = "Lan";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(calls.length, before);
  assert.equal(scheduled.size, 1);
  const job = [...scheduled.values()][0];
  assert.equal(job.ms, 300);
  job.fn();
  await tick();
  assert.match(w.location.hash, /partnerQ=Lan/);
});
test("response bộ lọc cũ không ghi đè khi response mới đã hiện", async (t) => {
  let release;
  const { init, doc, w } = await setup(t, {
    fetcher: async (url) => {
      if (
        url.pathname.endsWith("summary") &&
        url.searchParams.get("fund") === "-1,7"
      )
        return new Promise((resolve) => {
          release = resolve;
        });
      if (
        url.pathname.endsWith("summary") &&
        url.searchParams.get("fund") === "cash"
      )
        return {
          ok: true,
          json: async () => ({ ...summary, balances: [summary.balances[1]] }),
        };
    },
  });
  await init();
  doc.querySelector('[data-select-fund="-1,7"]').click();
  await tick();
  doc.querySelector('[data-select-fund="cash"]').click();
  await tick();
  release({ ok: true, json: async () => summary });
  await tick();
  assert.doesNotMatch(
    doc.getElementById("balancesBody").textContent,
    /Bank cũ/,
  );
});
test("lỗi API hiển thị tiếng Việt và giữ bộ lọc để thử lại", async (t) => {
  const { init, doc, w } = await setup(t, {
    hash: "#fund=-1&partnerPhone=123",
    fetcher: async (url) =>
      url.pathname.endsWith("entries")
        ? {
            ok: false,
            status: 500,
            json: async () => ({
              error: "Lỗi hệ thống, vui lòng thử lại sau.",
            }),
          }
        : null,
  });
  await init();
  assert.match(doc.getElementById("pageStatus").textContent, /Lỗi hệ thống/);
  assert.match(w.location.hash, /partnerPhone=123/);
  assert.equal(doc.getElementById("entriesSearch").value, "123");
  assert.equal(
    doc.querySelector('[data-search-mode="phone"]').getAttribute("aria-pressed"),
    "true",
  );
});
test("lỗi sau khi đổi bộ lọc không để số dư cũ dưới bộ lọc mới", async (t) => {
  const { init, doc, w } = await setup(t);
  await init();
  w.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: "Lỗi hệ thống, vui lòng thử lại sau." }),
  });
  doc.querySelector('[data-select-fund="cash"]').click();
  await tick();
  assert.doesNotMatch(
    doc.getElementById("balancesBody").textContent,
    /Bank cũ/,
  );
  assert.equal(doc.getElementById("totalReceipts").textContent, "—");
  assert.match(w.location.hash, /fund=cash/);
});
test("drawer và dialog đóng trả focus, Escape đóng drawer", async (t) => {
  const { init, doc, w } = await setup(t);
  await init();
  doc.getElementById("filterToggle").click();
  assert.equal(
    doc.getElementById("filterToggle").getAttribute("aria-expanded"),
    "true",
  );
  doc.dispatchEvent(
    new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(
    doc.getElementById("filterToggle").getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(doc.activeElement.id, "filterToggle");
  const btn = doc.querySelector('[data-export="entries"]');
  btn.click();
  doc.getElementById("exportDialog").close();
  assert.equal(doc.activeElement, btn);
});
test("export tất cả cột mặc định, empty chặn, lựa chọn nhớ riêng từng bảng và loại file", async (t) => {
  const { init, doc, api } = await setup(t);
  await init();
  doc.querySelector('[data-export="balances"]').click();
  assert.deepEqual(
    [...doc.querySelectorAll("#exportColumns input:checked")].map((i) => i.value),
    ["accountNo", "name", "description", "balanceHanoi", "balanceSaigon", "balance"],
  );
  for (const box of doc.querySelectorAll("#exportColumns input"))
    box.checked = false;
  doc
    .getElementById("exportColumns")
    .dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  assert.equal(doc.getElementById("exportDownload").disabled, true);
  doc.querySelector('#exportColumns input[value="name"]').checked = true;
  doc
    .getElementById("exportColumns")
    .dispatchEvent(new doc.defaultView.Event("change", { bubbles: true }));
  doc.getElementById("exportDialog").close();
  doc.querySelector('[data-export="entries"]').click();
  assert.equal(doc.querySelectorAll("#exportColumns input:checked").length, 14);
  doc.getElementById("exportDialog").close();
  doc.querySelector('[data-export="balances"]').click();
  assert.equal(doc.querySelectorAll("#exportColumns input:checked").length, 1);
  const url = new URL(
    api.exportUrl("balances", "html", ["name"], { fund: "-1", staff: [] }),
    "https://tokosi.test",
  );
  assert.equal(url.searchParams.get("format"), "html");
  assert.equal(url.searchParams.get("columns"), "name");
  assert.equal(url.searchParams.get("staff"), "");
  assert.equal(url.searchParams.has("page"), false);
});
test("preset radio và ngày tùy chỉnh phát query VN không kèm preset", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  const custom = doc.querySelector('[name="preset"][value="custom"]');
  assert.ok(custom && custom.type === "radio");
  custom.checked = true;
  custom.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  doc.getElementById("from").value = "2026-10-01";
  doc
    .getElementById("from")
    .dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  const last = calls
    .filter((c) => c.url.pathname.endsWith("entries"))
    .at(-1).url;
  assert.equal(last.searchParams.has("preset"), false);
  assert.equal(last.searchParams.get("from"), "2026-10-01");
});
test("không còn dropdown Quỹ; bấm tài khoản để lọc, bấm lại hoặc nút Bỏ lọc để xem tất cả", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  assert.equal(doc.querySelector('[data-dd="fund"]'), null);
  assert.equal(doc.querySelector('[name="fundMode"], [name="fundAccounts"]'), null);
  assert.equal(doc.getElementById("fundFilter").hidden, true);
  const lastFund = () =>
    calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url.searchParams.get("fund");
  doc.querySelector('[data-select-fund="-1,7"]').click();
  await tick();
  assert.equal(lastFund(), "-1,7");
  assert.equal(doc.getElementById("fundFilter").hidden, false);
  assert.equal(doc.getElementById("fundFilterName").textContent, "001");
  const row = doc.querySelector('#balancesBody tr[data-fund="-1,7"]');
  assert.ok(row.classList.contains("is-selected"));
  assert.equal(row.getAttribute("aria-selected"), "true");
  row.querySelector("td").click();
  await tick();
  assert.equal(lastFund(), "all");
  assert.equal(doc.getElementById("fundFilter").hidden, true);
  doc.querySelector('[data-select-fund="cash"]').click();
  await tick();
  assert.equal(doc.getElementById("fundFilterName").textContent, "Tiền mặt");
  doc.getElementById("clearFund").click();
  await tick();
  assert.equal(lastFund(), "all");
  assert.match(w.location.hash, /fund=all/);
});
for (const outcome of ["success", "failure"]) {
  test(`export ${outcome} cũ không đổi dialog bảng mới`, async (t) => {
    let finishExport;
    const { init, doc, w } = await setup(t, {
      fetcher: async (url) => {
        if (url.pathname.endsWith("export"))
          return new Promise((resolve) => {
            finishExport = resolve;
          });
      },
    });
    await init();
    const downloaded = [];
    w.URL.createObjectURL = () => "blob:synthetic";
    w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () {
      downloaded.push(this.download);
    };
    doc.querySelector('[data-export="balances"]').click();
    doc.getElementById("exportDownload").click();
    await tick();
    assert.equal(typeof finishExport, "function");
    doc.getElementById("exportDialog").close();
    doc.querySelector('[data-export="entries"]').click();
    doc.querySelector('#exportColumns input[value="code"]').checked = false;
    doc
      .getElementById("exportColumns")
      .dispatchEvent(new w.Event("change", { bubbles: true }));
    assert.equal(doc.getElementById("exportDownload").disabled, false);
    finishExport(
      outcome === "success"
        ? { ok: true, blob: async () => new w.Blob(["old file"]) }
        : {
            ok: false,
            status: 500,
            json: async () => ({ error: "Lỗi xuất số dư cũ." }),
          },
    );
    await tick();
    assert.equal(doc.getElementById("exportDialog").open, true);
    assert.equal(doc.querySelectorAll("#exportColumns input").length, 14);
    assert.equal(
      doc.querySelector('#exportColumns input[value="code"]').checked,
      false,
    );
    assert.equal(doc.getElementById("exportError").textContent, "");
    assert.equal(doc.getElementById("exportDownload").disabled, false);
    assert.equal(doc.getElementById("exportHtml").disabled, false);
    assert.deepEqual(downloaded, []);
  });
}

test("export cũ hoàn thành khi bảng mới đang tải không bật lại nút tải", async (t) => {
  const pending = [];
  const { init, doc, w } = await setup(t, {
    fetcher: async (url) => {
      if (url.pathname.endsWith("export"))
        return new Promise((resolve) => pending.push(resolve));
    },
  });
  await init();
  w.URL.createObjectURL = () => "blob:synthetic";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = () => {};
  doc.querySelector('[data-export="balances"]').click();
  doc.getElementById("exportDownload").click();
  await tick();
  doc.getElementById("exportDialog").close();
  doc.querySelector('[data-export="entries"]').click();
  doc.getElementById("exportDownload").click();
  await tick();
  assert.equal(pending.length, 2);
  assert.equal(doc.getElementById("exportDownload").disabled, true);
  pending[0]({ ok: true, blob: async () => new w.Blob(["old file"]) });
  await tick();
  assert.equal(doc.getElementById("exportDialog").open, true);
  assert.equal(doc.getElementById("exportDownload").disabled, true);
  pending[1]({ ok: true, blob: async () => new w.Blob(["new file"]) });
  await tick();
  assert.equal(doc.getElementById("exportDialog").open, false);
});

test("export xlsx/html tải file qua blob; lỗi giới hạn hiện trong dialog", async (t) => {
  const { init, doc, w, calls } = await setup(t, {
    fetcher: async (url) =>
      url.pathname.endsWith("export")
        ? { ok: true, blob: async () => new w.Blob(["file"]) }
        : null,
  });
  await init();
  const downloaded = [];
  w.URL.createObjectURL = () => "blob:synthetic";
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {
    downloaded.push(this.download);
  };
  for (const format of ["xlsx", "html"]) {
    doc.querySelector('[data-export="entries"]').click();
    doc.getElementById(format === "html" ? "exportHtml" : "exportDownload").click();
    await tick();
  }
  assert.deepEqual(downloaded, [
    "TKS_So_quy_entries.xlsx",
    "TKS_So_quy_entries.html",
  ]);
  assert.equal(
    calls
      .filter((c) => c.url.pathname.endsWith("export"))
      .every((c) => !c.url.searchParams.has("page")),
    true,
  );
  w.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "Vượt giới hạn 20.000 dòng." }),
  });
  doc.querySelector('[data-export="entries"]').click();
  doc.getElementById("exportDownload").click();
  await tick();
  assert.match(doc.getElementById("exportError").textContent, /20\.000/);
  assert.equal(doc.getElementById("exportDialog").open, true);
});

test("ô tìm sổ chi tiết theo chế độ ghi đúng tham số máy chủ, đổi chế độ chuyển từ khóa", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  const input = doc.getElementById("entriesSearch");
  input.value = "PT12";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 320));
  await tick();
  let last = calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url;
  assert.equal(last.searchParams.get("code"), "PT12");
  doc.querySelector('[data-search-mode="note"]').click();
  await tick();
  last = calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url;
  assert.equal(last.searchParams.get("note"), "PT12");
  assert.equal(last.searchParams.has("code"), false);
  assert.match(w.location.hash, /note=PT12/);
  doc.querySelector('[data-search-clear="entriesSearch"]').click();
  await tick();
  last = calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url;
  assert.equal(last.searchParams.has("note"), false);
});
test("ô tìm số dư lọc tại máy khách không gọi lại API", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  const before = calls.length,
    input = doc.getElementById("balancesSearch");
  input.value = "tien mat";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(calls.length, before);
  const rows = doc.querySelectorAll("#balancesBody tr[data-fund]");
  assert.deepEqual([...rows].map((row) => row.dataset.fund), ["cash"]);
  input.value = "khong co";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.match(doc.getElementById("balancesBody").textContent, /Không có tài khoản khớp/);
});
test("dropdown bộ lọc hiện tóm tắt lựa chọn, Esc đóng và trả focus", async (t) => {
  const { init, doc, w } = await setup(t);
  await init();
  const dd = doc.querySelector('[data-dd="docTypes"]'),
    button = dd.querySelector(".dd-button");
  assert.equal(dd.querySelector("[data-summary]").textContent, "Tất cả");
  button.click();
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(doc.getElementById("docTypesPanel").hidden, false);
  const payment = doc.querySelector('[name="docTypes"][value="payment"]');
  payment.checked = false;
  payment.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  assert.equal(dd.querySelector("[data-summary]").textContent, "Phiếu thu");
  assert.ok(dd.classList.contains("is-filtered"));
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(doc.getElementById("docTypesPanel").hidden, true);
  assert.equal(doc.activeElement, button);
  doc.querySelector('[data-select-fund="-1,7"]').click();
  await tick();
  assert.equal(doc.getElementById("fundFilterName").textContent, "001");
});
test("phân trang có nút trang đầu/cuối gọi đúng trang máy chủ", async (t) => {
  const { init, doc, calls } = await setup(t);
  await init();
  assert.equal(doc.getElementById("entriesFirst").disabled, true);
  doc.getElementById("entriesLast").click();
  await tick();
  const last = calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url;
  assert.equal(last.searchParams.get("page"), "3");
});
test("bảng số dư sắp xếp theo tiêu đề: tăng, giảm, bỏ; cột tiền so theo số", async (t) => {
  const { init, doc } = await setup(t);
  await init();
  const order = () =>
    [...doc.querySelectorAll("#balancesBody tr[data-fund]")].map((r) => r.dataset.fund);
  const sort = (field) => doc.querySelector('#balancesTable [data-sort="' + field + '"]').click();
  assert.deepEqual(order(), ["-1,7", "cash"]);
  sort("name");
  assert.deepEqual(order(), ["-1,7", "cash"]);
  assert.equal(doc.querySelector('#balancesTable th[aria-sort="ascending"]').dataset.field, "name");
  sort("name");
  assert.deepEqual(order(), ["cash", "-1,7"]);
  sort("name");
  assert.equal(doc.querySelector('#balancesTable th[aria-sort="ascending"], #balancesTable th[aria-sort="descending"]'), null);
  sort("balanceSaigon");
  assert.deepEqual(order(), ["cash", "-1,7"]);
  sort("balanceSaigon");
  assert.deepEqual(order(), ["-1,7", "cash"]);
});
test("tài khoản tách STK, tên tài khoản và nhóm; giữ mô tả và chọn quỹ", async (t) => {
  const { init, doc, w } = await setup(t);
  await init();
  const name = doc.querySelector('#balancesBody tr[data-fund="-1,7"] [data-field="name"]');
  assert.equal(doc.querySelector('#balancesBody tr[data-fund="-1,7"] [data-field="accountNo"] [data-select-fund]').textContent, "001");
  assert.equal(name.firstChild.textContent, "Bank cũ");
  assert.deepEqual(
    [...name.querySelectorAll(".cb-fund-note")].map((n) => n.textContent),
    ["TK chính"],
  );
  assert.equal(
    doc.querySelector('#balancesBody tr[data-fund="cash"] [data-select-fund]').textContent,
    "Tiền mặt",
  );
  assert.deepEqual(
    [...doc.querySelectorAll("#balancesTable th")].map((th) => th.textContent.replace(/[↕▲▼]/g, "")),
    ["STK", "Tên tài khoản", "Nhóm", "Tồn quỹ HN", "Tồn quỹ SG", "Tổng tồn quỹ"],
  );
  for (const selector of ["[data-checkpoint]", "[data-edit-bank]", "#checkpointDialog", "#bankDialog"])
    assert.equal(doc.querySelector(selector), null, selector);
  const input = doc.getElementById("balancesSearch");
  input.value = "bank cu";
  input.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.deepEqual(
    [...doc.querySelectorAll("#balancesBody tr[data-fund]")].map((r) => r.dataset.fund),
    ["-1,7"],
  );
});

test("lọc nhóm số dư kết hợp tìm kiếm và sắp xếp, không tải lại dữ liệu", async (t) => {
  const { init, doc, w, calls } = await setup(t);
  await init();
  const group = doc.getElementById("balancesGroupFilter");
  assert.ok(group, "Có dropdown lọc nhóm");
  assert.deepEqual([...group.options].map(option => option.textContent), ["Tất cả nhóm", "Anh Quân", "Khác"]);
  const count = calls.length;
  const order = () => [...doc.querySelectorAll("#balancesBody tr[data-fund]")].map(row => row.dataset.fund);
  const choose = value => { group.value = value; group.dispatchEvent(new w.Event("change", { bubbles: true })); };
  choose("Anh Quân");
  assert.deepEqual(order(), ["-1,7"]);
  doc.querySelector('#balancesTable [data-sort="accountNo"]').click();
  assert.deepEqual(order(), ["-1,7"]);
  const search = doc.getElementById("balancesSearch");
  search.value = "tien mat";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.deepEqual(order(), []);
  assert.match(doc.getElementById("balancesBody").textContent, /Không có tài khoản khớp/);
  assert.equal(doc.querySelector("#balancesBody td").colSpan, 6);
  choose("Khác");
  assert.deepEqual(order(), ["cash"]);
  doc.querySelector('[data-search-clear="balancesSearch"]').click();
  assert.deepEqual(order(), ["cash"]);
  choose("");
  assert.deepEqual(order(), ["-1,7", "cash"]);
  assert.equal(calls.length, count);
  assert.match(doc.getElementById("balanceTotal").textContent, /-1,234\.5/);
});

test("sắp xếp tên và nhóm dùng đúng cột, không dùng STK", async (t) => {
  const { init, doc } = await setup(t, { fetcher: async url => url.pathname.endsWith("summary") ? {
    ok: true, json: async () => ({ ...summary, balances: [
      { ...summary.balances[0], fund: "a", accountNo: "001", name: "Zebra", accountGroup: "Khác" },
      { ...summary.balances[0], fund: "b", accountNo: "002", name: "Alpha", accountGroup: "Anh Quân" },
    ] }),
  } : null });
  await init();
  const order = () => [...doc.querySelectorAll("#balancesBody tr[data-fund]")].map(row => row.dataset.fund);
  doc.querySelector('#balancesTable [data-sort="name"]').click();
  assert.deepEqual(order(), ["b", "a"]);
  doc.querySelector('#balancesTable [data-sort="accountGroup"]').click();
  assert.deepEqual(order(), ["b", "a"]);
  doc.querySelector('#balancesTable [data-sort="accountNo"]').click();
  assert.deepEqual(order(), ["a", "b"]);
});
test("dropdown chọn nhiều có Chọn tất cả / Bỏ chọn, đếm số mục và ô tìm khi danh sách dài", async (t) => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: String(i + 1), label: "Nhân viên " + (i + 1) }));
  many[7].label = "Đông";
  const { init, doc, w, calls } = await setup(t, {
    fetcher: async (url) =>
      url.pathname.endsWith("filter-options")
        ? { ok: true, json: async () => ({ ...options, staff: many }) }
        : null,
  });
  await init();
  const lastStaff = () =>
    calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url.searchParams.get("staff");
  const doc1 = doc.querySelector('[data-dd="docTypes"]');
  assert.equal(doc1.querySelector(".dd-count").textContent, "2/2 đã chọn");
  assert.equal(doc1.querySelector("[data-dd-all]").disabled, true);
  assert.equal(doc1.querySelector(".dd-search-wrap").hidden, true);
  doc1.querySelector("[data-dd-none]").click();
  await tick();
  assert.equal(
    calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url.searchParams.get("docTypes"),
    "",
  );
  assert.equal(doc1.querySelector(".dd-count").textContent, "0/2 đã chọn");
  assert.equal(doc1.querySelector("[data-dd-none]").disabled, true);
  doc1.querySelector("[data-dd-all]").click();
  await tick();
  assert.equal(
    calls.filter((c) => c.url.pathname.endsWith("entries")).at(-1).url.searchParams.has("docTypes"),
    false,
  );
  assert.equal(doc.querySelector('[data-dd="accounting"] .dd-tools'), null);
  const staff = doc.querySelector('[data-dd="staff"]');
  const search = staff.querySelector(".dd-search");
  assert.equal(staff.querySelector(".dd-search-wrap").hidden, false);
  staff.querySelector("[data-dd-none]").click();
  await tick();
  assert.equal(lastStaff(), "");
  search.value = "dong";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.deepEqual(
    [...staff.querySelectorAll(".cb-choices label:not([hidden]) input")].map((i) => i.value),
    ["8"],
  );
  staff.querySelector("[data-dd-all]").click();
  await tick();
  assert.equal(lastStaff(), "8");
  assert.equal(staff.querySelector(".dd-count").textContent, "1/8 đã chọn");
  search.value = "khong co";
  search.dispatchEvent(new w.Event("input", { bubbles: true }));
  assert.equal(staff.querySelector(".dd-nomatch").hidden, false);
  assert.equal(staff.querySelector("[data-dd-all]").disabled, true);
});

test('quỹ chưa xác định giữ đúng nhãn và khóa lọc sau khi tải lại',async(t)=>{
  const {doc,calls,init}=await setup(t,{hash:'#fund=unassigned'});
  await init();
  assert.equal(doc.getElementById('fundFilterName').textContent,'Chưa xác định tài khoản');
  assert.ok(calls.some(c=>c.url.pathname.endsWith('/entries')&&c.url.searchParams.get('fund')==='unassigned'));
});

async function fireRefresh(timers) {
  const next = [...timers].find(([,timer]) => timer.ms >= 15000);
  assert.ok(next, 'visible page must schedule an automatic refresh check');
  timers.delete(next[0]);
  await next[1].fn();
  await tick();
}

test('lọc nhóm giữ nguyên khi tự làm mới, kể cả nhóm tạm thời không có tài khoản', async t => {
  let revision = 'v1';
  const x = await setup(t, { captureTimers: true, fetcher: async url => {
    if (url.pathname.endsWith('sync-status')) return { ok: true, json: async () => ({ revision, enabled: true }) };
    if (url.pathname.endsWith('summary')) return { ok: true, json: async () => ({ ...summary, revision,
      balances: revision === 'v2' ? [summary.balances[1]] : summary.balances,
    }) };
  }});
  await x.init();
  const group = x.doc.getElementById('balancesGroupFilter');
  group.value = 'Anh Quân';
  group.dispatchEvent(new x.w.Event('change', { bubbles: true }));
  revision = 'v2'; await fireRefresh(x.timers);
  assert.equal(group.value, 'Anh Quân');
  assert.equal(x.doc.querySelectorAll('#balancesBody tr[data-fund]').length, 0);
  assert.match(x.doc.getElementById('balancesBody').textContent, /Không có tài khoản khớp/);
  revision = 'v3'; await fireRefresh(x.timers);
  assert.equal(group.value, 'Anh Quân');
  assert.deepEqual([...x.doc.querySelectorAll('#balancesBody tr[data-fund]')].map(row => row.dataset.fund), ['-1,7']);
});

test('automatic checks skip unchanged data and refresh changed balances without losing filters or pagination', async t => {
  let revision = 'v1';
  const x = await setup(t, { captureTimers: true, hash: '#fund=cash', fetcher: async url => {
    if (url.pathname.endsWith('sync-status')) return { ok: true, json: async () => ({ revision, enabled: true }) };
    if (url.pathname.endsWith('summary')) return { ok: true, json: async () => ({ ...summary, revision, kpis: { ...summary.kpis, totalReceipts: revision === 'v1' ? 10 : 42 } }) };
  }});
  await x.init();
  x.doc.getElementById('entriesLast').click(); await tick();
  const before = x.calls.filter(c => c.url.pathname.endsWith('summary')).length;
  await fireRefresh(x.timers);
  assert.equal(x.calls.filter(c => c.url.pathname.endsWith('summary')).length, before);
  revision = 'v2'; await fireRefresh(x.timers);
  assert.equal(x.doc.getElementById('totalReceipts').textContent, '42');
  const last = x.calls.filter(c => c.url.pathname.endsWith('entries')).at(-1).url;
  assert.equal(last.searchParams.get('fund'), 'cash');
  assert.equal(last.searchParams.get('page'), '3');
});

test('hidden and offline pages suspend polling; returning online or visible catches up immediately', async t => {
  const x = await setup(t, { captureTimers: true, fetcher: async url => url.pathname.endsWith('sync-status')
    ? { ok: true, json: async () => ({ revision: 'v1', enabled: true }) } : null });
  let hidden = false, online = true;
  Object.defineProperty(x.doc, 'hidden', { get: () => hidden });
  Object.defineProperty(x.w.navigator, 'onLine', { get: () => online });
  await x.init();
  hidden = true; x.doc.dispatchEvent(new x.w.Event('visibilitychange')); await tick();
  assert.equal(x.timers.size, 0);
  const count = x.calls.length;
  hidden = false; x.doc.dispatchEvent(new x.w.Event('visibilitychange')); await tick();
  assert.equal(x.calls.length, count + 1);
  online = false; x.w.dispatchEvent(new x.w.Event('offline')); await tick();
  assert.equal(x.timers.size, 0);
  online = true; x.w.dispatchEvent(new x.w.Event('online')); await tick();
  assert.equal(x.calls.length, count + 2);
});

test('background refresh failures retain previous balances, back off, and retry the same revision', async t => {
  let failed = false, revision = 'v1';
  const x = await setup(t, { captureTimers: true, fetcher: async url => {
    if (url.pathname.endsWith('sync-status')) return { ok: true, json: async () => ({ revision, enabled: true }) };
    if (url.pathname.endsWith('summary')) {
      if (failed) throw Error('network');
      return { ok: true, json: async () => ({ ...summary, revision, kpis: { ...summary.kpis, totalReceipts: revision === 'v1' ? 10 : 99 } }) };
    }
  }});
  await x.init(); revision = 'v2'; failed = true; await fireRefresh(x.timers);
  assert.equal(x.doc.getElementById('totalReceipts').textContent, '10');
  assert.ok(x.doc.querySelector('#balancesBody tr[data-fund="cash"]'));
  assert.ok([...x.timers.values()].some(t => t.ms > 15000));
  failed = false; await fireRefresh(x.timers);
  assert.equal(x.doc.getElementById('totalReceipts').textContent, '99');
});

test('repeated focus events do not overlap status requests or replace a user filter request', async t => {
  let resolveStatus;
  const x = await setup(t, { captureTimers: true, fetcher: async url => url.pathname.endsWith('sync-status')
    ? new Promise(r => { resolveStatus = r; }) : null });
  await x.init();
  x.w.dispatchEvent(new x.w.Event('focus')); x.w.dispatchEvent(new x.w.Event('focus'));
  await tick();
  assert.equal(x.calls.filter(c => c.url.pathname.endsWith('sync-status')).length, 1);
  x.doc.querySelector('[data-select-fund="cash"]').click(); await tick();
  resolveStatus({ ok: true, json: async () => ({ revision: 'v2', enabled: true }) }); await tick();
  assert.equal(x.calls.filter(c => c.url.pathname.endsWith('entries')).at(-1).url.searchParams.get('fund'), 'cash');
});

test('pagehide stops timers and pageshow restores automatic refresh after browser back navigation', async t => {
  const x = await setup(t, { captureTimers: true, fetcher: async url => url.pathname.endsWith('sync-status')
    ? { ok: true, json: async () => ({ revision: 'v1', enabled: true }) } : null });
  await x.init();
  x.w.dispatchEvent(new x.w.Event('pagehide')); await tick();
  assert.equal(x.timers.size, 0);
  x.w.dispatchEvent(new x.w.Event('pageshow')); await tick();
  assert.ok([...x.timers.values()].some(t => t.ms === 15000));
});
