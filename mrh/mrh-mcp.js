#!/usr/bin/env node
'use strict';
/*
 * MRH P6 - MCP sunucusu (Model Context Protocol)
 * Primavera P6 Professional SQLite veritabanlarini yapay zeka asistanlarina acar.
 * Bagimliliksiz. Tasima: stdio (varsayilan) ya da Streamable HTTP (--http).
 *
 *   node mrh-mcp.js                      stdio (Claude, Gemini CLI, Codex CLI)
 *   node mrh-mcp.js --http --port 4791   HTTP  (ChatGPT; bir HTTPS tuneli ile)
 *
 * Ortam degiskenleri:
 *   MRH_DB           acilista acilacak veritabani (istege bagli)
 *   MRH_EDIT=1       duzenleme araclarini acar (varsayilan: salt okunur)
 *   MRH_HTTP_SECRET  HTTP modunda URL yolundaki gizli anahtar (yoksa uretilir ve saklanir)
 *
 * (c) Merih Dogan - MIT
 */
const [ANA, ARA] = process.versions.node.split('.').map(Number);
if (ANA < 22 || (ANA === 22 && ARA < 13)) {
  process.stderr.write(`MRH P6 requires Node.js 22.13 or newer (found ${process.versions.node}). Install the LTS release from https://nodejs.org\n`);
  process.exit(1);
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');

const { DgnP6, MrhHata } = require('./dgn-p6');
const yaz = require('./dgn-yazim');
const { planSagligi } = require('./dgn-kontrol');
const { xerOlustur } = require('./dgn-xer');
const { projeOzeti, kayanlar, onumuzdeki } = require('./dgn-ozet');
const yedek = require('./mr-yedek');

let SURUM = '1.0.0';
try { SURUM = require('../package.json').version; } catch { /* paket dosyasi yok */ }
// Platform ayarlari bos ya da cozulmemis "${...}" yer tutucusu olarak gelebilir: yok sayilir
const ortam = ad => { const v = String(process.env[ad] || '').trim(); return v.includes('${') ? '' : v; };
const DUZENLEME = /^(1|true|yes|on|evet)$/i.test(ortam('MRH_EDIT'));
const VERI = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.config'), 'MrhP6Studio');
const YEDEK_PENCERE = 10 * 60 * 1000;
const PROTOKOLLER = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- oturum
const D = { p6: null, sonYedek: 0, gecmis: [], sayac: 0 };

function veritabaniAc(dosya) {
  const yeni = new DgnP6(dosya, { saltOkunur: !DUZENLEME });
  if (D.p6) D.p6.kapat();
  D.p6 = yeni; D.sonYedek = 0; D.gecmis = []; D.sayac = 0;
  return yeni;
}

function gerekli() {
  if (!D.p6 && ortam('MRH_DB')) veritabaniAc(ortam('MRH_DB'));
  if (!D.p6) throw new MrhHata('No database is open. Call mrh_db_open with the full path of the P6 Professional SQLite (.db) file (mrh_db_find can list .db files in a folder).');
  return D.p6;
}

function proje(p6, ref) {
  const L = p6.projeler();
  if (ref == null || ref === '') {
    const asil = L.filter(p => !p.tabanMi);
    if (asil.length === 1) return asil[0];
    if (L.length === 1) return L[0];
    throw new MrhHata(`Several projects exist; pass "project" (id or code). Projects: ${L.map(p => `${p.kod} (id ${p.id})`).join(', ')}`);
  }
  const p = L.find(x => x.id === Number(ref)) || L.find(x => String(x.kod).toLowerCase() === String(ref).toLowerCase());
  if (!p) throw new MrhHata(`Project not found: ${ref}. Use mrh_project_list.`);
  return p;
}

function aktiviteId(p6, projId, ref) {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const r = p6.bir(`SELECT task_id FROM ${p6.ad('TASK')} WHERE task_id=?${p6.canli('TASK')}`, Number(ref));
    if (r) return r.task_id;
  }
  const r = p6.bir(`SELECT task_id FROM ${p6.ad('TASK')} WHERE proj_id=? AND task_code=?${p6.canli('TASK')}`, projId, String(ref).trim());
  if (!r) throw new MrhHata(`Activity not found in this project: ${ref}`);
  return r.task_id;
}

async function yazmaIslemi(etiket, fn, { deneme = false } = {}) {
  const p6 = gerekli();
  if (!DUZENLEME) throw new MrhHata('Editing is disabled. Start the server with MRH_EDIT=1 to allow changes.');
  let yedekAd = null;
  if (!deneme && Date.now() - D.sonYedek > YEDEK_PENCERE) {
    yedekAd = (await yedek.al(p6, 'mcp-oncesi')).ad;
    D.sonYedek = Date.now();
  }
  const { sonuc, kayit } = p6.islem(etiket, k => fn(p6, k), { deneme });
  if (!deneme && kayit.degisiklik.length) { kayit.id = ++D.sayac; D.gecmis.push(kayit); D.gecmis = D.gecmis.slice(-50); }
  return {
    ...(sonuc && typeof sonuc === 'object' ? sonuc : {}),
    rows_changed: kayit.degisiklik.length, preview: deneme,
    backup: yedekAd ? path.join(yedek.klasor(p6.dosya), yedekAd) : undefined,
    next_step: deneme ? 'Nothing was written. Call again with preview=false to apply.' : 'In P6 press F5 (refresh) and F9 (schedule) so dates and float are recalculated.'
  };
}

// ---------------------------------------------------------------- eslemeler
const DURUM = { not_started: 'TK_NotStart', in_progress: 'TK_Active', completed: 'TK_Complete' };
const DURUM_TERS = Object.fromEntries(Object.entries(DURUM).map(([a, b]) => [b, a]));
const TUR = { task: 'TT_Task', resource_dependent: 'TT_Rsrc', start_milestone: 'TT_Mile', finish_milestone: 'TT_FinMile', level_of_effort: 'TT_LOE', wbs_summary: 'TT_WBS' };
const SURE = { fixed_duration_and_units: 'DT_FixedDUR2', fixed_duration_and_units_time: 'DT_FixedDrtn', fixed_units: 'DT_FixedQty', fixed_units_time: 'DT_FixedRate' };
const YUZDE = { physical: 'CP_Phys', duration: 'CP_Drtn', units: 'CP_Units' };
const KISIT = { none: '', start_on: 'CS_MSO', start_on_or_before: 'CS_MSOB', start_on_or_after: 'CS_MSOA', finish_on: 'CS_MEO',
  finish_on_or_before: 'CS_MEOB', finish_on_or_after: 'CS_MEOA', as_late_as_possible: 'CS_ALAP', mandatory_start: 'CS_MANDSTART', mandatory_finish: 'CS_MANDFIN' };
const esle = (harita, v, ad) => {
  if (v == null) return v;
  if (Object.values(harita).includes(v)) return v;
  const k = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (k in harita) return harita[k];
  throw new MrhHata(`Invalid ${ad}: "${v}". Allowed: ${Object.keys(harita).join(', ')}`);
};

function takvimId(p6, v) {
  if (v == null || v === '') return v;
  const L = p6.takvimler();
  const t = L.find(c => c.id === Number(v)) || L.find(c => c.ad.toLowerCase() === String(v).toLowerCase());
  if (!t) throw new MrhHata(`Calendar not found: ${v}. Available: ${L.map(c => c.ad).join(', ')}`);
  return t.id;
}

function wbsId(p6, projId, v) {
  if (v == null || v === '') return v;
  const yuk = p6.projeYukle(projId, { tabanId: null });
  if (/^\d+$/.test(String(v)) && yuk.wbs.some(w => w.id === Number(v))) return Number(v);
  const harita = new Map(yuk.wbs.map(w => [w.id, w]));
  const yol = w => { const p = []; let x = w, g = 0; while (x && !x.kok && g++ < 50) { p.unshift(x.kod); x = harita.get(x.ust); } return p.join('.'); };
  const s = String(v).trim().toLowerCase();
  const L = yuk.wbs.filter(w => yol(w).toLowerCase() === s || String(w.kod).toLowerCase() === s);
  if (L.length === 1) return L[0].id;
  if (L.length > 1) throw new MrhHata(`WBS code "${v}" is ambiguous; use the full path: ${L.map(yol).join(', ')}`);
  throw new MrhHata(`WBS not found: ${v}`);
}

function degisiklikler(p6, projId, c = {}) {
  const y = {};
  const koy = (k, v) => { if (v !== undefined) y[k] = v; };
  koy('ad', c.name); koy('kod', c.code);
  koy('st', esle(DURUM, c.status, 'status'));
  koy('as', c.actual_start); koy('af', c.actual_finish);
  koy('od', c.original_duration); koy('rd', c.remaining_duration); koy('pct', c.percent_complete);
  koy('cal', c.calendar !== undefined ? takvimId(p6, c.calendar) : undefined);
  koy('w', c.wbs !== undefined ? wbsId(p6, projId, c.wbs) : undefined);
  koy('ks', esle(KISIT, c.constraint, 'constraint'));
  koy('kt', c.constraint_date);
  koy('tur', esle(TUR, c.activity_type, 'activity_type'));
  koy('dt', esle(SURE, c.duration_type, 'duration_type'));
  koy('pt', esle(YUZDE, c.percent_type, 'percent_type'));
  if (!Object.keys(y).length) throw new MrhHata('"changes" is empty.');
  return y;
}

function satir(a, wbsKod) {
  return {
    id: a.id, code: a.kod, name: a.ad, wbs: wbsKod(a.w), status: DURUM_TERS[a.st] || a.st,
    type: Object.keys(TUR).find(k => TUR[k] === a.tur) || a.tur,
    od: a.od, rd: a.rd, pct: a.pct, start: a.bas, finish: a.bit, actual_start: a.as || undefined, actual_finish: a.af || undefined,
    total_float: a.st === 'TK_Complete' ? undefined : a.tf, critical: a.kr || undefined,
    bl_finish: a.bf || undefined
  };
}

function wbsKodlayici(yuk) {
  const harita = new Map(yuk.wbs.map(w => [w.id, w]));
  const on = new Map();
  return id => {
    if (on.has(id)) return on.get(id);
    const p = []; let x = harita.get(id), g = 0;
    while (x && !x.kok && g++ < 50) { p.unshift(x.kod); x = harita.get(x.ust); }
    const s = p.join('.'); on.set(id, s); return s;
  };
}

// ---------------------------------------------------------------- araclar
const OKU = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const YAZ = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const SIL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const projeOz = { project: { type: ['string', 'integer'], description: 'Project id or code. Optional when the database has a single project.' } };
const DEGISIKLIK = {
  type: 'object', additionalProperties: false, description: 'Fields to change. Durations are in working days; dates are YYYY-MM-DD.',
  properties: {
    name: { type: 'string' }, code: { type: 'string' },
    status: { type: 'string', enum: Object.keys(DURUM) },
    actual_start: { type: ['string', 'null'] }, actual_finish: { type: ['string', 'null'] },
    original_duration: { type: 'number' }, remaining_duration: { type: 'number' },
    percent_complete: { type: 'number', minimum: 0, maximum: 100 },
    calendar: { type: ['string', 'integer'], description: 'Calendar id or name' },
    wbs: { type: ['string', 'integer'], description: 'WBS id, code or dotted path (e.g. MUH.PRS)' },
    constraint: { type: 'string', enum: Object.keys(KISIT) }, constraint_date: { type: ['string', 'null'] },
    activity_type: { type: 'string', enum: Object.keys(TUR) },
    duration_type: { type: 'string', enum: Object.keys(SURE) },
    percent_type: { type: 'string', enum: Object.keys(YUZDE) }
  }
};

const ARACLAR = [
  {
    name: 'mrh_db_find', title: 'Find P6 databases', annotations: OKU,
    description: 'List P6 SQLite (.db/.sqlite) files in a folder. Without a folder, lists the user\'s Documents folder.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string' } } },
    fn: ({ folder }) => {
      const dir = path.resolve(folder || path.join(os.homedir(), 'Documents'));
      const L = fs.readdirSync(dir, { withFileTypes: true });
      return {
        folder: dir,
        databases: L.filter(f => f.isFile() && /\.(db|sqlite3?|s3db)$/i.test(f.name)).map(f => {
          const st = fs.statSync(path.join(dir, f.name));
          return { path: path.join(dir, f.name), size_mb: Math.round(st.size / 104857.6) / 10, modified: st.mtime.toISOString().slice(0, 16) };
        }),
        subfolders: L.filter(f => f.isDirectory() && !/^[.$]/.test(f.name)).map(f => f.name).slice(0, 200)
      };
    }
  },
  {
    name: 'mrh_db_open', title: 'Open a P6 database', annotations: OKU,
    description: 'Open a Primavera P6 Professional SQLite database by full path. Must be called before the other tools (unless MRH_DB is set).',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'Full path to the .db file' } } },
    fn: ({ path: p }) => { const x = veritabaniAc(p); return { ...x.ozet(), edit_enabled: DUZENLEME, projects: x.projeler().map(pr => ({ id: pr.id, code: pr.kod, name: pr.ad, activities: pr.adet, is_baseline: pr.tabanMi })) }; }
  },
  {
    name: 'mrh_project_list', title: 'List projects', annotations: OKU,
    description: 'List the projects in the open database with data date, finish, baseline project and activity count.',
    inputSchema: { type: 'object', properties: {} },
    fn: () => ({ projects: gerekli().projeler().map(p => ({ id: p.id, code: p.kod, name: p.ad, data_date: p.veriTarihi, start: p.baslangic, finish: p.bitis, baseline_project_id: p.taban, is_baseline: p.tabanMi, activities: p.adet })) })
  },
  {
    name: 'mrh_project_overview', title: 'Project overview', annotations: OKU,
    description: 'Progress (duration weighted), planned progress from the baseline, forecast vs baseline finish, status counts, critical/negative-float counts and progress per top-level WBS.',
    inputSchema: { type: 'object', properties: { ...projeOz, baseline: { type: ['string', 'integer', 'null'], description: 'Baseline project id/code. Default: the project\'s assigned baseline. null = none.' } } },
    fn: ({ project, baseline }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const tb = baseline === undefined ? undefined : baseline === null ? null : proje(p6, baseline).id;
      return projeOzeti(p6.projeYukle(pr.id, { tabanId: tb }));
    }
  },
  {
    name: 'mrh_activity_search', title: 'Search activities', annotations: OKU,
    description: 'Filter and list activities. Returns compact rows (durations in days, float in days, bl_finish = baseline finish).',
    inputSchema: {
      type: 'object', properties: {
        ...projeOz,
        text: { type: 'string', description: 'Matches code or name (case-insensitive)' },
        status: { type: 'string', enum: [...Object.keys(DURUM), 'open'] },
        critical_only: { type: 'boolean' },
        wbs: { type: 'string', description: 'WBS code or dotted path; includes sub-WBS' },
        sort: { type: 'string', enum: ['code', 'start', 'finish', 'total_float', 'slip'] },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }, offset: { type: 'integer', minimum: 0, default: 0 }
      }
    },
    fn: ({ project, text, status, critical_only, wbs, sort = 'code', limit = 100, offset = 0 }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const yuk = p6.projeYukle(pr.id);
      const kod = wbsKodlayici(yuk);
      let A = yuk.aktiviteler;
      if (text) { const q = text.toLocaleLowerCase('tr'); A = A.filter(a => `${a.kod} ${a.ad}`.toLocaleLowerCase('tr').includes(q)); }
      if (status === 'open') A = A.filter(a => a.st !== 'TK_Complete');
      else if (status) A = A.filter(a => a.st === DURUM[status]);
      if (critical_only) A = A.filter(a => a.kr);
      if (wbs) { const w = String(wbs).toLowerCase(); A = A.filter(a => { const k = kod(a.w).toLowerCase(); return k === w || k.startsWith(w + '.') || k.split('.').pop() === w; }); }
      const sapma = a => a.bf && a.bit ? (Date.parse(a.bf) - Date.parse(a.bit)) / 864e5 : Infinity;
      const S = { code: (x, y) => x.kod.localeCompare(y.kod, 'tr', { numeric: true }), start: (x, y) => (x.bas || '').localeCompare(y.bas || ''),
        finish: (x, y) => (x.bit || '').localeCompare(y.bit || ''), total_float: (x, y) => (x.tf ?? 1e9) - (y.tf ?? 1e9), slip: (x, y) => sapma(x) - sapma(y) };
      A = [...A].sort(S[sort] || S.code);
      return { project: pr.kod, data_date: pr.veriTarihi, total: A.length, offset, activities: A.slice(offset, offset + Math.min(limit, 1000)).map(a => satir(a, kod)) };
    }
  },
  {
    name: 'mrh_activity_get', title: 'Activity details', annotations: OKU,
    description: 'Full details of one activity: dates, durations, float, constraints, predecessors and successors, resource assignments, activity codes, user fields and notes.',
    inputSchema: { type: 'object', required: ['activity'], properties: { ...projeOz, activity: { type: ['string', 'integer'], description: 'Activity code or id' } } },
    fn: ({ project, activity }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const id = aktiviteId(p6, pr.id, activity);
      const yuk = p6.projeYukle(pr.id);
      const a = yuk.aktiviteler.find(x => x.id === id);
      const d = p6.aktiviteDetay(id);
      const t = yuk.takvimler.find(c => c.id === a.cal);
      const ilk = r => ({ link_id: r.id, code: r.kod, name: r.ad, type: r.tur.slice(3), lag_days: r.gecikme, status: DURUM_TERS[r.st] || r.st });
      return {
        ...satir(a, wbsKodlayici(yuk)), calendar: t ? t.ad : null, duration_type: Object.keys(SURE).find(k => SURE[k] === a.dt) || a.dt,
        percent_type: Object.keys(YUZDE).find(k => YUZDE[k] === a.pt) || a.pt,
        early_start: a.es, early_finish: a.ef, late_start: a.ls, late_finish: a.lf, free_float: a.ff,
        constraint: Object.keys(KISIT).find(k => KISIT[k] === (a.ks || '')) || a.ks, constraint_date: a.kt,
        bl_start: a.bs, predecessors: d.onculler.map(ilk), successors: d.ardillar.map(ilk),
        resources: d.kaynaklar, activity_codes: d.kodlar, user_fields: d.alanlar, notes: d.notlar
      };
    }
  },
  {
    name: 'mrh_health_check', title: 'Schedule health check', annotations: OKU,
    description: 'Run 15 schedule quality checks (missing logic, leads, lags, non-FS links, hard constraints, high/negative float, long durations, invalid dates, status errors, duplicate links, loops, redundant links, critical activities) and return a 0-100 score with sample activity codes per check.',
    inputSchema: { type: 'object', properties: { ...projeOz, sample: { type: 'integer', minimum: 0, maximum: 500, default: 20 } } },
    fn: ({ project, sample = 20 }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const yuk = p6.projeYukle(pr.id, { tabanId: null });
      const kod = new Map(yuk.aktiviteler.map(a => [a.id, a.kod]));
      const s = planSagligi(yuk);
      return { project: pr.kod, data_date: s.veriTarihi, score: s.puan, passed: s.gecen, scored_checks: s.toplam, open_activities: s.acik,
        checks: s.kontroller.map(k => ({ check: k.kod, name: k.ad, result: { gecti: 'pass', kaldi: 'fail', bilgi: 'info' }[k.durum], count: k.deger, of: k.payda,
          percent: k.oran, threshold_percent: k.tip === 'sifir' ? 0 : k.esik, description: k.aciklama, activities: [...new Set(k.idler)].slice(0, sample).map(i => kod.get(i)) })) };
    }
  },
  {
    name: 'mrh_baseline_compare', title: 'Baseline slips', annotations: OKU,
    description: 'Activities whose current finish is later than the baseline finish, worst first.',
    inputSchema: { type: 'object', properties: { ...projeOz, baseline: { type: ['string', 'integer'] }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 25 } } },
    fn: ({ project, baseline, limit = 25 }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const yuk = p6.projeYukle(pr.id, { tabanId: baseline == null ? undefined : proje(p6, baseline).id });
      if (!yuk.tabanId) throw new MrhHata('This project has no baseline assigned; pass "baseline" (project id or code).');
      const o = projeOzeti(yuk);
      return { project: pr.kod, baseline_project_id: yuk.tabanId, forecast_finish: o.tahminiBitis, baseline_finish: o.tabanBitis, finish_variance_days: o.bitisSapmasiGun, slipped: kayanlar(yuk, limit) };
    }
  },
  {
    name: 'mrh_lookahead', title: 'Look-ahead', annotations: OKU,
    description: 'Activities that start or finish within N days after the data date.',
    inputSchema: { type: 'object', properties: { ...projeOz, days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } },
    fn: ({ project, days = 30 }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      return { project: pr.kod, data_date: pr.veriTarihi, days, events: onumuzdeki(p6.projeYukle(pr.id), days).map(e => ({ event: e.olay === 'baslayacak' ? 'start' : 'finish', date: e.tarih, code: e.kod, name: e.ad, total_float: e.bolluk, critical: e.kritik || undefined })) };
    }
  },
  {
    name: 'mrh_sql_read', title: 'Read-only SQL', annotations: OKU,
    description: 'Run one read-only SELECT/WITH query on the P6 database (P6 table names such as TASK, TASKPRED, PROJWBS, CALENDAR, RSRC, TASKRSRC). Durations are stored in hours.',
    inputSchema: { type: 'object', required: ['sql'], properties: { sql: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 2000, default: 200 } } },
    fn: ({ sql, limit = 200 }) => {
      const p6 = gerekli();
      const q = String(sql).trim().replace(/;+\s*$/, '');
      if (!/^(select|with)\b/i.test(q)) throw new MrhHata('Only SELECT / WITH queries are allowed.');
      if (/;\s*\S/.test(q.replace(/'[^']*'/g, ''))) throw new MrhHata('Send one statement at a time.');
      const db = new DatabaseSync(p6.dosya, { readOnly: true });
      try {
        db.exec('PRAGMA query_only = ON');
        const rows = []; let more = false;
        for (const r of db.prepare(q).iterate()) {
          if (rows.length >= Math.min(limit, 2000)) { more = true; break; }
          for (const k of Object.keys(r)) if (r[k] instanceof Uint8Array) r[k] = `(binary ${r[k].length} bytes)`;
          rows.push(r);
        }
        return { rows, truncated: more };
      } finally { db.close(); }
    }
  },
  {
    name: 'mrh_xer_export', title: 'Export XER', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description: 'Write a project to an XER file (the database is not changed). Default folder: Documents\\MRH P6.',
    inputSchema: { type: 'object', properties: { ...projeOz, file_path: { type: 'string' }, encoding: { type: 'string', enum: ['cp1254', 'cp1252', 'utf8'], default: 'cp1252' } } },
    fn: ({ project, file_path, encoding = 'cp1252' }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const x = xerOlustur(p6, pr.id, { kodlama: encoding });
      const hedef = path.resolve(file_path || path.join(os.homedir(), 'Documents', 'MRH P6', x.dosyaAdi));
      fs.mkdirSync(path.dirname(hedef), { recursive: true });
      fs.writeFileSync(hedef, x.veri);
      return { file: hedef, bytes: x.veri.length, tables: x.sayim };
    }
  },
  {
    name: 'mrh_backup_list', title: 'List backups', annotations: OKU,
    description: 'List the automatic backups of the open database (taken before edits, kept next to the database in mrh_yedekler).',
    inputSchema: { type: 'object', properties: {} },
    fn: () => { const l = yedek.liste(gerekli().dosya); return { folder: l.klasor, backups: l.yedekler }; }
  },
  // ---------------- duzenleme (MRH_EDIT=1)
  {
    name: 'mrh_activity_update', title: 'Update activities', annotations: YAZ, duzenleme: true,
    description: 'Apply the same changes to one or many activities in ONE transaction (all or nothing). Pick activities by "activities" (codes/ids) and/or "select". Use preview=true first for large changes. Status rules are enforced (in progress needs actual_start, completed needs actual dates).',
    inputSchema: {
      type: 'object', required: ['changes'], properties: {
        ...projeOz,
        activities: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 5000 },
        select: { type: 'object', description: 'Optional filter instead of / in addition to a list', properties: { status: { type: 'string', enum: [...Object.keys(DURUM), 'open'] }, wbs: { type: 'string' }, text: { type: 'string' } } },
        changes: DEGISIKLIK, preview: { type: 'boolean', default: false }
      }
    },
    fn: async ({ project, activities = [], select, changes, preview = false }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const ids = new Set(activities.map(a => aktiviteId(p6, pr.id, a)));
      if (select) {
        const yuk = p6.projeYukle(pr.id, { tabanId: null }); const kod = wbsKodlayici(yuk);
        for (const a of yuk.aktiviteler) {
          if (select.status === 'open' ? a.st === 'TK_Complete' : select.status && a.st !== DURUM[select.status]) continue;
          if (select.wbs) { const w = select.wbs.toLowerCase(), k = kod(a.w).toLowerCase(); if (!(k === w || k.startsWith(w + '.'))) continue; }
          if (select.text && !`${a.kod} ${a.ad}`.toLocaleLowerCase('tr').includes(select.text.toLocaleLowerCase('tr'))) continue;
          ids.add(a.id);
        }
      }
      if (!ids.size) throw new MrhHata('No activities selected.');
      const yama = degisiklikler(p6, pr.id, changes);
      const s = await yazmaIslemi(`${ids.size} aktivite güncellendi (MCP)`, (x, k) => yaz.topluGuncelle(x, k, [...ids], yama), { deneme: preview });
      return { selected: ids.size, changed: s.degisen, warnings: s.uyarilar, ...s, degisen: undefined, uyarilar: undefined, uyariSayisi: undefined };
    }
  },
  {
    name: 'mrh_activity_create', title: 'Create activity', annotations: YAZ, duzenleme: true,
    description: 'Create a not-started activity (code is generated when omitted). Optionally link it after a predecessor and/or before a successor (FS).',
    inputSchema: {
      type: 'object', required: ['name'], properties: {
        ...projeOz, name: { type: 'string' }, code: { type: 'string' }, wbs: { type: ['string', 'integer'] },
        duration: { type: 'number', minimum: 0, default: 5 }, calendar: { type: ['string', 'integer'] },
        activity_type: { type: 'string', enum: Object.keys(TUR) },
        predecessor: { type: ['string', 'integer'] }, successor: { type: ['string', 'integer'] }
      }
    },
    fn: async a => {
      const p6 = gerekli(); const pr = proje(p6, a.project);
      const s = await yazmaIslemi(`Aktivite eklendi: ${a.name} (MCP)`, (x, k) => yaz.aktiviteEkle(x, k, {
        proje: pr.id, ad: a.name, kod: a.code, od: a.duration ?? 5, tur: esle(TUR, a.activity_type, 'activity_type'),
        wbs: a.wbs != null ? wbsId(x, pr.id, a.wbs) : null, cal: a.calendar != null ? takvimId(x, a.calendar) : null,
        oncul: a.predecessor != null ? aktiviteId(x, pr.id, a.predecessor) : null, ardil: a.successor != null ? aktiviteId(x, pr.id, a.successor) : null
      }));
      return { id: s.id, code: s.kod, rows_changed: s.rows_changed, backup: s.backup, next_step: s.next_step };
    }
  },
  {
    name: 'mrh_activity_delete', title: 'Delete activities', annotations: SIL, duzenleme: true,
    description: 'Delete activities together with their links, resource assignments, codes, user field values and notes. Requires confirm=true. Can be reverted with mrh_undo.',
    inputSchema: { type: 'object', required: ['activities', 'confirm'], properties: { ...projeOz, activities: { type: 'array', items: { type: ['string', 'integer'] }, minItems: 1, maxItems: 2000 }, confirm: { type: 'boolean' } } },
    fn: async ({ project, activities, confirm }) => {
      if (confirm !== true) throw new MrhHata('Set confirm=true after the user has approved the deletion.');
      const p6 = gerekli(); const pr = proje(p6, project);
      const ids = activities.map(a => aktiviteId(p6, pr.id, a));
      const s = await yazmaIslemi(`${ids.length} aktivite silindi (MCP)`, (x, k) => yaz.aktiviteSil(x, k, ids));
      return { deleted: s.silinen, related_rows: s.bagli, rows_changed: s.rows_changed, backup: s.backup, next_step: s.next_step };
    }
  },
  {
    name: 'mrh_link_add', title: 'Add relationship', annotations: YAZ, duzenleme: true,
    description: 'Add a relationship between two activities. Refuses duplicates and links that would create a loop.',
    inputSchema: { type: 'object', required: ['predecessor', 'successor'], properties: { ...projeOz, predecessor: { type: ['string', 'integer'] }, successor: { type: ['string', 'integer'] }, type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'], default: 'FS' }, lag_days: { type: 'number', default: 0 } } },
    fn: async ({ project, predecessor, successor, type = 'FS', lag_days = 0 }) => {
      const p6 = gerekli(); const pr = proje(p6, project);
      const s = await yazmaIslemi('İlişki eklendi (MCP)', (x, k) => yaz.iliskiEkle(x, k, { oncul: aktiviteId(x, pr.id, predecessor), ardil: aktiviteId(x, pr.id, successor), tur: 'PR_' + String(type).toUpperCase(), gecikme: lag_days }));
      return { link_id: s.id, rows_changed: s.rows_changed, backup: s.backup, next_step: s.next_step };
    }
  },
  {
    name: 'mrh_link_update', title: 'Update relationship', annotations: YAZ, duzenleme: true,
    description: 'Change the type and/or lag of a relationship (link_id from mrh_activity_get).',
    inputSchema: { type: 'object', required: ['link_id'], properties: { link_id: { type: 'integer' }, type: { type: 'string', enum: ['FS', 'SS', 'FF', 'SF'] }, lag_days: { type: 'number' } } },
    fn: async ({ link_id, type, lag_days }) => yazmaIslemi('İlişki güncellendi (MCP)', (x, k) => ({ changed: yaz.iliskiGuncelle(x, k, { id: link_id, tur: type ? 'PR_' + type.toUpperCase() : undefined, gecikme: lag_days }) }))
  },
  {
    name: 'mrh_link_delete', title: 'Delete relationships', annotations: SIL, duzenleme: true,
    description: 'Delete relationships by link_id (from mrh_activity_get).',
    inputSchema: { type: 'object', required: ['link_ids'], properties: { link_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 } } },
    fn: async ({ link_ids }) => yazmaIslemi('İlişki silindi (MCP)', (x, k) => yaz.iliskiSil(x, k, link_ids))
  },
  {
    name: 'mrh_data_date_set', title: 'Set data date', annotations: YAZ, duzenleme: true,
    description: 'Set the project data date (YYYY-MM-DD). Schedule with F9 in P6 afterwards.',
    inputSchema: { type: 'object', required: ['date'], properties: { ...projeOz, date: { type: 'string' } } },
    fn: async ({ project, date }) => { const pr = proje(gerekli(), project); return yazmaIslemi(`Veri tarihi: ${date} (MCP)`, (x, k) => ({ changed: yaz.veriTarihiAyarla(x, k, { proje: pr.id, tarih: date }) })); }
  },
  {
    name: 'mrh_undo', title: 'Undo last edit', annotations: YAZ, duzenleme: true,
    description: 'Revert the last edit made in this session. Refuses when the same rows were changed elsewhere afterwards.',
    inputSchema: { type: 'object', properties: {} },
    fn: async () => {
      const son = [...D.gecmis].reverse().find(g => !g.geriAlindi && !g.geriAlma);
      if (!son) throw new MrhHata('Nothing to undo in this session.');
      const s = await yazmaIslemi(`Geri alındı: ${son.etiket}`, (x, k) => yaz.geriAl(x, k, son));
      son.geriAlindi = true;
      const yeni = D.gecmis[D.gecmis.length - 1]; if (yeni && yeni !== son) yeni.geriAlma = true;
      return { undone: son.etiket, rows_restored: s.geriAlinan, next_step: s.next_step };
    }
  }
];

const gorunur = () => ARACLAR.filter(a => !a.duzenleme || DUZENLEME);

const TALIMAT = `MRH P6 reads${DUZENLEME ? ' and edits' : ''} Primavera P6 Professional SQLite databases.
Workflow: mrh_db_open (full .db path; mrh_db_find helps locate it) -> mrh_project_list -> mrh_project_overview / mrh_activity_search / mrh_activity_get / mrh_health_check / mrh_baseline_compare / mrh_lookahead.
Durations and float are in working days, dates are YYYY-MM-DD HH:MM. Dates, float and the critical path come from P6's last F9 calculation; this server does not schedule.
${DUZENLEME ? `Editing is ENABLED. A compressed backup is taken before the first edit (and every 10 minutes of editing). Confirm destructive actions with the user. Prefer one mrh_activity_update call with many activities over many calls, and use preview=true for large changes. After edits tell the user to press F5 and F9 in P6. mrh_undo reverts the last edit.`
    : 'Editing is DISABLED (read-only). The user can enable it by setting MRH_EDIT=1 in the server configuration.'}`;

// ---------------------------------------------------------------- JSON-RPC
async function isle(m) {
  const yanit = sonuc => (m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, result: sonuc });
  const hata = (kod, mesaj) => (m.id === undefined ? null : { jsonrpc: '2.0', id: m.id, error: { code: kod, message: mesaj } });
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return m && m.id !== undefined ? hata(-32600, 'Invalid request') : null;
  switch (m.method) {
    case 'initialize': {
      const istenen = m.params && m.params.protocolVersion;
      return yanit({
        protocolVersion: PROTOKOLLER.includes(istenen) ? istenen : PROTOKOLLER[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'mrh-p6', title: 'MRH P6', version: SURUM },
        instructions: TALIMAT
      });
    }
    case 'ping': return yanit({});
    case 'tools/list':
      return yanit({ tools: gorunur().map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations: { title, ...annotations } })) });
    case 'tools/call': {
      const ad = m.params && m.params.name;
      const arac = gorunur().find(a => a.name === ad);
      if (!arac) {
        const gizli = ARACLAR.find(a => a.name === ad);
        return yanit({ isError: true, content: [{ type: 'text', text: gizli ? `${ad} is an editing tool and editing is disabled (set MRH_EDIT=1).` : `Unknown tool: ${ad}` }] });
      }
      try {
        const sonuc = await arac.fn((m.params && m.params.arguments) || {});
        return yanit({ content: [{ type: 'text', text: JSON.stringify(sonuc, (k, v) => (v === undefined ? undefined : v)) }] });
      } catch (e) {
        if (!(e instanceof MrhHata)) process.stderr.write(`[mrh-p6] ${e && e.stack || e}\n`);
        return yanit({ isError: true, content: [{ type: 'text', text: 'Error: ' + (e && e.message || String(e)) }] });
      }
    }
    case 'resources/list': return yanit({ resources: [] });
    case 'prompts/list': return yanit({ prompts: [] });
    default:
      if (m.method.startsWith('notifications/')) return null;
      return hata(-32601, 'Method not found: ' + m.method);
  }
}

async function mesajlar(govde) {
  if (Array.isArray(govde)) return (await Promise.all(govde.map(isle))).filter(Boolean);
  return isle(govde);
}

// ---------------------------------------------------------------- tasimalar
function stdioBaslat() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let kuyruk = Promise.resolve();
  rl.on('line', satirMetni => {
    const s = satirMetni.trim();
    if (!s) return;
    kuyruk = kuyruk.then(async () => {
      let m;
      try { m = JSON.parse(s); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); return; }
      const y = await mesajlar(m);
      if (y && (!Array.isArray(y) || y.length)) process.stdout.write(JSON.stringify(y) + '\n');
    });
  });
  rl.on('close', () => { if (D.p6) D.p6.kapat(); process.exit(0); });
  process.stderr.write(`[mrh-p6] MCP server ${SURUM} ready on stdio (editing ${DUZENLEME ? 'ENABLED' : 'disabled'})\n`);
}

function gizliAnahtar() {
  if (ortam('MRH_HTTP_SECRET').length >= 16) return ortam('MRH_HTTP_SECRET');
  const f = path.join(VERI, 'mcp-http-anahtar.txt');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 24) return s; } catch { /* yok */ }
  const s = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(VERI, { recursive: true });
  fs.writeFileSync(f, s);
  return s;
}

function httpBaslat(port) {
  const anahtar = gizliAnahtar();
  const yol = `/mcp/${anahtar}`;
  const esit = s => { const a = Buffer.from(s), b = Buffer.from(yol); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const sunucu = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!esit(u.pathname)) { res.writeHead(404).end(); return; }
    if (req.method === 'GET') { res.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    const parca = []; let boy = 0;
    req.on('data', c => { boy += c.length; if (boy > 4 * 1024 * 1024) req.destroy(); else parca.push(c); });
    req.on('end', async () => {
      let m;
      try { m = JSON.parse(Buffer.concat(parca).toString('utf8')); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
      const y = await mesajlar(m);
      const bas = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (!Array.isArray(m) && m && m.method === 'initialize') bas['Mcp-Session-Id'] = crypto.randomUUID();
      if (!y || (Array.isArray(y) && !y.length)) { res.writeHead(202, bas).end(); return; }
      res.writeHead(200, bas).end(JSON.stringify(y));
    });
  });
  sunucu.listen(port, '127.0.0.1', () => {
    process.stderr.write(`\n  MRH P6 MCP server ${SURUM} (HTTP, editing ${DUZENLEME ? 'ENABLED' : 'disabled'})\n` +
      `  Local endpoint : http://127.0.0.1:${port}${yol}\n` +
      `  For ChatGPT    : expose port ${port} with an HTTPS tunnel and add  https://<tunnel-host>${yol}\n` +
      `  Keep this URL private: anyone who has it can use the tools.\n\n`);
  });
}

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : Number(process.env.MRH_PORT || 4791);
  if (process.argv.includes('--http')) httpBaslat(port); else stdioBaslat();
}

module.exports = { isle, ARACLAR };
