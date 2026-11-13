'use strict';
/*
 * MRH P6 Studio - disa aktarma (XER ve CSV)
 * (c) Merih Dogan
 */
const { MrhHata } = require('./dgn-p6');

const DISLA = new Set(['delete_session_id', 'delete_date']);

// Windows-1254 (Turkce) ve 1252 icin kucuk kodlayici
const CP_OZEL = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x0178: 0x9F
};
const TR = { 0x011E: 0xD0, 0x0130: 0xDD, 0x015E: 0xDE, 0x011F: 0xF0, 0x0131: 0xFD, 0x015F: 0xFE };
const TR_YER = new Set([0xD0, 0xDD, 0xDE, 0xF0, 0xFD, 0xFE]);

function kodla(metin, kodlama) {
  if (kodlama === 'utf8') return Buffer.from(metin, 'utf8');
  const tr = kodlama === 'cp1254';
  const out = Buffer.alloc(metin.length);
  let i = 0;
  for (const ch of metin) {
    const c = ch.codePointAt(0);
    let b;
    if (c < 0x80) b = c;
    else if (tr && TR[c] != null) b = TR[c];
    else if (CP_OZEL[c] != null) b = CP_OZEL[c];
    else if (c >= 0xA0 && c <= 0xFF && !(tr && TR_YER.has(c))) b = c;
    else b = 0x3F; // '?'
    out[i++] = b;
  }
  return out.subarray(0, i);
}

function deger(v, kolon) {
  if (v == null) return '';
  if (v instanceof Uint8Array) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/_date\d?$/.test(kolon) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s)) return s.replace('T', ' ').slice(0, 16);
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, '\x7f\x7f');
}

function xerOlustur(p6, projId, { kodlama = 'cp1254' } = {}) {
  projId = Number(projId);
  const proje = p6.bir(`SELECT * FROM ${p6.ad('PROJECT')} WHERE proj_id=?`, projId);
  if (!proje) throw new MrhHata('Proje bulunamadı', 404);
  const cn = (t, a = '') => p6.canli(t, a);
  const T = t => p6.ad(t);
  const gorevAlt = `SELECT task_id FROM ${T('TASK')} WHERE proj_id=${projId}${cn('TASK')}`;

  const plan = [];
  const ekle = (tablo, kosul) => { if (p6.tabloMu(tablo)) plan.push([tablo, kosul]); };

  // Takvimler: projede kullanilanlar + bunlarin temel takvimleri
  const takv = new Set();
  if (proje.clndr_id != null) takv.add(proje.clndr_id);
  for (const r of p6.hepsi(`SELECT DISTINCT clndr_id c FROM ${T('TASK')} WHERE proj_id=?${cn('TASK')}`, projId)) if (r.c != null) takv.add(r.c);
  if (p6.kol('CALENDAR', 'base_clndr_id')) {
    for (const id of [...takv]) {
      const r = p6.bir(`SELECT base_clndr_id b FROM ${T('CALENDAR')} WHERE clndr_id=?`, id);
      if (r && r.b != null) takv.add(r.b);
    }
  }
  if (takv.size) ekle('CALENDAR', `clndr_id IN (${[...takv].map(Number).join(',')})`);
  ekle('PROJECT', `proj_id=${projId}`);
  if (p6.var('TASKACTV')) {
    ekle('ACTVTYPE', `actv_code_type_id IN (SELECT DISTINCT c.actv_code_type_id FROM ${T('TASKACTV')} a JOIN ${T('ACTVCODE')} c ON c.actv_code_id=a.actv_code_id WHERE a.proj_id=${projId})`);
  }
  if (p6.var('TASKMEMO') && p6.var('MEMOTYPE')) ekle('MEMOTYPE', `memo_type_id IN (SELECT DISTINCT memo_type_id FROM ${T('TASKMEMO')} WHERE proj_id=${projId})`);
  if (p6.var('UDFVALUE') && p6.kol('UDFTYPE', 'table_name')) ekle('UDFTYPE', `table_name='TASK' AND udf_type_id IN (SELECT DISTINCT udf_type_id FROM ${T('UDFVALUE')} WHERE fk_id IN (${gorevAlt}))`);
  ekle('PROJWBS', `proj_id=${projId}`);
  if (p6.var('TASKACTV')) {
    ekle('ACTVCODE', `actv_code_type_id IN (SELECT DISTINCT c.actv_code_type_id FROM ${T('TASKACTV')} a JOIN ${T('ACTVCODE')} c ON c.actv_code_id=a.actv_code_id WHERE a.proj_id=${projId})`);
  }
  if (p6.var('TASKRSRC')) ekle('RSRC', `rsrc_id IN (SELECT DISTINCT rsrc_id FROM ${T('TASKRSRC')} WHERE proj_id=${projId})`);
  ekle('TASK', `proj_id=${projId}`);
  ekle('TASKMEMO', `proj_id=${projId}`);
  ekle('TASKACTV', `proj_id=${projId}`);
  ekle('TASKPRED', `task_id IN (${gorevAlt}) AND pred_task_id IN (${gorevAlt})`);
  ekle('TASKRSRC', `proj_id=${projId}`);
  if (p6.kol('UDFTYPE', 'table_name')) ekle('UDFVALUE', `fk_id IN (${gorevAlt}) AND udf_type_id IN (SELECT udf_type_id FROM ${T('UDFTYPE')} WHERE table_name='TASK')`);

  const bugun = new Date().toISOString().slice(0, 10);
  const satirlar = [['ERMHDR', '23.12', bugun, 'Project', 'MRH', 'MRH P6 Studio', 'dbxDatabaseNoName', 'Project Management', 'USD'].join('\t')];
  const sayim = {};
  for (const [tablo, kosul] of plan) {
    const kol = [...p6.kolonlar(tablo).keys()].filter(c => !DISLA.has(c));
    if (!kol.length) continue;
    const rows = p6.hepsi(`SELECT ${kol.join(',')} FROM ${T(tablo)} WHERE ${kosul}${cn(tablo)}`);
    if (!rows.length) continue;
    sayim[tablo] = rows.length;
    satirlar.push('%T\t' + tablo);
    satirlar.push('%F\t' + kol.join('\t'));
    for (const r of rows) satirlar.push('%R\t' + kol.map(c => deger(r[c], c)).join('\t'));
  }
  satirlar.push('%E');
  const metin = satirlar.join('\r\n') + '\r\n';
  return { veri: kodla(metin, kodlama), sayim, dosyaAdi: String(proje.proj_short_name || 'proje').replace(/[^\w\-. ]+/g, '_') + '_mrh.xer' };
}

function csvOlustur(yuk) {
  const wbs = new Map(yuk.wbs.map(w => [w.id, w]));
  const yol = id => { const p = []; let w = wbs.get(id), g = 0; while (w && !w.kok && g++ < 50) { p.unshift(w.kod); w = wbs.get(w.ust); } return p.join('.'); };
  const takv = new Map(yuk.takvimler.map(c => [c.id, c.ad]));
  const DURUM = { TK_NotStart: 'Başlamadı', TK_Active: 'Devam Ediyor', TK_Complete: 'Tamamlandı' };
  const bas = ['Aktivite Kodu', 'Aktivite Adı', 'WBS', 'Durum', 'Tür', 'Orijinal Süre', 'Kalan Süre', '% Tamamlanma', 'Başlangıç', 'Bitiş',
    'Fiili Başlangıç', 'Fiili Bitiş', 'Toplam Bolluk', 'Kritik', 'Takvim', 'Taban Başlangıç', 'Taban Bitiş'];
  const q = v => { if (v == null) return ''; const s = String(v); return /[;"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const sayiTR = v => v == null ? '' : String(v).replace('.', ',');
  const satir = [bas.join(';')];
  for (const a of yuk.aktiviteler) {
    satir.push([a.kod, a.ad, yol(a.w), DURUM[a.st] || a.st, a.tur, sayiTR(a.od), sayiTR(a.rd), sayiTR(a.pct), a.bas, a.bit, a.as, a.af,
      sayiTR(a.tf), a.kr ? 'Evet' : '', takv.get(a.cal) || '', a.bs, a.bf].map(q).join(';'));
  }
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(satir.join('\r\n'), 'utf8')]);
}

module.exports = { xerOlustur, csvOlustur, kodla };
