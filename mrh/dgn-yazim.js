'use strict';
/*
 * MRH P6 Studio - duzenleme islemleri
 * Her fonksiyon (p6, k, ...) alir; k = DgnKayitci (islem icinde, geri alinabilir).
 * (c) Merih Dogan
 */
const { MrhHata, SECENEK, tarihGir, simdiMetin, sayi, yeniGuid, esit } = require('./dgn-p6');

const SURE_SIFIR = new Set(['TT_Mile', 'TT_FinMile']);

function secenek(liste, v, etiket) {
  if (!liste.includes(v)) throw new MrhHata(`${etiket} geçersiz: ${v}`);
  return v;
}

function gorev(p6, id) {
  const t = p6.bir(`SELECT * FROM ${p6.ad('TASK')} WHERE task_id=?${p6.canli('TASK')}`, Number(id));
  if (!t) throw new MrhHata('Aktivite bulunamadı: ' + id, 404);
  return t;
}

function veriTarihiAl(p6, projId) {
  if (!p6.kol('PROJECT', 'last_recalc_date')) return null;
  const r = p6.bir(`SELECT last_recalc_date d FROM ${p6.ad('PROJECT')} WHERE proj_id=?`, projId);
  return r && r.d ? String(r.d).replace('T', ' ').slice(0, 16) : null;
}

/** Bir aktiviteye kismi degisiklik uygular; durum kurallarini korur. */
function aktiviteGuncelle(p6, k, id, yama, uyarilar = []) {
  const t = gorev(p6, id);
  const kod = t.task_code;
  const y = {};
  const varMi = a => Object.prototype.hasOwnProperty.call(yama, a);

  if (varMi('ad')) {
    const s = String(yama.ad ?? '').trim();
    if (!s) throw new MrhHata(`${kod}: aktivite adı boş olamaz`);
    if (s.length > 120) throw new MrhHata(`${kod}: aktivite adı en fazla 120 karakter olabilir`);
    y.task_name = s;
  }
  if (varMi('kod')) {
    const s = String(yama.kod ?? '').trim();
    if (!s) throw new MrhHata('Aktivite kodu boş olamaz');
    if (s.length > 40) throw new MrhHata('Aktivite kodu en fazla 40 karakter olabilir');
    const ayni = p6.bir(`SELECT 1 x FROM ${p6.ad('TASK')} WHERE proj_id=? AND task_code=? AND task_id<>?${p6.canli('TASK')}`, t.proj_id, s, t.task_id);
    if (ayni) throw new MrhHata(`"${s}" kodu bu projede zaten kullanılıyor`);
    y.task_code = s;
  }
  if (varMi('tur')) y.task_type = secenek(SECENEK.tur, yama.tur, 'Aktivite türü');
  if (varMi('dt')) y.duration_type = secenek(SECENEK.sureTuru, yama.dt, 'Süre türü');
  if (varMi('pt')) y.complete_pct_type = secenek(SECENEK.yuzdeTuru, yama.pt, 'Yüzde türü');
  if (varMi('cal')) {
    const c = p6.bir(`SELECT clndr_id FROM ${p6.ad('CALENDAR')} WHERE clndr_id=?`, Number(yama.cal));
    if (!c) throw new MrhHata('Takvim bulunamadı: ' + yama.cal);
    y.clndr_id = Number(yama.cal);
  }
  if (varMi('w')) {
    const w = p6.bir(`SELECT wbs_id FROM ${p6.ad('PROJWBS')} WHERE wbs_id=? AND proj_id=?${p6.canli('PROJWBS')}`, Number(yama.w), t.proj_id);
    if (!w) throw new MrhHata('WBS bu projede bulunamadı: ' + yama.w);
    y.wbs_id = Number(yama.w);
  }
  if (varMi('ks')) {
    const v = yama.ks || null;
    if (v) secenek(SECENEK.kisit, v, 'Kısıt türü');
    y.cstr_type = v;
    if (!v) y.cstr_date = null;
  }
  if (varMi('kt')) y.cstr_date = p6.tarih(tarihGir(yama.kt, '08:00', 'Kısıt tarihi'));
  const ksSon = varMi('ks') ? y.cstr_type : t.cstr_type;
  const ktSon = 'cstr_date' in y ? y.cstr_date : t.cstr_date;
  if (ksSon && ksSon !== 'CS_ALAP' && !ktSon) {
    throw new MrhHata(`${kod}: bu kısıt türü için kısıt tarihi gerekli`);
  }

  // --- sure, ilerleme ve durum ---
  const gs = p6.gunSaat(y.clndr_id ?? t.clndr_id);
  const tur = y.task_type || t.task_type || 'TT_Task';
  const pt = y.complete_pct_type || t.complete_pct_type || 'CP_Drtn';
  let st = varMi('st') ? secenek(SECENEK.durum, yama.st, 'Durum') : (t.status_code || 'TK_NotStart');
  let as = varMi('as') ? p6.tarih(tarihGir(yama.as, '08:00', 'Fiili başlangıç')) : t.act_start_date;
  let af = varMi('af') ? p6.tarih(tarihGir(yama.af, '17:00', 'Fiili bitiş')) : t.act_end_date;
  let odH = varMi('od') ? sayi(yama.od, 'Orijinal süre') * gs : (t.target_drtn_hr_cnt ?? 0);
  let rdH = varMi('rd') ? sayi(yama.rd, 'Kalan süre') * gs : (t.remain_drtn_hr_cnt ?? odH);
  if (odH < 0) throw new MrhHata(`${kod}: orijinal süre negatif olamaz`);
  if (rdH < 0) throw new MrhHata(`${kod}: kalan süre negatif olamaz`);

  if (varMi('pct')) {
    const p = sayi(yama.pct, 'Tamamlanma yüzdesi');
    if (p < 0 || p > 100) throw new MrhHata(`${kod}: yüzde 0 ile 100 arasında olmalı`);
    if (pt === 'CP_Drtn') rdH = odH * (1 - p / 100);
    else y.phys_complete_pct = p;
    if (pt === 'CP_Units') uyarilar.push(`${kod}: birim yüzdesi kaynak atamalarından hesaplanır; girilen deger fiziksel yüzde olarak kaydedildi.`);
    if (p > 0 && st === 'TK_NotStart' && !varMi('st')) {
      if (!as) throw new MrhHata(`${kod}: ilerleme girmek için önce fiili başlangıç tarihi girin`);
      st = 'TK_Active';
    }
  } else if (varMi('od') && !varMi('rd') && st === 'TK_NotStart') {
    rdH = odH;
  }
  if (varMi('as') && as && st === 'TK_NotStart' && !varMi('st')) st = 'TK_Active';
  if (varMi('af') && af && st !== 'TK_Complete' && !varMi('st')) st = 'TK_Complete';

  if (SURE_SIFIR.has(tur)) { odH = 0; rdH = 0; }

  if (st === 'TK_NotStart') {
    as = null; af = null; rdH = odH;
    if (pt !== 'CP_Drtn' && p6.kol('TASK', 'phys_complete_pct') && !varMi('pct')) y.phys_complete_pct = 0;
  } else if (st === 'TK_Active') {
    if (SURE_SIFIR.has(tur)) throw new MrhHata(`${kod}: kilometre taşı "devam ediyor" olamaz; başlamadı ya da tamamlandı seçin`);
    if (!as) throw new MrhHata(`${kod}: devam eden aktivite için fiili başlangıç gerekli`);
    af = null;
  } else {
    if (tur === 'TT_Mile') { if (!as) throw new MrhHata(`${kod}: tamamlanan başlangıç kilometre taşı için fiili başlangıç gerekli`); af = null; }
    else if (tur === 'TT_FinMile') { if (!af) throw new MrhHata(`${kod}: tamamlanan bitiş kilometre taşı için fiili bitiş gerekli`); as = null; }
    else {
      if (!as || !af) throw new MrhHata(`${kod}: tamamlanan aktivite için fiili başlangıç ve fiili bitiş gerekli`);
      if (String(af) < String(as)) throw new MrhHata(`${kod}: fiili bitiş, fiili başlangıçtan önce olamaz`);
    }
    rdH = 0;
    if (pt === 'CP_Phys' && !varMi('pct')) y.phys_complete_pct = 100;
  }

  const dd = veriTarihiAl(p6, t.proj_id);
  if (dd) {
    if (as && String(as).slice(0, 16) > dd) uyarilar.push(`${kod}: fiili başlangıç veri tarihinden (${dd}) sonra`);
    if (af && String(af).slice(0, 16) > dd) uyarilar.push(`${kod}: fiili bitiş veri tarihinden (${dd}) sonra`);
  }

  y.status_code = st;
  y.act_start_date = as;
  y.act_end_date = af;
  y.target_drtn_hr_cnt = Math.round(odH * 1000) / 1000;
  y.remain_drtn_hr_cnt = Math.round(rdH * 1000) / 1000;
  // Baslamamis aktivitede plan tarihleri bos kalmasin
  return k.guncelle('TASK', t.task_id, y);
}

function topluGuncelle(p6, k, idler, yama) {
  if (!Array.isArray(idler) || !idler.length) throw new MrhHata('Aktivite seçilmedi');
  if (idler.length > 20000) throw new MrhHata('Tek seferde en fazla 20.000 aktivite');
  const uyarilar = [];
  let degisen = 0;
  for (const id of idler) {
    try { if (aktiviteGuncelle(p6, k, id, yama, uyarilar)) degisen++; }
    catch (e) { if (e instanceof MrhHata && idler.length > 1) e.message = 'İşlem geri alındı - ' + e.message; throw e; }
  }
  return { degisen, uyarilar: uyarilar.slice(0, 50), uyariSayisi: uyarilar.length };
}

function sonrakiKod(p6, projId) {
  const kodlar = p6.hepsi(`SELECT task_code c FROM ${p6.ad('TASK')} WHERE proj_id=?${p6.canli('TASK')}`, projId).map(r => String(r.c));
  const gruplar = new Map();
  for (const c of kodlar) {
    const m = c.match(/^(.*?)(\d+)$/);
    if (!m) continue;
    const g = gruplar.get(m[1]) || { adet: 0, max: 0, uzunluk: m[2].length };
    g.adet++; g.max = Math.max(g.max, Number(m[2])); g.uzunluk = Math.max(g.uzunluk, m[2].length);
    gruplar.set(m[1], g);
  }
  let onek = 'A', g = { adet: 0, max: 990, uzunluk: 4 };
  for (const [o, x] of gruplar) if (x.adet > g.adet) { onek = o; g = x; }
  const set = new Set(kodlar);
  let n = Math.floor(g.max / 10) * 10 + 10;
  let kod;
  do { kod = onek + String(n).padStart(g.uzunluk, '0'); n += 10; } while (set.has(kod));
  return kod;
}

const gunEkle = (metin, gun) => {
  const d = new Date(metin.replace(' ', 'T') + 'Z');
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.ceil(gun)));
  return d.toISOString().slice(0, 10) + ' ' + metin.slice(11, 16) + ':00';
};

/** Sablondan satir: kaynak satirin tum kolonlarini alir, kimlik/tarih/miktar alanlarini sifirlar. */
function sablondanSatir(p6, tablo, kaynak, ayar) {
  const s = {};
  for (const [ad, c] of p6.kolonlar(tablo)) {
    let v = kaynak ? kaynak[ad] : undefined;
    if (ad === 'guid') v = yeniGuid();
    else if (/_date$/.test(ad) || /_date\d?$/.test(ad)) v = c.notnull ? p6.tarih(simdiMetin()) : null;
    else if (/(_qty|_cost|_cnt)$/.test(ad) && typeof v === 'number') v = 0;
    else if (ad === 'delete_session_id') v = null;
    if (v !== undefined) s[ad] = v;
  }
  if (p6.kol(tablo, 'create_user')) s.create_user = 'mrh';
  if (p6.kol(tablo, 'update_user')) s.update_user = 'mrh';
  for (const [a, v] of Object.entries(ayar)) {
    if (!p6.kol(tablo, a)) continue;
    if (v == null && p6.kolonlar(tablo).get(a).notnull) continue; // zorunlu kolonda sablon degeri kalir
    s[a] = v;
  }
  return s;
}

function aktiviteEkle(p6, k, a) {
  const projId = Number(a.proje);
  const proje = p6.bir(`SELECT * FROM ${p6.ad('PROJECT')} WHERE proj_id=?`, projId);
  if (!proje) throw new MrhHata('Proje bulunamadı');
  let wbsId = a.wbs != null && a.wbs !== '' ? Number(a.wbs) : null;
  if (wbsId == null) {
    const kok = p6.bir(`SELECT wbs_id FROM ${p6.ad('PROJWBS')} WHERE proj_id=?${p6.kol('PROJWBS', 'proj_node_flag') ? " AND proj_node_flag='Y'" : ''}${p6.canli('PROJWBS')}`, projId);
    if (!kok) throw new MrhHata('Projenin kök WBS düğümü bulunamadı');
    wbsId = kok.wbs_id;
  } else if (!p6.bir(`SELECT 1 x FROM ${p6.ad('PROJWBS')} WHERE wbs_id=? AND proj_id=?`, wbsId, projId)) {
    throw new MrhHata('WBS bu projeye ait değil');
  }
  const ad = String(a.ad ?? '').trim();
  if (!ad) throw new MrhHata('Aktivite adı gerekli');
  let kod = String(a.kod ?? '').trim() || sonrakiKod(p6, projId);
  if (p6.bir(`SELECT 1 x FROM ${p6.ad('TASK')} WHERE proj_id=? AND task_code=?${p6.canli('TASK')}`, projId, kod)) throw new MrhHata(`"${kod}" kodu zaten var`);
  const tur = a.tur ? secenek(SECENEK.tur, a.tur, 'Aktivite türü') : 'TT_Task';

  const sablon = p6.bir(`SELECT * FROM ${p6.ad('TASK')} WHERE proj_id=?${p6.canli('TASK')} ORDER BY (wbs_id=?) DESC, task_id DESC LIMIT 1`, projId, wbsId);
  const clndr = a.cal != null && a.cal !== '' ? Number(a.cal) : (sablon?.clndr_id ?? proje.clndr_id ?? null);
  const gs = p6.gunSaat(clndr);
  const odGun = SURE_SIFIR.has(tur) ? 0 : sayi(a.od ?? 5, 'Orijinal süre');
  if (odGun < 0) throw new MrhHata('Süre negatif olamaz');
  const bas = (veriTarihiAl(p6, projId) || String(proje.plan_start_date || simdiMetin()).slice(0, 16)).slice(0, 10) + ' 08:00:00';
  const bit = gunEkle(bas, odGun * 7 / 5).slice(0, 11) + '17:00:00';
  const id = p6.yeniId('TASK', 'task_id');
  const tarihler = {};
  for (const c of ['early_start_date', 'late_start_date', 'target_start_date', 'restart_date']) tarihler[c] = p6.tarih(bas);
  for (const c of ['early_end_date', 'late_end_date', 'target_end_date', 'reend_date']) tarihler[c] = p6.tarih(bit);

  const satir = sablondanSatir(p6, 'TASK', sablon, {
    task_id: id, proj_id: projId, wbs_id: wbsId, clndr_id: clndr, task_code: kod, task_name: ad, task_type: tur,
    status_code: 'TK_NotStart', phys_complete_pct: 0, target_drtn_hr_cnt: odGun * gs, remain_drtn_hr_cnt: odGun * gs,
    act_start_date: null, act_end_date: null, cstr_type: null, cstr_date: null, cstr_type2: null, cstr_date2: null,
    total_float_hr_cnt: null, free_float_hr_cnt: null, driving_path_flag: 'N',
    duration_type: sablon?.duration_type || 'DT_FixedDUR2', complete_pct_type: sablon?.complete_pct_type || 'CP_Drtn',
    create_date: p6.tarih(simdiMetin()), update_date: p6.tarih(simdiMetin()), ...tarihler
  });
  k.ekle('TASK', satir);
  if (a.oncul) iliskiEkle(p6, k, { oncul: a.oncul, ardil: id, tur: 'PR_FS', gecikme: 0 });
  if (a.ardil) iliskiEkle(p6, k, { oncul: id, ardil: a.ardil, tur: 'PR_FS', gecikme: 0 });
  return { id, kod };
}

const BAGLI_TABLOLAR = ['TASKPRED', 'TASKRSRC', 'TASKACTV', 'TASKMEMO', 'TASKPROC', 'TASKFIN', 'TRSRCFIN', 'TASKDOC', 'TASKNOTE', 'PROJCOST'];

function aktiviteSil(p6, k, idler) {
  if (!Array.isArray(idler) || !idler.length) throw new MrhHata('Aktivite seçilmedi');
  let silinen = 0, bagli = 0;
  const udf = p6.var('UDFVALUE') && p6.var('UDFTYPE') && p6.kol('UDFTYPE', 'table_name');
  for (const ham of idler) {
    const t = gorev(p6, ham);
    for (const tb of BAGLI_TABLOLAR) if (p6.kol(tb, 'task_id')) bagli += k.silNerede(tb, 'task_id=?', [t.task_id]);
    if (p6.kol('TASKPRED', 'pred_task_id')) bagli += k.silNerede('TASKPRED', 'pred_task_id=?', [t.task_id]);
    if (udf) bagli += k.silNerede('UDFVALUE', `fk_id=? AND udf_type_id IN (SELECT udf_type_id FROM ${p6.ad('UDFTYPE')} WHERE table_name='TASK')`, [t.task_id]);
    silinen += k.silNerede('TASK', 'task_id=?', [t.task_id]);
  }
  return { silinen, bagli };
}

// ---------- iliskiler ----------
function dongu(p6, onculId, ardilId) {
  // ardil'dan ileri giderek oncul'e ulasiliyor mu?
  const kom = new Map();
  for (const r of p6.hepsi(`SELECT task_id s, pred_task_id p FROM ${p6.ad('TASKPRED')} WHERE 1=1${p6.canli('TASKPRED')}`)) {
    if (!kom.has(r.p)) kom.set(r.p, []);
    kom.get(r.p).push(r.s);
  }
  const gorulen = new Set([ardilId]);
  const yigin = [ardilId];
  while (yigin.length) {
    const x = yigin.pop();
    if (x === onculId) return true;
    for (const y of kom.get(x) || []) if (!gorulen.has(y)) { gorulen.add(y); yigin.push(y); }
  }
  return false;
}

function iliskiEkle(p6, k, a) {
  const o = gorev(p6, a.oncul), s = gorev(p6, a.ardil);
  if (o.task_id === s.task_id) throw new MrhHata('Bir aktivite kendisine bağlanamaz');
  const tur = secenek(SECENEK.iliski, a.tur || 'PR_FS', 'İlişki türü');
  const gec = a.gecikme === '' || a.gecikme == null ? 0 : sayi(a.gecikme, 'Gecikme');
  const ayni = p6.hepsi(`SELECT pred_type t FROM ${p6.ad('TASKPRED')} WHERE task_id=? AND pred_task_id=?${p6.canli('TASKPRED')}`, s.task_id, o.task_id);
  if (ayni.some(r => r.t === tur)) throw new MrhHata(`${o.task_code} -> ${s.task_code} (${tur.slice(3)}) ilişkisi zaten var`);
  if (dongu(p6, o.task_id, s.task_id)) throw new MrhHata(`${o.task_code} -> ${s.task_code} bağlantısı döngü oluşturur (${s.task_code} zaten ${o.task_code} öncesine bağlı)`);
  const id = p6.yeniId('TASKPRED', 'task_pred_id');
  k.ekle('TASKPRED', {
    task_pred_id: id, task_id: s.task_id, pred_task_id: o.task_id, proj_id: s.proj_id, pred_proj_id: o.proj_id,
    pred_type: tur, lag_hr_cnt: gec * p6.gunSaat(s.clndr_id)
  });
  return { id };
}

function iliskiGuncelle(p6, k, a) {
  const r = p6.bir(`SELECT * FROM ${p6.ad('TASKPRED')} WHERE task_pred_id=?`, Number(a.id));
  if (!r) throw new MrhHata('İlişki bulunamadı', 404);
  const s = gorev(p6, r.task_id);
  const y = {};
  if (a.tur != null) y.pred_type = secenek(SECENEK.iliski, a.tur, 'İlişki türü');
  if (a.gecikme != null && a.gecikme !== '') y.lag_hr_cnt = sayi(a.gecikme, 'Gecikme') * p6.gunSaat(s.clndr_id);
  if (y.pred_type && y.pred_type !== r.pred_type) {
    const ayni = p6.bir(`SELECT 1 x FROM ${p6.ad('TASKPRED')} WHERE task_id=? AND pred_task_id=? AND pred_type=? AND task_pred_id<>?`, r.task_id, r.pred_task_id, y.pred_type, r.task_pred_id);
    if (ayni) throw new MrhHata('Aynı türde ilişki zaten var');
  }
  return k.guncelle('TASKPRED', r.task_pred_id, y);
}

function iliskiSil(p6, k, idler) {
  let n = 0;
  for (const id of idler || []) n += k.silNerede('TASKPRED', 'task_pred_id=?', [Number(id)]);
  if (!n) throw new MrhHata('Silinecek ilişki bulunamadı');
  return { silinen: n };
}

// ---------- WBS ----------
function wbsEkle(p6, k, a) {
  const projId = Number(a.proje);
  const W = p6.ad('PROJWBS');
  const ust = a.ust ? p6.bir(`SELECT * FROM ${W} WHERE wbs_id=? AND proj_id=?`, Number(a.ust), projId)
    : p6.bir(`SELECT * FROM ${W} WHERE proj_id=?${p6.kol('PROJWBS', 'proj_node_flag') ? " AND proj_node_flag='Y'" : ''}`, projId);
  if (!ust) throw new MrhHata('Üst WBS bulunamadı');
  const kod = String(a.kod ?? '').trim(), ad = String(a.ad ?? '').trim();
  if (!kod || !ad) throw new MrhHata('WBS kodu ve adı gerekli');
  if (p6.bir(`SELECT 1 x FROM ${W} WHERE parent_wbs_id=? AND wbs_short_name=?${p6.canli('PROJWBS')}`, ust.wbs_id, kod)) throw new MrhHata(`Bu seviyede "${kod}" kodu zaten var`);
  const sablon = p6.bir(`SELECT * FROM ${W} WHERE proj_id=?${p6.kol('PROJWBS', 'proj_node_flag') ? " ORDER BY proj_node_flag='N' DESC" : ''} LIMIT 1`, projId);
  const sira = p6.kol('PROJWBS', 'seq_num') ? (p6.bir(`SELECT MAX(seq_num) m FROM ${W} WHERE parent_wbs_id=?`, ust.wbs_id).m || 0) + 10 : undefined;
  const id = p6.yeniId('PROJWBS', 'wbs_id');
  k.ekle('PROJWBS', sablondanSatir(p6, 'PROJWBS', sablon, {
    wbs_id: id, proj_id: projId, parent_wbs_id: ust.wbs_id, wbs_short_name: kod, wbs_name: ad, proj_node_flag: 'N', seq_num: sira,
    create_date: p6.tarih(simdiMetin()), update_date: p6.tarih(simdiMetin())
  }));
  return { id };
}

function wbsGuncelle(p6, k, a) {
  const r = p6.bir(`SELECT * FROM ${p6.ad('PROJWBS')} WHERE wbs_id=?`, Number(a.id));
  if (!r) throw new MrhHata('WBS bulunamadı', 404);
  const y = {};
  if (a.ad != null) { const s = String(a.ad).trim(); if (!s) throw new MrhHata('WBS adı boş olamaz'); y.wbs_name = s; }
  if (a.kod != null) {
    if (r.proj_node_flag === 'Y') throw new MrhHata('Kök WBS kodu proje kimliğidir; P6 içinden değiştirin');
    const s = String(a.kod).trim();
    if (!s) throw new MrhHata('WBS kodu boş olamaz');
    if (p6.bir(`SELECT 1 x FROM ${p6.ad('PROJWBS')} WHERE parent_wbs_id=? AND wbs_short_name=? AND wbs_id<>?${p6.canli('PROJWBS')}`, r.parent_wbs_id, s, r.wbs_id)) throw new MrhHata('Bu seviyede aynı kod var');
    y.wbs_short_name = s;
  }
  return k.guncelle('PROJWBS', r.wbs_id, y);
}

function wbsSil(p6, k, a) {
  const r = p6.bir(`SELECT * FROM ${p6.ad('PROJWBS')} WHERE wbs_id=?`, Number(a.id));
  if (!r) throw new MrhHata('WBS bulunamadı', 404);
  if (r.proj_node_flag === 'Y') throw new MrhHata('Kök WBS silinemez');
  const alt = p6.bir(`SELECT COUNT(*) n FROM ${p6.ad('PROJWBS')} WHERE parent_wbs_id=?${p6.canli('PROJWBS')}`, r.wbs_id).n;
  const akt = p6.bir(`SELECT COUNT(*) n FROM ${p6.ad('TASK')} WHERE wbs_id=?${p6.canli('TASK')}`, r.wbs_id).n;
  if (alt || akt) throw new MrhHata(`WBS boş değil (${alt} alt WBS, ${akt} aktivite). Önce içeriğini taşıyın ya da silin.`);
  return { silinen: k.silNerede('PROJWBS', 'wbs_id=?', [r.wbs_id]) };
}

function veriTarihiAyarla(p6, k, a) {
  if (!p6.kol('PROJECT', 'last_recalc_date')) throw new MrhHata('Bu veritabaninda veri tarihi kolonu yok');
  const r = p6.bir(`SELECT last_recalc_date d FROM ${p6.ad('PROJECT')} WHERE proj_id=?`, Number(a.proje));
  if (!r) throw new MrhHata('Proje bulunamadı');
  const saat = r.d ? String(r.d).slice(11, 16) : '08:00';
  return k.guncelle('PROJECT', Number(a.proje), { last_recalc_date: p6.tarih(tarihGir(a.tarih, saat || '08:00', 'Veri tarihi')) });
}

/** Kayitli bir islemi tersine uygular; araya giren degisiklikleri yakalar. */
function geriAl(p6, k, kayit, zorla = false) {
  const atla = new Set(['update_date', 'update_user']);
  for (const d of [...kayit.degisiklik].reverse()) {
    if (d.once && d.sonra) {
      const simdi = k.satir(d.t, d.pk, d.v);
      if (!simdi) throw new MrhHata(`Geri alınamıyor: ${d.t} ${d.v} kaydı artık yok`, 409);
      if (!zorla) for (const c of Object.keys(d.sonra)) {
        if (!atla.has(c) && !esit(simdi[c], d.sonra[c])) throw new MrhHata(`Çakışma: ${d.t} #${d.v} kaydının "${c}" alanı bu işlemden sonra başka yerde değiştirilmiş. Zorla geri almak mevcut degisikligin üzerine yazar.`, 409);
      }
      k.guncelle(d.t, d.v, d.once, { iz: false });
    } else if (d.sonra) {
      if (d.pk) k.silNerede(d.t, `${d.pk}=?`, [d.v]);
    } else if (d.once) {
      if (d.pk && k.satir(d.t, d.pk, d.v)) throw new MrhHata(`Geri alınamıyor: ${d.t} #${d.v} zaten mevcut`, 409);
      k.ekle(d.t, d.once, { doldur: false });
    }
  }
  return { geriAlinan: kayit.degisiklik.length };
}

module.exports = {
  aktiviteGuncelle, topluGuncelle, aktiviteEkle, aktiviteSil, sonrakiKod,
  iliskiEkle, iliskiGuncelle, iliskiSil, wbsEkle, wbsGuncelle, wbsSil, veriTarihiAyarla, geriAl
};
