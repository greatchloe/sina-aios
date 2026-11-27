/* 매입 M1 화면 규칙(배포 전 후보). 서버 계약: docs/erp_매입_M1_DB검토안_20261125.md §4
   (upsert_supplier · save_purchase · receive_purchase_line · cancel_purchase, 운영 적용 11/27 purchase_m1_v1).
   - 매입은 RPC로만 저장한다(표 직접 쓰기 없음). 읽기는 회원 RLS 그대로.
   - 모르는 값은 0으로 채우지 않는다: 단가·부가세·증빙 합계·kg는 비우면 「없음/미확인」으로 보낸다.
   - 요청 번호는 보낼 내용(정렬된 JSON)에 묶는다. 응답을 못 받으면 같은 번호·같은 내용으로만 다시 보낸다(서버가 중복 없이 처리).
   - 전표일(매입 날짜)과 입고일(원료수불 날짜)은 따로 둔다. */
(function (root) {
  'use strict';

  const CATS = ['원료', '사입상품', '포장재', '운송비', '기타'];
  const TAXES = ['미확인', '과세', '면세'];
  const SHIP = /운송비|운임|택배비|배송비|퀵|용차|운반비/;
  const PACK = /아이스팩|아이스박스|스치로폼|박스대|비닐|봉투|테이프/;

  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  function newKey() {
    const c = root.crypto;
    if (c && c.randomUUID) return 'pur-' + c.randomUUID();
    const a = new Uint8Array(16); c.getRandomValues(a);
    return 'pur-' + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  // 숫자 칸 읽기: 빈칸 = null(모름), 형식 오류 = NaN. 쉼표 허용.
  function num(text) {
    if (text === null || text === undefined) return null;
    if (typeof text === 'number') return Number.isFinite(text) ? text : NaN;
    const t = String(text).trim();
    if (t === '') return null;
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(t)) return NaN;
    return Number(t.replace(/,/g, ''));
  }

  function blankLine(date) {
    return { category: '원료', item: '', spec: '', unit: 'kg', qty: '', price: '', amt: '', tax: '미확인', vat: '',
             raw: '', kg: '', recv: false, recvDate: date || '', link: '', allowSimilar: false, memo: '' };
  }
  // 기존 「거래명세서 붙여넣기」 읽기 결과(parseStmt 한 줄) → 매입 줄 초안(CTO 11/27: 입고는 사람이 켠 줄만).
  // kg를 읽었다고 실제 입고가 끝난 것은 아니므로 「지금 입고」는 항상 끈 채로 둔다. 원료 이름을 못 찾은 품목은 구분을 비워 확인을 요구한다.
  function lineFromStmt(r, date) {
    const cat = SHIP.test(r.name) ? '운송비' : PACK.test(r.name) ? '포장재' : r.raw ? '원료' : '';   // '' = 구분 확인 필요(저장 전 고름)
    const kg = cat === '원료' && r.pack ? Math.round(r.qty * r.pack * 1000) / 1000 : null;
    const price = r.guess || r.price === null || r.price === undefined ? '' : String(r.price);
    // 읽기 규칙은 단위가 없으면 kg로 본다. 원료가 아닌 줄(택배비 등)에 글에 없던 kg를 붙이지 않는다
    const unit = cat !== '원료' && r.unit === 'kg' && !/kg|키로|킬로/i.test(r.src || '') ? (cat === '운송비' ? '건' : '') : (r.unit || '');
    return { category: cat, item: r.name, spec: '', unit, qty: String(r.qty),
             price, amt: r.amt === null || r.amt === undefined ? '' : String(Math.round(r.amt)),
             tax: '미확인', vat: '', raw: cat === '원료' ? (r.raw || '') : '', kg: kg === null ? '' : String(kg),
             recv: false, recvDate: r.date || date || '', link: '', allowSimilar: false,
             memo: '', src: r.src || '', warn: (cat ? [] : ['구분 확인 필요(원료 이름을 못 찾음)']).concat((r.msg || []).filter(m => !/원료 아님|원료 고르기/.test(m) && (cat === '원료' || !/단위|kg/.test(m)))) };
  }

  // 같은 날·같은 원료·같은 kg의 따로 있는 입고(서버 거부 조건과 같다): 연결 후보
  function similarMoves(raws, date, raw, kg) {
    return (raws || []).filter(m => !m.canceled && m.kind === '입고' && m.date === date && m.raw === raw
      && Number(m.qty) === Number(kg) && !m.purchase_line_id);
  }

  // 초안 검사: errors(저장 막음) · warns(알림) · 합계. 서버 규칙을 화면에서 먼저 보여 주는 용도이며, 최종 판단은 서버.
  function review(draft, raws) {
    const errors = [], warns = [], lines = [];
    if (!draft.date) errors.push('전표일(매입 날짜)이 없습니다.');
    if (!draft.sup_code) errors.push('매입처를 고르세요.');
    if (!draft.lines.length) errors.push('줄이 없습니다.');
    if (draft.lines.length > 200) errors.push('줄은 200개까지입니다.');
    let supply = 0, vat = 0, vatKnown = true, recv = 0, pend = 0;
    draft.lines.forEach((l, k) => {
      const i = k + 1, e = m => errors.push(`${i}번 줄: ${m}`);
      const qty = num(l.qty), price = num(l.price), vatl = num(l.vat), kg = num(l.kg);
      let amt = num(l.amt);
      if (!CATS.includes(l.category)) e('구분을 고르세요(원료·사입상품·포장재·운송비·기타 — 붙여넣기에서 못 알아본 품목).');
      if (!String(l.item || '').trim()) e('품목이 없습니다.');
      if (!String(l.unit || '').trim()) e('단위가 없습니다.');
      if (qty === null || Number.isNaN(qty) || qty <= 0) e('수량은 0보다 큰 숫자여야 합니다.');
      if (Number.isNaN(price) || (price !== null && price < 0)) e('단가 형식을 확인하세요(모르면 비우기).');
      if (amt === null && price !== null && !Number.isNaN(price) && qty > 0) amt = Math.round(qty * price);
      if (amt === null || Number.isNaN(amt) || amt < 0 || !Number.isSafeInteger(amt)) e('금액은 0 이상 원 단위 정수여야 합니다.');
      else if (price !== null && !Number.isNaN(price) && qty > 0 && Math.round(qty * price) !== amt)
        e(`수량×단가(${Math.round(qty * price).toLocaleString('ko-KR')})와 금액(${amt.toLocaleString('ko-KR')})이 다릅니다. 단가를 비우거나 고치세요.`);
      if (!TAXES.includes(l.tax)) e('과세 구분을 고르세요.');
      if (Number.isNaN(vatl) || (vatl !== null && (vatl < 0 || !Number.isSafeInteger(vatl)))) e('부가세는 0 이상 정수여야 합니다(모르면 비우기).');
      if (l.tax === '면세' && vatl) e('면세 줄에 부가세가 있습니다.');
      if (Number.isNaN(kg) || (kg !== null && kg <= 0)) e('kg는 0보다 큰 숫자여야 합니다(모르면 비우기).');
      const vatEff = l.tax === '면세' && vatl === null ? 0 : vatl;
      const isRaw = l.category === '원료';
      let cands = [];
      if (isRaw && l.recv) {
        if (!l.recvDate) e('입고일이 없습니다(모르면 「지금 입고」를 끄고 미반영으로 두세요).');
        if (!String(l.raw || '').trim()) e('원료 이름이 없습니다.');
        if (kg === null) e('입고 kg가 없습니다(모르면 「지금 입고」를 끄세요).');
        if (l.recvDate && l.raw && kg > 0) {
          cands = similarMoves(raws, l.recvDate, String(l.raw).trim(), kg);
          if (l.link && !cands.some(m => m.id === l.link)) e(`연결할 입고(${l.link})가 같은 날·원료·kg의 연결 안 된 입고가 아닙니다.`);
          if (!l.link && cands.length && !l.allowSimilar) e(`같은 날 같은 원료·kg 입고(${cands.map(m => m.id).join(', ')})가 이미 있습니다. 그 입고에 연결하거나 「별개 입고」를 체크하세요.`);
        }
        if (l.recvDate && draft.date && l.recvDate !== draft.date) warns.push(`${i}번 줄: 입고일 ${l.recvDate}이 전표일 ${draft.date}과 다릅니다.`);
        recv++;
      } else if (isRaw) { pend++; warns.push(`${i}번 줄: 원료수불에 아직 안 들어갑니다(미반영 — 나중에 「입고 연결」).`); }
      if (!isRaw && l.recv) e('원료가 아닌 줄은 원료수불에 입고하지 않습니다.');
      if (!Number.isNaN(amt) && amt !== null) supply += amt;
      if (vatEff === null || Number.isNaN(vatEff)) vatKnown = false; else vat += vatEff;
      lines.push({ i, qty, price, amt, vat: vatEff, kg, cands });
    });
    const total = num(draft.doc_total);
    let check;
    if (Number.isNaN(total) || (total !== null && !Number.isSafeInteger(total))) { errors.push('증빙 합계는 원 단위 숫자여야 합니다(없으면 비우기).'); check = '오류'; }
    else if (total === null) check = '증빙합계없음';
    else if (!vatKnown) { check = '미확인'; warns.push('부가세를 모르는 줄이 있어 증빙 합계와 맞는지 확인하지 못합니다(미확인으로 저장).'); }
    else if (supply + vat !== total) { errors.push(`증빙 합계(${total.toLocaleString('ko-KR')})가 공급가+부가세(${(supply + vat).toLocaleString('ko-KR')})와 다릅니다.`); check = '불일치'; }
    else check = '일치';
    return { errors, warns, lines, supply, vat: vatKnown ? vat : null, vatKnown, total, check, recv, pend };
  }

  // 서버로 보낼 p_doc. 같은 초안이면 항상 같은 값(요청 번호를 이 내용에 묶는다).
  function toPayload(draft, raws) {
    const rv = review(draft, raws || []);
    if (rv.errors.length) throw new Error(rv.errors[0]);
    const doc = { date: draft.date, sup_code: draft.sup_code, lines: draft.lines.map((l, k) => {
      const L = rv.lines[k], o = { category: l.category, item: String(l.item).trim(), unit: String(l.unit).trim(), qty: L.qty, amt: L.amt, tax: l.tax };
      if (String(l.spec || '').trim()) o.spec = String(l.spec).trim();
      if (L.price !== null) o.price = L.price;
      if (L.vat !== null) o.vat = L.vat;
      if (L.kg !== null) o.kg = L.kg;
      if (l.category === '원료' && String(l.raw || '').trim()) o.raw = String(l.raw).trim();
      if (String(l.memo || '').trim()) o.memo = String(l.memo).trim();
      if (l.category === '원료' && l.recv) {
        o.receive = { date: l.recvDate };
        if (l.link) o.receive.link_raw_move_id = l.link;
        if (!l.link && l.allowSimilar) o.receive.allow_similar = true;
      }
      return o;
    }) };
    if (String(draft.src_doc_no || '').trim()) doc.src_doc_no = String(draft.src_doc_no).trim();
    if (rv.total !== null) doc.doc_total = rv.total;
    if (String(draft.memo || '').trim()) doc.memo = String(draft.memo).trim();
    return doc;
  }

  // 응답 분류(하루 마감과 같은 기준): 서버가 답한 거부 = 확정 실패, 연결 실패·게이트웨이 = 결과 모름
  function classify(res) {
    if (res && res.error) {
      const e = res.error;
      const answered = !!(e.code && String(e.code).length) && !/^(PGRST00[0-3]|5\d\d)$/.test(String(e.code));
      return answered ? { kind: 'rejected', message: e.message || '저장이 거부되었습니다.' } : { kind: 'unknown', message: e.message || '' };
    }
    if (!res) return { kind: 'unknown', message: '' };
    return { kind: 'ok', data: res.data };
  }

  // 결과 미확정 저장 요청 보관: {key, body, doc}. 화면 저장소에는 요청 번호와 보낸 본문만 둔다.
  const PKEY = 'purchase_pending_v1';
  class Saver {
    constructor(storage) { this.storage = storage || null; this.pending = null;
      try { const s = this.storage && this.storage.getItem(PKEY); if (s) this.pending = JSON.parse(s); } catch (e) { this.pending = null; } }
    _keep() { try { if (!this.storage) return; if (this.pending) this.storage.setItem(PKEY, JSON.stringify(this.pending)); else this.storage.removeItem(PKEY); } catch (e) { /* 저장소 없음 */ } }
    // 같은 내용이면 미확정 요청의 번호를 다시 쓴다. 다른 내용인데 미확정 요청이 있으면 막는다(먼저 결과 확인).
    prepare(doc) {
      const body = canonical(doc);
      if (this.pending) {
        if (this.pending.body === body) return this.pending;
        throw new Error('앞서 보낸 매입 저장의 결과를 아직 모릅니다. 「같은 내용 다시 보내기」로 확인하거나 매입장에서 확인한 뒤 「버리기」를 누르세요.');
      }
      this.pending = { key: newKey(), body, doc, at: new Date().toISOString() }; this._keep();
      return this.pending;
    }
    async send(rpc, p) {
      const res = await rpc('save_purchase', { p_request_key: p.key, p_doc: p.doc });
      const c = classify(res);
      if (c.kind === 'ok' || c.kind === 'rejected') { this.pending = null; this._keep(); }
      return c;
    }
    discard() { this.pending = null; this._keep(); }
  }

  // 매입장: 문서·줄을 기간·매입처·구분으로 거른 줄 목록(취소 포함 여부 선택)
  function ledger(docs, lines, sups, f) {
    f = f || {};
    const sname = Object.fromEntries((sups || []).map(s => [s.code, s.name]));
    const byDoc = Object.fromEntries((docs || []).map(d => [d.id, d]));
    return (lines || []).map(l => ({ l, d: byDoc[l.doc_id] })).filter(({ d }) => d)
      .filter(({ l, d }) => (!f.from || d.date >= f.from) && (!f.to || d.date <= f.to) && (!f.sup || d.sup_code === f.sup)
        && (!f.cat || l.category === f.cat) && (f.canceled || !d.canceled))
      .sort((a, b) => a.d.date < b.d.date ? -1 : a.d.date > b.d.date ? 1 : a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : a.l.line_no - b.l.line_no)
      .map(({ l, d }) => ({ date: d.date, doc_id: d.id, sup_code: d.sup_code, sup: sname[d.sup_code] || d.sup_code, src_doc_no: d.src_doc_no || '',
        line_no: l.line_no, category: l.category, item: l.item, spec: l.spec || '', unit: l.unit, qty: Number(l.qty),
        price: l.price === null || l.price === undefined ? null : Number(l.price), amt: Number(l.amt), tax: l.tax,
        vat: l.vat === null || l.vat === undefined ? null : Number(l.vat), kg: l.kg === null || l.kg === undefined ? null : Number(l.kg),
        raw: l.raw || '', receipt: l.receipt, raw_move_id: l.raw_move_id || '', total_check: d.total_check, canceled: !!d.canceled, line_id: l.id }));
  }
  function ledgerSum(rows) {
    const live = rows.filter(r => !r.canceled);
    const vatUnknown = live.filter(r => r.vat === null).length;
    return { lines: live.length, supply: live.reduce((a, r) => a + r.amt, 0), vat: live.reduce((a, r) => a + (r.vat || 0), 0), vatUnknown };
  }
  function csv(rows) {
    const H = ['전표일', '매입번호', '매입처코드', '매입처', '원전표번호', '줄', '구분', '품목', '규격', '단위', '수량', '단가', '공급가', '과세', '부가세', '입고kg', '원료', '원료수불', '입고번호', '합계확인', '취소'];
    const q = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const out = [H.join(',')].concat(rows.map(r => [r.date, r.doc_id, r.sup_code, r.sup, r.src_doc_no, r.line_no, r.category, r.item, r.spec, r.unit, r.qty,
      r.price === null ? '' : r.price, r.amt, r.tax, r.vat === null ? '미확인' : r.vat, r.kg === null ? '' : r.kg, r.raw, r.receipt, r.raw_move_id, r.total_check, r.canceled ? '취소' : ''].map(q).join(',')));
    return out.join('\r\n');
  }
  // 아직 원료수불에 안 들어간 원료 줄(취소 안 된 매입만)
  function pending(docs, lines) {
    const live = Object.fromEntries((docs || []).filter(d => !d.canceled).map(d => [d.id, d]));
    return (lines || []).filter(l => l.receipt === '미반영' && live[l.doc_id]).map(l => ({ l, d: live[l.doc_id] }));
  }

  const api = { CATS, TAXES, canonical, newKey, num, blankLine, lineFromStmt, similarMoves, review, toPayload, classify, Saver, ledger, ledgerSum, csv, pending };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Purchase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
