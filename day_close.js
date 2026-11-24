/* F5-2 하루 마감 화면 규칙(배포 전 후보). 기존 화면(index.html)에는 아직 연결하지 않는다.
   참조 모형: src/b2b_cutover/close_session.py, 서버 계약: docs/erp_D6_운영SQL_검토안_20261122.md 3.4·3.9·3.10.
   - 화면은 토큰을 쓰지 않는다(로그인 회원 RPC만: preview_day_close·save_day_close·day_close_request_status).
   - 마감 생산은 save_day_close로만 저장하고, 일반 직접 생산은 기존 insert 경로 그대로(두 호출은 따로 성공·실패).
   - 결과 미확정 요청은 날짜별로 화면 저장소에 남긴다(요청 번호·날짜·본문만, 고객 정보·토큰 없음).
   - 저장 확인 '없음'이어도 요청을 지우지 않는다. 같은 요청 재전송 또는 사람의 명시적 「버리기」만 허용. */
(function (root) {
  'use strict';

  class DayCloseError extends Error {}

  // 정렬된 키 JSON(요청 번호를 내용에 묶기 위한 결정적 문자열)
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  async function sha256hex(text) {
    const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  }
  function randomSalt() {
    const a = new Uint8Array(16); root.crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  // 미리보기 응답 → 화면 값. basis(날짜·지문·세대·기대 버전)에 체크가 묶인다(P2).
  function previewFrom(r) {
    const last = r.last_close || {};
    return {
      day: r.day, fingerprint: r.fingerprint, generation: r.generation,
      expected_close_version: r.expected_close_version, valid_count: r.valid_count,
      canceled_count: r.canceled_count, total: r.total, format_ok: r.format_ok, mode: r.mode,
      pending_correction: !!r.pending_correction, last_request_key: last.request_key || null,
      last_close: r.last_close || null, slips: r.slips || [], close_bundle: r.close_bundle || [],
      direct_prods: r.direct_prods || [],
      basis: canonical([r.day, r.fingerprint, r.generation, r.expected_close_version]),
    };
  }

  // 화면 생산표 줄 나누기(P9): src(마감 출처)가 있는 줄 = 마감 생산, 없는 줄 = 일반 직접 생산
  function splitLines(plines) {
    return { close: plines.filter(l => l.src), direct: plines.filter(l => !l.src) };
  }
  // 마감 줄 → save_day_close 인자 모양(product·kg·loss·uses·memo). uses는 화면 계산값(서버가 다시 계산해 비교)
  function toServerLines(closeLines, usesFor, loss, memoOf) {
    return closeLines.map(l => {
      const o = { product: l.product, kg: l.kg, loss: loss, uses: usesFor(l.product, l.kg) || [] };
      const m = memoOf ? memoOf(l) : null; if (m) o.memo = m;
      return o;
    });
  }

  // supabase-js 결과 분류: 응답 자체를 못 받음(연결 실패·시한) = 결과 모름. 서버가 거부 코드와 함께 답함 = 확정(거부).
  function classify(res) {
    if (res && res.error) {
      const e = res.error;
      const answered = !!(e.code && String(e.code).length) && !/^(PGRST00[0-3]|5\d\d)$/.test(String(e.code));
      return answered ? { kind: 'rejected', message: e.message || '저장이 거부되었습니다.' } : { kind: 'unknown', message: e.message || '' };
    }
    if (!res) return { kind: 'unknown', message: '' };
    return { kind: 'ok', data: res.data };
  }

  class Session {
    constructor({ salt, user = '', storage = null } = {}) {
      this.salt = salt; this.storage = storage; this.user = '';
      this.preview = null; this.listChecked = false; this.b2bNone = false;
      this.unresolved = {}; this.results = {};
      if (user) this.login(user);
    }
    _key() { return 'sina-day-close-pending:' + this.user; }
    _persist() {
      if (!this.storage || !this.user) return;
      try {
        if (Object.keys(this.unresolved).length) this.storage.setItem(this._key(), JSON.stringify(this.unresolved));
        else this.storage.removeItem(this._key());
      } catch (_) { /* 저장소를 못 쓰면 이 창 안에서만 기억(규칙은 같다) */ }
    }
    // 다른 사용자로 바뀌면 이전 사용자의 미확정 요청을 이어받지 않는다(서버도 거부)
    login(user) {
      if (user !== this.user) {
        if (this.storage && this.user) try { this.storage.removeItem(this._key()); } catch (_) {}
        this.unresolved = {}; this.results = {};
        this.user = user;
        if (this.storage && user) {
          try {
            for (let i = this.storage.length - 1; i >= 0; i--) {
              const k = this.storage.key(i);
              if (k && k.startsWith('sina-day-close-pending:') && k !== this._key()) this.storage.removeItem(k);
            }
            this.unresolved = JSON.parse(this.storage.getItem(this._key()) || '{}');
          } catch (_) { this.unresolved = {}; }
        }
      }
    }
    logout() {
      if (this.storage && this.user) try { this.storage.removeItem(this._key()); } catch (_) {}
      this.unresolved = {}; this.results = {};
      this.user = ''; this.preview = null; this.listChecked = false; this.b2bNone = false;
    }

    // 새 미리보기 반영: 'same' | 'reset' | 'committed'
    load(previewResponse) {
      const p = previewResponse.basis ? previewResponse : previewFrom(previewResponse);
      const pend = this.unresolved[p.day];
      if (pend && p.last_request_key === pend.p_request_key) {
        delete this.unresolved[p.day]; this._persist();
        this.results[p.day] = { status: '저장됨' };
        this._reset(p); return 'committed';
      }
      // 마지막 마감 번호가 내 번호와 달라도 미확정 요청은 지우지 않는다(P6)
      if (this.preview && this.preview.basis === p.basis) { this.preview = p; return 'same'; }
      this._reset(p); return 'reset';
    }
    _reset(p) { this.preview = p; this.listChecked = false; this.b2bNone = false; }
    _need() { if (!this.preview) throw new DayCloseError('마감 미리보기를 먼저 불러오세요.'); return this.preview; }

    checkList(on = true) { this._need(); this.listChecked = !!on; }
    setB2bNone(on) {
      const p = this._need();
      if (on && p.valid_count) throw new DayCloseError('유효한 명세서가 있어 「B2B 출고 없음」을 켤 수 없습니다.');
      this.b2bNone = !!on;
    }

    // 저장을 막는 이유(P8). null이면 저장 가능
    blockReason() {
      const p = this.preview;
      if (!p) return '마감 미리보기를 먼저 불러오세요.';
      if (!this.user) return '로그인이 필요합니다.';
      if (this.unresolved[p.day]) return '이 날짜에 결과를 모르는 저장이 있습니다 — 「다시 보내기」나 「저장 확인」을 먼저 하세요.';
      if (p.mode === 'hold') return '마감 저장이 보류 중입니다 — 관리자에게 알리세요.';
      if (p.mode !== 'compat' && p.mode !== 'enforced') return '마감 쓰기 모드를 확인할 수 없습니다 — 관리자에게 알리세요.';
      if (!p.format_ok) return '명세서 형식 이상으로 마감할 수 없습니다 — 관리자 확인 필요.';
      if (p.pending_correction) return '이 날짜에 처리 대기 중인 생산 정정 요청이 있습니다 — 처리된 뒤 마감하세요.';
      return null;
    }

    // 새 저장 요청(서버 인자 그대로). 보내기 직전에 미확정으로 남긴다.
    async request(lines, memo = null) {
      const why = this.blockReason(); if (why) throw new DayCloseError(why);
      const p = this.preview;
      if (!this.listChecked) throw new DayCloseError('그날 명세서 목록을 보고 「명세서 목록 확인함」을 체크하세요.');
      if (!lines.length && !this.b2bNone) throw new DayCloseError('생산 줄 없는 마감은 「B2B 출고 없음」일 때만 할 수 있습니다.');
      if (this.b2bNone && p.valid_count) throw new DayCloseError('유효한 명세서가 있어 「B2B 출고 없음」으로 마감할 수 없습니다.');
      if (!this.salt || this.salt.length < 16) throw new DayCloseError('화면 식별값이 없습니다 — 새로고침하세요.');
      const body = {
        p_day: p.day, p_lines: lines, p_reviewed_fp: p.fingerprint, p_reviewed_gen: p.generation,
        p_expected_close_version: p.expected_close_version, p_list_checked: true, p_b2b_none: this.b2bNone,
        p_memo: memo === '' ? null : memo,
      };
      const digest = await sha256hex(canonical(body));
      const key = 'dc-' + (await sha256hex(this.salt + ':' + this.user + ':' + digest)).slice(0, 40);
      const req = Object.assign({}, body, { p_request_key: key });
      this.unresolved[p.day] = req; delete this.results[p.day]; this._persist();   // 지난 결과 표시는 새 요청과 섞지 않는다
      return Object.assign({}, req);
    }
    resend(day) {
      if (!this.unresolved[day]) throw new DayCloseError('다시 보낼 요청이 없습니다.');
      const r = Object.assign({}, this.unresolved[day]); delete r.not_found; return r;
    }
    // 사람이 명시적으로 미확정 요청을 버린다(다른 내용으로 새로 저장하려면). 뒤이어 새 미리보기가 필요하다.
    // 버린 요청이 늦게 도착해 먼저 커밋되면 새 요청이 기대 버전 검사로 거부되고, 새 요청이 먼저면 옛 요청이 거부된다.
    discard(day) {
      if (!this.unresolved[day]) throw new DayCloseError('버릴 요청이 없습니다.');
      delete this.unresolved[day]; this._persist();
      this.results[day] = { status: '버림' };
      if (this.preview && this.preview.day === day) this._clearPreview();
    }
    onResponse(day, ok, result) {
      delete this.unresolved[day]; this._persist();
      this.results[day] = ok ? { status: '저장됨', result } : { status: '거부', message: result };
      if (this.preview && this.preview.day === day) this._clearPreview();
    }
    onStatus(day, st) {
      if (!this.unresolved[day]) return;
      if (st && st.status === '저장됨') { delete this.unresolved[day]; this.results[day] = { status: '저장됨', result: st.result }; }
      // '없음' = 확인 시점까지 커밋 없음. 그 요청이 뒤에 실행될 수 없다는 뜻은 아니므로 지우지 않는다.
      // 기본 복구는 같은 요청 재전송, 다른 내용으로 새로 저장하려면 사람이 discard()로 명시적으로 버린다.
      else if (st && st.status === '없음') { this.unresolved[day] = Object.assign({}, this.unresolved[day], { not_found: true }); this.results[day] = { status: '확인 시점 저장 없음' }; }
      else throw new DayCloseError('저장 확인 응답을 알 수 없습니다.');
      this._persist();
      if (this.preview && this.preview.day === day) this._clearPreview();
    }
    _clearPreview() { this.preview = null; this.listChecked = false; this.b2bNone = false; }
    // 날짜를 바꾸면 화면의 미리보기·체크를 버린다(미확정 요청은 날짜별로 그대로 남는다)
    clearPreview() { this._clearPreview(); }
  }

  // ---- 서버 호출 묶음(rpc = (이름, 인자) => Promise<{data, error}>, supabase-js의 sb.rpc와 같은 모양) ----
  async function refresh(rpc, s, day) {
    const r = classify(await rpc('preview_day_close', { p_day: day }));
    if (r.kind !== 'ok') throw new DayCloseError(r.kind === 'rejected' ? r.message : '미리보기를 불러오지 못했습니다 — 연결을 확인하고 다시 누르세요.');
    return s.load(r.data);
  }
  // 반환 { state: 'saved' | 'rejected' | 'unknown', data?, message? }
  async function send(rpc, s, req) {
    let res; try { res = await rpc('save_day_close', req); } catch (e) { res = { error: { message: String(e && e.message || e) } }; }
    const r = classify(res);
    if (r.kind === 'ok') { s.onResponse(req.p_day, true, r.data); return { state: 'saved', data: r.data }; }
    if (r.kind === 'rejected') { s.onResponse(req.p_day, false, r.message); return { state: 'rejected', message: r.message }; }
    return { state: 'unknown', message: '저장 결과를 받지 못했습니다. 「다시 보내기」(같은 내용) 또는 「저장 확인」을 누르세요. 새로 저장하지 마세요.' };
  }
  async function confirmSaved(rpc, s, day) {
    const pend = s.unresolved[day]; if (!pend) return { state: 'none' };
    let res; try { res = await rpc('day_close_request_status', { p_day: day, p_request_key: pend.p_request_key }); }
    catch (e) { res = { error: { message: String(e && e.message || e) } }; }
    const r = classify(res);
    if (r.kind !== 'ok') return { state: 'unknown', message: r.kind === 'rejected' ? r.message : '확인 응답을 받지 못했습니다 — 잠시 뒤 다시 확인하세요.' };
    s.onStatus(day, r.data);
    return { state: r.data.status === '저장됨' ? 'saved' : 'not_found', data: r.data };
  }

  const api = { DayCloseError, Session, previewFrom, splitLines, toServerLines, classify, canonical, sha256hex, randomSalt, refresh, send, confirmSaved };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.DayClose = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
