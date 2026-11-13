'use strict';
/*
 * MRH P6 Studio - sentetik demo veritabani ureticisi
 * P6 Professional SQLite semasina benzer tablolarla tamamen uydurma bir
 * endustriyel tesis projesi uretir (gercek bir projeye ait veri icermez).
 * Kullanim: node araclar/dgn-demo-olustur.js [cikti.db]
 * (c) Merih Dogan
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const CIKTI = path.resolve(process.argv[2] || path.join(__dirname, '..', 'ornek', 'mrh-demo.db'));
fs.mkdirSync(path.dirname(CIKTI), { recursive: true });
for (const ek of ['', '-journal', '-wal', '-shm']) fs.rmSync(CIKTI + ek, { force: true });

const db = new DatabaseSync(CIKTI);
const sil = 'delete_session_id INTEGER, delete_date TEXT';
const iz = 'create_date TEXT, create_user TEXT, update_date TEXT, update_user TEXT';
db.exec(`
CREATE TABLE NEXTKEY (key_name TEXT PRIMARY KEY, key_seq_num INTEGER NOT NULL);
CREATE TABLE CALENDAR (clndr_id INTEGER PRIMARY KEY, clndr_name TEXT NOT NULL, default_flag TEXT NOT NULL DEFAULT 'N', proj_id INTEGER,
  base_clndr_id INTEGER, clndr_type TEXT NOT NULL, day_hr_cnt REAL, week_hr_cnt REAL, clndr_data TEXT, guid TEXT, ${iz}, ${sil});
CREATE TABLE PROJECT (proj_id INTEGER PRIMARY KEY, proj_short_name TEXT NOT NULL, clndr_id INTEGER, last_recalc_date TEXT,
  plan_start_date TEXT, plan_end_date TEXT, scd_end_date TEXT, sum_base_proj_id INTEGER, orig_proj_id INTEGER,
  project_flag TEXT NOT NULL DEFAULT 'Y', status_code TEXT, def_duration_type TEXT, guid TEXT NOT NULL, ${iz}, ${sil});
CREATE TABLE PROJWBS (wbs_id INTEGER PRIMARY KEY, proj_id INTEGER NOT NULL, parent_wbs_id INTEGER, wbs_short_name TEXT NOT NULL,
  wbs_name TEXT NOT NULL, seq_num INTEGER NOT NULL, proj_node_flag TEXT NOT NULL, status_code TEXT NOT NULL, obs_id INTEGER NOT NULL,
  guid TEXT NOT NULL, ${iz}, ${sil});
CREATE TABLE TASK (task_id INTEGER PRIMARY KEY, proj_id INTEGER NOT NULL, wbs_id INTEGER NOT NULL, clndr_id INTEGER NOT NULL,
  task_code TEXT NOT NULL, task_name TEXT, task_type TEXT NOT NULL, status_code TEXT NOT NULL, duration_type TEXT NOT NULL,
  complete_pct_type TEXT NOT NULL, phys_complete_pct REAL NOT NULL, priority_type TEXT NOT NULL, target_drtn_hr_cnt REAL NOT NULL,
  remain_drtn_hr_cnt REAL, act_start_date TEXT, act_end_date TEXT, early_start_date TEXT, early_end_date TEXT, late_start_date TEXT,
  late_end_date TEXT, target_start_date TEXT NOT NULL, target_end_date TEXT NOT NULL, restart_date TEXT, reend_date TEXT,
  total_float_hr_cnt REAL, free_float_hr_cnt REAL, driving_path_flag TEXT, cstr_type TEXT, cstr_date TEXT, cstr_type2 TEXT,
  cstr_date2 TEXT, float_path INTEGER, act_work_qty REAL NOT NULL DEFAULT 0, remain_work_qty REAL NOT NULL DEFAULT 0,
  target_work_qty REAL NOT NULL DEFAULT 0, rev_fdbk_flag TEXT NOT NULL DEFAULT 'N', location_id INTEGER, guid TEXT NOT NULL, ${iz}, ${sil});
CREATE TABLE TASKPRED (task_pred_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, pred_task_id INTEGER NOT NULL, proj_id INTEGER NOT NULL,
  pred_proj_id INTEGER NOT NULL, pred_type TEXT NOT NULL, lag_hr_cnt REAL NOT NULL, comments TEXT, float_path INTEGER, aref TEXT, arls TEXT,
  ${iz}, ${sil});
CREATE TABLE RSRC (rsrc_id INTEGER PRIMARY KEY, rsrc_short_name TEXT NOT NULL, rsrc_name TEXT NOT NULL, rsrc_type TEXT NOT NULL,
  unit_id INTEGER, clndr_id INTEGER, parent_rsrc_id INTEGER, active_flag TEXT NOT NULL DEFAULT 'Y', guid TEXT, ${iz}, ${sil});
CREATE TABLE TASKRSRC (taskrsrc_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, proj_id INTEGER NOT NULL, rsrc_id INTEGER NOT NULL,
  target_qty REAL, act_reg_qty REAL, act_ot_qty REAL, remain_qty REAL, target_cost REAL, act_reg_cost REAL, remain_cost REAL, guid TEXT, ${iz}, ${sil});
CREATE TABLE ACTVTYPE (actv_code_type_id INTEGER PRIMARY KEY, actv_code_type TEXT NOT NULL, proj_id INTEGER, actv_short_len INTEGER, seq_num INTEGER, ${sil});
CREATE TABLE ACTVCODE (actv_code_id INTEGER PRIMARY KEY, actv_code_type_id INTEGER NOT NULL, parent_actv_code_id INTEGER, short_name TEXT NOT NULL,
  actv_code_name TEXT, seq_num INTEGER, color TEXT, ${sil});
CREATE TABLE TASKACTV (task_id INTEGER NOT NULL, actv_code_type_id INTEGER NOT NULL, actv_code_id INTEGER NOT NULL, proj_id INTEGER NOT NULL, ${sil});
CREATE TABLE UDFTYPE (udf_type_id INTEGER PRIMARY KEY, table_name TEXT NOT NULL, udf_type_name TEXT, udf_type_label TEXT, logical_data_type TEXT, ${sil});
CREATE TABLE UDFVALUE (udf_type_id INTEGER NOT NULL, fk_id INTEGER NOT NULL, proj_id INTEGER, udf_date TEXT, udf_number REAL, udf_text TEXT, udf_code_id INTEGER, ${sil});
CREATE TABLE MEMOTYPE (memo_type_id INTEGER PRIMARY KEY, memo_type TEXT NOT NULL);
CREATE TABLE TASKMEMO (memo_id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, memo_type_id INTEGER NOT NULL, proj_id INTEGER NOT NULL, task_memo TEXT, ${sil});
`);

// ---------- yardimcilar ----------
let tohum = 20261113;
const rnd = () => { tohum = (tohum * 1103515245 + 12345) & 0x7fffffff; return tohum / 0x7fffffff; };
const guid = () => crypto.randomBytes(16).toString('base64').replace(/=+$/, '');
const iki = n => String(n).padStart(2, '0');
const BASLANGIC = new Date(Date.UTC(2026, 2, 2)); // 2 Mart 2026 Pazartesi
function isGunuTarih(i) {
  const d = new Date(BASLANGIC);
  let n = 0;
  while (n < i) { d.setUTCDate(d.getUTCDate() + 1); const g = d.getUTCDay(); if (g !== 0 && g !== 6) n++; }
  return d;
}
const tm = (d, saat) => `${d.getUTCFullYear()}-${iki(d.getUTCMonth() + 1)}-${iki(d.getUTCDate())} ${saat}`;
const basT = i => tm(isGunuTarih(i), '08:00:00');
const bitT = i => tm(isGunuTarih(i), '17:00:00');
const SIMDI = '2026-11-13 09:00:00';

// ---------- takvimler ----------
const ins = (t, o) => { const k = Object.keys(o); db.prepare(`INSERT INTO ${t} (${k.join(',')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map(x => o[x] ?? null)); };
ins('CALENDAR', { clndr_id: 1, clndr_name: 'MRH Standart 5x8', default_flag: 'Y', clndr_type: 'CA_Base', day_hr_cnt: 8, week_hr_cnt: 40, clndr_data: '(0||CalendarData()())', guid: guid() });
ins('CALENDAR', { clndr_id: 2, clndr_name: 'MRH Saha 6x10', default_flag: 'N', clndr_type: 'CA_Base', day_hr_cnt: 10, week_hr_cnt: 60, clndr_data: '(0||CalendarData()())', guid: guid() });
ins('CALENDAR', { clndr_id: 3, clndr_name: 'MRH Kesintisiz 7x24', default_flag: 'N', clndr_type: 'CA_Base', day_hr_cnt: 24, week_hr_cnt: 168, clndr_data: '(0||CalendarData()())', guid: guid() });

// ---------- WBS ve aktivite plani ----------
const WBS = [
  ['PY', 'Proje Yönetimi', null], ['MUH', 'Mühendislik', null], ['MUH.PRS', 'Proses Mühendisliği', 'MUH'], ['MUH.MEK', 'Mekanik Mühendislik', 'MUH'],
  ['MUH.ELK', 'Elektrik Mühendisliği', 'MUH'], ['TED', 'Tedarik', null], ['INS', 'İnşaat', null], ['INS.SH', 'Saha Hazırlık', 'INS'],
  ['INS.TML', 'Temeller', 'INS'], ['INS.CLK', 'Çelik Yapı', 'INS'], ['MEK', 'Mekanik Montaj', null], ['MEK.EKP', 'Ekipman Montajı', 'MEK'],
  ['MEK.BRU', 'Boru Montajı', 'MEK'], ['EIE', 'Elektrik ve Enstrümantasyon', null], ['DVR', 'Devreye Alma', null]
];
// [kod, ad, wbs, sure(isgunu), tur, onculler[[kod, tip, gecikme]]]
const A = [];
const a = (kod, ad, wbs, sure, onc = [], tur = 'TT_Task') => A.push({ kod, ad, wbs, sure, onc, tur });
a('M1000', 'Proje başlangıcı', 'PY', 0, [], 'TT_Mile');
a('M1010', 'Sözleşme imzası', 'PY', 0, [['M1000', 'FS', 0]], 'TT_Mile');
a('A1020', 'Proje yönetim planı', 'PY', 15, [['M1010', 'FS', 0]]);
a('A1030', 'Kalite ve İSG planı', 'PY', 10, [['A1020', 'SS', 5]]);
a('A1040', 'Proje yönetimi ve raporlama', 'PY', 260, [['M1010', 'FS', 0]], 'TT_LOE');
a('A2000', 'Proses tasarım kriterleri', 'MUH.PRS', 12, [['M1010', 'FS', 0]]);
a('A2010', 'Proses akış diyagramları (PFD)', 'MUH.PRS', 18, [['A2000', 'FS', 0]]);
a('A2020', 'P&ID revizyon A', 'MUH.PRS', 25, [['A2010', 'FS', 0]]);
a('A2030', 'P&ID onay (IFC)', 'MUH.PRS', 15, [['A2020', 'FS', 5]]);
a('A2040', 'HAZOP çalışması', 'MUH.PRS', 8, [['A2020', 'FS', 0]]);
a('A2100', 'Ekipman yerleşim planı', 'MUH.MEK', 15, [['A2010', 'SS', 10]]);
a('A2110', 'Ekipman veri sayfaları', 'MUH.MEK', 20, [['A2010', 'FS', 0]]);
a('A2120', 'Boru güzergah 3B modeli', 'MUH.MEK', 35, [['A2100', 'FS', 0], ['A2020', 'FS', 0]]);
a('A2130', 'Izometrik çizimler', 'MUH.MEK', 30, [['A2120', 'SS', 15]]);
a('A2140', 'Çelik yapı tasarımı', 'MUH.MEK', 25, [['A2100', 'FS', 0]]);
a('A2150', 'Temel tasarımı', 'MUH.MEK', 20, [['A2100', 'FS', 0]]);
a('A2200', 'Yük listesi', 'MUH.ELK', 10, [['A2110', 'FS', 0]]);
a('A2210', 'Tek hat şemaları', 'MUH.ELK', 15, [['A2200', 'FS', 0]]);
a('A2220', 'Kablo güzergah ve listeleri', 'MUH.ELK', 20, [['A2210', 'FS', 0], ['A2120', 'SS', 10]]);
a('A2230', 'Enstrüman indeksi ve loop diyagramları', 'MUH.ELK', 25, [['A2030', 'FS', 0]]);
a('M2900', 'Mühendislik tamamlandı', 'MUH', 0, [['A2130', 'FS', 0], ['A2220', 'FS', 0], ['A2230', 'FS', 0], ['A2040', 'FS', 0]], 'TT_FinMile');
const TED = [['A3000', 'Pompalar', 'A2110', 65], ['A3010', 'Basınçlı kaplar', 'A2110', 90], ['A3020', 'Isı eşanjörleri', 'A2110', 80],
  ['A3030', 'Kompresör paketi', 'A2110', 120], ['A3040', 'Boru ve fitingler', 'A2130', 45], ['A3050', 'Vanalar', 'A2030', 60],
  ['A3060', 'Yapısal çelik', 'A2140', 40], ['A3070', 'Elektrik panoları', 'A2210', 75], ['A3080', 'Kablolar', 'A2220', 35],
  ['A3090', 'Saha enstrümanları', 'A2230', 55]];
for (const [k, ad, onc, s] of TED) a(k, ad + ' - satın alma ve teslimat', 'TED', s, [[onc, 'FS', 0]]);
a('A4000', 'Saha mobilizasyonu', 'INS.SH', 10, [['M1010', 'FS', 20]]);
a('A4010', 'Hafriyat ve tesviye', 'INS.SH', 20, [['A4000', 'FS', 0]]);
a('A4020', 'Yeraltı drenaj ve topraklama', 'INS.SH', 15, [['A4010', 'SS', 10]]);
a('A4100', 'Ekipman temelleri', 'INS.TML', 30, [['A4010', 'FS', 0], ['A2150', 'FS', 0]]);
a('A4110', 'Çelik yapı temelleri', 'INS.TML', 20, [['A4010', 'FS', 0], ['A2150', 'FS', 0]]);
a('A4120', 'Kompresör blok temeli', 'INS.TML', 25, [['A4100', 'SS', 10]]);
a('A4200', 'Çelik yapı montajı - Kısım 1', 'INS.CLK', 25, [['A4110', 'FS', 0], ['A3060', 'FS', 0]]);
a('A4210', 'Çelik yapı montajı - Kısım 2', 'INS.CLK', 25, [['A4200', 'SS', 15]]);
a('A4220', 'Platform ve merdivenler', 'INS.CLK', 15, [['A4210', 'FF', 5]]);
a('A5000', 'Pompa montajı', 'MEK.EKP', 12, [['A4100', 'FS', 0], ['A3000', 'FS', 0]]);
a('A5010', 'Basınçlı kap montajı', 'MEK.EKP', 15, [['A4100', 'FS', 0], ['A3010', 'FS', 0]]);
a('A5020', 'Eşanjör montajı', 'MEK.EKP', 10, [['A4100', 'FS', 0], ['A3020', 'FS', 0]]);
a('A5030', 'Kompresör montajı ve hizalama', 'MEK.EKP', 25, [['A4120', 'FS', 0], ['A3030', 'FS', 0]]);
a('A5100', 'Boru prefabrikasyonu', 'MEK.BRU', 45, [['A3040', 'FS', 0], ['A2130', 'FS', 0]]);
a('A5110', 'Boru montajı - rack', 'MEK.BRU', 40, [['A5100', 'SS', 15], ['A4220', 'FS', 0]]);
a('A5120', 'Boru montajı - ekipman bağlantıları', 'MEK.BRU', 35, [['A5110', 'SS', 20], ['A5010', 'FS', 0], ['A5000', 'FS', 0], ['A3050', 'FS', 0]]);
a('A5130', 'Hidrostatik testler', 'MEK.BRU', 20, [['A5120', 'FF', 10]]);
a('A5140', 'İzolasyon ve boya', 'MEK.BRU', 25, [['A5130', 'SS', 10]]);
a('A6000', 'Kablo tavaları', 'EIE', 25, [['A4220', 'SS', 5]]);
a('A6010', 'Pano montajı', 'EIE', 10, [['A3070', 'FS', 0], ['A4100', 'FS', 0]]);
a('A6020', 'Kablo çekimi', 'EIE', 30, [['A6000', 'SS', 10], ['A3080', 'FS', 0]]);
a('A6030', 'Kablo bağlantıları ve megger', 'EIE', 20, [['A6020', 'SS', 15], ['A6010', 'FS', 0]]);
a('A6040', 'Enstrüman montajı', 'EIE', 20, [['A3090', 'FS', 0], ['A5120', 'SS', 10]]);
a('A6050', 'Loop testleri', 'EIE', 15, [['A6040', 'FS', 0], ['A6030', 'FS', 0]]);
a('M6900', 'Mekanik tamamlanma', 'MEK', 0, [['A5140', 'FS', 0], ['A6050', 'FS', 0], ['A5030', 'FS', 0], ['A5020', 'FS', 0]], 'TT_FinMile');
a('A7000', 'Ön devreye alma kontrolleri', 'DVR', 15, [['M6900', 'FS', 0]]);
a('A7010', 'Motor rotasyon ve kuru testler', 'DVR', 10, [['A7000', 'SS', 5]]);
a('A7020', 'Yıkama ve kurutma', 'DVR', 12, [['A7000', 'FS', 0]]);
a('A7030', 'Islak devreye alma', 'DVR', 15, [['A7020', 'FS', 0], ['A7010', 'FS', 0]]);
a('A7040', 'Performans testi', 'DVR', 10, [['A7030', 'FS', 3]]);
a('A7050', 'Eğitim ve dokümantasyon teslimi', 'DVR', 10, [['A7030', 'SS', 0]]);
a('M7900', 'Geçici kabul', 'DVR', 0, [['A7040', 'FS', 0], ['A7050', 'FS', 0]], 'TT_FinMile');
// Kasitli kalite sorunlari (Plan Sagligi ekranini gostermek icin)
a('A6060', 'Yangın algılama sistemi montajı', 'EIE', 18, [['A6020', 'FS', -3]]); // negatif gecikme, ardilsiz
a('A1050', 'İşletme ruhsatı başvurusu ve takibi', 'PY', 25, [['A7000', 'SS', 0]]); // uzun sure, ardilsiz

// ---------- CPM ----------
function cpm(liste, gecikmeEk = {}) {
  const m = new Map(liste.map(x => [x.kod, { ...x, sure: x.sure + (gecikmeEk[x.kod] || 0) }]));
  const sira = liste.map(x => m.get(x.kod));
  for (const t of sira) {
    let es = 0;
    for (const [p, tip, lag] of t.onc) {
      const o = m.get(p);
      if (tip === 'FS') es = Math.max(es, o.ef + lag);
      else if (tip === 'SS') es = Math.max(es, o.es + lag);
      else if (tip === 'FF') es = Math.max(es, o.ef + lag - t.sure);
    }
    t.es = es; t.ef = es + t.sure; // ef: ilk bos isgunu (dahil degil)
  }
  const bitis = Math.max(...sira.filter(t => t.tur !== 'TT_LOE').map(t => t.ef));
  for (const t of sira) { t.lf = bitis; }
  for (const t of [...sira].reverse()) {
    if (t.tur === 'TT_LOE') { t.lf = t.ef; t.ls = t.es; continue; }
    t.ls = t.lf - t.sure;
    for (const [p, tip, lag] of t.onc) {
      const o = m.get(p);
      if (tip === 'FS') o.lf = Math.min(o.lf, t.ls - lag);
      else if (tip === 'SS') o.lf = Math.min(o.lf, t.ls - lag + o.sure);
      else if (tip === 'FF') o.lf = Math.min(o.lf, t.lf - lag);
    }
  }
  for (const t of sira) { if (t.tur !== 'TT_LOE') t.ls = t.lf - t.sure; t.tf = t.ls - t.es; }
  for (const t of sira) if (t.tur === 'TT_LOE') { t.ef = bitis; t.sure = bitis - t.es; t.lf = bitis; t.ls = t.es; t.tf = 0; }
  return { m, bitis };
}

const tab = cpm(A);
const gun = cpm(A, { A3030: 60, A3010: 12, A2120: 6 }); // gercekte yasanan gecikmeler
const VERI_GUN = 175;

// ---------- projeler ----------
ins('PROJECT', { proj_id: 1, proj_short_name: 'MRH-DEMO', clndr_id: 1, last_recalc_date: basT(VERI_GUN), plan_start_date: basT(0),
  plan_end_date: bitT(tab.bitis - 1), scd_end_date: bitT(gun.bitis - 1), sum_base_proj_id: 2, project_flag: 'Y', status_code: 'Active',
  def_duration_type: 'DT_FixedDUR2', guid: guid(), create_date: SIMDI, update_date: SIMDI });
ins('PROJECT', { proj_id: 2, proj_short_name: 'MRH-DEMO-BL1', clndr_id: 1, last_recalc_date: basT(0), plan_start_date: basT(0),
  plan_end_date: bitT(tab.bitis - 1), scd_end_date: bitT(tab.bitis - 1), orig_proj_id: 1, project_flag: 'N', status_code: 'Active', guid: guid(), create_date: SIMDI, update_date: SIMDI });

let wbsId = 100, taskId = 1000, predId = 5000, rsrcAtamaId = 9000;
const wbsHarita = {};
for (const proj of [1, 2]) {
  const kok = ++wbsId;
  ins('PROJWBS', { wbs_id: kok, proj_id: proj, wbs_short_name: proj === 1 ? 'MRH-DEMO' : 'MRH-DEMO-BL1', wbs_name: proj === 1 ? 'MRH Demo Endüstriyel Tesis' : 'MRH Demo Endüstriyel Tesis - Taban 1',
    seq_num: 0, proj_node_flag: 'Y', status_code: 'WS_Open', obs_id: 1, guid: guid(), create_date: SIMDI });
  const h = {};
  WBS.forEach(([kod, ad, ust], i) => {
    const id = ++wbsId; h[kod] = id;
    ins('PROJWBS', { wbs_id: id, proj_id: proj, parent_wbs_id: ust ? h[ust] : kok, wbs_short_name: kod.split('.').pop(), wbs_name: ad,
      seq_num: (i + 1) * 10, proj_node_flag: 'N', status_code: 'WS_Open', obs_id: 1, guid: guid(), create_date: SIMDI });
  });
  wbsHarita[proj] = h;
}

const RSRC = [[1, 'MUH', 'Mühendis', 'RT_Labor'], [2, 'TEK', 'Teknisyen', 'RT_Labor'], [3, 'KYN', 'Kaynakçı', 'RT_Labor'],
  [4, 'VNC', 'Mobil vinç 80t', 'RT_Equip'], [5, 'ELK', 'Elektrikçi', 'RT_Labor']];
for (const [id, k, ad, tip] of RSRC) ins('RSRC', { rsrc_id: id, rsrc_short_name: k, rsrc_name: ad, rsrc_type: tip, clndr_id: 1, guid: guid() });

ins('ACTVTYPE', { actv_code_type_id: 1, actv_code_type: 'Faz', proj_id: 1, actv_short_len: 4, seq_num: 1 });
ins('ACTVTYPE', { actv_code_type_id: 2, actv_code_type: 'Sorumlu', proj_id: 1, actv_short_len: 6, seq_num: 2 });
const FAZ = { PY: [1, 'YON', 'Yönetim'], MUH: [2, 'MUH', 'Mühendislik'], TED: [3, 'TED', 'Tedarik'], INS: [4, 'INS', 'İnşaat'], MEK: [5, 'MON', 'Montaj'], EIE: [5, 'MON', 'Montaj'], DVR: [6, 'DVR', 'Devreye alma'] };
for (const [id, kod, ad] of Object.values(FAZ).filter((v, i, s) => s.findIndex(x => x[0] === v[0]) === i)) ins('ACTVCODE', { actv_code_id: id, actv_code_type_id: 1, short_name: kod, actv_code_name: ad, seq_num: id, color: ['1F6FEB', '8957E5', 'D29922', '3FB950', 'DB6D28', 'F778BA'][id - 1] });
ins('ACTVCODE', { actv_code_id: 11, actv_code_type_id: 2, short_name: 'EKIP-A', actv_code_name: 'Ekip A', seq_num: 1 });
ins('ACTVCODE', { actv_code_id: 12, actv_code_type_id: 2, short_name: 'EKIP-B', actv_code_name: 'Ekip B', seq_num: 2 });
ins('UDFTYPE', { udf_type_id: 1, table_name: 'TASK', udf_type_name: 'user_field_1', udf_type_label: 'Ağırlık (%)', logical_data_type: 'FT_FLOAT_2_DECIMALS' });
ins('UDFTYPE', { udf_type_id: 2, table_name: 'TASK', udf_type_name: 'user_field_2', udf_type_label: 'Sözleşme kalemi', logical_data_type: 'FT_TEXT' });
ins('MEMOTYPE', { memo_type_id: 1, memo_type: 'Genel notlar' });

const fazOf = wbs => FAZ[wbs.split('.')[0]];
const idHarita = { 1: {}, 2: {} };
for (const proj of [1, 2]) {
  const plan = proj === 1 ? gun : tab;
  for (const x of A) {
    const t = plan.m.get(x.kod);
    const id = ++taskId; idHarita[proj][x.kod] = id;
    const kilometre = x.tur === 'TT_Mile' || x.tur === 'TT_FinMile';
    const hr = t.sure * 8;
    let st = 'TK_NotStart', as = null, af = null, rem = hr, pct = 0;
    if (proj === 1) {
      if (t.ef <= VERI_GUN && !(kilometre && t.es > VERI_GUN)) {
        st = 'TK_Complete'; rem = 0; pct = 100;
        if (x.tur !== 'TT_FinMile') as = basT(t.es);
        if (x.tur !== 'TT_Mile') af = kilometre ? bitT(Math.max(0, t.es - 1)) : bitT(t.ef - 1);
      } else if (t.es < VERI_GUN && !kilometre) {
        st = 'TK_Active'; as = basT(t.es); rem = (t.ef - VERI_GUN) * 8; pct = Math.round((1 - rem / hr) * 100);
      }
    }
    const esT = st === 'TK_Active' ? VERI_GUN : t.es;
    const bas = kilometre && x.tur === 'TT_FinMile' ? bitT(Math.max(0, t.es - 1)) : basT(esT);
    const bit = kilometre ? (x.tur === 'TT_FinMile' ? bitT(Math.max(0, t.ef - 1)) : basT(t.es)) : bitT(t.ef - 1);
    const lsT = basT(t.ls), lfT = kilometre ? basT(t.lf) : bitT(Math.max(0, t.lf - 1));
    const tbl = tab.m.get(x.kod);
    ins('TASK', {
      task_id: id, proj_id: proj, wbs_id: wbsHarita[proj][x.wbs], clndr_id: x.wbs.startsWith('INS') && x.kod === 'A4010' ? 2 : 1,
      task_code: x.kod, task_name: x.ad, task_type: x.tur, status_code: st, duration_type: 'DT_FixedDUR2',
      complete_pct_type: x.wbs.startsWith('MEK') ? 'CP_Phys' : 'CP_Drtn', phys_complete_pct: x.wbs.startsWith('MEK') ? pct : 0,
      priority_type: 'PT_Normal', target_drtn_hr_cnt: hr, remain_drtn_hr_cnt: rem, act_start_date: as, act_end_date: af,
      early_start_date: st === 'TK_Complete' ? null : bas, early_end_date: st === 'TK_Complete' ? null : bit,
      late_start_date: st === 'TK_Complete' ? null : lsT, late_end_date: st === 'TK_Complete' ? null : lfT,
      target_start_date: basT(tbl.es), target_end_date: kilometre ? basT(tbl.es) : bitT(tbl.ef - 1),
      restart_date: st === 'TK_Complete' ? null : bas, reend_date: st === 'TK_Complete' ? null : bit,
      total_float_hr_cnt: st === 'TK_Complete' ? null : t.tf * 8, free_float_hr_cnt: st === 'TK_Complete' ? null : 0,
      driving_path_flag: t.tf <= 0 && st !== 'TK_Complete' ? 'Y' : 'N',
      cstr_type: x.kod === 'A7040' ? 'CS_MEO' : x.kod === 'A4000' ? 'CS_MSOA' : null,
      cstr_date: x.kod === 'A7040' ? bitT(tab.m.get('A7040').ef - 1) : x.kod === 'A4000' ? basT(20) : null,
      target_work_qty: 0, guid: guid(), create_date: SIMDI, create_user: 'mrh', update_date: SIMDI, update_user: 'mrh'
    });
    if (proj === 1) {
      const f = fazOf(x.wbs);
      ins('TASKACTV', { task_id: id, actv_code_type_id: 1, actv_code_id: f[0], proj_id: 1 });
      ins('TASKACTV', { task_id: id, actv_code_type_id: 2, actv_code_id: rnd() > 0.5 ? 11 : 12, proj_id: 1 });
      if (!kilometre) ins('UDFVALUE', { udf_type_id: 1, fk_id: id, proj_id: 1, udf_number: Math.round(rnd() * 400) / 100 });
      if (x.wbs === 'TED') ins('UDFVALUE', { udf_type_id: 2, fk_id: id, proj_id: 1, udf_text: 'SK-' + x.kod.slice(1) });
      if (/^A(5|6)/.test(x.kod)) {
        const rs = x.kod.startsWith('A6') ? 5 : (rnd() > 0.5 ? 3 : 2);
        const q = t.sure * 8 * (2 + Math.round(rnd() * 3));
        const act = st === 'TK_Complete' ? q : st === 'TK_Active' ? Math.round(q * pct / 100) : 0;
        ins('TASKRSRC', { taskrsrc_id: ++rsrcAtamaId, task_id: id, proj_id: 1, rsrc_id: rs, target_qty: q, act_reg_qty: act, act_ot_qty: 0, remain_qty: q - act,
          target_cost: q * 45, act_reg_cost: act * 45, remain_cost: (q - act) * 45, guid: guid() });
      }
      if (x.kod === 'A3030') ins('TASKMEMO', { memo_id: 1, task_id: id, memo_type_id: 1, proj_id: 1,
        task_memo: '<p>Tedarikçi üretim programında 60 iş günü kayma bildirdi.</p><p>Hızlandırma seçenekleri değerlendiriliyor.</p>' });
    }
  }
  for (const x of A) for (const [p, tip, lag] of x.onc) {
    ins('TASKPRED', { task_pred_id: ++predId, task_id: idHarita[proj][x.kod], pred_task_id: idHarita[proj][p], proj_id: proj, pred_proj_id: proj,
      pred_type: 'PR_' + tip, lag_hr_cnt: lag * 8, create_date: SIMDI });
  }
}

for (const [k, v] of [['task_task_id', taskId + 1], ['taskpred_task_pred_id', predId + 1], ['projwbs_wbs_id', wbsId + 1], ['taskrsrc_taskrsrc_id', rsrcAtamaId + 1]]) {
  ins('NEXTKEY', { key_name: k, key_seq_num: v });
}
db.close();
console.log(`Demo veritabanı olusturuldu: ${CIKTI}\n  ${A.length} aktivite x 2 proje (guncel + taban), veri tarihi ${basT(VERI_GUN).slice(0, 10)}`);
