/* Charter Desk VA — web app. Talks to Supabase; all game rules run in the database. */
'use strict';

const CFG = window.CHARTER_CONFIG || {};
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString('en-US');
const kmoney = n => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? '$' + (n / 1e3).toFixed(1) + 'k' : money(n);
const pad = n => String(n).padStart(2, '0');
const hm = h => { const m = Math.round((h || 0) * 60); return `${Math.floor(m / 60)}:${pad(m % 60)}` };
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const R = Math.PI / 180;
const BIDWAIT = [30, 22, 15, 10];
const UPG = {
  sales: { name: 'Sales desk', cost: [30000, 70000, 140000], desc: 'Clients phone you directly more often, with private offers above market rate.' },
  broker: { name: 'Broker relations', cost: [25000, 60000, 120000], desc: 'Brokers favour you: a 3% edge on every quote per level.' },
  fast: { name: 'Priority broker line', cost: [20000, 50000, 100000], desc: 'Get decisions faster on requests you open: 30s, then 22s, 15s and 10s.' },
  crew: { name: 'Crew training', cost: [40000, 90000, 180000], desc: 'Cuts operating cost per flight hour by 5% per level.' },
  pr: { name: 'PR and brand', cost: [35000, 80000, 160000], desc: 'Reputation gains count 25% more per level. Reputation wins close bids.' },
  empty: { name: 'Empty-leg sales', cost: [50000, 120000], desc: 'Sell seats on positioning legs. Each level recovers 25% of positioning cost.' },
};
const CALL_LINES = [
  (c, A, B) => `Hi, I've been given your number by a friend. I need ${c.pax} of us from ${A.city} to ${B.city}. Can you do it?`,
  (c, A, B) => `It's short notice, I know. ${B.city} for ${c.pax}, leaving from ${A.city}. Your name came up as the operator to call.`,
  (c, A, B) => `My assistant usually books this, but she's away. We need ${c.from_icao} to ${c.to_icao}, ${c.pax} passengers. I'll pay well for reliability.`,
  (c, A, B) => `We flew with you before and it went smoothly. Same again please: ${A.city} to ${B.city}, ${c.pax} on board.`,
];

if (!window.supabase || !CFG.supabaseUrl || CFG.supabaseUrl.includes('YOUR-PROJECT')) {
  $('#main').innerHTML = `<div class="authwrap"><div class="authcard"><h1>Almost there</h1><p>Open <b class="mono">config.js</b> and fill in your Supabase project URL and anon key, then reload this page.</p></div></div>`;
  throw new Error('Charter Desk is not configured');
}
const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

/* ---------- state ---------- */
const D = { settings: {}, airports: {}, apList: [], types: {}, clients: [], me: null, fleet: [], requests: [], bids: [], calls: [], trips: [], myPireps: [] };
const UI = { tab: 'market', band: 'any', showAll: false, sort: 'closing', acId: null, sound: false };
const TABS = [['market', 'Market'], ['trips', 'Trips'], ['hangar', 'Hangar'], ['shop', 'Shop'], ['live', 'Live map'], ['reports', 'Reports'], ['pilots', 'Pilots'], ['ledger', 'Ledger'], ['profile', 'Profile'], ['staff', 'Staff']];
try { UI.sound = localStorage.getItem('cd-ringer') === '1'; } catch (e) { }
let pollTimer = null, liveMap = null, liveLayer = null;

async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args || {});
  if (error) throw new Error(error.message);
  return data;
}
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(error.message);
  return data;
}

/* ---------- geometry and planning ---------- */
function nmLL(la1, lo1, la2, lo2) { const a = Math.sin((la2 - la1) * R / 2) ** 2 + Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin((lo2 - lo1) * R / 2) ** 2; return Math.round(2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)))) }
function nm(a, b) { const A = D.airports[a], B = D.airports[b]; return A && B ? nmLL(A.lat, A.lon, B.lat, B.lon) : 0 }
function brg(a, b) { const A = D.airports[a], B = D.airports[b]; const y = Math.sin((B.lon - A.lon) * R) * Math.cos(B.lat * R); const x = Math.cos(A.lat * R) * Math.sin(B.lat * R) - Math.sin(A.lat * R) * Math.cos(B.lat * R) * Math.cos((B.lon - A.lon) * R); return (Math.atan2(y, x) / R + 360) % 360 }
const blockH = (t, d) => d <= 0 ? 0 : d / t.ktas + 0.33;
const upg = k => (D.me?.upgrades || {})[k] || 0;
const opRate = t => t.rate * 0.55 * (1 - 0.05 * upg('crew'));
const repoFactor = () => 1 - 0.25 * upg('empty');
const fits = (t, r) => r.dist <= t.range_nm * 0.92 && r.pax <= t.seats;
const whyNot = (t, r) => r.pax > t.seats ? `${r.pax} pax, ${t.seats} seats` : r.dist > t.range_nm * 0.92 ? 'Beyond range' : '';
const acById = id => D.fleet.find(a => a.id === id);
const typeOf = ac => D.types[ac.type_code];
const queue = ac => D.trips.filter(t => t.aircraft_id === ac.id && (t.status === 'booked' || t.status === 'flying')).sort((a, b) => a.seq - b.seq);
const futureLoc = ac => { const qd = queue(ac); return qd.length ? qd[qd.length - 1].to_icao : ac.loc };
const active = () => acById(UI.acId) || D.fleet[0];
function quote(ac, r, from) {
  const t = typeOf(ac), loc = from || futureLoc(ac);
  const repoNm = loc === r.from_icao ? 0 : nm(loc, r.from_icao);
  const bh = blockH(t, r.dist), rh = blockH(t, repoNm);
  return { loc, repoNm, bh, rh, basis: t.rate * bh, guide: Math.round(t.rate * bh / 100) * 100, repoCost: Math.round(opRate(t) * rh * repoFactor()), fair: Math.round((t.rate * bh + 0.55 * t.rate * rh) / 100) * 100, opc: Math.round(opRate(t) * (bh + rh * repoFactor())) };
}
function winOdds(r, ac, amount) {
  const qd = quote(ac, r), t = typeOf(ac), cl = D.clients.find(c => c.name === r.client) || { bud_lo: 0.95, bud_hi: 1.2 };
  const rep = D.me.rep, repF = 1 + (rep - 50) / 400, edge = 1 - 0.03 * upg('broker');
  let w = 0; const N = 500;
  for (let i = 0; i < N; i++) {
    const budget = qd.basis * rand(+cl.bud_lo, +cl.bud_hi) * (1 + (rep - 50) / 600) + 0.55 * t.rate * qd.rh * 0.6;
    if (amount > budget) continue;
    let m = Infinity; for (let c = 0; c < r.npc; c++) m = Math.min(m, 0.92 + Math.random() * 0.30 + Math.random() * 0.22);
    if (amount / qd.basis / repF * edge < m) w++;
  }
  return w / N;
}
function cruiseFL(t, from, to, d) {
  let fl = d < 150 ? 220 : d < 300 ? 300 : d < 600 ? 360 : d < 1500 ? 400 : 430; fl = Math.min(fl, t.ceil); const east = brg(from, to) < 180;
  if (fl > 410 && t.ceil >= 450) return east ? 450 : 430;
  fl = Math.min(fl, 410); let f = Math.floor(fl / 10); if (east && f % 2 === 0) f--; if (!east && f % 2 === 1) f--; return f * 10;
}
function alternate(icao) { let best = null, bd = 1e9; for (const a of D.apList) { if (a.icao === icao) continue; const d = nm(icao, a.icao); if (d < bd) { bd = d; best = a.icao } } return [best, bd] }
function prevLoc(trip) { const ac = acById(trip.aircraft_id); const qd = queue(ac); const i = qd.findIndex(t => t.id === trip.id); return i <= 0 ? ac.loc : qd[i - 1].to_icao }
function plan(trip) {
  const ac = acById(trip.aircraft_id), t = typeOf(ac), r = { ...trip };
  const from = prevLoc(trip), qd = quote(ac, r, trip.from_icao);
  const [alt, altd] = alternate(trip.to_icao);
  const tripFuel = Math.round(t.burn * (trip.dist / t.ktas) + t.burn * 0.25), altFuel = Math.round(t.burn * (altd / t.ktas + 0.15)), res = Math.round(t.burn * 0.75), taxi = Math.round(t.burn * 0.08);
  return { ac, t, from, bh: qd.bh, opc: Math.round(opRate(t) * qd.bh * (trip.kind === 'ferry' ? repoFactor() : 1)), alt, altd, fl: cruiseFL(t, trip.from_icao, trip.to_icao, trip.dist), tripFuel, altFuel, res, taxi, block: tripFuel + altFuel + res + taxi, payload: trip.pax * 230 };
}

/* ---------- time ---------- */
function fmtDep(ts) {
  if (!ts) return '—'; const d = new Date(ts), n = new Date(); const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(n).setHours(0, 0, 0, 0)) / 864e5);
  return day === 0 ? `Today ${t}` : day === 1 ? `Tmrw ${t}` : day === -1 ? `Yday ${t}` : `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })} ${t}`;
}
const fmtDate = ts => new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
function mmss(ms) { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return s >= 3600 ? `${Math.floor(s / 3600)}h ${pad(Math.floor(s % 3600 / 60))}m` : `${Math.floor(s / 60)}:${pad(s % 60)}` }
const ts = v => new Date(v).getTime();

/* ---------- toasts and sound ---------- */
function toast(msg, kind) { const el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.textContent = msg; $('#toasts').prepend(el); setTimeout(() => el.remove(), 5500); while ($('#toasts').children.length > 4) $('#toasts').lastChild.remove() }
let actx = null;
function ring() {
  if (!UI.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const now = actx.currentTime;
    for (let k = 0; k < 2; k++) for (let i = 0; i < 8; i++) { const o = actx.createOscillator(), g = actx.createGain(), t0 = now + k * 1.2 + i * 0.05; o.frequency.value = i % 2 ? 440 : 480; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05); o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + 0.06) }
  } catch (e) { }
}

/* ---------- boot ---------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') location.reload() });
  if (!session) return renderAuth();
  await loadStatic();
  D.uid = session.user.id;
  D.me = await q(sb.from('pilots').select('*').eq('id', D.uid).maybeSingle());
  if (!D.me) return renderOnboarding();
  await refreshCore();
  UI.acId = D.fleet[0]?.id;
  const h = location.hash.slice(1); if (TABS.some(t => t[0] === h)) UI.tab = h;
  document.body.classList.add('in');
  $('#top').hidden = false;
  renderAll();
  await doPoll();
  pollTimer = setInterval(doPoll, 4000);
  setInterval(() => { clock(); updateCountdowns() }, 1000);
}
async function loadStatic() {
  const [settings, aps, types, clients] = await Promise.all([
    q(sb.from('va_settings').select('*').single()),
    q(sb.from('airports').select('*').order('icao').limit(5000)),
    q(sb.from('aircraft_types').select('*').order('price')),
    q(sb.from('clients').select('*'))]);
  D.settings = settings; D.apList = aps.filter(a => a.active); D.airports = Object.fromEntries(aps.map(a => [a.icao, a]));
  D.types = Object.fromEntries(types.map(t => [t.code, t])); D.typeList = types; D.clients = clients;
  document.title = `${settings.va_name} · Charter Desk`;
}
async function refreshCore() {
  const u = D.uid;
  const [me, fleet, requests, bids, calls, trips, pireps] = await Promise.all([
    q(sb.from('pilots').select('*').eq('id', u).single()),
    q(sb.from('fleet').select('*').eq('pilot_id', u).order('created_at')),
    q(sb.from('requests').select('*').in('status', ['open', 'deciding']).order('expires_at').limit(200)),
    q(sb.from('bids').select('*').eq('pilot_id', u).order('id', { ascending: false }).limit(25)),
    q(sb.from('calls').select('*').eq('pilot_id', u).eq('status', 'ringing')),
    q(sb.from('trips').select('*').eq('pilot_id', u).in('status', ['booked', 'flying', 'filed']).order('seq')),
    q(sb.from('pireps').select('id,trip_id,status,net,rep_delta,landing_fpm,block_h,created_at,review_note').eq('pilot_id', u).order('id', { ascending: false }).limit(8))]);
  const prevCall = D.calls[0]?.id;
  Object.assign(D, { me, fleet, requests, bids, calls, trips, myPireps: pireps });
  if (D.calls[0] && D.calls[0].id !== prevCall) ring();
}
let polling = false;
async function doPoll() {
  if (polling) return; polling = true;
  try {
    const res = await rpc('poll');
    for (const e of (res.events || [])) toast(e.won ? `Won: ${e.client}, ${e.route} at ${money(e.amount)}. It's in your trips.` : `Lost ${e.route}. ${e.note}`, e.won ? 'ok' : 'bad');
    await refreshCore();
    renderHeader(); renderCall();
    if (['market', 'trips'].includes(UI.tab) && !$('#modal').children.length) renderTabSafe();
  } catch (e) { console.warn(e) }
  polling = false;
}

/* ---------- auth screens ---------- */
function renderAuth(mode) {
  mode = mode || 'in';
  $('#main').innerHTML = `<div class="authwrap"><form class="authcard" id="authForm">
    <h1>Charter Desk</h1><p>${mode === 'in' ? 'Sign in to run your charter company.' : 'Create a pilot account. You\'ll set up your company next.'}</p>
    <div class="field"><label for="aEmail">Email</label><input id="aEmail" type="email" autocomplete="email" required></div>
    <div class="field"><label for="aPass">Password</label><input id="aPass" type="password" autocomplete="${mode === 'in' ? 'current-password' : 'new-password'}" minlength="8" required></div>
    <div class="err" id="aErr"></div>
    <button class="btn pri" type="submit">${mode === 'in' ? 'Sign in' : 'Create account'}</button>
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <button class="linkbtn" type="button" id="aSwitch">${mode === 'in' ? 'New pilot? Create an account' : 'Already registered? Sign in'}</button>
      ${mode === 'in' ? '<button class="linkbtn" type="button" id="aReset">Forgot password</button>' : ''}</div>
  </form></div>`;
  $('#aSwitch').onclick = () => renderAuth(mode === 'in' ? 'up' : 'in');
  if ($('#aReset')) $('#aReset').onclick = async () => {
    const email = $('#aEmail').value.trim(); if (!email) { $('#aErr').textContent = 'Enter your email first.'; return }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    $('#aErr').textContent = error ? error.message : 'Check your email for a reset link.';
  };
  $('#authForm').onsubmit = async e => {
    e.preventDefault(); $('#aErr').textContent = '';
    const email = $('#aEmail').value.trim(), password = $('#aPass').value;
    const { data, error } = mode === 'in' ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { $('#aErr').textContent = error.message; return }
    if (mode === 'up' && !data.session) { $('#aErr').textContent = 'Check your email to confirm the account, then sign in.'; return }
    boot();
  };
}
function renderOnboarding() {
  const opts = D.apList.map(a => `<option value="${a.icao}" ${a.icao === D.settings.start_home ? 'selected' : ''}>${a.icao} · ${esc(a.city)}</option>`).join('');
  $('#main').innerHTML = `<div class="authwrap"><form class="authcard" id="obForm">
    <h1>Found your company</h1><p>You start with ${money(D.settings.start_cash)} and one ${esc(D.types[D.settings.start_type]?.name || 'aircraft')} at your home base.</p>
    <div class="row2"><div class="field"><label for="obCs">Pilot callsign</label><input id="obCs" maxlength="8" placeholder="ALT001" required></div>
    <div class="field"><label for="obName">Your name</label><input id="obName" maxlength="40" required></div></div>
    <div class="field"><label for="obCo">Company name</label><input id="obCo" maxlength="40" placeholder="Jersey Executive Charter" required></div>
    <div class="row2"><div class="field"><label for="obPx">Flight number prefix</label><input id="obPx" maxlength="3" placeholder="JEC" required></div>
    <div class="field"><label for="obHome">Home base</label><select id="obHome">${opts}</select></div></div>
    <div class="err" id="obErr"></div><button class="btn pri" type="submit">Start trading</button></form></div>`;
  $('#obCo').oninput = () => { if (!$('#obPx').dataset.touched) $('#obPx').value = $('#obCo').value.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 3) };
  $('#obPx').oninput = () => $('#obPx').dataset.touched = '1';
  $('#obForm').onsubmit = async e => {
    e.preventDefault();
    try { await rpc('ensure_pilot', { p_callsign: $('#obCs').value, p_name: $('#obName').value, p_company: $('#obCo').value, p_prefix: $('#obPx').value, p_home: $('#obHome').value }); boot() }
    catch (err) { $('#obErr').textContent = err.message }
  };
}

/* ---------- header, call, countdowns ---------- */
function renderHeader() {
  $('#vaName').textContent = D.settings.va_name + ' · ' + D.me.callsign;
  $('#coName').textContent = D.me.company;
  $('#gCash').textContent = money(D.me.cash);
  $('#gRep').textContent = Math.round(D.me.rep) + ' / 100';
  $('#gRepBar').style.width = D.me.rep + '%';
  $('#soundBtn').textContent = UI.sound ? 'Ringer on' : 'Ringer off';
  const counts = { market: D.bids.filter(b => b.status === 'pending').length, trips: D.trips.length };
  $('#tabs').innerHTML = TABS.filter(t => t[0] !== 'staff' || D.me.is_admin).map(([k, l]) =>
    `<a href="#${k}" data-tab="${k}" ${UI.tab === k ? 'aria-current="page"' : ''}>${l}${counts[k] ? `<span class="ct">${counts[k]}</span>` : ''}</a>`).join('');
}
function clock() { const d = new Date(); $('#gClock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
function updateCountdowns() {
  const now = Date.now();
  document.querySelectorAll('[data-cd]').forEach(e => e.textContent = mmss(+e.dataset.cd - now));
  document.querySelectorAll('[data-bar]').forEach(e => { const a = +e.dataset.from, b = +e.dataset.until; e.style.width = clamp((now - a) / (b - a) * 100, 0, 100) + '%' });
}
function renderCall() {
  const c = D.calls[0]; if (!c) { $('#call').innerHTML = ''; return }
  if ($('#call').dataset.id === String(c.id)) return;
  $('#call').dataset.id = c.id;
  const A = D.airports[c.from_icao], B = D.airports[c.to_icao];
  const el = D.fleet.filter(a => fits(typeOf(a), c));
  $('#call').innerHTML = `<div class="callcard" role="alertdialog" aria-label="Incoming call">
  <div class="who"><div class="phone"><svg viewBox="0 0 24 24" fill="#06242b"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1z"/></svg></div>
  <div><b>${esc(c.caller)}</b><div class="muted" style="font-size:12px">${esc(c.client)} · rings off in <span data-cd="${ts(c.expires_at)}"></span></div></div></div>
  <q>${esc(CALL_LINES[c.line % 4](c, A, B))}</q>
  <div class="mono" style="font-size:13px">${c.from_icao} → ${c.to_icao} · ${c.dist.toLocaleString()} nm · ${fmtDep(c.dep_at)}</div>
  <div style="display:flex;justify-content:space-between;align-items:end;gap:10px;flex-wrap:wrap"><div><div class="muted" style="font-size:11px;font-family:var(--f-disp);letter-spacing:.12em;text-transform:uppercase">Offering</div><div class="offer">${money(c.offer)}</div></div>
  ${el.length > 1 ? `<select class="sel" id="callAc" aria-label="Aircraft">${el.map(a => `<option value="${a.id}">${a.reg} · ${a.type_code} @ ${futureLoc(a)}</option>`).join('')}</select>` : el.length ? `<span class="mono muted" style="font-size:12px">${el[0].reg} @ ${futureLoc(el[0])}</span>` : '<span class="muted" style="font-size:12px">No aircraft can fly this</span>'}</div>
  <div class="btns"><button type="button" class="btn pri" data-act="acceptcall" data-id="${c.id}" ${el.length ? '' : 'disabled'}>Accept job</button><button type="button" class="btn" data-act="declinecall" data-id="${c.id}">Decline</button></div></div>`;
  updateCountdowns();
}

/* ---------- tabs ---------- */
function renderAll() { renderHeader(); renderCall(); renderTab() }
function renderTabSafe() { const ae = document.activeElement; if (ae && $('#main').contains(ae) && ae.matches('input,select,textarea')) return; renderTab() }
function renderTab() {
  const f = { market: renderMarket, trips: renderTrips, hangar: renderHangar, shop: renderShop, live: renderLive, reports: renderReports, pilots: renderPilots, ledger: renderLedger, profile: renderProfile, staff: renderStaff }[UI.tab] || renderMarket;
  Promise.resolve(f()).catch(e => { $('#main').innerHTML = `<div class="panel empty">Couldn't load this page: ${esc(e.message)}</div>` });
}

const BANDS = [['any', 'Any'], ['0-1', 'Under 1h'], ['1-2', '1–2h'], ['2-3', '2–3h'], ['3-5', '3–5h'], ['5-99', '5h+']];
const inBand = h => { if (UI.band === 'any') return true; const [a, b] = UI.band.split('-').map(Number); return h >= a && h < b };

function renderMarket() {
  const ac = active(); if (!ac) { $('#main').innerHTML = '<div class="panel empty">You have no aircraft. Add one in the Shop.</div>'; return }
  const t = typeOf(ac);
  let list = D.requests.map(r => ({ r, ok: fits(t, r), q: quote(ac, r) })).filter(x => inBand(blockH(t, x.r.dist)));
  const hidden = list.filter(x => !x.ok).length;
  if (!UI.showAll) list = list.filter(x => x.ok);
  const sorts = { closing: (a, b) => ts(a.r.decide_at || a.r.expires_at) - ts(b.r.decide_at || b.r.expires_at), value: (a, b) => b.q.guide - a.q.guide, dep: (a, b) => ts(a.r.dep_at) - ts(b.r.dep_at), repo: (a, b) => a.q.repoNm - b.q.repoNm };
  list.sort(sorts[UI.sort]);
  const h = new Date().getHours();
  const mood = h < 6 ? 'Overnight: a quiet board, mostly urgent and medical work.' : h < 12 ? 'Morning: business routes between financial centres lead the board.' : h < 17 ? 'Afternoon: a mix of business returns and leisure departures.' : 'Evening: leisure demand to the Med and islands is building.';
  const pending = D.bids.filter(b => b.status === 'pending'), recent = D.bids.filter(b => b.status !== 'pending').slice(0, 7);
  $('#main').innerHTML = `<div class="market">
 <aside class="side">
  <div class="panel"><h3>Bidding with</h3><div class="acpick">${D.fleet.map(a => { const tt = typeOf(a), n = queue(a).length; return `<button type="button" class="acopt" data-act="pickac" data-id="${a.id}" aria-pressed="${a.id === ac.id}"><b>${a.reg}</b><span>${esc(tt.name)}</span><em>At ${futureLoc(a)}${n ? ` after ${n} leg${n > 1 ? 's' : ''}` : ''} · ${tt.seats} seats · ${tt.range_nm.toLocaleString()} nm</em></button>` }).join('')}</div></div>
  <div class="panel"><h3>Flight time</h3><div class="bands">${BANDS.map(([k, l]) => `<button type="button" class="chip" data-act="band" data-k="${k}" aria-pressed="${UI.band === k}">${l}</button>`).join('')}</div>
   <p class="muted" style="font-size:12px;margin:10px 0 0">Block time in the ${esc(t.name)}, including taxi and climb.</p></div>
  <div class="panel"><h3>${esc(t.name)}</h3><div class="specs">
   <div><label>Cruise</label><span>${t.ktas} kt</span></div><div><label>Range</label><span>${t.range_nm.toLocaleString()} nm</span></div>
   <div><label>Seats</label><span>${t.seats}</span></div><div><label>Charter rate</label><span>${kmoney(t.rate)}/h</span></div>
   <div><label>Op. cost</label><span>${kmoney(opRate(t))}/h</span></div><div><label>Fuel burn</label><span>${t.burn.toLocaleString()} lb/h</span></div></div></div>
 </aside>
 <section style="min-width:0">
  <div class="boardhead"><div><h2>Request board · ${new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</h2><p>${mood} Every ${esc(D.settings.va_name)} pilot sees this board.</p></div>
   <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="check"><input type="checkbox" id="showAll" data-act="showall" ${UI.showAll ? 'checked' : ''}> Show requests this aircraft can't fly${hidden && !UI.showAll ? ` (${hidden})` : ''}</label>
   <select class="sel" id="sortSel" data-act="sort" aria-label="Sort requests">${[['closing', 'Closing soonest'], ['value', 'Highest value'], ['dep', 'Earliest departure'], ['repo', 'Closest to aircraft']].map(([k, l]) => `<option value="${k}" ${UI.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
  <div class="strips">${list.length ? list.map(x => strip(x, ac)).join('') : `<div class="empty">No requests in this time band for ${ac.reg} right now. New requests arrive every minute or so.</div>`}</div>
 </section>
 <aside class="bidcol">
  <div class="panel"><h3>Bids with brokers</h3>${pending.length ? `<div style="display:flex;flex-direction:column;gap:8px">${pending.map(b => { const r = D.requests.find(x => x.id === b.request_id); const until = r?.decide_at ? ts(r.decide_at) : Date.now(); return `<div class="bid"><div class="r"><span>${r ? `${r.from_icao} → ${r.to_icao}` : 'Request'}</span><b>${money(b.amount)}</b></div><div class="bar"><i data-bar data-from="${ts(b.placed_at)}" data-until="${until}"></i></div><small>${acById(b.aircraft_id)?.reg || ''}${r && r.player_bids > 1 ? ` · ${r.player_bids - 1} other VA pilot${r.player_bids > 2 ? 's' : ''} quoting` : ''} · decision in <span data-cd="${until}"></span></small></div>` }).join('')}</div>` : `<p class="muted" style="margin:0;font-size:13px">No open bids. Pick a strip and quote a price. The broker decides ${BIDWAIT[Math.min(3, upg('fast'))]} seconds after the first quote.</p>`}</div>
  <div class="panel"><h3>Recent decisions</h3>${recent.length ? recent.map(b => `<div class="result"><span class="tag ${b.status}">${b.status === 'won' ? 'Won' : 'Lost'}</span><div><span class="mono">${money(b.amount)}</span><br><span class="muted">${esc(b.note || '')}</span></div></div>`).join('') : '<p class="muted" style="margin:0;font-size:13px">Broker decisions appear here.</p>'}</div>
 </aside></div>`;
  updateCountdowns();
}
function strip({ r, ok, q: qd }, ac) {
  const t = typeOf(ac), bid = D.bids.find(b => b.request_id === r.id), A = D.airports[r.from_icao] || {}, B = D.airports[r.to_icao] || {};
  const deciding = r.status === 'deciding';
  let act;
  if (!ok) act = esc(whyNot(t, r));
  else if (bid) act = `<span class="placed">Bid ${kmoney(bid.amount)}</span><span class="cd">decision <span data-cd="${ts(r.decide_at)}"></span></span>`;
  else act = `<button type="button" data-act="bid" data-id="${r.id}">Quote</button><span class="cd">${deciding ? `deciding <span data-cd="${ts(r.decide_at)}"></span>` : `closes <span data-cd="${ts(r.expires_at)}"></span>`}</span>`;
  return `<article class="strip ${ok ? '' : 'na'}">
 <div class="band ${r.cat}"></div>
 <div class="s-client"><b>${esc(r.client)}</b><span>REQ ${r.id} · ${r.npc} quoting${r.player_bids ? ` + ${r.player_bids} VA` : ''}</span></div>
 <div class="s-route"><div class="codes">${r.from_icao}<i>▸</i>${r.to_icao}</div><div class="names">${esc(A.city)} to ${esc(B.city)}</div>${ok && qd.repoNm ? `<div class="repo">+ position ${qd.repoNm} nm from ${qd.loc}</div>` : ''}</div>
 <div class="c-dist"><label>Dist</label><span class="v">${r.dist.toLocaleString()} nm</span></div>
 <div class="c-blk"><label>Block</label><span class="v">${hm(blockH(t, r.dist))}</span></div>
 <div class="c-pax"><label>Pax</label><span class="v">${r.pax}</span></div>
 <div class="c-dep"><label>Dep</label><span class="v">${fmtDep(r.dep_at)}</span></div>
 <div class="c-guide"><label>Guide</label><span class="v">${ok ? kmoney(qd.guide) : '—'}</span></div>
 <div class="s-act">${act}</div></article>`;
}

function renderTrips() {
  const list = D.trips.slice().sort((a, b) => (a.aircraft_id || '').localeCompare(b.aircraft_id || '') || a.seq - b.seq);
  const reps = D.myPireps;
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Trips</h2><p>Fly each leg with the Charter Desk Tracker: load the aircraft at the departure gate, pick the booking in the tracker and press Start flight. The report files itself at block on.</p></div><a class="btn" href="#profile" data-tab="profile">Get the tracker</a></div>
  ${list.length ? `<div class="trips">${list.map(tripCard).join('')}</div>` : `<div class="panel empty">Nothing booked. Quote on the request board or wait for the phone to ring.<div style="margin-top:12px"><a class="btn pri" href="#market" data-tab="market">Open the request board</a></div></div>`}</div>
  ${reps.length ? `<div class="section"><h2>Your recent reports</h2><div class="panel tablewrap"><table class="grid"><thead><tr><th>Filed</th><th>Status</th><th>Block</th><th>Landing</th><th>Net</th><th>Rep</th><th>Note</th></tr></thead><tbody>${reps.map(p => `<tr class="click" data-act="pirep" data-id="${p.id}"><td class="n">${fmtDate(p.created_at)}</td><td><span class="tag ${p.status}">${p.status}</span></td><td class="n">${hm(p.block_h)}</td><td class="n">${p.landing_fpm ?? '—'} fpm</td><td class="n">${p.net == null ? '—' : money(p.net)}</td><td class="n">${p.rep_delta == null ? '—' : (p.rep_delta > 0 ? '+' : '') + (+p.rep_delta).toFixed(1)}</td><td>${esc(p.review_note || '')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}`;
  list.forEach(tr => drawMap(document.getElementById('map-' + tr.id), tr));
}
function tripCard(trip) {
  const ac = acById(trip.aircraft_id); if (!ac) return '';
  const p = plan(trip), t = p.t, qd = queue(ac), first = qd[0]?.id === trip.id, ferry = trip.kind === 'ferry';
  const profit = trip.price - p.opc;
  const fltNum = (trip.flt.split(' ')[1] || '').replace(/\D/g, '');
  const sbUrl = `https://dispatch.simbrief.com/options/custom?type=${ac.type_code}&orig=${trip.from_icao}&dest=${trip.to_icao}&altn=${p.alt}&airline=${D.me.prefix}&fltnum=${fltNum}&reg=${ac.reg}&pax=${trip.pax}&fl=${p.fl * 100}`;
  const A = D.airports[trip.from_icao], B = D.airports[trip.to_icao];
  const state = trip.status === 'flying' ? '<span class="tag flying">In flight</span>' : trip.status === 'filed' ? '<span class="tag filed">Awaiting review</span>' : first ? '<span class="tag won">Ready to fly</span>' : '<span class="tag pending">Queued</span>';
  const ferryCost = Math.round(opRate(t) * p.bh * 1.5);
  return `<article class="trip"><div class="info">
  <div class="flt"><b>${trip.flt}</b><span class="muted">${ac.reg} · ${esc(t.name)}</span>${ferry ? '<span class="tag ferry">Positioning</span>' : `<span class="tag ${trip.source === 'call' ? 'call' : 'won'}">${trip.source === 'call' ? 'Phone booking' : 'Won bid'}</span>`}${state}</div>
  <div><div class="route">${trip.from_icao}<i>▸</i>${trip.to_icao}</div><div class="places">${esc(A?.name)}, ${esc(A?.city)} to ${esc(B?.name)}, ${esc(B?.city)}${ferry ? ' · empty' : ` · ${esc(trip.caller ? trip.caller + ' (' + trip.client + ')' : trip.client)}`}</div></div>
  <div class="grid4">
   <div class="kv"><label>${ferry ? 'Position by' : 'Departs'}</label><span>${fmtDep(trip.dep_at)}</span></div>
   <div class="kv"><label>Distance</label><span>${trip.dist.toLocaleString()} nm</span></div>
   <div class="kv"><label>Est. block</label><span>${hm(p.bh)}</span></div>
   <div class="kv"><label>Cruise</label><span>FL${p.fl}</span></div>
   <div class="kv"><label>Passengers</label><span>${trip.pax} · ${p.payload.toLocaleString()} lb</span></div>
   <div class="kv"><label>Block fuel</label><span>${p.block.toLocaleString()} lb</span></div>
   <div class="kv"><label>Alternate</label><span>${p.alt} · ${p.altd} nm</span></div>
   <div class="kv"><label>Course</label><span>${String(Math.round(brg(trip.from_icao, trip.to_icao))).padStart(3, '0')}°</span></div>
   <div class="kv"><label>Revenue</label><span>${money(trip.price)}</span></div>
   <div class="kv"><label>Est. op. cost</label><span>${money(p.opc)}</span></div>
   <div class="kv"><label>Est. profit</label><span class="${profit >= 0 ? 'pos' : 'neg'}">${money(profit)}</span></div>
   <div class="kv"><label>Fuel split</label><span style="font-size:12px">Trip ${p.tripFuel.toLocaleString()} · Res ${p.res.toLocaleString()}</span></div>
  </div>
  <div class="btns">
   <a class="btn" href="${sbUrl}" target="_blank" rel="noopener">Plan in SimBrief ↗</a>
   <button type="button" class="btn" data-act="copyplan" data-id="${trip.id}">Copy plan</button>
   ${ferry && first && trip.status === 'booked' ? `<button type="button" class="btn" data-act="outsource" data-id="${trip.id}" data-cost="${ferryCost}">Use a contract crew · ${kmoney(ferryCost)}</button>` : ''}
   ${!ferry && trip.status === 'booked' ? `<button type="button" class="btn danger" data-act="cancel" data-id="${trip.id}">Cancel</button>` : ''}
  </div>
  ${!first && trip.status === 'booked' ? `<div class="waiting">Fly ${qd[0].flt} (${qd[0].from_icao} → ${qd[0].to_icao}) with ${ac.reg} first.</div>` : ''}
 </div><div class="mapbox"><canvas id="map-${trip.id}" aria-label="Route map ${trip.from_icao} to ${trip.to_icao}"></canvas></div></article>`;
}
function drawMap(cv, trip) {
  if (!cv) return; const p = plan(trip); const [alt] = [p.alt];
  const pts = [trip.from_icao, trip.to_icao, alt].map(k => D.airports[k]).filter(Boolean);
  const box = cv.parentElement.getBoundingClientRect(); const W = Math.max(260, box.width), H = Math.max(240, box.height); const dpr = window.devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const la = pts.map(a => a.lat), lo = pts.map(a => a.lon); const minLa = Math.min(...la), maxLa = Math.max(...la), minLo = Math.min(...lo), maxLo = Math.max(...lo);
  const midLat = (minLa + maxLa) / 2, k = Math.cos(midLat * R); const sp = Math.max((maxLo - minLo) * k / W, (maxLa - minLa) / H, 2 / Math.min(W, H)) * 1.45;
  const cx = (minLo + maxLo) / 2, cy = midLat; const X = lon => W / 2 + (lon - cx) * k / sp, Y = lat => H / 2 - (lat - cy) / sp;
  c.fillStyle = '#0a0f12'; c.fillRect(0, 0, W, H);
  const step = sp * Math.min(W, H) > 20 ? 10 : sp * Math.min(W, H) > 8 ? 5 : 2; c.strokeStyle = '#18232a'; c.lineWidth = 1; c.font = '10px "IBM Plex Mono",monospace'; c.fillStyle = '#3b4a52';
  for (let g = Math.floor((cy - H * sp / 2) / step) * step; g < cy + H * sp / 2; g += step) { const y = Y(g); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); c.fillText(`${Math.abs(g)}°${g >= 0 ? 'N' : 'S'}`, 4, y - 3) }
  for (let g = Math.floor((cx - W * sp / k / 2) / step) * step; g < cx + W * sp / k / 2; g += step) { const x = X(g); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); c.fillText(`${Math.abs(g)}°${g >= 0 ? 'E' : 'W'}`, x + 3, H - 5) }
  D.apList.forEach(a => { const x = X(a.lon), y = Y(a.lat); if (x < 0 || x > W || y < 0 || y > H) return; c.fillStyle = '#34444c'; c.beginPath(); c.arc(x, y, 2, 0, 7); c.fill() });
  const gc = (A, B, dash, col, w) => { c.save(); c.setLineDash(dash); c.strokeStyle = col; c.lineWidth = w; c.beginPath(); const n = 40; const p1 = [A.lat * R, A.lon * R], p2 = [B.lat * R, B.lon * R]; const d = 2 * Math.asin(Math.sqrt(Math.sin((p2[0] - p1[0]) / 2) ** 2 + Math.cos(p1[0]) * Math.cos(p2[0]) * Math.sin((p2[1] - p1[1]) / 2) ** 2)) || 1e-9; for (let i = 0; i <= n; i++) { const f = i / n; const a = Math.sin((1 - f) * d) / Math.sin(d), b = Math.sin(f * d) / Math.sin(d); const x = a * Math.cos(p1[0]) * Math.cos(p1[1]) + b * Math.cos(p2[0]) * Math.cos(p2[1]), y = a * Math.cos(p1[0]) * Math.sin(p1[1]) + b * Math.cos(p2[0]) * Math.sin(p2[1]), z = a * Math.sin(p1[0]) + b * Math.sin(p2[0]); const lat = Math.atan2(z, Math.hypot(x, y)) / R, lon = Math.atan2(y, x) / R; i ? c.lineTo(X(lon), Y(lat)) : c.moveTo(X(lon), Y(lat)) } c.stroke(); c.restore() };
  const F = D.airports[trip.from_icao], T = D.airports[trip.to_icao], AL = D.airports[alt];
  if (AL) gc(T, AL, [2, 3], '#4b5a62', 1);
  gc(F, T, trip.kind === 'ferry' ? [5, 4] : [], trip.kind === 'ferry' ? '#c98a24' : '#f0a83a', 2.5);
  const lab = (a, col, txt, r) => { const x = X(a.lon), y = Y(a.lat); c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.font = '600 12px "IBM Plex Mono",monospace'; c.fillStyle = '#e3e8ea'; const tw = c.measureText(txt).width; let tx = x + 8; if (tx + tw > W - 4) tx = x - 8 - tw; c.fillText(txt, tx, y - 6) };
  if (AL) lab(AL, '#6a7a82', alt + ' ALT', 2.5); lab(F, '#f0a83a', trip.from_icao, 4.5); lab(T, '#f0a83a', trip.to_icao, 4.5);
}

function renderHangar() {
  const used = D.fleet.length;
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Hangar</h2><p>${used} of ${D.me.slots} fleet slots in use. Aircraft stay wherever their last flight ended.</p></div></div>
  <form class="panel" id="coForm" style="display:flex;gap:12px;align-items:end;flex-wrap:wrap"><div class="field" style="flex:1;min-width:200px"><label for="coInput">Company name</label><input id="coInput" maxlength="40" value="${esc(D.me.company)}"></div>
   <div class="field" style="width:120px"><label for="pxInput">Flight prefix</label><input id="pxInput" maxlength="3" value="${esc(D.me.prefix)}"></div><button class="btn pri" type="submit">Save</button></form>
  <div class="cards">${D.fleet.map(a => { const t = typeOf(a), n = queue(a).length; return `<div class="card ${a.id === active()?.id ? 'active' : ''}"><div class="hd"><b class="mono">${a.reg}</b><span>${a.type_code}</span></div><p>${esc(t.name)} · ${esc(t.cls)}</p>
  <div class="specs"><div><label>Location</label><span>${a.loc} ${esc(D.airports[a.loc]?.city || '')}</span></div><div><label>Hours flown</label><span>${hm(a.hours)}</span></div><div><label>Legs queued</label><span>${n}</span></div><div><label>Seats / range</label><span>${t.seats} / ${t.range_nm.toLocaleString()} nm</span></div></div>
  <div class="foot">${a.id === active()?.id ? '<span class="tag won">Bidding aircraft</span>' : `<button type="button" class="btn" data-act="pickac" data-id="${a.id}">Bid with this</button>`}
  ${D.fleet.length > 1 ? `<button type="button" class="btn danger" data-act="sell" data-id="${a.id}" ${n ? 'disabled title="Finish or cancel its trips first"' : ''}>Sell ${kmoney(Math.round(t.price * 0.6))}</button>` : ''}</div></div>` }).join('')}
  ${Array.from({ length: Math.max(0, D.me.slots - used) }, () => `<div class="card" style="border-style:dashed;justify-content:center;align-items:center;text-align:center;min-height:180px"><p>Empty slot</p><a class="btn" href="#shop" data-tab="shop">Add an aircraft</a></div>`).join('')}</div></div>`;
  $('#coForm').onsubmit = async e => { e.preventDefault(); await act(() => rpc('update_company', { p_company: $('#coInput').value, p_prefix: $('#pxInput').value }), 'Company details saved.') };
}

function renderShop() {
  const free = D.me.slots - D.fleet.length, slotCost = 60000 * 2 ** (D.me.slots - 2), cash = D.me.cash;
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Aircraft</h2><p>Each aircraft takes a fleet slot and is delivered to your home base, ${D.me.home}. Prices are the lease deposit. ${free ? `You have ${free} free slot${free > 1 ? 's' : ''}.` : 'All slots are full, so buy a slot first.'}</p></div>
  <div class="card" style="min-width:min(300px,100%)"><div class="hd"><b>Fleet slot ${D.me.slots + 1}</b><span class="price">${kmoney(slotCost)}</span></div><button type="button" class="btn pri" data-act="buyslot" ${cash < slotCost ? 'disabled' : ''}>Buy slot</button></div></div>
 <div class="cards">${D.typeList.map(t => { const own = D.fleet.filter(a => a.type_code === t.code).length; return `<div class="card"><div class="hd"><b>${esc(t.name)}</b><span>${t.code}</span></div><p>${esc(t.cls)}${own ? ` · ${own} in fleet` : ''}</p>
  <div class="specs"><div><label>Seats</label><span>${t.seats}</span></div><div><label>Range</label><span>${t.range_nm.toLocaleString()} nm</span></div><div><label>Cruise</label><span>${t.ktas} kt</span></div><div><label>Charter rate</label><span>${kmoney(t.rate)}/h</span></div></div>
  <div class="foot"><span class="price">${kmoney(t.price)}</span><button type="button" class="btn ${free && cash >= t.price ? 'pri' : ''}" data-act="buyac" data-k="${t.code}" ${!free || cash < t.price ? 'disabled' : ''}>Add to fleet</button></div></div>` }).join('')}</div></div>
 <div class="section"><div class="sechead"><div><h2>Company upgrades</h2><p>Permanent improvements to how your desk wins and runs work.</p></div></div>
 <div class="cards">${Object.entries(UPG).map(([k, u]) => { const l = upg(k), c = u.cost[l]; return `<div class="card"><div class="hd"><b>${u.name}</b><div class="pips">${u.cost.map((_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('')}</div></div><p>${u.desc}</p>
  <div class="foot">${l >= u.cost.length ? '<span class="tag won">Maxed</span>' : `<span class="price">${kmoney(c)}</span><button type="button" class="btn ${cash >= c ? 'pri' : ''}" data-act="upg" data-k="${k}" ${cash < c ? 'disabled' : ''}>Level ${l + 1}</button>`}</div></div>` }).join('')}</div></div>`;
}

async function renderLedger() {
  const rows = await q(sb.from('ledger').select('*').eq('pilot_id', D.uid).order('id', { ascending: false }).limit(150));
  const flown = await q(sb.from('pireps').select('block_h,dist_flown,revenue').eq('pilot_id', D.uid).eq('status', 'accepted').limit(5000));
  const sum = (a, k) => a.reduce((s, x) => s + (+x[k] || 0), 0);
  $('#main').innerHTML = `<div class="section"><h2>Ledger</h2>
 <div class="stats">${[['Balance', money(D.me.cash)], ['Flights flown', flown.length], ['Block hours', hm(sum(flown, 'block_h'))], ['Miles flown', sum(flown, 'dist_flown').toLocaleString() + ' nm'], ['Revenue', money(sum(flown, 'revenue'))], ['Reputation', Math.round(D.me.rep)]].map(([l, v]) => `<div class="panel kv"><label>${l}</label><span style="font-size:18px">${v}</span></div>`).join('')}</div>
 <div class="panel tablewrap"><table class="ledger"><tbody>${rows.map(e => `<tr><td class="t">${fmtDate(e.at)}</td><td>${esc(e.text)}</td><td class="a" style="color:${e.amount >= 0 ? 'var(--ok)' : 'var(--bad)'}">${e.amount ? money(e.amount) : ''}</td></tr>`).join('')}</tbody></table></div></div>`;
}

/* ---------- live map ---------- */
const planeSvg = (hdg, col) => `<svg width="26" height="26" viewBox="0 0 24 24" style="transform:rotate(${hdg}deg)"><path fill="${col}" stroke="#0a0f12" stroke-width=".8" d="M12 2c.8 0 1.3.9 1.3 2v5.2l7.7 4.6v2l-7.7-2.3v4.6l2.2 1.7V21L12 20.1 8.5 21v-1.2l2.2-1.7v-4.6L3 15.8v-2l7.7-4.6V4c0-1.1.5-2 1.3-2z"/></svg>`;
async function renderLive() {
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Live map</h2><p id="liveNote">Pilots flying with the tracker right now. Updates every 15 seconds.</p></div></div><div id="livemap"></div></div>`;
  liveMap = L.map('livemap', { worldCopyJump: true }).setView([48, 4], 4);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: 'abcd', maxZoom: 12 }).addTo(liveMap);
  liveLayer = L.layerGroup().addTo(liveMap);
  await refreshLive(true);
}
async function refreshLive(fit) {
  if (UI.tab !== 'live' || !liveMap) return;
  const rows = await q(sb.from('positions').select('*, pilots(callsign,company), trips(flt,from_icao,to_icao)'));
  liveLayer.clearLayers();
  const bounds = [];
  rows.forEach(p => {
    const t = p.trips, A = t && D.airports[t.from_icao], B = t && D.airports[t.to_icao];
    if (A && B) L.polyline([[A.lat, A.lon], [p.lat, p.lon], [B.lat, B.lon]], { color: '#f0a83a', weight: 1.5, opacity: .6, dashArray: '4 4' }).addTo(liveLayer);
    L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'plane-icon', html: planeSvg(p.hdg || 0, p.pilot_id === D.uid ? '#f0a83a' : '#6cbfd2'), iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindPopup(`<b>${esc(p.pilots?.callsign)}</b> · ${esc(p.pilots?.company)}<br>${t ? `${esc(t.flt)} ${t.from_icao} → ${t.to_icao}<br>` : ''}<span class="mono">${(p.alt || 0).toLocaleString()} ft · ${p.gs || 0} kt · ${esc(p.phase || '')}</span>`).addTo(liveLayer);
    bounds.push([p.lat, p.lon]);
  });
  $('#liveNote').textContent = rows.length ? `${rows.length} pilot${rows.length > 1 ? 's' : ''} flying now. Updates every 15 seconds.` : 'Nobody is flying right now. Aircraft appear here when a pilot starts the tracker.';
  if (fit && bounds.length) liveMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 7 });
}
setInterval(() => refreshLive(false).catch(() => { }), 15000);

/* ---------- reports and pilots ---------- */
async function renderReports() {
  const rows = await q(sb.from('pireps').select('id,status,landing_fpm,block_h,net,created_at,arr_icao,trips(flt,from_icao,to_icao,kind),pilots(callsign)').order('id', { ascending: false }).limit(60));
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Flight reports</h2><p>The latest flights across the VA. Select one to see its track and checks.</p></div></div>
  <div class="panel tablewrap"><table class="grid"><thead><tr><th>Filed</th><th>Pilot</th><th>Flight</th><th>Route</th><th>Block</th><th>Landing</th><th>Status</th></tr></thead><tbody>
  ${rows.length ? rows.map(p => `<tr class="click" data-act="pirep" data-id="${p.id}"><td class="n">${fmtDate(p.created_at)}</td><td class="n">${esc(p.pilots?.callsign)}</td><td class="n">${esc(p.trips?.flt)}${p.trips?.kind === 'ferry' ? ' <span class="tag ferry">Pos</span>' : ''}</td><td class="n">${p.trips?.from_icao} → ${p.arr_icao}</td><td class="n">${hm(p.block_h)}</td><td class="n">${p.landing_fpm ?? '—'} fpm</td><td><span class="tag ${p.status}">${p.status}</span></td></tr>`).join('') : '<tr><td colspan="7" class="muted">No flights filed yet.</td></tr>'}
  </tbody></table></div></div>`;
}
async function openPirep(id, staff) {
  const p = await q(sb.from('pireps').select('*,trips(flt,from_icao,to_icao,kind,client,price,dist),pilots(callsign,name,company)').eq('id', id).single());
  const t = p.trips || {};
  const checkNames = { departure: 'Departure airport', arrival: 'Arrival airport', aircraft: 'Aircraft type', speed: 'Plausible speed', crash: 'No crash', slew: 'No slew', sim_rate: 'Normal sim rate', overspeed: 'No overspeed below 10,000 ft' };
  const checks = Object.entries(p.checks || {}).map(([k, v]) => `<span class="${v.ok ? 'check-ok' : 'check-bad'}">${v.ok ? '✓' : '✗'} ${checkNames[k] || k}${k === 'departure' || k === 'arrival' ? ` (${v.nm} nm)` : ''}${k === 'sim_rate' && !v.ok ? ` ×${v.max}` : ''}${k === 'overspeed' && !v.ok ? ` ${v.seconds}s` : ''}</span>`).join('');
  $('#modal').innerHTML = `<div class="scrim" data-act="scrim"><div class="modal" role="dialog" aria-modal="true" aria-label="Flight report" style="width:min(720px,100%)">
  <div><h3 style="margin:0 0 4px">${esc(t.flt)} · ${esc(p.pilots?.callsign)} · ${esc(p.pilots?.company)}</h3><div class="route">${t.from_icao}<i>▸</i>${p.arr_icao}${p.arr_icao !== t.to_icao ? ` <span class="muted" style="font-size:14px">planned ${t.to_icao}</span>` : ''}</div>
  <div class="muted" style="font-size:13px">${esc(p.sim || '')} · ${esc(p.aircraft_title || '')} · <span class="tag ${p.status}">${p.status}</span></div></div>
  <div class="pmap" id="pmap"></div>
  <div class="grid4">
   <div class="kv"><label>Block off</label><span>${new Date(p.block_off).toISOString().slice(11, 16)}Z</span></div>
   <div class="kv"><label>Block on</label><span>${new Date(p.block_on).toISOString().slice(11, 16)}Z</span></div>
   <div class="kv"><label>Block / air</label><span>${hm(p.block_h)} / ${p.air_h != null ? hm(p.air_h) : '—'}</span></div>
   <div class="kv"><label>Distance flown</label><span>${p.dist_flown ?? '—'} nm</span></div>
   <div class="kv"><label>Landing</label><span>${p.landing_fpm ?? '—'} fpm</span></div>
   <div class="kv"><label>G / bounces</label><span>${p.landing_g ?? '—'} / ${p.bounces}</span></div>
   <div class="kv"><label>Fuel used</label><span>${p.fuel_used_lb != null ? Math.round(p.fuel_used_lb).toLocaleString() + ' lb' : '—'}</span></div>
   <div class="kv"><label>Net</label><span class="${(p.net || 0) >= 0 ? 'pos' : 'neg'}">${p.net == null ? '—' : money(p.net)}</span></div></div>
  <div class="checks">${checks}</div>
  ${p.review_note ? `<div class="note">${esc(p.review_note)}</div>` : ''}
  ${staff && p.status === 'pending' ? `<div class="field"><label for="rvNote">Note to the pilot</label><input id="rvNote" maxlength="200" placeholder="e.g. Diverted for weather, accepted"></div>
   <div class="btns" style="justify-content:flex-end"><button type="button" class="btn danger" data-act="review" data-id="${p.id}" data-ok="0">Reject</button><button type="button" class="btn pri" data-act="review" data-id="${p.id}" data-ok="1">Accept and pay</button></div>` : `<div class="btns" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Close</button></div>`}
  </div></div>`;
  const m = L.map('pmap', { attributionControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 12 }).addTo(m);
  const path = (p.path || []).map(x => [x[0], x[1]]);
  const A = D.airports[t.from_icao], B = D.airports[t.to_icao];
  if (A && B) L.polyline([[A.lat, A.lon], [B.lat, B.lon]], { color: '#4b5a62', weight: 1, dashArray: '3 4' }).addTo(m);
  if (path.length > 1) L.polyline(path, { color: '#f0a83a', weight: 2.5 }).addTo(m);
  const bounds = path.length > 1 ? path : (A && B ? [[A.lat, A.lon], [B.lat, B.lon]] : [[48, 4]]);
  m.fitBounds(bounds, { padding: [30, 30], maxZoom: 9 });
}
async function renderPilots() {
  const [pilots, reps] = await Promise.all([
    q(sb.from('pilots').select('id,callsign,name,company,rep,cash,is_admin,created_at').order('rep', { ascending: false })),
    q(sb.from('pireps').select('pilot_id,landing_fpm,block_h').eq('status', 'accepted').limit(10000))]);
  const st = {}; reps.forEach(r => { const s = st[r.pilot_id] ||= { n: 0, h: 0, l: 0, ln: 0 }; s.n++; s.h += +r.block_h || 0; if (r.landing_fpm != null) { s.l += r.landing_fpm; s.ln++ } });
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Pilots</h2><p>Every company flying for ${esc(D.settings.va_name)}, ranked by reputation.</p></div></div>
  <div class="panel tablewrap"><table class="grid"><thead><tr><th>#</th><th>Callsign</th><th>Pilot</th><th>Company</th><th>Reputation</th><th>Flights</th><th>Hours</th><th>Avg landing</th><th>Balance</th></tr></thead><tbody>
  ${pilots.map((p, i) => { const s = st[p.id] || { n: 0, h: 0, ln: 0 }; return `<tr${p.id === D.uid ? ' style="background:var(--panel2)"' : ''}><td class="n">${i + 1}</td><td class="n">${esc(p.callsign)}${p.is_admin ? ' <span class="tag call">Staff</span>' : ''}</td><td>${esc(p.name)}</td><td>${esc(p.company)}</td><td class="n">${Math.round(p.rep)}</td><td class="n">${s.n}</td><td class="n">${hm(s.h)}</td><td class="n">${s.ln ? Math.round(s.l / s.ln) + ' fpm' : '—'}</td><td class="n">${kmoney(p.cash)}</td></tr>` }).join('')}
  </tbody></table></div></div>`;
}

/* ---------- profile ---------- */
async function renderProfile() {
  const key = await rpc('my_tracker_key');
  const code = btoa(JSON.stringify({ u: CFG.supabaseUrl, a: CFG.supabaseAnonKey, k: key }));
  $('#main').innerHTML = `<div class="section"><h2>Flight tracker</h2>
  <div class="panel" style="display:flex;flex-direction:column;gap:14px">
   <ol class="steps"><li>Install FSUIPC for your sim: FSUIPC7 for MSFS 2020/2024, FSUIPC6 for Prepar3D, or XPUIPC for X-Plane. The free versions work.</li>
   <li>Download the Charter Desk Tracker and run it. Windows may ask you to confirm because the app is new.</li>
   <li>Paste the setup code below when the tracker asks for it.</li>
   <li>Load your aircraft at the departure gate, choose the booking in the tracker and press Start flight. Fly normally; the report files itself when you're parked with the brake set or engines off.</li></ol>
   <div class="btns"><a class="btn pri" href="${esc(CFG.trackerDownloadUrl || '#')}" target="_blank" rel="noopener">Download the tracker ↗</a></div>
   <div class="field"><label>Your tracker setup code</label><div class="code" id="setupCode">${code}</div></div>
   <div class="btns"><button type="button" class="btn" data-act="copycode">Copy setup code</button><button type="button" class="btn danger" data-act="rotatekey">Make a new code</button></div>
   <p class="muted" style="margin:0;font-size:12.5px">The code lets the tracker file flights as you. Keep it private. Making a new code stops the old one working.</p></div></div>
  <div class="section"><h2>Account</h2><div class="panel kv" style="display:flex;gap:28px;flex-wrap:wrap"><div><label>Callsign</label><span>${esc(D.me.callsign)}</span></div><div><label>Name</label><span>${esc(D.me.name)}</span></div><div><label>Home base</label><span>${D.me.home}</span></div><div><label>Joined</label><span>${new Date(D.me.created_at).toLocaleDateString('en-GB')}</span></div></div></div>`;
}

/* ---------- staff ---------- */
async function renderStaff() {
  if (!D.me.is_admin) { UI.tab = 'market'; return renderTab() }
  const [pending, pilots] = await Promise.all([
    q(sb.from('pireps').select('id,created_at,landing_fpm,block_h,checks,arr_icao,trips(flt,from_icao,to_icao),pilots(callsign)').eq('status', 'pending').order('id')),
    q(sb.from('pilots').select('id,callsign,name,company,is_admin,cash,rep').order('callsign'))]);
  const s = D.settings;
  $('#main').innerHTML = `<div class="section"><div class="sechead"><div><h2>Reports to review</h2><p>Reports that failed an automatic check${s.auto_accept ? '' : ', or every report while automatic acceptance is off'}.</p></div></div>
  <div class="panel tablewrap"><table class="grid"><thead><tr><th>Filed</th><th>Pilot</th><th>Flight</th><th>Route</th><th>Failed checks</th></tr></thead><tbody>
  ${pending.length ? pending.map(p => `<tr class="click" data-act="pirepstaff" data-id="${p.id}"><td class="n">${fmtDate(p.created_at)}</td><td class="n">${esc(p.pilots?.callsign)}</td><td class="n">${esc(p.trips?.flt)}</td><td class="n">${p.trips?.from_icao} → ${p.arr_icao}</td><td>${Object.entries(p.checks || {}).filter(([, v]) => !v.ok).map(([k]) => `<span class="check-bad">${k}</span>`).join(' ') || '—'}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Nothing waiting. Nice.</td></tr>'}</tbody></table></div></div>

  <div class="section"><h2>VA settings</h2><form class="panel" id="setForm" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;align-items:end">
   <div class="field"><label for="sName">VA name</label><input id="sName" value="${esc(s.va_name)}"></div>
   <div class="field"><label for="sTz">Market time zone</label><input id="sTz" value="${esc(s.timezone)}"></div>
   <div class="field"><label for="sCash">New pilot starting cash</label><input id="sCash" type="number" value="${s.start_cash}"></div>
   <div class="field"><label for="sBase">Base board size</label><input id="sBase" type="number" min="4" max="40" value="${s.market_base}"></div>
   <label class="check"><input type="checkbox" id="sAuto" ${s.auto_accept ? 'checked' : ''}> Accept clean reports automatically</label>
   <button class="btn pri" type="submit">Save settings</button></form></div>

  <div class="section"><div class="sechead"><div><h2>Airports</h2><p>${D.apList.length} active airports feed the request board. Paste CSV rows to add or update many at once: ICAO, name, city, country, latitude, longitude, tags (biz, leisure, ski, long, separated by spaces).</p></div></div>
   <form class="panel" id="apForm" style="display:flex;flex-direction:column;gap:10px"><textarea class="ta" id="apCsv" placeholder="LFKC,Calvi Sainte-Catherine,Calvi,FR,42.5308,8.7933,leisure"></textarea><div class="btns"><button class="btn pri" type="submit">Import airports</button></div><div class="err" id="apErr"></div></form></div>

  <div class="section"><h2>Pilots</h2><div class="panel tablewrap"><table class="grid"><thead><tr><th>Callsign</th><th>Name</th><th>Company</th><th>Balance</th><th>Rep</th><th>Staff</th><th>Adjust</th></tr></thead><tbody>
  ${pilots.map(p => `<tr><td class="n">${esc(p.callsign)}</td><td>${esc(p.name)}</td><td>${esc(p.company)}</td><td class="n">${money(p.cash)}</td><td class="n">${Math.round(p.rep)}</td>
   <td><label class="check"><input type="checkbox" data-act="staff" data-id="${p.id}" ${p.is_admin ? 'checked' : ''} ${p.id === D.uid ? 'disabled' : ''}> Staff</label></td>
   <td><button type="button" class="btn" data-act="adjust" data-id="${p.id}" data-cs="${esc(p.callsign)}">Adjust</button></td></tr>`).join('')}</tbody></table></div></div>`;
  $('#setForm').onsubmit = async e => { e.preventDefault(); await act(async () => { await rpc('admin_settings', { p_va_name: $('#sName').value, p_timezone: $('#sTz').value, p_start_cash: +$('#sCash').value, p_market_base: +$('#sBase').value, p_auto_accept: $('#sAuto').checked }); await loadStatic() }, 'Settings saved.') };
  $('#apForm').onsubmit = async e => {
    e.preventDefault(); const lines = $('#apCsv').value.split(/\r?\n/).map(l => l.trim()).filter(Boolean); let n = 0; $('#apErr').textContent = '';
    for (const line of lines) {
      const c = line.split(',').map(x => x.trim());
      if (c.length < 6 || isNaN(+c[4]) || isNaN(+c[5])) { $('#apErr').textContent = `Skipped "${line}": needs ICAO, name, city, country, latitude, longitude.`; continue }
      try { await rpc('admin_upsert_airport', { p_icao: c[0], p_name: c[1], p_city: c[2], p_country: c[3], p_lat: +c[4], p_lon: +c[5], p_tags: (c[6] || '').split(/\s+/).filter(Boolean), p_active: true }); n++ }
      catch (err) { $('#apErr').textContent = `${c[0]}: ${err.message}` }
    }
    if (n) { toast(`Imported ${n} airport${n > 1 ? 's' : ''}.`, 'ok'); await loadStatic(); renderTab() }
  };
}

/* ---------- quote modal ---------- */
function openBid(r) {
  const ac = active(), qd = quote(ac, r);
  $('#modal').innerHTML = `<div class="scrim" data-act="scrim"><div class="modal" role="dialog" aria-modal="true" aria-label="Quote for request">
  <div><h3 style="margin:0 0 4px">Quote · REQ ${r.id} · ${esc(r.client)}</h3><div class="route">${r.from_icao}<i>▸</i>${r.to_icao}</div><div class="muted" style="font-size:13px">${esc(D.airports[r.from_icao]?.city)} to ${esc(D.airports[r.to_icao]?.city)} · ${r.pax} pax · departs ${fmtDep(r.dep_at)}</div></div>
  <div class="grid4"><div class="kv"><label>Aircraft</label><span>${ac.reg}</span></div><div class="kv"><label>Block</label><span>${hm(qd.bh)}</span></div>
   <div class="kv"><label>Positioning</label><span>${qd.repoNm ? `${qd.repoNm} nm · ${kmoney(qd.repoCost)}` : 'None'}</span></div><div class="kv"><label>Op. cost</label><span>${kmoney(qd.opc)}</span></div></div>
  <div class="field"><label for="bidAmt">Your price</label><div class="amount"><span>$</span><input id="bidAmt" inputmode="numeric" value="${qd.guide}"></div>
   <input type="range" id="bidRange" min="${Math.round(qd.guide * 0.6 / 100) * 100}" max="${Math.round(qd.fair * 1.6 / 100) * 100}" step="100" value="${qd.guide}" aria-label="Adjust price">
   <div style="display:flex;justify-content:space-between;font-size:11.5px;flex-wrap:wrap;gap:6px" class="muted mono"><span>Market rate ${kmoney(qd.guide * 0.95)}–${kmoney(qd.guide * 1.1)}${qd.repoNm ? `; outside operators may not need to position` : ''}</span><span>${r.npc} outside operators${r.player_bids ? ` + ${r.player_bids} VA pilot${r.player_bids > 1 ? 's' : ''}` : ''}</span></div></div>
  <div class="odds"><div class="kv"><label>Margin</label><span id="oMargin"></span></div><div class="kv"><label>Est. win chance</label><span id="oWin"></span></div><div class="kv"><label>Decision in</label><span>${r.decide_at ? `<span data-cd="${ts(r.decide_at)}"></span>` : BIDWAIT[Math.min(3, upg('fast'))] + 's'}</span></div></div>
  <div class="oddsbar"><i id="oBar"></i></div>
  <p class="muted" style="margin:0;font-size:12px">The estimate counts outside operators only. Other VA pilots may undercut you.</p>
  <div class="err" id="bidErr"></div>
  <div class="btns" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Cancel</button><button type="button" class="btn pri" id="sendBid" data-act="sendbid" data-id="${r.id}">Send quote</button></div></div></div>`;
  const inp = $('#bidAmt'), rg = $('#bidRange');
  const upd = () => { const v = parseInt(inp.value.replace(/\D/g, '')) || 0; const m = v - qd.opc; $('#oMargin').textContent = money(m); $('#oMargin').className = m >= 0 ? 'pos' : 'neg'; const o = winOdds(r, ac, v); $('#oWin').textContent = Math.round(o * 100) + '%'; $('#oBar').style.width = o * 100 + '%'; $('#oBar').style.background = o > 0.6 ? 'var(--ok)' : o > 0.3 ? 'var(--amber)' : 'var(--bad)'; $('#sendBid').disabled = v < 100 };
  inp.addEventListener('input', () => { rg.value = parseInt(inp.value.replace(/\D/g, '')) || 0; upd() });
  rg.addEventListener('input', () => { inp.value = rg.value; upd() });
  upd(); updateCountdowns(); inp.focus(); inp.select();
}
function confirmBox(title, body, label, fn) {
  $('#modal').innerHTML = `<div class="scrim" data-act="scrim"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2><div class="muted">${body}</div><div class="err" id="cfErr"></div><div class="btns" style="justify-content:flex-end"><button type="button" class="btn" data-act="close">Keep it</button><button type="button" class="btn pri" id="cfOk">${esc(label)}</button></div></div></div>`;
  $('#cfOk').onclick = async () => { try { await fn(); closeModal(); await afterChange() } catch (e) { $('#cfErr').textContent = e.message } };
}
function closeModal() { $('#modal').innerHTML = '' }
async function afterChange() { await refreshCore(); renderAll() }
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg, 'ok'); await afterChange() }
  catch (e) { toast(e.message, 'bad') }
}

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { e.preventDefault(); if (liveMap) { liveMap.remove(); liveMap = null } UI.tab = tab.dataset.tab; history.replaceState(null, '', '#' + UI.tab); renderAll(); window.scrollTo(0, 0); return }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  if (a === 'scrim') { if (e.target === b) closeModal(); return }
  if (a === 'close') closeModal();
  if (a === 'signout') { await sb.auth.signOut(); location.reload() }
  if (a === 'sound') { UI.sound = !UI.sound; try { localStorage.setItem('cd-ringer', UI.sound ? '1' : '0') } catch (_) { } if (UI.sound) { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume() } catch (_) { } } renderHeader() }
  if (a === 'pickac') { UI.acId = id; renderTab() }
  if (a === 'band') { UI.band = b.dataset.k; renderTab() }
  if (a === 'bid') { const r = D.requests.find(x => x.id === +id); if (r) openBid(r) }
  if (a === 'sendbid') {
    const v = parseInt($('#bidAmt').value.replace(/\D/g, '')) || 0;
    try { await rpc('place_bid', { p_request: +id, p_aircraft: active().id, p_amount: v }); closeModal(); toast(`Quote of ${money(v)} sent.`, ''); await afterChange() }
    catch (err) { $('#bidErr').textContent = err.message }
  }
  if (a === 'acceptcall') { const ac = $('#callAc')?.value || D.fleet.find(x => fits(typeOf(x), D.calls[0]))?.id; await act(() => rpc('accept_call', { p_call: +id, p_aircraft: ac }), 'Booked. Plan it under Trips.'); $('#call').dataset.id = '' }
  if (a === 'declinecall') { await act(() => rpc('decline_call', { p_call: +id })); $('#call').dataset.id = '' }
  if (a === 'copyplan') {
    const tr = D.trips.find(x => x.id === +id), p = plan(tr), ac = p.ac;
    const txt = `${tr.flt}  ${ac.reg} (${ac.type_code})\n${tr.from_icao} → ${tr.to_icao}  ALTN ${p.alt}\nDEP ${fmtDep(tr.dep_at)}  PAX ${tr.pax}  PAYLOAD ${p.payload} lb\nDIST ${tr.dist} nm  FL${p.fl}  EST BLOCK ${hm(p.bh)}\nFUEL trip ${p.tripFuel} / altn ${p.altFuel} / res ${p.res} / taxi ${p.taxi} = ${p.block} lb`;
    try { await navigator.clipboard.writeText(txt); toast('Flight plan copied.', 'ok') } catch (_) { confirmBox('Flight plan', `<pre class="code" style="white-space:pre-wrap">${esc(txt)}</pre>`, 'Done', async () => { }) }
  }
  if (a === 'outsource') confirmBox('Use a contract crew?', `A contract crew positions the aircraft for ${money(+b.dataset.cost)}. You won't need to fly this leg.`, 'Pay and position', () => rpc('outsource_ferry', { p_trip: +id }));
  if (a === 'cancel') { const tr = D.trips.find(x => x.id === +id); confirmBox(`Cancel ${tr.flt}?`, `${esc(tr.client)} will need another operator. You'll pay a ${money(Math.round(tr.price * 0.2))} cancellation fee and lose 5 reputation.`, 'Cancel trip', () => rpc('cancel_trip', { p_trip: +id })) }
  if (a === 'buyslot') await act(() => rpc('buy_slot'), 'New fleet slot ready.');
  if (a === 'buyac') await act(() => rpc('buy_aircraft', { p_type: b.dataset.k }), `${D.types[b.dataset.k].name} delivered to ${D.me.home}.`);
  if (a === 'upg') await act(() => rpc('buy_upgrade', { p_key: b.dataset.k }), `${UPG[b.dataset.k].name} upgraded.`);
  if (a === 'sell') { const ac = acById(id), t = typeOf(ac); confirmBox(`Sell ${ac.reg}?`, `The ${esc(t.name)} returns to the lessor and you recover ${money(Math.round(t.price * 0.6))} of the deposit.`, 'Sell aircraft', async () => { await rpc('sell_aircraft', { p_ac: id }); if (UI.acId === id) UI.acId = null }) }
  if (a === 'pirep') openPirep(+id, false).catch(err => toast(err.message, 'bad'));
  if (a === 'pirepstaff') openPirep(+id, true).catch(err => toast(err.message, 'bad'));
  if (a === 'review') { const note = $('#rvNote')?.value || ''; try { await rpc('admin_review', { p_pirep: +id, p_accept: b.dataset.ok === '1', p_note: note }); closeModal(); toast('Review saved.', 'ok'); renderTab() } catch (err) { toast(err.message, 'bad') } }
  if (a === 'copycode') { try { await navigator.clipboard.writeText($('#setupCode').textContent); toast('Setup code copied.', 'ok') } catch (_) { const r = document.createRange(); r.selectNodeContents($('#setupCode')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Press Ctrl+C to copy the selected code.', '') } }
  if (a === 'rotatekey') confirmBox('Make a new setup code?', 'The tracker will stop working until you paste the new code into it.', 'Make new code', () => rpc('rotate_tracker_key'));
  if (a === 'adjust') {
    confirmBox(`Adjust ${b.dataset.cs}`, `<div class="row2" style="margin-top:8px"><div class="field"><label for="adCash">Cash change ($)</label><input id="adCash" type="number" value="0"></div><div class="field"><label for="adRep">Reputation change</label><input id="adRep" type="number" step="0.5" value="0"></div></div><div class="field" style="margin-top:10px"><label for="adWhy">Reason</label><input id="adWhy" maxlength="120"></div>`, 'Apply',
      () => rpc('admin_adjust', { p_pilot: id, p_cash: +$('#adCash').value || 0, p_rep: +$('#adRep').value || 0, p_reason: $('#adWhy').value }));
  }
});
document.addEventListener('change', async e => {
  const a = e.target.dataset.act;
  if (a === 'showall') { UI.showAll = e.target.checked; renderTab() }
  if (a === 'sort') { UI.sort = e.target.value; renderTab() }
  if (a === 'staff') { try { await rpc('admin_set_staff', { p_pilot: e.target.dataset.id, p_staff: e.target.checked }); toast('Staff access updated.', 'ok') } catch (err) { toast(err.message, 'bad'); e.target.checked = !e.target.checked } }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); if (e.key === 'Enter' && e.target.id === 'bidAmt') $('#sendBid').click() });
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (TABS.some(t => t[0] === h) && h !== UI.tab) { if (liveMap) { liveMap.remove(); liveMap = null } UI.tab = h; renderAll() } });
let rz; window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (UI.tab === 'trips' && !$('#modal').children.length) renderTab() }, 200) });

boot().catch(e => { $('#main').innerHTML = `<div class="authwrap"><div class="authcard"><h1>Couldn't start</h1><p>${esc(e.message)}</p></div></div>` });
