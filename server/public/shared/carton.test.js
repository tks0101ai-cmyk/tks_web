'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('./carton.js');
const pick=s=>({terms:s.terms,loose:s.loose,quantity:s.quantity});
test('deduct/restore reject fractional or unsafe pieces instead of rounding',()=>{
  const spec=C.parseSpec('1Tx100');
  for(const quantity of [0.4,0.6,-1,Infinity,NaN,Number.MAX_SAFE_INTEGER+1]){
    assert.equal(C.deduct(spec,quantity),null);
    assert.equal(C.restore(spec,quantity),null);
  }
  assert.equal(C.deduct(spec,30).spec.quantity,70);
  assert.equal(C.restore(C.parseSpec('1Tx100-30'),30).spec.quantity,100);
  assert.equal(C.deduct(spec,0).spec.quantity,100);
});
test('restore integer pieces exactly for large cartons without near-whole rounding',()=>{
  assert.equal(C.restore(C.parseSpec('1Tx10000'),9999).spec.quantity,19999);
  assert.equal(C.restore(C.parseSpec('1Tx20000'),1).spec.quantity,20001);
});
test('parseSpec đọc <số thùng>T x <SL/thùng>, chịu hoa thường, dấu x * ×, khoảng trắng và dấu phẩy thập phân',()=>{
  assert.deepEqual(pick(C.parseSpec('5Tx100')),{terms:[{cartons:5,perCarton:100,suffix:''}],loose:0,quantity:500});
  assert.equal(C.parseSpec(' 40T x 250 ').quantity,10000);
  assert.equal(C.parseSpec('3tx35').quantity,105);
  assert.equal(C.parseSpec('5T*80').quantity,400);
  assert.equal(C.parseSpec('2 T × 60').quantity,120);
  const one=C.parseSpec('2T x 50');assert.equal(one.cartons,2);assert.equal(one.perCarton,50);assert.equal(one.multi,false);
});
test('parseSpec nhiều quy cách nối bằng +, và phần trừ lẻ tùy chọn',()=>{
  const multi=C.parseSpec('1Tx50 + 2Tx25');
  assert.equal(multi.quantity,100);assert.equal(multi.multi,true);assert.equal(multi.terms.length,2);assert.equal(multi.perCarton,50,'quy cách đầu');
  assert.equal(C.parseSpec('1Tx50 + 2Tx25 - 30').quantity,70);
  assert.equal(C.parseSpec('1Tx50 + 2Tx25 - 30').loose,30);
  assert.equal(C.parseSpec('1tx50+2TX25−30').quantity,70,'không cần khoảng trắng, chịu dấu trừ −');
  const single=C.parseSpec('1Tx50 - 30');assert.equal(single.quantity,20);assert.equal(single.multi,false,'một quy cách kèm trừ lẻ vẫn là một quy cách');
});
test('parseSpec từ chối chuỗi không đúng quy cách, số thùng hoặc SL/thùng không nguyên dương, hoặc trừ quá SL',()=>{
  for(const bad of ['0.5T x 100','0,5Tx100','0T x 50','1T x 50.5','1Tx50 - 0.5','abc','Thùng 100 chiếc','Dãy cửa kho','5T','x100','5T x 0','-1T x 5','5T x 100 ghi chú','1T x 50 / 2T x 60','1Tx50 +','+ 1Tx50','1Tx50 + hàng lẻ','1Tx50 - 60','- 30'])assert.equal(C.parseSpec(bad),null,String(bad));
});
test('formatSpec và cartonsOf làm tròn số thùng, không để lộ sai số số thực',()=>{
  assert.equal(C.formatSpec(3,100),'3T x 100');
  assert.equal(C.formatSpec(C.parseSpec('1tx50+2tx25-30')),'1T x 50 + 2T x 25 - 30');
  assert.equal(C.cartonsOf(110,55),2);
  assert.equal(C.cartonsOf(50,60),0.833333);
  assert.equal(C.cartonsOf(5,0),null);
  assert.equal(C.cartonsOf(5,null),null);
  assert.equal(C.isWhole(2),true);assert.equal(C.isWhole(0.5),false);assert.equal(C.isWhole(1.9999999),true);
});
test('không bao giờ tự sinh số thùng thập phân vào ghi chú',()=>{
  for(const [text,q] of [['1Tx50',25],['5Tx100',150],['2Tx60',30],['1Tx50 + 2Tx25',30]]){
    const d=C.deduct(C.parseSpec(text),q);assert.doesNotMatch(d.text,/d.d|0T/,text+' - '+q);
    assert.equal(d.spec.quantity,C.parseSpec(text).quantity-q);
  }
  assert.equal(C.deduct(C.parseSpec('5Tx100'),150).text,'5T x 100 - 150','không tròn thùng thì ghi vào phần trừ lẻ');
});
test('trừ thùng: 5T x 100 lấy 200 còn 3T x 100; hết thùng thì bỏ số hạng',()=>{
  const spec=C.parseSpec('5T x 100');
  const d=C.deduct(spec,200);assert.equal(d.text,'3T x 100');assert.equal(d.taken,2);assert.equal(d.spec.quantity,300);
  const multi=C.deduct(C.parseSpec('1Tx50 + 2Tx25'),50);
  assert.equal(multi.text,'2T x 25','lấy nguyên thùng 50 làm số hạng đầu biến mất');assert.equal(multi.taken,1);
  assert.equal(C.deduct(C.parseSpec('1Tx50'),50).text,'Hết hàng','hết hẳn: ghi chú Hết hàng, SL 0, không sinh 0T');
  assert.equal(C.parseSpec('Hết hàng').quantity,0);assert.deepEqual(C.warnings('Hết hàng'),[]);
});
test('bốc lẻ ghi vào phần trừ lẻ và cộng dồn',()=>{
  const first=C.deduct(C.parseSpec('1Tx50 + 2Tx25'),30);
  assert.equal(first.text,'1T x 50 + 2T x 25 - 30');assert.equal(first.spec.quantity,70);
  assert.equal(first.taken,0.6,'phần lẻ 30 chia SL/thùng của số hạng đầu (50)');
  const second=C.deduct(first.spec,25);
  assert.equal(second.text,'1T x 50 + 2T x 25 - 55','đã có phần trừ lẻ thì cộng dồn, kể cả khi 25 vừa một thùng');
  assert.equal(second.spec.quantity,45);
  assert.equal(C.deduct(C.parseSpec('1Tx50'),25).text,'1T x 50 - 25');
  assert.equal(C.deduct(C.parseSpec('1Tx50'),25).taken,0.5);
  assert.equal(C.deduct(C.parseSpec('1Tx50'),60),null,'không trừ quá tồn');
});
test('ST của một lượt nhặt theo từng quy cách',()=>{
  assert.equal(C.cartonsFor(C.parseSpec('1Tx50'),50),1);
  assert.equal(C.cartonsFor(C.parseSpec('1Tx60'),60),1);
  assert.equal(C.cartonsFor(C.parseSpec('1Tx50'),25),0.5);
  assert.equal(C.cartonsFor(C.parseSpec('1Tx50 + 2Tx25'),25),1,'25 khớp một thùng của quy cách thứ hai');
  assert.equal(C.cartonsFor(C.parseSpec('1Tx50'),999),null);
});
test('stFor: ST nguyên + phần thiếu khi mở thùng không lấy hết',()=>{
  const st=(n,q)=>C.stFor(C.parseSpec(n),q);
  assert.deepEqual(st('1Tx150',100),{cartons:1,excess:50,text:'1T x 150 - 50'});
  assert.deepEqual(st('1Tx50',50),{cartons:1,excess:0,text:'1T x 50'});
  assert.deepEqual(st('1Tx50',25),{cartons:1,excess:25,text:'1T x 50 - 25'});
  assert.deepEqual(st('7Tx50',250),{cartons:5,excess:0,text:'5T x 50'});
  assert.equal(st('1Tx50',999),null);
});
test('mergeSt: gộp ST nhiều vị trí thành một chuỗi, cùng SL/thùng cộng thùng, phần thiếu cộng dồn',()=>{
  assert.deepEqual(C.mergeSt(['3Tx100','2Tx100','2Tx50-30']),{terms:[{cartons:5,perCarton:100},{cartons:2,perCarton:50}],excess:30,cartons:7,text:'5T x 100 + 2T x 50 - 30'});
  assert.equal(C.mergeSt(['1T x 50','1T x 150 - 50','1Tx150-20']).text,'2T x 150 + 1T x 50 - 70');
  assert.equal(C.mergeSt(['1Tx200+1Tx50']).text,'1T x 200 + 1T x 50');
  assert.equal(C.mergeSt([]),null);
  assert.equal(C.mergeSt(['abc']),null);
  assert.equal(C.parseStText('1T x 150 - 50').excess,50);
});
test('restore cộng trả lại khi không khôi phục nguyên chuỗi được',()=>{
  assert.equal(C.restore(C.parseSpec('1T x 50 + 2T x 25 - 55'),25).text,'1T x 50 + 2T x 25 - 30');
  assert.equal(C.restore(C.parseSpec('3T x 100'),200).text,'5T x 100');
  assert.equal(C.restore(C.parseSpec('Hết hàng'),50).text,'1T x 50');
});
test('suggest dùng tổ hợp thùng nguyên cộng đúng SL cần nếu có',()=>{
  const r=C.suggest(100,[{id:'a',available:200,perCarton:50},{id:'b',available:120,perCarton:60}]);
  assert.deepEqual(r.picks,[{id:'a',quantity:100}],'ưu tiên ít vị trí nhất');
  assert.equal(r.shortage,0);
  const two=C.suggest(110,[{id:'a',available:50,perCarton:50},{id:'b',available:60,perCarton:60}]);
  assert.deepEqual(two.picks.map(p=>[p.id,p.quantity]).sort(),[['a',50],['b',60]]);
});
test('suggest làm tròn lên thùng nguyên khi không có tổ hợp tròn (ví dụ ABC cần 100 = 50 + 60)',()=>{
  const r=C.suggest(100,[{id:'A01',available:50,perCarton:50},{id:'B02',available:60,perCarton:60}]);
  assert.deepEqual(r.picks.map(p=>[p.id,p.quantity]).sort(),[['A01',50],['B02',60]]);
  assert.equal(r.shortage,0);
  const over=C.suggest(120,[{id:'a',available:500,perCarton:100}]);
  assert.deepEqual(over.picks,[{id:'a',quantity:200}],'cần 120 từ 100/thùng thì lấy 2 thùng');
});
test('suggest với khu nhiều quy cách gộp các số hạng cùng một vị trí',()=>{
  const r=C.suggest(75,[{id:'m',available:100,terms:[{cartons:1,perCarton:50},{cartons:2,perCarton:25}]}]);
  assert.deepEqual(r.picks,[{id:'m',quantity:75}]);
});
test('suggest trả null khi không áp dụng được để quay về gợi ý theo SL',()=>{
  assert.equal(C.suggest(100,[{id:'a',available:500,perCarton:null}]),null,'có vị trí chưa rõ quy cách');
  assert.equal(C.suggest(100,[{id:'a',available:60,perCarton:60}]),null,'tổng thùng nguyên không đủ');
  assert.equal(C.suggest(10.5,[{id:'a',available:500,perCarton:50}]),null,'SL cần không nguyên');
  assert.equal(C.suggest(30,[{id:'a',available:70,loose:30,terms:[{cartons:1,perCarton:50},{cartons:2,perCarton:25}]}]),null,'đã có phần trừ lẻ thì không đoán thùng');
});
test('warnings: nhiều quy cách, sai định dạng (kể cả rỗng), số không nguyên dương; quy cách đơn kể cả có trừ lẻ thì sạch',()=>{
  assert.deepEqual(C.warnings('1Tx50 + 2Tx25'),['multi']);
  assert.deepEqual(C.warnings('1Tx50 + 2Tx25 - 30'),['multi','loose']);
  assert.deepEqual(C.warnings('1Tx100 - 30'),['loose'],'một quy cách kèm trừ lẻ cũng cảnh báo');
  assert.equal(C.parseSpec('1Tx100 - 30').quantity,70,'nhưng SL vẫn tính đúng');
  assert.deepEqual(C.warnings('1Tx70'),[],'sửa về dạng sạch thì hết cảnh báo');
  assert.equal(C.WARNING_LABEL.loose,'Có phần trừ lẻ');
  assert.deepEqual(C.warnings('5T x 100'),[]);
  assert.deepEqual(C.warnings('5T'),['unreadable']);
  assert.deepEqual(C.warnings('Dãy cửa kho'),['unreadable'],'mô tả tự do không tính được SL');
  assert.deepEqual(C.warnings(''),[],'ghi chú rỗng là hợp lệ, SL 0, không cảnh báo');
  assert.deepEqual(C.warnings('   '),[],'chỉ có khoảng trắng cũng là rỗng');
  assert.deepEqual(C.warnings(null),[]);assert.deepEqual(C.warnings(undefined),[]);
  assert.deepEqual(C.warnings('abc'),['unreadable'],'có chữ nhưng sai định dạng vẫn cảnh báo');
  for(const blank of ['',' ',null,undefined,'Hết hàng']){const spec=C.parseSpec(blank);assert.equal(spec.quantity,0,String(blank));assert.equal(spec.multi,false);}
  assert.deepEqual(C.warnings('1Tx50 - 60'),['unreadable'],'trừ quá SL');
  assert.deepEqual(C.warnings('0.5Tx100'),['badnumber'],'số thùng thập phân');
  assert.deepEqual(C.warnings('0Tx50'),['badnumber']);
  assert.deepEqual(C.warnings('2Tx0'),['badnumber']);
  assert.deepEqual(C.warnings('1Tx50.5'),['badnumber']);
  assert.deepEqual(C.warnings('1Tx50'),[],'sửa thành số nguyên dương thì hết cảnh báo');
  assert.deepEqual(C.warnings('5T x 100',{unknownCode:true}),['unknowncode']);
  assert.deepEqual(C.warnings('abc',{unknownCode:true}),['unreadable','unknowncode']);
  assert.deepEqual(C.warnings('',{unknownCode:true}),['unknowncode']);
  assert.deepEqual(C.warnings('5T x 100',{unknownCode:false}),[]);
  assert.equal(C.WARNING_LABEL.unknowncode,'Mã hàng chưa có trong danh mục');
  assert.equal(C.WARNING_LABEL.unreadable,'Ghi chú sai định dạng');assert.equal(C.WARNING_LABEL.multi,'Nhiều quy cách');
});
test('hậu tố c (cái) sau SL/thùng chỉ là đơn vị: 50c = 50, chịu c hoa/thường và khoảng trắng',()=>{
  for(const text of ['1T x 50c','1Tx50c','1Tx50 c','1tx50C','1T X 50 C'])assert.equal(C.parseSpec(text).quantity,50,text);
  assert.equal(C.parseSpec('5Tx100c').quantity,500);
  const multi=C.parseSpec('1Tx50c + 2Tx25c - 30');assert.equal(multi.quantity,70);assert.equal(multi.multi,true);
  assert.equal(C.parseSpec('1Tx50c - 30c').quantity,20,'phần trừ lẻ cũng chịu c');
  assert.deepEqual(C.warnings('1T x 50c'),[]);assert.deepEqual(C.warnings('1Tx50c + 2Tx25c - 30'),['multi','loose']);
  for(const bad of ['1T x 50cm','1T x c','1T x 50 cc','1Tx50c ghi chú','1/10 đi sửa','vỏ','1t','1b*200'])assert.notEqual(C.warnings(bad).length,0,bad);
});
test('trừ thùng giữ hậu tố c của từng số hạng; phần trừ lẻ thêm mới không có c',()=>{
  assert.equal(C.deduct(C.parseSpec('5T x 100c'),200).text,'3T x 100c');
  assert.equal(C.deduct(C.parseSpec('1Tx50c + 2Tx25'),50).text,'2T x 25','số hạng có c biến mất, số hạng không c giữ nguyên');
  assert.equal(C.deduct(C.parseSpec('1Tx50c + 2Tx25c'),50).text,'2T x 25c');
  assert.equal(C.deduct(C.parseSpec('1T x 50c'),25).text,'1T x 50c - 25');
  assert.equal(C.deduct(C.parseSpec('1Tx50c - 25'),10).text,'1T x 50c - 35');
  assert.equal(C.restore(C.parseSpec('3T x 100c'),200).text,'5T x 100c');
});
test('dấu phẩy nối nhiều quy cách tương đương +; các dạng khác vẫn sai định dạng (2X20 nay hợp lệ = 2Tx20)',()=>{
  for(const t of ['9tx14, 5tx 14','9tx14,5tx14','9tx14 , 5tx14','9tx14 + 5tx14']){const s=C.parseSpec(t);assert.equal(s.quantity,196,t);assert.equal(s.multi,false,'cùng SL/thùng gộp thành một');assert.deepEqual(C.warnings(t),[]);}
  assert.deepEqual(C.warnings('9tx14, 5tx 15'),['multi']);
  assert.equal(C.deduct(C.parseSpec('9tx14, 5tx 14'),126).text,'5T x 14','chuẩn hóa dấu nối thành + khi ghi lại');
  assert.deepEqual(C.warnings('0,5Tx100'),['badnumber'],'dấu phẩy thập phân không bị tách');
  for(const bad of ['1t','1b*200','1tx40 + 1t','vin 19/9 gọi vỏ','9tx14, 5'])assert.deepEqual(C.warnings(bad),['unreadable'],bad);
  assert.equal(C.parseSpec('2X20').quantity,40,'a*B không có T là aTxB');
});
test('mọi khoảng trắng bị xóa trước khi đọc, dấu nhân tùy chọn: 1t 11 = 1T11 = 1t x 11; 1t vẫn sai (2X20 nay = 2Tx20)',()=>{
  for(const t of ['1t 11','1T X 11','1t x 11','1t*11','1T * 11','1t×11','1t  11','1t11','1T11',' 1 T 1 1 '])assert.equal(C.parseSpec(t).quantity,11,t);
  assert.equal(C.parseSpec('5T 100c').quantity,500);
  for(const t of ['1t 11, 2t 5','1t 11 + 2t 5','1t*11, 2T*5','1t 11,2t 5'])assert.equal(C.parseSpec(t).quantity,21,t);
  assert.equal(C.parseSpec('1t*11 - 4').quantity,7);assert.equal(C.parseSpec('1t 11 - 4').quantity,7);
  assert.deepEqual(C.warnings('1t 11, 2t 5'),['multi']);
  for(const bad of ['1t','1b*200','1 11','t 11','1t x','1t 11 ,'])assert.deepEqual(C.warnings(bad),['unreadable'],bad);
  assert.deepEqual(C.warnings('0,5Tx100'),['badnumber']);
});
test('normalizeNote: đọc được thì về dạng chuẩn, sai định dạng chỉ gộp khoảng trắng, rỗng giữ rỗng',()=>{
  for(const t of ['1t 11','1T X 11','1t*11','  1t   x 11 '])assert.equal(C.normalizeNote(t),'1T x 11',t);
  assert.equal(C.normalizeNote('9tx14,5tx 14'),'14T x 14');
  assert.equal(C.normalizeNote('1tx50C+2Tx25c-30'),'1T x 50c + 2T x 25c - 30');
  assert.equal(C.normalizeNote('  vin   19/9  gọi vỏ '),'vin 19/9 gọi vỏ');
  assert.equal(C.normalizeNote('   '),'');assert.equal(C.normalizeNote(null),'');
  assert.equal(C.normalizeNote('1Tx50 - 50'),'1T x 50 - 50');
});
test('số hạng cùng SL/thùng gộp thành một; chỉ còn một SL/thùng thì hết cảnh báo nhiều quy cách',()=>{
  assert.equal(C.normalizeNote('9T x 14 + 5T x 14'),'14T x 14');assert.equal(C.normalizeNote('9tx14, 5tx 14'),'14T x 14');
  assert.equal(C.normalizeNote('1t 11 + 2t 11'),'3T x 11');
  assert.equal(C.normalizeNote('1Tx50 + 2Tx25 + 1Tx50'),'2T x 50 + 2T x 25');
  assert.equal(C.normalizeNote('1Tx50 + 2Tx50 - 30'),'3T x 50 - 30');
  assert.equal(C.parseSpec('9T x 14 + 5T x 14').quantity,196);
  assert.deepEqual(C.warnings('9T x 14 + 5T x 14'),[]);assert.deepEqual(C.warnings('9tx14, 5tx 14'),[]);
  assert.deepEqual(C.warnings('9T x 14 + 5T x 14 - 6'),['loose']);
  assert.deepEqual(C.warnings('1Tx50 + 2Tx25'),['multi']);assert.deepEqual(C.warnings('1Tx50 + 2Tx25 + 1Tx50'),['multi']);
  assert.equal(C.deduct(C.parseSpec('9T x 14 + 5T x 14'),28).text,'12T x 14');
});

test('trừ thông minh nhiều quy cách: 3T x 200 + 1T x 50 trừ 250 còn 2T x 200; ít thùng nhất; không khớp thì trừ lẻ',()=>{
  const d=(note,q)=>C.deduct(C.parseSpec(note),q);
  assert.equal(d('3T x 200 + 1T x 50',250).text,'2T x 200');
  assert.equal(d('3T x 200 + 1T x 50',250).taken,2);
  assert.equal(d('3T x 200 + 1T x 50',50).text,'3T x 200');
  assert.equal(d('3T x 200 + 1T x 50',600).text,'1T x 50');
  assert.equal(d('2T x 100 + 4T x 50',100).text,'1T x 100 + 4T x 50','ưu tiên ít thùng nhất');
  assert.equal(d('2T x 100 + 4T x 50',150).text,'1T x 100 + 3T x 50');
  assert.equal(d('3T x 200 + 1T x 50',30).text,'3T x 200 + 1T x 50 - 30','không ghép được trọn thùng: trừ lẻ');
  assert.equal(d('3T x 200 + 1T x 50',650).text,'Hết hàng');
});

test('pickText: cột Số thùng khi in — lấy tròn 5Tx50, lấy lẻ 2Tx60-20, nhiều quy cách ghép thông minh',()=>{
  const p=(note,q)=>C.pickText(C.parseSpec(note),q);
  assert.equal(p('2T x 60',100),'2Tx60-20','khách lấy 100 từ khu 2Tx60');
  assert.equal(p('7T x 50',250),'5Tx50','khách lấy 250 từ khu 7Tx50: tròn thùng');
  assert.equal(p('2T x 60',60),'1Tx60');
  assert.equal(p('2T x 60',20),'1Tx60-40');
  assert.equal(p('3T x 200 + 1T x 50',250),'1Tx200+1Tx50');
  assert.equal(p('3T x 200 + 1T x 50',100),'1Tx200-100');
  assert.equal(p('1T x 100 - 30',70),'1Tx100-30','thùng đã mở thiếu 30');
  assert.equal(p('2T x 60',121),null,'vượt tồn');
  assert.equal(p('2T x 60',0),null);
  assert.equal(p('rác',5),null);
  assert.equal(p('',5),null);
  assert.equal(C.pickText(null,5),null);
});

test('1T100 (không dấu nhân, không khoảng trắng) là 1 thùng 100; ví dụ 1t100 + 2T*100 = 3T x 100 (SL 300)',()=>{
  assert.equal(C.parseSpec('1T100').quantity,100);
  assert.equal(C.parseSpec('1t100 + 2T*100').quantity,300);
  assert.equal(C.normalizeNote('1t100 + 2T*100'),'3T x 100');
  assert.equal(C.normalizeNote(' 2 t 5 0 c - 1 0 '),'2T x 50c - 10');
  assert.deepEqual(C.warnings('1T100'),[]);
});

test('chuẩn hóa ghi chú: bỏ khoảng trắng, không phân biệt hoa/thường, x X * × đều là dấu nhân',()=>{
  for(const t of ['3T x 100','3t X100','3 T * 100','3t×100','3T100','3tx100',' 3 t x 1 0 0 ','3TX100'])assert.equal(C.normalizeNote(t),'3T x 100',t);
  assert.equal(C.normalizeNote('1tX50C + 2T*25c'),'1T x 50c + 2T x 25c');
  for(const t of ['Hết hàng','HẾT HÀNG','hết  hàng','  hết hàng '])assert.equal(C.parseSpec(t).quantity,0,t);
  assert.deepEqual(C.warnings('HẾT HÀNG'),[]);
});

test('a*B (không có T) là aTxB: x X * × đều chuẩn hóa thành x, hợp lệ, không cảnh báo sai định dạng',()=>{
  for(const t of ['9*12','9x12','9X12','9×12',' 9 * 12 '])assert.equal(C.normalizeNote(t),'9T x 12',t);
  assert.equal(C.parseSpec('9*12').quantity,108);
  assert.deepEqual(C.warnings('9*12'),[],'không còn Sai định dạng');
  // Ví dụ người dùng gửi: 9X12+1TX12 = 10 thùng 12 (cùng quy cách gộp một).
  const mixed=C.parseSpec('9X12+1TX12');
  assert.equal(mixed.quantity,120);assert.equal(mixed.cartons,10);assert.equal(mixed.multi,false);
  assert.equal(C.normalizeNote('9X12+1TX12'),'10T x 12');
  assert.deepEqual(C.warnings('9X12+1TX12'),[]);
  assert.equal(C.parseSpec('5*200c').quantity,1000,'hậu tố c vẫn là đơn vị');
  assert.equal(C.parseSpec('9*12+1*50 - 8').quantity,150,'trộn nhiều quy cách và phần trừ lẻ');
});

test('không có T mà cũng không có dấu nhân thì vẫn sai định dạng (không đoán)',()=>{
  for(const bad of ['912','9 12','x12','9*','9*0','0*12','0.5*12','9*12 ghi chú','9**12','9x'])assert.equal(C.parseSpec(bad),null,bad);
  assert.deepEqual(C.warnings('912'),['unreadable']);
});

test('cùng quy cách gộp thành một dù viết bằng t*B hay *B: 3t*40+14t*40+1t*39 = 17Tx40 + 1Tx39',()=>{
  const spec=C.parseSpec('3t*40+14t*40+1t*39');
  assert.deepEqual(spec.terms.map(t=>[t.cartons,t.perCarton]),[[17,40],[1,39]]);
  assert.equal(spec.quantity,719);
  assert.equal(C.normalizeNote('3t*40+14t*40+1t*39'),'17T x 40 + 1T x 39');
  assert.equal(C.normalizeNote('3*40+14X40+1t*40'),'18T x 40');
  assert.deepEqual(C.warnings('3t*40+14t*40'),[],'gộp về một quy cách thì không còn cảnh báo nhiều quy cách');
});

test('chuẩn hóa từng phần ở mọi vị trí, giữ chữ, dấu câu và xuống dòng',()=>{
  for(const [raw,expected] of [
    ['14tx30 chổi','14T x 30 chổi'],
    ['37T (chổi) x30 + 30T (xô)x30','37T x 30 (chổi) + 30T x 30 (xô)'],
    ['1TX26 ( KO VỎ )','1T x 26 (KO VỎ)'],
    ['T x','T x'],
    ['kho: 2th (chổi mịn) * 30, 3t (xô)×20','kho: 2T x 30 (chổi mịn), 3T x 20 (xô)'],
    ['4t*30, check lại','4T x 30, check lại'],
    ['T x (1 bóng mịn + 1 bóng sần hở)\n1t*19','T x (1 bóng mịn + 1 bóng sần hở)\n1T x 19'],
    ['check lại: 4th*30, còn 1t*19 ở kho','check lại: 4T x 30, còn 1T x 19 ở kho'],
    ['ghi chú 1t*30+2T30; kiểm lại 1th*19','ghi chú 3T x 30; kiểm lại 1T x 19'],
    ['MÃ1t30 và ngày 1/10, còn 2t*50','MÃ1t30 và ngày 1/10, còn 2T x 50']
  ]){
    assert.equal(C.normalizeNote(raw),expected,raw);
    assert.equal(C.normalizeNote(expected),expected);
    assert.equal(C.parseSpec(C.normalizeNote(raw)),null,'định dạng không tự xác nhận toàn bộ ghi chú hợp lệ');
  }
});

test('chú thích sau một số hạng giữ đúng số thùng, không bị gộp với số hạng đứng trước',()=>{
  for(const unit of ['t','T','th','TH'])for(const sign of ['*','x','X','×']){
    const raw=`1${unit}${sign}30+ 2${unit}${sign}30 (dán tem) + 2${unit}${sign}30\n+1${unit}${sign}30`;
    const expected='4T x 30 + 2T x 30 (dán tem)';
    assert.equal(C.normalizeNote(raw),expected,raw);
    assert.equal(C.normalizeNote(expected),expected);
  }
  assert.equal(C.normalizeNote('T x 11X250 +1TX250'),'12T x 250');
  assert.equal(C.normalizeNote('1t30+2t(chổi)x30 + 3t(xô)x30'),'1T x 30 + 2T x 30 (chổi) + 3T x 30 (xô)');
  assert.equal(C.normalizeNote('1t30 (dán tem) + 2t30 + 3t30 (dán tem) + 1t30'),'4T x 30 (dán tem) + 3T x 30');
});

test('chuẩn hóa độc lập với hợp lệ: tiền tố thừa, chú thích tự do và phần số sai vẫn được định dạng',()=>{
  for(const [raw,expected] of [
    ['T x 2X20','2T x 20'],
    ['T x 9X12+1TX12','10T x 12'],
    ['1TX800 ( DÁN LẠI TEM )','1T x 800 (DÁN LẠI TEM)'],
    ['T x 9X12+1TX12 ( DÁN LẠI TEM )','9T x 12 + 1T x 12 (DÁN LẠI TEM)'],
    ['T x 1b*80','1b x 80'],
    ['0.5th*100','0.5T x 100'],
    ['1tx40 + 1t','1T x 40 + 1t'],
    ['1t*100 thiếu 20','1T x 100 thiếu 20']
  ]){
    assert.equal(C.normalizeNote(raw),expected,raw);
    assert.equal(C.normalizeNote(expected),expected,'chuẩn hóa lặp lại không đổi');
  }
  assert.equal(C.parseSpec('T x 2X20').quantity,40);
  assert.equal(C.parseSpec('T x 9X12+1TX12').quantity,120);
  for(const bad of ['T x 1b*80','1b x 80','1TX800 ( DÁN LẠI TEM )','0.5th*100','1t*100 thiếu 20']){
    assert.equal(C.parseSpec(bad),null,bad);
    assert.equal(C.parseSpec(C.normalizeNote(bad)),null,bad);
  }
});

test('cách ghi thùng th và chú thích lẻ/in tem vẫn chuẩn hóa, giữ chú thích qua cộng trừ',()=>{
  for(const unit of ['th','TH','Th','tH','t','T']){
    for(const sign of ['*','x','X','×',''])assert.equal(C.normalizeNote('1'+unit+sign+'360'),'1T x 360');
    assert.equal(C.normalizeNote('1'+unit+'360, 2'+unit+'360'),'3T x 360');
  }
  for(const [raw,normalized,quantity] of [
    ['1th*360','1T x 360',360],
    [' 2 TH x 100 + 1t100 ','3T x 100',300],
    ['1t*7c lẻ','1T x 7c lẻ',7],
    ['1t x 72 ( in tem )','1T x 72 (in tem)',72]
  ]){
    assert.equal(C.normalizeNote(raw),normalized,raw);
    assert.equal(C.parseSpec(raw).quantity,quantity,raw);
    assert.deepEqual(C.warnings(raw),[],raw);
    assert.equal(C.normalizeNote(normalized),normalized);
  }
  assert.equal(C.deduct(C.parseSpec('2th*72 (in tem)'),72).text,'1T x 72 (in tem)');
  assert.equal(C.restore(C.parseSpec('1t*7c lẻ'),7).text,'2T x 7c lẻ');
  for(const raw of ['1t*7c lẻ 3','1th*360 thiếu 20','1t x 72 (thiếu 2)','1t x 72 ghi chú'])assert.equal(C.parseSpec(raw),null,raw);
});

test('cùng SL/thùng gộp kể cả khi cách nhau: 9X12+1Tx20+1TX12 = 10T x 12 + 1T x 20 (thứ tự theo lần xuất hiện đầu)',()=>{
  const spec=C.parseSpec('9X12+1Tx20+1TX12');
  assert.deepEqual(spec.terms.map(t=>[t.cartons,t.perCarton]),[[10,12],[1,20]]);
  assert.equal(spec.quantity,140);
  assert.equal(C.normalizeNote('9X12+1Tx20+1TX12'),'10T x 12 + 1T x 20');
  assert.equal(C.normalizeNote('1Tx20+2Tx12+3*20+4X12'),'4T x 20 + 6T x 12');
  assert.equal(C.normalizeNote('2T x 12 + 1T x 20 + 3T x 12 - 5'),'5T x 12 + 1T x 20 - 5');
  assert.deepEqual(C.warnings('9X12+1Tx20+1TX12'),['multi'],'còn 2 quy cách khác nhau thì vẫn cảnh báo nhiều quy cách');
  assert.deepEqual(C.warnings('1Tx12+1Tx20+1Tx12+1Tx20'),['multi']);
  assert.deepEqual(C.warnings('1Tx12+1Tx20+1Tx12'),['multi']);
  // Sau khi gộp, trừ/in phiếu làm việc trên số hạng đã gộp.
  assert.equal(C.pickText(spec,120),'10Tx12');
  assert.equal(C.deduct(spec,20).text,'10T x 12');
});
test('mergeNotes cộng dồn ghi chú (gõ "+1T x 50" trong hộp Chỉ định vị trí): giữ phần trừ lẻ ở cuối, gộp cùng quy cách',()=>{
  assert.equal(C.mergeNotes('3T x 100 - 20','1T x 50'),'3T x 100 + 1T x 50 - 20');
  assert.equal(C.mergeNotes('3T x 100','1t*100'),'4T x 100');
  assert.equal(C.mergeNotes('60','1T x 60'),'2T x 60','số trần = 1 thùng');
  assert.equal(C.mergeNotes('5T x 100 - 30','2T x 50 - 10'),'5T x 100 + 2T x 50 - 40');
  assert.equal(C.mergeNotes('rác','1T x 5'),null);
  assert.equal(C.mergeNotes('1T x 5','rác'),null);
  assert.equal(C.parseSpec(C.mergeNotes('3T x 100 - 20','1T x 50')).quantity,330);
});

test('số âm: parseSigned đọc "-2T x 100" = -200 còn parseSpec vẫn từ chối',()=>{
  assert.equal(C.parseSpec('-2T x 100'),null);
  const s=C.parseSigned('-2T x 100');assert.equal(s.quantity,-200);assert.equal(s.negative,true);
  assert.equal(C.parseSigned('5T x 100').quantity,500);
  for(const bad of ['- 30','-','-0T x 5','-abc'])assert.equal(C.parseSigned(bad),null,bad);
  assert.equal(C.normalizeNote('- 2t*100'),'-2T x 100');
  assert.deepEqual(C.warnings('-2T x 100'),['negative']);
});
test('số âm: subtractNotes trừ quá tồn ra dòng âm, đủ tồn thì trừ thông minh',()=>{
  assert.deepEqual(C.subtractNotes('5T x 100',700,100),{text:'-2T x 100',quantity:-200});
  assert.deepEqual(C.subtractNotes('5T x 100',150,100),{text:'5T x 100 - 150',quantity:350});
  assert.equal(C.subtractNotes('5T x 100',500,100).text,'Hết hàng');
  assert.equal(C.subtractNotes('Hết hàng',150,50).text,'-3T x 50');
  assert.equal(C.subtractNotes('Hết hàng',70,100).text,'-1T x 70','không chẵn quy cách thì ghi một thùng thiếu');
  assert.equal(C.subtractNotes('-2T x 100',100,100).text,'-3T x 100','đang âm thì âm thêm');
  assert.equal(C.subtractNotes('abc',10),null);
});
test('số âm: mergeNotes tự bù khi cộng hàng vào dòng âm',()=>{
  assert.equal(C.mergeNotes('-2T x 100','5T x 100'),'3T x 100');
  assert.equal(C.mergeNotes('-2T x 100','1T x 100'),'-1T x 100');
  assert.equal(C.mergeNotes('-2T x 100','2T x 100'),'Hết hàng');
  assert.equal(C.mergeNotes('-2T x 100','-1T x 100'),'-3T x 100');
  assert.equal(C.mergeNotes('3T x 100','1T x 50'),'3T x 100 + 1T x 50','không âm thì giữ hành vi cũ');
});
