'use strict';
/*
 * MRH P6 Studio - P6 SQLite veri katmani
 * Primavera P6 Professional SQLite semasini kolonlari tek tek yoklayarak okur;
 * surumler arasi kolon farklarina karsi uyarlanabilir calisir.
 * (c) Merih Dogan
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

class MrhHata extends Error {
  constructor(mesaj, kod = 400) { super(mesaj); this.kod = kod; }
}

// Bilinen birincil anahtarlar (P6 tablolarinda tek kolonlu vekil anahtarlar)
const PK = {
  PROJECT: 'proj_id', PROJWBS: 'wbs_id', TASK: 'task_id', TASKPRED: 'task_pred_id',
  TASKRSRC: 'taskrsrc_id', TASKMEMO: 'memo_id', CALENDAR: 'clndr_id', RSRC: 'rsrc_id',
  ACTVTYPE: 'actv_code_type_id', ACTVCODE: 'actv_code_id', UDFTYPE: 'udf_type_id',
  MEMOTYPE: 'memo_type_id', PROJCOST: 'cost_item_id', TASKPROC: 'proc_id'
};

const SECENEK = {
  durum: ['TK_NotStart', 'TK_Active', 'TK_Complete'],
  tur: ['TT_Task', 'TT_Rsrc', 'TT_Mile', 'TT_FinMile', 'TT_LOE', 'TT_WBS'],
  sureTuru: ['DT_FixedDUR2', 'DT_FixedDrtn', 'DT_FixedQty', 'DT_FixedRate'],
  yuzdeTuru: ['CP_Phys', 'CP_Drtn', 'CP_Units'],
  iliski: ['PR_FS', 'PR_SS', 'PR_FF', 'PR_SF'],
  kisit: ['CS_MSO', 'CS_MSOB', 'CS_MSOA', 'CS_MEO', 'CS_MEOB', 'CS_MEOA', 'CS_ALAP', 'CS_MANDSTART', 'CS_MANDFIN']
};

// ---------- yardimcilar ----------
const iki = n => String(n).padStart(2, '0');

function tarihMetni(v) {
  if (v == null || v === '') return null;
  let s = String(v).trim().replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += ' 00:00';
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.slice(0, 16) : null;
}

function tarihGir(v, varsayilanSaat = '08:00', etiket = 'Tarih') {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim().replace('T', ' ');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) throw new MrhHata(`${etiket} geçersiz: "${v}" (YYYY-AA-GG bekleniyor)`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new MrhHata(`${etiket} takvimde yok: ${v}`);
  const hh = m[4] ?? varsayilanSaat.slice(0, 2), mm = m[5] ?? varsayilanSaat.slice(3, 5);
  if (+hh > 23 || +mm > 59) throw new MrhHata(`${etiket} saati geçersiz: ${v}`);
  return `${m[1]}-${m[2]}-${m[3]} ${hh}:${mm}:00`;
}

function simdiMetin() {
  const d = new Date();
  return `${d.getFullYear()}-${iki(d.getMonth() + 1)}-${iki(d.getDate())} ${iki(d.getHours())}:${iki(d.getMinutes())}:${iki(d.getSeconds())}`;
}

function sayi(v, etiket) {
  if (v === '' || v == null) throw new MrhHata(`${etiket} boş olamaz`);
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').trim());
  if (!Number.isFinite(n)) throw new MrhHata(`${etiket} sayı olmalı: "${v}"`);
  return n;
}

const yuvarla = (n, b = 2) => (n == null || !Number.isFinite(n)) ? null : Math.round(n * 10 ** b) / 10 ** b;

/** P6 GUID: 16 rastgele baytin dolgusuz base64 hali (22 karakter) */
const yeniGuid = () => crypto.randomBytes(16).toString('base64').replace(/=+$/, '');

const param = v => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;

function esit(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

// ---------- ana sinif ----------
class DgnP6 {
  constructor(dosya, { saltOkunur = true } = {}) {
    const tam = path.resolve(String(dosya || '').trim().replace(/^"+|"+$/g, ''));
    if (!fs.existsSync(tam) || !fs.statSync(tam).isFile()) throw new MrhHata('Veritabanı dosyası bulunamadı: ' + tam, 404);
    const fd = fs.openSync(tam, 'r');
    const bas = Buffer.alloc(16);
    fs.readSync(fd, bas, 0, 16, 0);
    fs.closeSync(fd);
    if (bas.toString('latin1') !== 'SQLite format 3\u0000') throw new MrhHata('Bu dosya bir SQLite veritabanı değil.');

    this.dosya = tam;
    this.saltOkunur = saltOkunur;
    this.db = new DatabaseSync(tam, { readOnly: saltOkunur });
    this.db.exec('PRAGMA busy_timeout = 8000');
    this._tablo = new Map();   // BUYUK -> { ad, tur }
    for (const r of this.db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')").all()) {
      this._tablo.set(String(r.name).toUpperCase(), { ad: r.name, tur: r.type });
    }
    this._kolon = new Map();
    const eksik = ['PROJECT', 'PROJWBS', 'TASK', 'TASKPRED'].filter(t => !this.var(t));
    if (eksik.length) {
      this.db.close();
      throw new MrhHata('Bu bir Primavera P6 veritabanı gibi görünmüyor (eksik tablolar: ' + eksik.join(', ') + ').');
    }
    // Tarih bicimi: bazi veritabanlari milisaniye eki ile saklar
    this._tarihEki = '';
    if (this.kol('TASK', 'update_date')) {
      const ornek = this.bir(`SELECT update_date d FROM ${this.ad('TASK')} WHERE update_date IS NOT NULL LIMIT 1`);
      if (ornek && /\.\d{3}$/.test(String(ornek.d))) this._tarihEki = '.000';
    }
  }

  kapat() { try { this.db.close(); } catch { /* zaten kapali */ } }

  // ----- sema -----
  var(t) { return this._tablo.has(String(t).toUpperCase()); }
  tabloMu(t) { const x = this._tablo.get(String(t).toUpperCase()); return !!x && x.tur === 'table'; }
  ad(t) {
    const x = this._tablo.get(String(t).toUpperCase());
    if (!x) throw new MrhHata('Tablo bulunamadı: ' + t, 500);
    return '"' + x.ad.replace(/"/g, '""') + '"';
  }
  kolonlar(t) {
    const B = String(t).toUpperCase();
    if (!this._kolon.has(B)) {
      const m = new Map();
      if (this.var(B)) {
        for (const c of this.db.prepare(`PRAGMA table_info(${this.ad(B)})`).all()) {
          m.set(String(c.name).toLowerCase(), { ad: c.name, tip: String(c.type || '').toUpperCase(), notnull: !!c.notnull, dflt: c.dflt_value, pk: c.pk });
        }
      }
      this._kolon.set(B, m);
    }
    return this._kolon.get(B);
  }
  kol(t, c) { return this.var(t) && this.kolonlar(t).has(String(c).toLowerCase()); }
  /** silinmis (P6 yumusak silme) satirlari disarida birakan kosul */
  canli(t, takma = '') { return this.kol(t, 'delete_session_id') ? ` AND ${takma ? takma + '.' : ''}delete_session_id IS NULL` : ''; }
  sec(t, istenen, takma = '') { return istenen.filter(c => this.kol(t, c)).map(c => (takma ? takma + '.' : '') + c); }
  pk(t) {
    const B = String(t).toUpperCase();
    if (PK[B] && this.kol(B, PK[B])) return PK[B];
    for (const [ad, c] of this.kolonlar(B)) if (c.pk === 1) return ad;
    return null;
  }
  tarih(v) { return v ? v + this._tarihEki : v; }

  // ----- sorgu kisayollari -----
  hepsi(sql, ...p) { return this.db.prepare(sql).all(...p.map(param)); }
  bir(sql, ...p) { return this.db.prepare(sql).get(...p.map(param)); }
  calistir(sql, ...p) { return this.db.prepare(sql).run(...p.map(param)); }

  // ----- okuma -----
  ozet() {
    const say = t => this.var(t) ? this.bir(`SELECT COUNT(*) n FROM ${this.ad(t)} WHERE 1=1${this.canli(t)}`).n : 0;
    const boyut = fs.statSync(this.dosya).size;
    return {
      dosya: this.dosya, ad: path.basename(this.dosya), boyut, saltOkunur: this.saltOkunur,
      sayilar: { proje: say('PROJECT'), aktivite: say('TASK'), iliski: say('TASKPRED'), kaynak: say('RSRC'), takvim: say('CALENDAR') }
    };
  }

  takvimler() {
    if (!this.var('CALENDAR')) return [];
    const k = this.sec('CALENDAR', ['clndr_id', 'clndr_name', 'day_hr_cnt', 'week_hr_cnt', 'clndr_type', 'proj_id', 'default_flag', 'base_clndr_id']);
    return this.hepsi(`SELECT ${k.join(',')} FROM ${this.ad('CALENDAR')} WHERE 1=1${this.canli('CALENDAR')} ORDER BY clndr_name`).map(r => ({
      id: r.clndr_id, ad: r.clndr_name, gunSaat: r.day_hr_cnt > 0 ? r.day_hr_cnt : 8, haftaSaat: r.week_hr_cnt ?? null,
      tur: r.clndr_type ?? null, proje: r.proj_id ?? null, varsayilan: r.default_flag === 'Y'
    }));
  }

  gunSaat(clndrId) {
    if (clndrId == null || !this.kol('CALENDAR', 'day_hr_cnt')) return 8;
    const r = this.bir(`SELECT day_hr_cnt h FROM ${this.ad('CALENDAR')} WHERE clndr_id=?`, clndrId);
    return r && r.h > 0 ? r.h : 8;
  }

  projeler() {
    const k = this.sec('PROJECT', ['proj_id', 'proj_short_name', 'last_recalc_date', 'plan_start_date', 'plan_end_date',
      'scd_end_date', 'sum_base_proj_id', 'orig_proj_id', 'project_flag', 'status_code', 'clndr_id'], 'p');
    const adSql = this.kol('PROJWBS', 'proj_node_flag')
      ? `(SELECT w.wbs_name FROM ${this.ad('PROJWBS')} w WHERE w.proj_id=p.proj_id AND w.proj_node_flag='Y'${this.canli('PROJWBS', 'w')} LIMIT 1)`
      : 'NULL';
    const rows = this.hepsi(`SELECT ${k.join(',')}, ${adSql} AS ad,
        (SELECT COUNT(*) FROM ${this.ad('TASK')} t WHERE t.proj_id=p.proj_id${this.canli('TASK', 't')}) AS adet
      FROM ${this.ad('PROJECT')} p WHERE 1=1${this.canli('PROJECT', 'p')} ORDER BY p.proj_short_name`);
    return rows.map(r => ({
      id: r.proj_id, kod: r.proj_short_name, ad: r.ad || r.proj_short_name,
      veriTarihi: tarihMetni(r.last_recalc_date), baslangic: tarihMetni(r.plan_start_date),
      bitis: tarihMetni(r.scd_end_date) || tarihMetni(r.plan_end_date),
      taban: r.sum_base_proj_id ?? null,
      tabanMi: r.orig_proj_id != null || r.project_flag === 'N',
      durum: r.status_code ?? null, takvim: r.clndr_id ?? null, adet: r.adet
    }));
  }

  projeBul(id) {
    const p = this.projeler().find(x => x.id === Number(id));
    if (!p) throw new MrhHata('Proje bulunamadı: ' + id, 404);
    return p;
  }

  _gorevKolonlari() {
    return this.sec('TASK', ['task_id', 'proj_id', 'wbs_id', 'clndr_id', 'task_code', 'task_name', 'task_type', 'status_code',
      'duration_type', 'complete_pct_type', 'phys_complete_pct', 'target_drtn_hr_cnt', 'remain_drtn_hr_cnt',
      'act_start_date', 'act_end_date', 'early_start_date', 'early_end_date', 'late_start_date', 'late_end_date',
      'target_start_date', 'target_end_date', 'restart_date', 'reend_date', 'total_float_hr_cnt', 'free_float_hr_cnt',
      'driving_path_flag', 'cstr_type', 'cstr_date', 'priority_type']);
  }

  _birimIlerleme(projId) {
    const m = new Map();
    if (!this.kol('TASKRSRC', 'remain_qty') || !this.kol('TASKRSRC', 'act_reg_qty')) return m;
    const ot = this.kol('TASKRSRC', 'act_ot_qty') ? '+COALESCE(act_ot_qty,0)' : '';
    for (const r of this.hepsi(`SELECT task_id, SUM(COALESCE(act_reg_qty,0)${ot}) a, SUM(COALESCE(remain_qty,0)) r
        FROM ${this.ad('TASKRSRC')} WHERE proj_id=?${this.canli('TASKRSRC')} GROUP BY task_id`, projId)) m.set(r.task_id, r);
    return m;
  }

  _aktivite(t, takv, varsayilanSaat, birim) {
    const gs = takv.get(t.clndr_id) || varsayilanSaat;
    const gun = h => h == null ? null : yuvarla(h / gs, 2);
    const st = t.status_code || 'TK_NotStart';
    const od = gun(t.target_drtn_hr_cnt), rd = gun(t.remain_drtn_hr_cnt);
    const as = tarihMetni(t.act_start_date), af = tarihMetni(t.act_end_date);
    const es = tarihMetni(t.restart_date) || tarihMetni(t.early_start_date) || tarihMetni(t.target_start_date);
    const ef = tarihMetni(t.reend_date) || tarihMetni(t.early_end_date) || tarihMetni(t.target_end_date);
    let bas, bit;
    if (st === 'TK_Complete') { bas = as || af || es; bit = af || as || ef; }
    else if (st === 'TK_Active') { bas = as || es; bit = ef; }
    else { bas = es; bit = ef; }
    if (t.task_type === 'TT_Mile' && !bit) bit = bas;
    if (t.task_type === 'TT_FinMile' && !bas) bas = bit;
    const pt = t.complete_pct_type || 'CP_Drtn';
    const surePct = st === 'TK_Complete' ? 100 : st === 'TK_NotStart' ? 0
      : (od > 0 && rd != null ? Math.min(100, Math.max(0, (od - rd) / od * 100)) : 0);
    let pct = surePct;
    if (pt === 'CP_Phys') pct = t.phys_complete_pct ?? 0;
    else if (pt === 'CP_Units') {
      const u = birim.get(t.task_id);
      if (u && u.a + u.r > 0) pct = u.a / (u.a + u.r) * 100;
    }
    const tf = gun(t.total_float_hr_cnt);
    return {
      id: t.task_id, w: t.wbs_id ?? null, cal: t.clndr_id ?? null, kod: t.task_code, ad: t.task_name,
      tur: t.task_type || 'TT_Task', st, dt: t.duration_type ?? null, pt, pct: yuvarla(pct, 1), surePct: yuvarla(surePct, 1),
      od, rd, as, af, es, ef, ls: tarihMetni(t.late_start_date), lf: tarihMetni(t.late_end_date),
      bas, bit, tf, ff: gun(t.free_float_hr_cnt),
      kr: st !== 'TK_Complete' && ((tf != null && tf <= 0) || t.driving_path_flag === 'Y'),
      ks: t.cstr_type || null, kt: tarihMetni(t.cstr_date), onc: t.priority_type ?? null
    };
  }

  projeYukle(projId, { tabanId } = {}) {
    projId = Number(projId);
    const proje = this.projeBul(projId);
    const takvimler = this.takvimler();
    const takv = new Map(takvimler.map(c => [c.id, c.gunSaat]));
    const varsayilanSaat = takv.get(proje.takvim) || 8;

    const wk = this.sec('PROJWBS', ['wbs_id', 'parent_wbs_id', 'wbs_short_name', 'wbs_name', 'seq_num', 'proj_node_flag']);
    const sira = this.kol('PROJWBS', 'seq_num') ? 'seq_num, wbs_short_name' : 'wbs_short_name';
    const wbs = this.hepsi(`SELECT ${wk.join(',')} FROM ${this.ad('PROJWBS')} WHERE proj_id=?${this.canli('PROJWBS')} ORDER BY ${sira}`, projId)
      .map(r => ({ id: r.wbs_id, ust: r.parent_wbs_id ?? null, kod: r.wbs_short_name, ad: r.wbs_name, sira: r.seq_num ?? 0, kok: r.proj_node_flag === 'Y' }));

    const birim = this._birimIlerleme(projId);
    const gorev = this.hepsi(`SELECT ${this._gorevKolonlari().join(',')} FROM ${this.ad('TASK')} WHERE proj_id=?${this.canli('TASK')} ORDER BY task_code`, projId);
    const aktiviteler = gorev.map(t => this._aktivite(t, takv, varsayilanSaat, birim));
    const idler = new Set(aktiviteler.map(a => a.id));
    const takvimiNe = new Map(aktiviteler.map(a => [a.id, takv.get(a.cal) || varsayilanSaat]));

    const ik = this.sec('TASKPRED', ['task_pred_id', 'task_id', 'pred_task_id', 'pred_type', 'lag_hr_cnt']);
    const projKosul = this.kol('TASKPRED', 'pred_proj_id') ? '(proj_id=? OR pred_proj_id=?)' : '(proj_id=? OR proj_id=?)';
    let disIliski = 0;
    const iliskiler = [];
    for (const r of this.hepsi(`SELECT ${ik.join(',')} FROM ${this.ad('TASKPRED')} WHERE ${projKosul}${this.canli('TASKPRED')}`, projId, projId)) {
      if (!idler.has(r.task_id) || !idler.has(r.pred_task_id)) { disIliski++; continue; }
      iliskiler.push({ id: r.task_pred_id, ardil: r.task_id, oncul: r.pred_task_id, tur: r.pred_type || 'PR_FS',
        gecikme: yuvarla((r.lag_hr_cnt || 0) / takvimiNe.get(r.task_id), 2) });
    }

    // Taban (baseline) karsilastirmasi: aktivite koduna gore eslestirilir
    let taban = tabanId === undefined ? proje.taban : (tabanId === '' || tabanId == null ? null : Number(tabanId));
    if (taban === projId) taban = null;
    if (taban != null) {
      const ok = this.bir(`SELECT proj_id FROM ${this.ad('PROJECT')} WHERE proj_id=?`, taban);
      if (!ok) taban = null;
    }
    if (taban != null) {
      const bb = this._birimIlerleme(taban);
      const tg = this.hepsi(`SELECT ${this._gorevKolonlari().join(',')} FROM ${this.ad('TASK')} WHERE proj_id=?${this.canli('TASK')}`, taban);
      const harita = new Map();
      for (const t of tg) { const a = this._aktivite(t, takv, varsayilanSaat, bb); harita.set(a.kod, a); }
      for (const a of aktiviteler) {
        const b = harita.get(a.kod);
        if (b) { a.bs = b.bas; a.bf = b.bit; a.bod = b.od; }
      }
    }
    return { proje, wbs, aktiviteler, iliskiler, takvimler, tabanId: taban, disIliski };
  }

  aktiviteDetay(id) {
    id = Number(id);
    const ham = this.bir(`SELECT * FROM ${this.ad('TASK')} WHERE task_id=?`, id);
    if (!ham) throw new MrhHata('Aktivite bulunamadı: ' + id, 404);
    const gs = this.gunSaat(ham.clndr_id);
    const T = this.ad('TASK');
    const lag = this.kol('TASKPRED', 'lag_hr_cnt') ? 'p.lag_hr_cnt' : '0';
    const iliski = (yon) => this.hepsi(`SELECT p.task_pred_id id, p.pred_type tur, ${lag} lag, t.task_id aid, t.task_code kod, t.task_name ad,
          t.status_code st, t.proj_id proj, t.clndr_id cal
        FROM ${this.ad('TASKPRED')} p JOIN ${T} t ON t.task_id = p.${yon === 'oncul' ? 'pred_task_id' : 'task_id'}
        WHERE p.${yon === 'oncul' ? 'task_id' : 'pred_task_id'}=?${this.canli('TASKPRED', 'p')}${this.canli('TASK', 't')} ORDER BY t.task_code`, id)
      .map(r => ({ id: r.id, tur: r.tur || 'PR_FS', gecikme: yuvarla((r.lag || 0) / (yon === 'oncul' ? gs : this.gunSaat(r.cal)), 2),
        aktivite: r.aid, kod: r.kod, ad: r.ad, st: r.st, proje: r.proj }));

    let kaynaklar = [];
    if (this.var('TASKRSRC') && this.var('RSRC')) {
      const k = this.sec('TASKRSRC', ['taskrsrc_id', 'target_qty', 'act_reg_qty', 'remain_qty', 'target_cost', 'act_reg_cost', 'remain_cost'], 'a');
      kaynaklar = this.hepsi(`SELECT ${k.join(',')}, r.rsrc_short_name kod, r.rsrc_name ad${this.kol('RSRC', 'rsrc_type') ? ', r.rsrc_type tip' : ''}
          FROM ${this.ad('TASKRSRC')} a JOIN ${this.ad('RSRC')} r ON r.rsrc_id=a.rsrc_id
          WHERE a.task_id=?${this.canli('TASKRSRC', 'a')} ORDER BY r.rsrc_short_name`, id);
    }
    let kodlar = [];
    if (this.var('TASKACTV') && this.var('ACTVCODE') && this.var('ACTVTYPE')) {
      kodlar = this.hepsi(`SELECT y.actv_code_type tur, c.short_name kod, c.actv_code_name ad
          FROM ${this.ad('TASKACTV')} a JOIN ${this.ad('ACTVCODE')} c ON c.actv_code_id=a.actv_code_id
          JOIN ${this.ad('ACTVTYPE')} y ON y.actv_code_type_id=c.actv_code_type_id
          WHERE a.task_id=?${this.canli('TASKACTV', 'a')} ORDER BY y.actv_code_type`, id);
    }
    let alanlar = [];
    if (this.var('UDFVALUE') && this.var('UDFTYPE')) {
      const k = this.sec('UDFVALUE', ['udf_text', 'udf_number', 'udf_date'], 'v');
      alanlar = this.hepsi(`SELECT y.udf_type_label ad, y.logical_data_type tip${k.length ? ', ' + k.join(',') : ''}
          FROM ${this.ad('UDFVALUE')} v JOIN ${this.ad('UDFTYPE')} y ON y.udf_type_id=v.udf_type_id
          WHERE v.fk_id=? AND y.table_name='TASK'${this.canli('UDFVALUE', 'v')} ORDER BY y.udf_type_label`, id)
        .map(r => ({ ad: r.ad, deger: r.udf_text ?? (r.udf_number != null ? r.udf_number : tarihMetni(r.udf_date)) }));
    }
    let notlar = [];
    if (this.var('TASKMEMO')) {
      const mt = this.var('MEMOTYPE') ? `(SELECT memo_type FROM ${this.ad('MEMOTYPE')} y WHERE y.memo_type_id=m.memo_type_id)` : 'NULL';
      notlar = this.hepsi(`SELECT ${mt} baslik, m.task_memo metin FROM ${this.ad('TASKMEMO')} m WHERE m.task_id=?${this.canli('TASKMEMO', 'm')}`, id)
        .map(r => ({ baslik: r.baslik || 'Not', metin: String(r.metin || '').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim() }));
    }
    for (const k of Object.keys(ham)) if (ham[k] instanceof Uint8Array) ham[k] = '(ikili veri)';
    return { ham, gunSaat: gs, onculler: iliski('oncul'), ardillar: iliski('ardil'), kaynaklar, kodlar, alanlar, notlar };
  }

  kaynaklar() {
    if (!this.var('RSRC')) return [];
    const k = this.sec('RSRC', ['rsrc_id', 'rsrc_short_name', 'rsrc_name', 'rsrc_type', 'unit_id', 'clndr_id', 'parent_rsrc_id', 'active_flag']);
    const atama = this.var('TASKRSRC')
      ? `, (SELECT COUNT(*) FROM ${this.ad('TASKRSRC')} a WHERE a.rsrc_id=r.rsrc_id${this.canli('TASKRSRC', 'a')}) atama` : ', 0 atama';
    return this.hepsi(`SELECT ${k.map(c => 'r.' + c).join(',')}${atama} FROM ${this.ad('RSRC')} r WHERE 1=1${this.canli('RSRC', 'r')} ORDER BY r.rsrc_short_name`);
  }

  // ----- yazma altyapisi -----
  /**
   * Tum yazmalar tek bir islem (transaction) icinde yapilir ve her degisiklik
   * oncesi/sonrasi satir goruntusu ile kaydedilir (geri alma icin).
   */
  islem(etiket, fn, { deneme = false } = {}) {
    if (this.saltOkunur) throw new MrhHata('Düzenleme modu kapalı. Üst çubuktan Düzenleme Modunu açın.', 403);
    const kayit = { etiket, zaman: new Date().toISOString(), degisiklik: [] };
    const k = new DgnKayitci(this, kayit.degisiklik);
    try { this.db.exec('BEGIN IMMEDIATE'); }
    catch (e) { throw kilitHatasi(e); }
    try {
      const sonuc = fn(k);
      this.db.exec(deneme ? 'ROLLBACK' : 'COMMIT');
      return { sonuc, kayit };
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* yok */ }
      throw kilitHatasi(e);
    }
  }

  yeniId(tablo, pkKolon) {
    const T = this.ad(tablo);
    const m = this.bir(`SELECT MAX(${pkKolon}) m FROM ${T}`).m || 0;
    let id = m + 1;
    if (this.var('NEXTKEY') && this.kol('NEXTKEY', 'key_name')) {
      const anahtar = `${tablo.toLowerCase()}_${pkKolon}`;
      const r = this.bir(`SELECT key_seq_num n FROM ${this.ad('NEXTKEY')} WHERE key_name=?`, anahtar);
      if (r) {
        id = Math.max(id, Number(r.n) || 0);
        this.calistir(`UPDATE ${this.ad('NEXTKEY')} SET key_seq_num=? WHERE key_name=?`, id + 1, anahtar);
      }
    }
    return id;
  }

  /** NOT NULL olup varsayilani olmayan kolonlar icin tipine uygun deger uretir */
  doldur(tablo, satir) {
    const s = {};
    for (const [ad, c] of this.kolonlar(tablo)) {
      if (Object.prototype.hasOwnProperty.call(satir, ad)) { s[ad] = satir[ad]; continue; }
      if (ad === 'guid') { s[ad] = yeniGuid(); continue; }
      if (!c.notnull || c.dflt != null) continue;
      if (/date/.test(ad) || /DATE|TIME/.test(c.tip)) s[ad] = this.tarih(simdiMetin());
      else if (/INT|REAL|NUM|DEC|DOUB|FLOA/.test(c.tip)) s[ad] = 0;
      else if (/_flag$/.test(ad)) s[ad] = 'N';
      else s[ad] = '';
    }
    return s;
  }
}

function kilitHatasi(e) {
  const m = String(e && e.message || e);
  if (/locked|busy/i.test(m)) return new MrhHata('Veritabanı kilitli: P6 şu anda bu dosyaya yazıyor olabilir. Birkaç saniye sonra tekrar deneyin ya da P6\'yi kapatın.', 409);
  return e;
}

class DgnKayitci {
  constructor(p6, liste) { this.p6 = p6; this.liste = liste; }

  satir(t, pk, v) { return this.p6.bir(`SELECT * FROM ${this.p6.ad(t)} WHERE ${pk}=?`, v); }

  guncelle(t, v, yama, { iz = true } = {}) {
    const p6 = this.p6, pk = p6.pk(t);
    if (!pk) throw new MrhHata('Birincil anahtar yok: ' + t, 500);
    const once = this.satir(t, pk, v);
    if (!once) throw new MrhHata(`${t} kaydı bulunamadı: ${v}`, 404);
    const deg = {};
    for (const [k, d] of Object.entries(yama)) {
      const kk = k.toLowerCase();
      if (kk === pk || !p6.kol(t, kk)) continue;
      if (!esit(once[kk], d)) deg[kk] = d;
    }
    if (!Object.keys(deg).length) return false;
    if (iz) {
      if (p6.kol(t, 'update_date')) deg.update_date = p6.tarih(simdiMetin());
      if (p6.kol(t, 'update_user')) deg.update_user = 'mrh';
    }
    const ks = Object.keys(deg);
    p6.calistir(`UPDATE ${p6.ad(t)} SET ${ks.map(k => k + '=?').join(', ')} WHERE ${pk}=?`, ...ks.map(k => deg[k]), v);
    this.liste.push({ t: t.toUpperCase(), pk, v, once, sonra: this.satir(t, pk, v) });
    return true;
  }

  ekle(t, satir, { doldur = true } = {}) {
    const p6 = this.p6;
    const s = doldur ? p6.doldur(t, satir) : Object.fromEntries(Object.entries(satir).filter(([k]) => p6.kol(t, k)));
    const ks = Object.keys(s).filter(k => p6.kol(t, k));
    p6.calistir(`INSERT INTO ${p6.ad(t)} (${ks.join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ...ks.map(k => s[k]));
    const pk = p6.pk(t);
    this.liste.push({ t: t.toUpperCase(), pk, v: pk ? s[pk] : null, once: null, sonra: pk ? this.satir(t, pk, s[pk]) : s });
    return s;
  }

  silNerede(t, kosul, params = []) {
    const p6 = this.p6;
    if (!p6.tabloMu(t)) return 0;
    const T = p6.ad(t), pk = p6.pk(t);
    const rows = p6.hepsi(`SELECT * FROM ${T} WHERE ${kosul}`, ...params);
    if (!rows.length) return 0;
    p6.calistir(`DELETE FROM ${T} WHERE ${kosul}`, ...params);
    for (const r of rows) this.liste.push({ t: t.toUpperCase(), pk, v: pk ? r[pk] : null, once: r, sonra: null });
    return rows.length;
  }
}

module.exports = { DgnP6, DgnKayitci, MrhHata, SECENEK, tarihMetni, tarihGir, simdiMetin, sayi, yuvarla, yeniGuid, esit };
