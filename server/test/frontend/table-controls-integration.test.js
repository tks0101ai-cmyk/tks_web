'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const publicDir = path.join(__dirname, '../../public');
const pages = ['index.html', 'account/index.html', 'cashbook/index.html', 'humanresources/index.html', 'shipment/lifecycle/index.html', 'vat-draft/index.html'];
test('every table page loads shared controls after page styles and before application scripts', () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(publicDir, page), 'utf8');
    const css = html.indexOf('/shared/table-controls.css');
    const js = html.indexOf('/shared/table-controls.js');
    assert.ok(css > html.lastIndexOf('</style>'), page + ': controls CSS must override page styles');
    assert.ok(js > 0 && js < html.lastIndexOf('<script'), page + ': shared controller required');
    assert.match(html, /data-table-key=/, page + ': stable table identities required');
    const dom = new JSDOM(html);
    for (const header of dom.window.document.querySelectorAll('table th')) {
      assert.ok(header.dataset.columnKey, page + ': field identity missing for ' + header.textContent.trim());
    }
    dom.window.close();
  }
});
test('legacy column persistence and clipped lifecycle notes are replaced', () => {
  const account = fs.readFileSync(path.join(publicDir, 'account/index.html'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(publicDir, 'shipment/lifecycle/index.html'), 'utf8');
  const locations = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-positions.js'), 'utf8');
  assert.doesNotMatch(lifecycle, /HIDDEN_COLUMNS_STORAGE_KEY|bulkColumnStyle|-webkit-line-clamp/);
  assert.doesNotMatch(locations, /COLUMN_STORAGE_KEY/);
  assert.doesNotMatch(account, /openUserColumnsModal|userColumnsModal|tableColumnsStorageKey|visibleUserColumns/);
  assert.match(lifecycle, /TKSTables\.enhance\(bulkTable/);
  assert.match(locations, /onVisibilityChange/);
});

test('table frames own export actions and each static table has exactly one working picker', () => {
  const source=fs.readFileSync(path.join(publicDir,'shared/table-controls.js'),'utf8');
  for(const page of pages){
    const dom=new JSDOM(fs.readFileSync(path.join(publicDir,page),'utf8'),{runScripts:'outside-only',pretendToBeVisual:true,url:'https://tables.test/'+page});
    try {
      const doc=dom.window.document;
      for(const table of doc.querySelectorAll('table'))if(!table.tHead?.rows.length)table.createTHead().innerHTML='<tr><th>Mã</th><th>Tên</th></tr>';
      dom.window.eval(source);dom.window.TKSTables.refreshAll();dom.window.TKSTables.refreshAll();
      assert.equal(doc.querySelectorAll('.tks-columns-button').length,doc.querySelectorAll('table:not([data-table-controls=off])').length,page+': duplicate or missing picker');
      for(const table of doc.querySelectorAll('#hrSubtab-quydinh table')){
        assert.equal(table.dataset.tableControls,'off');
        assert.equal(table.closest('.tks-table-frame'),null);
        assert.equal(table.querySelector('.tks-column-resizer'),null);
      }
      for(const button of doc.querySelectorAll('.tks-columns-button')){
        button.click();assert.equal(doc.querySelector('.tks-columns-picker').hidden,false,page+': button must work');
        doc.querySelector('.tks-columns-picker [data-action=close]').click();
      }
      if(page==='account/index.html'||page==='humanresources/index.html'){
        const ids=page.startsWith('account')?['btnExportUsers']:['btnExportExcel','btnExportEmployeeDirectory'];
        for(const id of ids){const button=doc.getElementById(id);assert.ok(button.closest('.users-table-panel'),id+': export must be inside frame');assert.equal(button.parentElement.lastElementChild,button,id+': export must be rightmost');assert.equal(button.parentElement.querySelectorAll('.tks-columns-button').length,1);}
      }
      for(const actions of doc.querySelectorAll('.panel-head-actions')){
        const exports=actions.querySelectorAll('button.export-button:not([data-not-export])');
        if(exports.length)assert.equal(actions.lastElementChild,exports[exports.length-1],page+': export must be rightmost');
      }
    }finally{dom.window.close();}
  }
});
