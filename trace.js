/* 유통이력(수입농산물 · 농관원 pass.naqs.go.kr) 신고 도우미
   - 명세서(slips)의 「(수입)…」 줄을 신고 대기로 모은다(설정 trace_items에 있는 품목만, trace_start 이후).
   - 농관원 「유통이력신고일괄등록 → 양식내려받기」 파일을 올리면, 받은 물량에 날짜 순서로 배정해
     30줄씩 나눈 업로드 파일을 만든다(한 번에 많이 올리면 농관원 서버 오류 — 2026-11-17 실측).
   - 만든 줄은 trace_filed에 「파일생성」으로 남기고, 농관원에 올린 뒤 「신고완료」로 바꾼다. 삭제 없음(취소 상태).
   - 신고 기한: 판매일 다음 날부터 영업일 5일(토·일·공휴일 제외).
   순수 계산 함수는 Node 시험에서도 쓰도록 TRACE 객체로 내보낸다. */
(function(root){
'use strict';
const TYPES = ['음식점','소매업체','유통업체','수입업체','개인(신고제외)'];
const NEED_ADDR = new Set(['소매업체','유통업체','수입업체']);
const CHUNK = 30;
// 공휴일(대체공휴일 포함). 해가 바뀌면 여기에 추가한다.
const HOLIDAYS = new Set(['2026-12-25','2027-01-01','2027-02-06','2027-02-07','2027-02-08','2027-02-09','2027-03-01',
  '2027-05-05','2027-05-13','2027-06-06','2027-08-15','2027-08-16','2027-09-14','2027-09-15','2027-09-16',
  '2027-10-03','2027-10-04','2027-10-09','2027-10-11','2027-12-25']);

function ymd(d){ return d.toISOString().slice(0,10); }
function isBizDay(s){ const w=new Date(s+'T00:00:00Z').getUTCDay(); return w!==0 && w!==6 && !HOLIDAYS.has(s); }
function deadline(dealDate, n=5){ let d=new Date(dealDate+'T00:00:00Z'), k=0;
  while(k<n){ d.setUTCDate(d.getUTCDate()+1); if(isBizDay(ymd(d))) k++; } return ymd(d); }
function daysLeft(dl, todayStr){ return Math.round((new Date(dl+'T00:00:00Z')-new Date(todayStr+'T00:00:00Z'))/86400000); }

/* 신고 대기 줄: 명세서 줄 kg − 이미 기록된 kg(취소 제외) */
function pendingLines(slips, filed, items, start){
  const done = {};
  (filed||[]).forEach(f=>{ if(f.status==='취소') return; const k=f.slip_id+'#'+f.line_no;
    done[k] = done[k] || {kg:0, made:0}; done[k].kg += Number(f.kg)||0; if(f.status==='파일생성') done[k].made += Number(f.kg)||0; });
  const out = [];
  (slips||[]).forEach(s=>{ if(s.canceled || (start && s.date < start)) return;
    (s.lines||[]).forEach((l,i)=>{ const m = items[String(l.name||'').trim()]; if(!m) return;
      const qty = Number(l.qty)||0; if(qty<=0) return;
      const kg = qty*m.kg, d = done[s.id+'#'+i] || {kg:0, made:0};
      const left = Math.round((kg-d.kg)*1000)/1000;
      out.push({slip_id:s.id, line_no:i, date:s.date, code:s.code, name:l.name, item:m.item, qty, kg, left, made:d.made}); }); });
  return out.sort((a,b)=>a.date.localeCompare(b.date)||String(a.slip_id).localeCompare(String(b.slip_id))||a.line_no-b.line_no);
}

/* 양식(시트 행 배열)에서 받은 물량 읽기: 4행이 머리글, 5행부터 물량 */
function lotsFromSheet(rows){
  const h = rows.findIndex(r=>r && String(r[0]).includes('수입신고번호') && String(r[3]).includes('거래일련'));
  if(h<0) throw new Error('농관원 「양식내려받기」 파일이 아닙니다(머리글 「수입신고번호·거래일련번호」를 못 찾음).');
  const lots = [];
  for(let r=h+1; r<rows.length; r++){ const v=rows[r]; if(!v || !v[3]) continue;
    lots.push({cells:v.slice(0,9).map(x=>x==null?'':String(x)), serial:String(v[3]), item:String(v[4]).trim(),
      date:String(v[7]).slice(0,10), left:Number(String(v[8]).replace(/,/g,''))||0}); }
  return {header: rows.slice(0,h+1), lots};
}

/* 날짜 순서 배정: 같은 신고품목, 양수일자 ≤ 거래일, 먼저 받은 물량부터 */
function allocate(pending, lots){
  const L = lots.map(l=>({...l})).sort((a,b)=>a.date.localeCompare(b.date)||a.serial.localeCompare(b.serial));
  const rows=[], short=[];
  pending.filter(p=>p.left>0 && p.made===0).forEach(p=>{ let need=p.left;
    for(const l of L){ if(need<=0) break; if(l.item!==p.item || l.date>p.date || l.left<=0) continue;
      const u=Math.min(need,l.left); l.left=Math.round((l.left-u)*1000)/1000; need=Math.round((need-u)*1000)/1000; rows.push({p, lot:l, kg:u}); }
    if(need>0) short.push({p, kg:need}); });
  return {rows, short, lotsLeft:L};
}

/* 업로드 줄(양식 A~W) */
function uploadRow(a, c, type){
  const name = c ? (c.legal||c.name) : a.p.code, biz = c ? String(c.bizno||'') : '';
  return [...a.lot.cells, type, biz, '', name, NEED_ADDR.has(type) ? (c?.addr||'') : (c?.addr||''), c?.ceo||'', '', '', a.p.date, '', '', String(a.kg), '', ''];
}
function chunks(arr, n=CHUNK){ const o=[]; for(let i=0;i<arr.length;i+=n) o.push(arr.slice(i,i+n)); return o; }

/* 거래처 점검: 유형 미정, 주소 필요한데 없음, 사업자번호 없음 */
function custProblems(pending, customers, types){
  const out={}; pending.forEach(p=>{ if(p.left<=0) return; const c=customers.find(x=>x.code===p.code), t=types[p.code];
    const why=[]; if(!t) why.push('신고 유형 미정'); else if(t!=='개인(신고제외)'){
      if(!c?.bizno) why.push('사업자번호 없음'); if(NEED_ADDR.has(t) && !c?.addr) why.push('주소 없음'); }
    if(why.length) out[p.code]={name:c?.name||p.code, why}; }); return out;
}

const TRACE = {TYPES, CHUNK, deadline, daysLeft, isBizDay, pendingLines, lotsFromSheet, allocate, uploadRow, chunks, custProblems};
if(typeof module!=='undefined') module.exports = TRACE;
root.TRACE = TRACE;

/* ───────────── 화면 (브라우저에서만) ───────────── */
if(typeof document==='undefined') return;
const T = {items:{}, cust:{}, start:null, filed:[], plan:null, header:null};
const esc = s=>String(s??'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const el = id=>document.getElementById(id);

function mount(){
  if(el('v-trace')) return;
  const b=document.createElement('button'); b.dataset.v='trace'; b.textContent='유통이력'; el('nav').appendChild(b);
  const sec=document.createElement('section'); sec.id='v-trace'; sec.className='hidden';
  sec.innerHTML = `
  <div class="card"><h2>유통이력 신고 <span class="mut">(수입 김치 → 농관원. 기한: 판매 다음 날부터 영업일 5일)</span></h2>
    <p id="tr-sum" class="mut"></p><div id="tr-cust"></div></div>
  <div class="card"><h2>신고 대기</h2><div class="wrap"><table id="tr-table"><thead><tr><th>거래일</th><th>기한</th><th>거래처</th><th>유형</th><th>품목</th><th>신고품목</th><th class="n">kg</th><th>상태</th></tr></thead><tbody></tbody></table></div></div>
  <div class="card"><h2>업로드 파일 만들기</h2>
    <p class="mut">① 농관원 「유통이력신고일괄등록(유통업체)」 → 받은 물량 전체 체크 → 「양식내려받기」로 받은 파일을 아래에 넣습니다.
      ② 「배정하기」 → 30줄씩 나뉜 파일을 받아 농관원 「일괄등록하기」에 하나씩 올리고 데이터검증·신고합니다.
      ③ 다 올렸으면 「신고 완료 표시」를 누릅니다.</p>
    <div class="row"><div><label>농관원 양식 파일</label><input type="file" id="tr-file" accept=".xls,.xlsx"></div>
      <div style="flex:0"><button class="btn pri" id="tr-go">배정하기</button></div></div>
    <div id="tr-out"></div></div>
  <div class="card"><h2>만든 파일 기록</h2><div id="tr-batches"></div></div>`;
  document.querySelector('main').appendChild(sec);
  b.addEventListener('click', ()=>render());
  el('nav').addEventListener('click', ()=>setTimeout(drawBanner,0));   // 명세서 저장 뒤 화면을 옮기면 알림도 새로
  el('tr-go').onclick = makePlan;
  const banner=document.createElement('div'); banner.id='tr-banner'; banner.className='card hidden';
  banner.style.cssText='border-left:6px solid var(--wine,#8b1d2c);cursor:pointer';
  banner.onclick=()=>document.querySelector('#nav button[data-v="trace"]').click();
  el('v-slip').prepend(banner);
}

async function fetchTrace(){
  const [st, fl] = await Promise.all([
    sb.from('settings').select('key,value').in('key',['trace_items','trace_cust','trace_start']),
    sb.from('trace_filed').select('*').order('id').range(0,49999)]);
  if(st.error) throw st.error; if(fl.error) throw fl.error;
  const S = Object.fromEntries(st.data.map(r=>[r.key,r.value]));
  T.items=S.trace_items||{}; T.cust=S.trace_cust||{}; T.start=S.trace_start||null; T.filed=fl.data||[];
}
function pending(){ return TRACE.pendingLines(db.slips, T.filed, T.items, T.start); }

function drawBanner(){
  const all=pending().filter(p=>(p.left>0||p.made>0) && T.cust[p.code]!=='개인(신고제외)'); const b=el('tr-banner'); if(!b) return;
  if(!all.length){ b.classList.add('hidden'); return; }
  const P=all.filter(p=>p.left>0), M=all.filter(p=>p.made>0);
  const t=today(), dl=all.map(p=>TRACE.deadline(p.date)).sort()[0], d=TRACE.daysLeft(dl,t), kg=P.reduce((a,p)=>a+p.left,0);
  b.classList.remove('hidden');
  b.innerHTML=`<b>유통이력 ${P.length?`신고 대기 ${P.length}줄 · ${won(kg)}kg`:''}${P.length&&M.length?' / ':''}${M.length?`파일만 만들고 안 올린 ${M.length}줄`:''}</b> — 가장 급한 기한 ${dl} <b style="color:${d<=1?'var(--wine,#8b1d2c)':'inherit'}">(${d<0?'기한 지남 '+(-d)+'일':'D-'+d})</b> <span class="mut">눌러서 신고 화면으로</span>`;
}

function render(){
  const P=pending(), t=today(), live=P.filter(p=>p.left>0 && T.cust[p.code]!=='개인(신고제외)');
  const kg=live.reduce((a,p)=>a+p.left,0);
  el('tr-sum').innerHTML = `대기 <b>${live.length}줄 ${won(kg)}kg</b>` + (T.start?` · ${esc(T.start)} 이후 명세서 대상`:'') +
    ` · 품목표에 없는 「(수입)」 품목(장아찌 등)은 신고 대상에서 뺍니다.`;
  const probs=TRACE.custProblems(P, db.customers, T.cust);
  el('tr-cust').innerHTML = Object.keys(probs).length ? '<p><b>거래처 정보를 먼저 채워 주세요</b></p>' + Object.entries(probs).map(([code,x])=>
    `<div class="row" style="align-items:center"><div style="max-width:260px">${esc(code)} ${esc(x.name)} <span class="mut">— ${esc(x.why.join(', '))}</span></div>
     <div style="max-width:180px"><select data-tc="${esc(code)}"><option value="">유형 선택</option>${TRACE.TYPES.map(y=>`<option${T.cust[code]===y?' selected':''}>${y}</option>`).join('')}</select></div></div>`).join('')
     + '<p class="mut">사업자번호·주소는 「거래처·단가」 화면에서 고칩니다.</p>' : '';
  el('tr-cust').querySelectorAll('select[data-tc]').forEach(s=>s.onchange=async()=>{ if(!s.value) return;
    T.cust={...T.cust,[s.dataset.tc]:s.value}; await must(sb.from('settings').upsert({key:'trace_cust', value:T.cust})); render(); drawBanner(); });
  const rows=P.filter(p=>p.left>0||p.made>0).map(p=>{ const c=cust(p.code), dl=TRACE.deadline(p.date), d=TRACE.daysLeft(dl,t), ty=T.cust[p.code]||'(미정)';
    const st = ty==='개인(신고제외)'?'신고 제외':p.made>0?'파일 만듦(농관원 업로드 대기)':(d<0?'<b style="color:var(--wine,#8b1d2c)">기한 지남</b>':'대기');
    return `<tr><td>${p.date}</td><td>${dl} <span class="mut">${d<0?'+'+(-d):'D-'+d}</span></td><td>${esc(c?.name||p.code)}</td><td>${esc(ty)}</td><td>${esc(p.name)}</td><td>${esc(p.item)}</td><td class="n">${won(p.left||p.made)}</td><td>${st}</td></tr>`; });
  el('tr-table').querySelector('tbody').innerHTML = rows.join('') || '<tr><td colspan="8" class="mut">신고할 줄이 없습니다.</td></tr>';
  drawBatches();
}

async function readSheet(file){
  if(typeof XLSX==='undefined') throw new Error('엑셀 읽기 도구를 못 불러왔습니다(인터넷 확인).');
  const wb=XLSX.read(await file.arrayBuffer(), {type:'array'}); const ws=wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, {header:1, raw:false, defval:''});
}

async function makePlan(){
  const f=el('tr-file').files[0]; if(!f) return alert('농관원 양식 파일을 먼저 고르세요.');
  let sheet; try{ sheet=TRACE.lotsFromSheet(await readSheet(f)); }catch(e){ return alert(e.message); }
  const P=pending().filter(p=>p.left>0 && p.made===0 && T.cust[p.code] && T.cust[p.code]!=='개인(신고제외)');
  const probs=TRACE.custProblems(P, db.customers, T.cust);
  const ok=P.filter(p=>!probs[p.code]);
  const plan=TRACE.allocate(ok, sheet.lots); T.plan=plan; T.header=sheet.header;
  const files=TRACE.chunks(plan.rows), skipped=P.length-ok.length;
  el('tr-out').innerHTML = `<p>배정 <b>${plan.rows.length}줄 ${won(plan.rows.reduce((a,r)=>a+r.kg,0))}kg</b> → 파일 ${files.length}개(30줄씩)` +
    (skipped?` · 거래처 정보가 없어 뺀 줄 ${skipped}`:'') + `</p>` +
    (plan.short.length?`<p style="color:var(--wine,#8b1d2c)"><b>공급처 물량 부족 ${plan.short.length}줄 ${won(plan.short.reduce((a,s)=>a+s.kg,0))}kg</b> — 받은 날짜 이전 판매거나 받은 물량이 모자랍니다. 공급처(고향앤푸드)에 양도 신고를 확인하세요.<br>`+
      plan.short.slice(0,20).map(s=>`${s.p.date} ${esc(cust(s.p.code)?.name||s.p.code)} ${esc(s.p.item)} ${won(s.kg)}kg`).join(' · ')+'</p>':'') +
    (files.length?`<div class="row">${files.map((_,i)=>`<div style="flex:0"><button class="btn" data-tf="${i}">파일 ${i+1} 받기</button></div>`).join('')}</div>
      <p class="mut">파일을 받으면 「파일 만듦」으로 기록됩니다. 농관원에 다 올린 뒤 아래 「만든 파일 기록」에서 「신고 완료 표시」를 누르세요.</p>`:'');
  el('tr-out').querySelectorAll('button[data-tf]').forEach(b=>b.onclick=()=>downloadFile(files, Number(b.dataset.tf)));
}

async function downloadFile(files, i){
  const part=files[i]; if(!part) return;
  const batch=`${today()}-${String(Date.now()).slice(-6)}-${i+1}`;
  const body=part.map(a=>TRACE.uploadRow(a, cust(a.p.code), T.cust[a.p.code]));
  const ws=XLSX.utils.aoa_to_sheet([...T.header, ...body]);
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, '거래내역');
  XLSX.writeFile(wb, `유통업체 유통이력신고 일괄양식_${batch}.xlsx`);
  const me=(await sb.auth.getUser()).data.user?.email||'';
  const recs=part.map(a=>({slip_id:String(a.p.slip_id), line_no:a.p.line_no, code:a.p.code, deal_date:a.p.date, item:a.p.item, kg:a.kg, lot_serial:a.lot.serial, status:'파일생성', batch, created_by:me}));
  const saved=await must(sb.from('trace_filed').insert(recs).select()); T.filed.push(...saved);
  files[i]=null; const btn=el('tr-out').querySelector(`button[data-tf="${i}"]`); if(btn){ btn.disabled=true; btn.textContent=`파일 ${i+1} 받음`; }
  render(); drawBanner();
}

function drawBatches(){
  const g={}; T.filed.forEach(f=>{ const k=f.batch||'(묶음 없음)'; (g[k]=g[k]||{rows:0,kg:0,st:new Set(),at:f.created_at}); g[k].rows++; g[k].kg+=Number(f.kg)||0; g[k].st.add(f.status); });
  const ks=Object.keys(g).sort().reverse().slice(0,30);
  el('tr-batches').innerHTML = ks.length ? '<div class="wrap"><table><thead><tr><th>묶음</th><th class="n">줄</th><th class="n">kg</th><th>상태</th><th></th></tr></thead><tbody>'+
    ks.map(k=>{ const x=g[k], st=[...x.st].join('/'), made=x.st.has('파일생성');
      return `<tr><td>${esc(k)}</td><td class="n">${x.rows}</td><td class="n">${won(x.kg)}</td><td>${esc(st)}</td><td>${made?`<button class="btn pri" data-done="${esc(k)}">신고 완료 표시</button> <button class="btn" data-cancel="${esc(k)}">취소(안 올림)</button>`:''}</td></tr>`; }).join('')+'</tbody></table></div>'
    : '<p class="mut">아직 없습니다.</p>';
  el('tr-batches').querySelectorAll('button[data-done]').forEach(b=>b.onclick=()=>setBatch(b.dataset.done,'신고완료'));
  el('tr-batches').querySelectorAll('button[data-cancel]').forEach(b=>b.onclick=()=>{ if(confirm('이 묶음을 농관원에 올리지 않았나요? 취소하면 다시 신고 대기로 돌아갑니다.')) setBatch(b.dataset.cancel,'취소'); });
}
async function setBatch(batch, status){
  await must(sb.from('trace_filed').update({status}).eq('batch',batch).eq('status','파일생성'));
  T.filed.forEach(f=>{ if(f.batch===batch && f.status==='파일생성') f.status=status; }); render(); drawBanner();
}

root.traceInit = async function(){
  try{ mount(); await fetchTrace(); drawBanner(); if(!el('v-trace').classList.contains('hidden')) render(); }
  catch(e){ console.warn('유통이력 불러오기 실패', e); }
};
})(typeof window!=='undefined'?window:globalThis);
