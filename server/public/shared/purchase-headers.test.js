const {test}=require('node:test');const assert=require('node:assert/strict');const {JSDOM}=require('jsdom');const {mount}=require('./purchase-headers');const columns=require('./purchase-columns');
test('default language scope changes only Orders headers, leaving container tables and filters untouched',()=>{
 const dom=new JSDOM('<button id="lang"></button><label>Trạng thái</label><table><thead id="mainHead"><tr><th data-k="supplier">NCC</th></tr></thead><tbody><tr><td>THỨC</td></tr></tbody></table><table id="containers"><tr><th data-k="supplier">NCC</th></tr></table>',{url:'https://test.local'});const w=dom.window;try{const button=w.document.getElementById('lang'),state=mount({button,columns,document:w.document,storage:w.localStorage});button.click();assert.equal(w.document.querySelector('#mainHead th').textContent,'供应商');assert.equal(w.document.querySelector('#containers th').textContent,'NCC');assert.equal(w.document.querySelector('label').textContent,'Trạng thái');assert.equal(w.document.querySelector('td').textContent,'THỨC');state.disconnect()}finally{w.close()}
});
test('nhãn nằm trong .sort-label của ô tiêu đề sắp xếp được vẫn đổi ngôn ngữ, biểu tượng ▲▼ giữ nguyên',()=>{
 const dom=new JSDOM('<button id="lang"></button><table><thead id="mainHead"><tr><th data-k="supplier" class="sortable"><button type="button" class="sort-button"><span class="sort-label">NCC</span><span class="sort-indicator" aria-hidden="true">▲▼</span></button></th></tr></thead></table>',{url:'https://test.local'});const w=dom.window;try{
 const button=w.document.getElementById('lang'),state=mount({button,columns,document:w.document,storage:w.localStorage});
 button.click();
 assert.equal(w.document.querySelector('.sort-label').textContent,'供应商');
 assert.equal(w.document.querySelector('.sort-indicator').textContent,'▲▼');
 button.click();
 assert.equal(w.document.querySelector('.sort-label').textContent,'NCC');
 state.disconnect();
 }finally{w.close()}
});
test('switch headers both ways, preserve cells/resize handles and restore private preference',async()=>{
 const dom=new JSDOM('<button id="lang"></button><table><tr><th data-k="supplier">NCC<span class="cn">供应商</span><span class="resize"></span></th></tr><tr><td>THỨC</td></tr></table>',{url:'https://test.local'});const w=dom.window;try{
 const button=w.document.getElementById('lang'),state=mount({button,columns,document:w.document,storage:w.localStorage,selector:'th'});button.click();assert.equal(w.document.querySelector('th').firstChild.textContent,'供应商');assert.equal(w.document.querySelector('td').textContent,'THỨC');assert.ok(w.document.querySelector('.resize'));assert.equal(w.localStorage.getItem('purchase:header-language'),'zh');
 w.document.querySelector('th').firstChild.textContent='NCC';await new Promise(r=>setImmediate(r));assert.equal(w.document.querySelector('th').firstChild.textContent,'供应商');button.click();assert.equal(w.document.querySelector('th').firstChild.textContent,'NCC');state.disconnect();
 }finally{w.close()}
});
