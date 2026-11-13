'use strict';
// MRH P6 - MCP sunucusu uctan uca testleri (stdio ve HTTP)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const DIZIN = fs.mkdtempSync(path.join(os.tmpdir(), 'mrh-mcp-'));
const DB = path.join(DIZIN, 'demo.db');
execFileSync(process.execPath, [path.join(__dirname, '..', 'araclar', 'dgn-demo-olustur.js'), DB], { stdio: 'ignore' });
const SUNUCU = path.join(__dirname, '..', 'mrh', 'mrh-mcp.js');
test.after(() => fs.rmSync(DIZIN, { recursive: true, force: true }));

function stdioIstemci(env) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SUNUCU], { env: { ...process.env, LOCALAPPDATA: DIZIN, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let tampon = '', id = 0;
  const bekleyen = new Map();
  p.stdout.on('data', d => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const s = tampon.slice(0, i); tampon = tampon.slice(i + 1);
      const m = JSON.parse(s);
      bekleyen.get(m.id)?.(m); bekleyen.delete(m.id);
    }
  });
  const iste = (method, params) => new Promise(coz => { const n = ++id; bekleyen.set(n, coz); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  const cagir = async (name, args = {}) => {
    const r = await iste('tools/call', { name, arguments: args });
    const metin = r.result.content[0].text;
    return { hata: !!r.result.isError, metin, veri: r.result.isError ? null : JSON.parse(metin) };
  };
  return { iste, cagir, bildir: m => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: m }) + '\n'), kapat: () => p.stdin.end() };
}

test('salt okunur: el sikisma, arac listesi, okuma araclari', async () => {
  const c = stdioIstemci({ MRH_DB: DB, MRH_EDIT: '${user_config.allow_edit}' });
  const ini = await c.iste('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(ini.result.protocolVersion, '2025-06-18');
  assert.match(ini.result.instructions, /DISABLED/);
  c.bildir('notifications/initialized');
  const L = (await c.iste('tools/list')).result.tools.map(t => t.name);
  assert.ok(L.includes('mrh_activity_search'));
  assert.ok(!L.includes('mrh_activity_update'), 'duzenleme araclari gizli olmali');

  const ozet = await c.cagir('mrh_project_overview', {});
  assert.equal(ozet.veri.aktivite, 65);
  assert.ok(ozet.veri.bitisSapmasiGun < 0);
  const ara = await c.cagir('mrh_activity_search', { critical_only: true, status: 'open', limit: 5 });
  assert.ok(ara.veri.total > 0 && ara.veri.activities.length <= 5);
  const det = await c.cagir('mrh_activity_get', { activity: 'A3030' });
  assert.equal(det.veri.code, 'A3030');
  assert.equal(det.veri.successors[0].code, 'A5030');
  const sag = await c.cagir('mrh_health_check', { sample: 3 });
  assert.equal(sag.veri.checks.length, 15);
  const kay = await c.cagir('mrh_baseline_compare', { limit: 3 });
  assert.equal(kay.veri.slipped.length, 3);
  const sql = await c.cagir('mrh_sql_read', { sql: 'SELECT COUNT(*) n FROM TASK' });
  assert.equal(sql.veri.rows[0].n, 130);
  assert.ok((await c.cagir('mrh_sql_read', { sql: 'DELETE FROM TASK' })).hata);
  const yaz = await c.cagir('mrh_activity_update', { activities: ['A3030'], changes: { name: 'x' } });
  assert.ok(yaz.hata && /editing/i.test(yaz.metin));
  const xer = await c.cagir('mrh_xer_export', { file_path: path.join(DIZIN, 'cikti.xer') });
  assert.ok(fs.statSync(xer.veri.file).size > 1000);
  c.kapat();
});

test('duzenleme: guncelle, ekle, iliski, sil, geri al', async () => {
  const c = stdioIstemci({ MRH_EDIT: '1', MRH_DB: '' });
  await c.iste('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  const ac = await c.cagir('mrh_db_open', { path: DB });
  assert.equal(ac.veri.edit_enabled, true);
  const on = await c.cagir('mrh_activity_update', { project: 'MRH-DEMO', select: { wbs: 'DVR', status: 'not_started' }, changes: { calendar: 'MRH Saha 6x10' }, preview: true });
  assert.ok(on.veri.selected >= 5 && on.veri.preview === true);
  const g = await c.cagir('mrh_activity_update', { project: 'MRH-DEMO', activities: ['A7050'], changes: { status: 'in_progress', actual_start: '2026-10-28', percent_complete: 20 } });
  assert.equal(g.veri.changed, 1);
  assert.ok(g.veri.backup && fs.existsSync(g.veri.backup));
  const e = await c.cagir('mrh_activity_create', { project: 'MRH-DEMO', name: 'MCP deneme', duration: 3, wbs: 'DVR', predecessor: 'A7040' });
  assert.ok(e.veri.code);
  const d = await c.cagir('mrh_link_add', { project: 'MRH-DEMO', predecessor: e.veri.code, successor: 'M1000' });
  assert.ok(d.hata && /döngü/.test(d.metin));
  const s = await c.cagir('mrh_activity_delete', { project: 'MRH-DEMO', activities: [e.veri.code], confirm: true });
  assert.equal(s.veri.deleted, 1);
  const u = await c.cagir('mrh_undo');
  assert.ok(u.veri.rows_restored >= 1);
  const geri = await c.cagir('mrh_activity_get', { project: 'MRH-DEMO', activity: e.veri.code });
  assert.equal(geri.veri.name, 'MCP deneme');
  c.kapat();
});

test('HTTP tasima: gizli yol, initialize, tools/list', async () => {
  const port = 4900 + Math.floor(Math.random() * 90);
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SUNUCU, '--http', '--port', String(port)], { env: { ...process.env, LOCALAPPDATA: DIZIN, MRH_DB: DB, MRH_HTTP_SECRET: 'g'.repeat(32) }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  try {
    const url = `http://127.0.0.1:${port}/mcp/${'g'.repeat(32)}`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcp/yanlis`, { method: 'POST', body: '{}' })).status, 404);
    const ini = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {} } }) });
    assert.equal(ini.status, 200);
    assert.ok(ini.headers.get('mcp-session-id'));
    assert.equal((await ini.json()).result.serverInfo.name, 'mrh-p6');
    assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
    const L = await (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
    assert.ok(L.result.tools.length >= 12);
  } finally { p.kill(); }
});
