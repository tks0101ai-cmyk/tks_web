/* Follow a selected container using its existing indicator row. */
const watchedCont=document.createElement('section');watchedCont.id='watchedContainer';watchedCont.hidden=true;watchedCont.setAttribute('aria-label','Chỉ số cont đang theo dõi');orderPanel.before(watchedCont);
document.getElementById('planningTaskMount').hidden=true;
let watchedSourceRow=null;
function watchedTop(){return (document.querySelector('.topbar')?.getBoundingClientRect().bottom||44)+4}
function positionWatchedContainer(){const selected=!!contById(planning.target);watchedCont.style.top=watchedTop()+'px';watchedCont.hidden=!selected||!watchedSourceRow||watchedSourceRow.getBoundingClientRect().top>=watchedTop();const viewport=mainTable.closest('.table-wrap'),bounds=viewport.getBoundingClientRect(),edge=watchedCont.hidden?watchedTop():Math.max(watchedTop(),watchedCont.getBoundingClientRect().bottom);const offset=bounds.bottom>edge?Math.max(0,edge-bounds.top):0;viewport.style.setProperty('--purchase-header-offset',offset+'px')}
function renderWatchedContainer(){
 const c=contById(planning.target);watchedSourceRow=null;contFull.querySelectorAll('tr.cont-pick').forEach(tr=>{const id=Number(tr.getAttribute('onclick')?.match(/pickCont\('([0-9]+)'\)/)?.[1]);tr.classList.toggle('on',!!c&&id===c.id);if(c&&id===c.id)watchedSourceRow=tr});
 if(!c){watchedCont.innerHTML='';watchedCont.hidden=true;return}
 const table=contFull.closest('table'),row=watchedSourceRow?.cloneNode(true);
 if(!row){watchedCont.hidden=true;return}
 row.removeAttribute('onclick');row.querySelectorAll('button,select,input').forEach(el=>{if(el.matches('[data-cont-freight],[data-freight-base],[data-freight-capacity],[data-freight-auto]'))return;const text=document.createElement('span');text.textContent=el.tagName==='SELECT'?el.selectedOptions[0]?.textContent:el.value||el.textContent;el.replaceWith(text)});
 const clone=table.cloneNode(false);clone.removeAttribute('id');const head=table.querySelector('thead')?.cloneNode(true);if(head){head.querySelectorAll('[id]').forEach(el=>el.removeAttribute('id'));clone.append(head)}const body=document.createElement('tbody');body.append(row);clone.append(body);
 watchedCont.replaceChildren();const label=document.createElement('div');label.className='watched-caption';label.textContent='Đang theo dõi '+c.name+' · Chỉ số cập nhật theo thay đổi trên bảng';const close=document.createElement('button');close.type='button';close.textContent='Bỏ ghim';close.onclick=()=>{planning.target=null;render()};label.append(close);const scroll=document.createElement('div');scroll.className='watched-scroll';scroll.append(clone);watchedCont.append(label,scroll);positionWatchedContainer();
}
pickCont=function(value){planning.target=Number(value)||null;fCont.value='';state.page=1;render()};
const watchedRenderConts=renderConts;renderConts=function(){watchedRenderConts();renderWatchedContainer()};
const watchedOpenAdd=openAdd;openAdd=function(){watchedOpenAdd();if(planning.target)aCont.value=String(planning.target)};
window.addEventListener('scroll',positionWatchedContainer,{passive:true});document.addEventListener('scroll',positionWatchedContainer,{passive:true,capture:true});window.addEventListener('resize',positionWatchedContainer);
contFull.closest('.panel').querySelector('.legend').textContent='ƒ = cộng từ bảng Đặt hàng · Chọn cont để theo dõi; dòng chỉ số được ghim khi cuộn xuống. Bộ lọc mã bên dưới hoạt động riêng.';
renderConts();

if(window.ResizeObserver)new ResizeObserver(positionWatchedContainer).observe(watchedCont);

// Forward pinned freight controls through the original table's delegated handlers.
for(const type of ['change','click'])watchedCont.addEventListener(type,e=>{const control=e.target.closest('[data-cont-freight],[data-freight-base],[data-freight-capacity],[data-freight-auto]');if(!control)return;const attr=[...control.attributes].find(a=>a.name.startsWith('data-'));const original=contFull.querySelector('['+attr.name+'="'+attr.value+'"]');if(!original)return;if(type==='change')original.value=control.value;original.dispatchEvent(new Event(type,{bubbles:true}))});
