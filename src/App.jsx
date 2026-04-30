import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragOverlay } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// ─────────────────────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────────────────────
const CURRENCIES = ["GBP","USD","AUD","SGD","IDR","CNY"];
const GOOGLE_CLIENT_ID = "468703441147-16782cttqb9in18ttpkihtconlbdr525.apps.googleusercontent.com";
const parseJwt = token => { try { return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); } catch { return null; } };
const AUTH_KEY = 'nw_auth';
const IDLE_MS = 30 * 60 * 1000;
const getStoredAuth = () => {
  try {
    const s = JSON.parse(localStorage.getItem(AUTH_KEY));
    if (!s || Date.now() - s.lastActive > IDLE_MS) { localStorage.removeItem(AUTH_KEY); return null; }
    const p = parseJwt(s.credential);
    if (!p?.exp || p.exp * 1000 <= Date.now()) { localStorage.removeItem(AUTH_KEY); return null; }
    return s.credential;
  } catch { return null; }
};
const LIQUIDITY_OPTIONS = [
  { value:"liquid",      label:"Liquid",               desc:"Instant access" },
  { value:"near-liquid", label:"Near-Liquid",           desc:"Accessible within ~1 week" },
  { value:"illiquid",    label:"Illiquid",              desc:"Locked until a future date (e.g. pension)" },
  { value:"speculative", label:"Speculative Liquidity", desc:"Uncertain timeline to liquidate" },
];
const RISK_OPTIONS = [
  { value:"very-low",  label:"Very Low",  desc:"Cash, government-backed savings" },
  { value:"low",       label:"Low",       desc:"Fixed savings, bonds" },
  { value:"medium",    label:"Medium",    desc:"Index funds, diversified investments" },
  { value:"high",      label:"High",      desc:"Individual stocks, crypto" },
  { value:"very-high", label:"Very High", desc:"Speculative or illiquid assets" },
];
const CLASS_OPTIONS = [
  { value:"cash-savings", label:"Cash & Savings" },
  { value:"investments",  label:"Investments" },
  { value:"retirement",   label:"Retirement" },
  { value:"property",     label:"Property" },
  { value:"debt",         label:"Debt" },
];
const TYPE_OPTIONS = [
  { value:"asset",     label:"Asset",     desc:"Adds to net worth" },
  { value:"liability", label:"Liability", desc:"Subtracts from net worth" },
];
const RISK_COLORS = {
  "very-low":"#7eb8a4","low":"#a8c9a0","medium":"#c8a96e",
  "high":"#d4845a","very-high":"#e07070"
};
const LIQ_COLORS = {
  "liquid":"#7eb8a4","near-liquid":"#a8c9a0",
  "illiquid":"#c8a96e","speculative":"#d4845a"
};

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,6);

const fmt = (n, currency="GBP", compact=false) => {
  if (n===null||n===undefined||isNaN(Number(n))) return "—";
  n = Number(n);
  let val=n, suffix="";
  if (compact && Math.abs(n)>=1_000_000) { val=n/1_000_000; suffix="M"; }
  else if (compact && Math.abs(n)>=1_000) { val=n/1_000; suffix="k"; }
  try {
    return new Intl.NumberFormat("en-GB",{
      style:"currency", currency,
      maximumFractionDigits: compact?1:2,
    }).format(val)+suffix;
  } catch { return `${currency} ${val.toFixed(2)}${suffix}`; }
};

const fmtDate = ts => {
  if (!ts) return "—";
  return new Date(Number(ts)).toLocaleString("en-GB",{
    day:"2-digit",month:"short",year:"numeric",
    hour:"2-digit",minute:"2-digit"
  });
};

const latestBalance = acc => {
  if (!acc.records?.length) return null;
  return Number([...acc.records].sort((a,b)=>Number(b.ts)-Number(a.ts))[0].amount);
};

const latestTs = acc => {
  if (!acc.records?.length) return null;
  return [...acc.records].sort((a,b)=>Number(b.ts)-Number(a.ts))[0].ts;
};

// Balance for an account as of a given timestamp (latest record ≤ ts)
const balanceAt = (acc, ts) => {
  const recs = (acc.records||[]).filter(r=>Number(r.ts)<=ts);
  if (!recs.length) return null;
  return Number([...recs].sort((a,b)=>Number(b.ts)-Number(a.ts))[0].amount);
};

// Vesting helpers
const dateToStr = ts => ts ? new Date(Number(ts)).toISOString().slice(0,10) : '';
const strToDateMs = s => s ? new Date(s+'T00:00:00').getTime() : null;

const vestedFraction = (vesting, atTs = Date.now()) => {
  if (!vesting?.cliffDate || !vesting?.vestByDate) return 1;
  const cliff = Number(vesting.cliffDate), vestBy = Number(vesting.vestByDate);
  if (atTs < cliff) return 0;
  if (atTs >= vestBy) return 1;
  return (atTs - cliff) / (vestBy - cliff);
};

const vestedBalance = (acc, atTs = Date.now()) => {
  const raw = latestBalance(acc);
  if (raw === null) return null;
  if (!acc.vesting) return raw;
  return raw * vestedFraction(acc.vesting, atTs);
};

const vestedBalanceAt = (acc, ts) => {
  const raw = balanceAt(acc, ts);
  if (raw === null) return null;
  if (!acc.vesting) return raw;
  return raw * vestedFraction(acc.vesting, ts);
};

// Net worth for visible accounts reconstructed at a past timestamp
const networthAt = (accounts, excluded, ts, toDisplay) => {
  let total = 0, hasAny = false;
  for (const acc of accounts) {
    if (excluded.has(acc.id) || excluded.has(`cls:${acc.class}`)) continue;
    const raw = vestedBalanceAt(acc, ts);
    if (raw === null) continue;
    hasAny = true;
    const conv = toDisplay(raw, acc.currency);
    total += acc.type === 'liability' ? -Math.abs(conv) : conv;
  }
  return hasAny ? total : null;
};

// Format a timestamp as a datetime-local input value (YYYY-MM-DDThh:mm)
const localDatetimeStr = ts => {
  const d = new Date(ts||Date.now());
  const p = n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ─────────────────────────────────────────────────────────────
//  CHART HELPERS
// ─────────────────────────────────────────────────────────────
const CLS_COLORS = {
  "cash-savings":"#7eb8a4","investments":"#c8a96e",
  "retirement":"#8ba3c7","property":"#b07eb8","debt":"#e07070",
};
const CUR_COLORS = {
  "GBP":"#7eb8a4","USD":"#c8a96e","AUD":"#8ba3c7",
  "SGD":"#b07eb8","IDR":"#d4845a","CNY":"#e07070",
};
const CF_INCOME_CATS  = ["Salary","Freelance / Contract","Rental Income","Dividends / Interest","Benefits","Pension","Other Income"];
const CF_EXPENSE_CATS = ["Rent / Mortgage","Utilities","Groceries","Transport","Subscriptions","Insurance","Healthcare","Dining & Entertainment","Education","Childcare","Other"];
const CF_FREQ = [
  { value:"daily",       label:"Daily",       mult:365/12 },
  { value:"weekly",      label:"Weekly",      mult:52/12  },
  { value:"fortnightly", label:"Fortnightly", mult:26/12  },
  { value:"monthly",     label:"Monthly",     mult:1      },
  { value:"annual",      label:"Annual",      mult:1/12   },
  { value:"one-time",    label:"One-time",    mult:0      },
];
const cfMonthly = (cf, toDisplay) => {
  const freq = CF_FREQ.find(f=>f.value===cf.frequency);
  if (!freq || freq.mult===0) return 0;
  return toDisplay(cf.amount * freq.mult, cf.currency);
};

const polarXY = (cx, cy, r, deg) => {
  const rad = (deg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
};
const donutArc = (cx, cy, outerR, innerR, s, e) => {
  const s1=polarXY(cx,cy,outerR,s), e1=polarXY(cx,cy,outerR,e);
  const s2=polarXY(cx,cy,innerR,e), e2=polarXY(cx,cy,innerR,s);
  const lg = e-s > 180 ? 1 : 0;
  const f = n => n.toFixed(2);
  return `M${f(s1.x)} ${f(s1.y)} A${outerR} ${outerR} 0 ${lg} 1 ${f(e1.x)} ${f(e1.y)} L${f(s2.x)} ${f(s2.y)} A${innerR} ${innerR} 0 ${lg} 0 ${f(e2.x)} ${f(e2.y)} Z`;
};

// ─────────────────────────────────────────────────────────────
//  GOOGLE SHEETS API
// ─────────────────────────────────────────────────────────────
const fetchWithTimeout = (url, ms=20000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
};
const createApi = (url, getToken) => ({
  call: async (action, params={}) => {
    const qs = new URLSearchParams({action, idToken: getToken?.() || '', ...params}).toString();
    try {
      const res = await fetchWithTimeout(`${url}?${qs}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return data;
    } catch(e) {
      if (e.name === 'AbortError') throw new Error('Request timed out — check your connection or try again');
      throw e;
    }
  },
  callWithData: async (action, data, extra={}) => {
    const qs = new URLSearchParams({action, idToken: getToken?.() || '', data: JSON.stringify(data), ...extra}).toString();
    try {
      const res = await fetchWithTimeout(`${url}?${qs}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json;
    } catch(e) {
      if (e.name === 'AbortError') throw new Error('Request timed out — check your connection or try again');
      throw e;
    }
  },
});

// ─────────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────────
const STYLE = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0c0e13;--s1:#13161e;--s2:#181c26;--s3:#1f2433;
  --border:#252b3b;--border2:#2e3547;
  --gold:#c9a96e;--gold2:#e8c98a;--teal:#6fb5a2;
  --red:#d96b6b;--text:#e2ddd4;--muted:#5e677a;--muted2:#8896a8;
  --pos:#6fb5a2;--neg:#d96b6b;
  --fd:'Playfair Display',serif;--fm:'Fira Code',monospace;--fb:'Jost',sans-serif;
  --r:10px;--r2:6px;
}
html,body{min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--fb)}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:4px}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
.hdr{border-bottom:1px solid var(--border);padding:14px 0 10px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.hdr-brand{font-family:var(--fd);font-size:1.25rem;color:var(--gold);letter-spacing:.02em;display:flex;align-items:center;gap:10px}
.hdr-brand span{font-size:.65rem;font-family:var(--fm);color:var(--muted);letter-spacing:.12em;text-transform:uppercase;border:1px solid var(--border2);padding:2px 7px;border-radius:999px}
.hdr-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.sync{display:flex;align-items:center;gap:5px;font-family:var(--fm);font-size:.65rem;color:var(--muted);padding:4px 10px;background:var(--s2);border:1px solid var(--border);border-radius:999px}
.sync-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.sync-dot.ok{background:var(--pos)}.sync-dot.err{background:var(--neg)}.sync-dot.spin{background:var(--gold);animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.2}}
.cur-drop{position:relative}
.cur-btn{background:var(--s3);border:1px solid var(--border2);color:var(--text);padding:5px 12px;border-radius:var(--r2);font-family:var(--fm);font-size:.75rem;cursor:pointer;outline:none;display:flex;align-items:center;gap:6px;transition:border-color .15s}
.cur-btn:hover,.cur-btn:focus{border-color:var(--gold)}
.cur-chevron{font-size:.55rem;opacity:.5;transition:transform .15s}
.cur-btn.open .cur-chevron{transform:rotate(180deg);opacity:.8}
.cur-menu{position:absolute;right:0;top:calc(100% + 6px);background:var(--s1);border:1px solid var(--border2);border-radius:var(--r2);min-width:200px;z-index:200;box-shadow:0 10px 32px rgba(0,0,0,.5);overflow:hidden}
.cur-opt{display:flex;justify-content:space-between;align-items:center;padding:9px 14px;background:none;border:none;border-bottom:1px solid var(--border);color:var(--text);font-family:var(--fm);cursor:pointer;width:100%;text-align:left;gap:12px;transition:background .1s}
.cur-opt:last-child{border-bottom:none}
.cur-opt:hover{background:var(--s3)}
.cur-opt.sel{background:var(--s2)}
.cur-opt-code{font-size:.78rem;font-weight:600;flex-shrink:0}
.cur-opt.sel .cur-opt-code{color:var(--gold)}
.cur-opt-rate{font-size:.62rem;color:var(--muted);text-align:right;line-height:1.3}
.nav{display:flex;gap:4px;padding:12px 0;overflow-x:auto}.nav::-webkit-scrollbar{height:0}
.nb{background:none;border:none;color:var(--muted2);font-family:var(--fb);font-size:.85rem;font-weight:500;padding:7px 16px;border-radius:999px;cursor:pointer;transition:all .2s;white-space:nowrap;flex-shrink:0}
.nb.on{background:var(--gold);color:#0c0e13;font-weight:600}
.nb:hover:not(.on){background:var(--s3);color:var(--text)}
.page{padding:16px 0 60px}
.st{font-family:var(--fm);font-size:.65rem;letter-spacing:.14em;color:var(--muted);text-transform:uppercase;margin:24px 0 10px}
.card{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:18px 20px;margin-bottom:12px}
.card2{background:var(--s2);border:1px solid var(--border);border-radius:var(--r2);padding:12px 14px;margin-bottom:8px}
.hero{background:linear-gradient(140deg,#13161e 0%,#181c26 50%,#131921 100%);border:1px solid var(--border);border-radius:var(--r);padding:32px 24px;margin-bottom:16px;position:relative;overflow:hidden;text-align:center}
.hero::after{content:'';position:absolute;bottom:-60px;right:-60px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(201,169,110,.07) 0%,transparent 70%);pointer-events:none}
.hero-label{font-family:var(--fm);font-size:.65rem;letter-spacing:.18em;color:var(--muted);text-transform:uppercase;margin-bottom:12px}
.hero-value{font-family:var(--fd);font-size:clamp(2.2rem,7vw,3.6rem);color:var(--gold);line-height:1.05;font-weight:600}
.hero-sub{font-family:var(--fm);font-size:.72rem;color:var(--muted);margin-top:8px}
.delta{display:inline-flex;align-items:center;gap:5px;font-family:var(--fm);font-size:.78rem;padding:4px 12px;border-radius:999px;margin-top:12px;font-weight:500}
.delta.pos{background:rgba(111,181,162,.12);color:var(--pos)}
.delta.neg{background:rgba(217,107,107,.12);color:var(--neg)}
.crow{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:8px}
.crow:last-child{border-bottom:none}
.crow-left{display:flex;flex-direction:column;gap:2px}
.crow-label{font-size:.88rem;color:var(--text)}
.crow-desc{font-size:.7rem;color:var(--muted);font-family:var(--fm)}
.crow-val{font-family:var(--fm);font-size:.9rem;text-align:right;white-space:nowrap}
.crow-val.pos{color:var(--pos)}.crow-val.neg{color:var(--neg)}.crow-val.neu{color:var(--muted2)}
.pill{display:inline-flex;align-items:center;font-family:var(--fm);font-size:.62rem;padding:2px 8px;border-radius:999px;border:1px solid;letter-spacing:.04em;white-space:nowrap}
.btn{border:none;border-radius:var(--r2);padding:9px 18px;font-family:var(--fb);font-size:.85rem;font-weight:500;cursor:pointer;transition:all .18s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:var(--gold);color:#0c0e13}.btn-primary:hover{background:var(--gold2)}
.btn-ghost{background:var(--s3);color:var(--text);border:1px solid var(--border2)}.btn-ghost:hover{border-color:var(--gold);color:var(--gold)}
.btn-danger{background:rgba(217,107,107,.12);color:var(--red);border:1px solid rgba(217,107,107,.25)}.btn-danger:hover{background:rgba(217,107,107,.22)}
.btn-sm{padding:5px 12px;font-size:.78rem}.btn-xs{padding:3px 9px;font-size:.72rem}
.btn:disabled{opacity:.45;cursor:not-allowed}
.input{background:var(--s3);border:1px solid var(--border2);color:var(--text);padding:9px 12px;border-radius:var(--r2);font-family:var(--fb);font-size:.88rem;width:100%;outline:none;transition:border .15s}
.input[type=datetime-local]{color-scheme:dark}
.backdate-tag{font-size:.6rem;font-family:var(--fm);color:var(--gold);background:rgba(201,169,110,.12);border:1px solid rgba(201,169,110,.3);border-radius:999px;padding:1px 7px;letter-spacing:.06em;text-transform:uppercase}
.ms-preview{background:var(--s2);border:1px solid var(--border);border-radius:var(--r2);padding:13px 16px;margin-bottom:20px}
.ms-preview-label{font-family:var(--fm);font-size:.6rem;letter-spacing:.12em;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.ms-preview-val{font-family:var(--fd);font-size:1.5rem;color:var(--gold);line-height:1.1}
.ms-preview-sub{font-family:var(--fm);font-size:.68rem;color:var(--muted2);margin-top:4px}
.input:focus{border-color:var(--gold)}.input::placeholder{color:var(--muted)}
.sel{appearance:none;background:var(--s3);border:1px solid var(--border2);color:var(--text);padding:9px 12px;border-radius:var(--r2);font-family:var(--fb);font-size:.88rem;width:100%;outline:none;cursor:pointer}
.sel:focus{border-color:var(--gold)}
.label{font-size:.75rem;color:var(--muted2);margin-bottom:5px;font-weight:500}
.frow{margin-bottom:14px}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:500px){.fgrid{grid-template-columns:1fr}}
.acc-card{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px;transition:border-color .2s,box-shadow .2s}
.acc-card:hover{border-color:var(--border2)}
.acc-card-click{cursor:pointer}
.acc-card-click:hover{border-color:var(--gold);box-shadow:0 2px 16px rgba(201,169,110,.08)}
.hist-summary{display:flex;justify-content:space-between;align-items:flex-start;background:var(--s2);border:1px solid var(--border);border-radius:var(--r2);padding:14px 16px;margin-bottom:16px}
.hist-summary-label{font-family:var(--fm);font-size:.6rem;letter-spacing:.12em;color:var(--muted);text-transform:uppercase;margin-bottom:4px}
.hist-summary-val{font-family:var(--fd);font-size:1.3rem;font-weight:600;line-height:1.1}
.hist-summary-conv{font-family:var(--fm);font-size:.68rem;color:var(--muted2);margin-top:3px}
.hist-table-wrap{max-height:240px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r2);margin-bottom:4px}
.hist-table-head{display:grid;grid-template-columns:1fr auto auto 18px;gap:12px;padding:7px 12px;background:var(--s3);font-family:var(--fm);font-size:.62rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;border-bottom:1px solid var(--border);position:sticky;top:0}
.hist-row{display:grid;grid-template-columns:1fr auto auto 18px;gap:12px;padding:8px 12px;border-bottom:1px solid var(--border);align-items:center}
.hist-row:last-child{border-bottom:none}
.hist-row:hover{background:var(--s2)}
.hist-del-btn{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border:none;background:none;color:var(--muted);cursor:pointer;border-radius:3px;padding:0;font-size:.75rem;opacity:0;transition:opacity .15s,color .15s}
.hist-row:hover .hist-del-btn{opacity:1}
.hist-del-btn:hover{color:var(--neg)!important}
.hist-row-confirm{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border);background:rgba(217,107,107,.07)}
.hist-row-confirm:last-child{border-bottom:none}
.hist-confirm-label{font-family:var(--fm);font-size:.7rem;color:var(--neg);flex:1}
.hist-confirm-btn{font-family:var(--fm);font-size:.65rem;padding:2px 10px;border-radius:999px;cursor:pointer;border:1px solid;transition:all .15s}
.hist-confirm-yes{background:var(--neg);border-color:var(--neg);color:#fff}
.hist-confirm-yes:hover{opacity:.85}
.hist-confirm-no{background:none;border-color:var(--border2);color:var(--muted2)}
.hist-confirm-no:hover{border-color:var(--muted2);color:var(--text)}
.hist-date{font-family:var(--fm);font-size:.72rem;color:var(--muted2)}
.hist-delta{font-family:var(--fm);font-size:.72rem;font-weight:500;text-align:right;min-width:70px}
.hist-amount{font-family:var(--fm);font-size:.78rem;font-weight:600;text-align:right;min-width:90px}
.acc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
.acc-name{font-family:var(--fd);font-size:1.05rem;color:var(--text);font-weight:600}
.acc-balance{font-family:var(--fm);font-size:1.1rem;color:var(--gold);white-space:nowrap}
.acc-balance.liability{color:var(--neg)}
.acc-pills{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.acc-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.acc-ts{font-family:var(--fm);font-size:.65rem;color:var(--muted)}
.acc-actions{display:flex;gap:6px}
.chart-empty{text-align:center;padding:28px 20px;color:var(--muted);font-size:.8rem;font-family:var(--fm);line-height:1.6}
.chart-tt{position:absolute;transform:translateX(-50%);bottom:26px;background:var(--s2);border:1px solid var(--border2);border-radius:var(--r2);padding:7px 12px;pointer-events:none;white-space:nowrap;z-index:10}
.chart-tt-val{font-family:var(--fm);font-size:.8rem;font-weight:600}
.chart-tt-date{font-family:var(--fm);font-size:.62rem;color:var(--muted);margin-top:2px}
.alloc-grid{display:flex;gap:24px;align-items:center}
.alloc-bars{flex:1;min-width:0}
@media(max-width:640px){.alloc-grid{flex-direction:column;align-items:stretch}.donut-wrap{width:100%;max-width:200px;margin:0 auto}}
.donut-wrap{width:180px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:0}
.cls-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;display:inline-block}
.excl-card{opacity:.55}
.excl-card:hover{opacity:.8}
.excl-active{color:var(--gold)!important;border-color:var(--gold)!important}
.excl-row{opacity:.5}
.excl-btn{background:none;border:1px solid var(--border2);color:var(--muted);font-family:var(--fm);font-size:.6rem;padding:2px 7px;border-radius:999px;cursor:pointer;transition:all .15s;flex-shrink:0}
.excl-btn:hover{border-color:var(--text);color:var(--text)}
.excl-tag{font-family:var(--fm);font-size:.62rem;color:var(--muted);font-style:italic}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px)}
.modal{background:var(--s1);border:1px solid var(--border2);border-radius:var(--r);padding:24px;width:100%;max-width:480px;max-height:90vh;overflow-y:auto;position:relative}
.modal-title{font-family:var(--fd);font-size:1.2rem;color:var(--gold);margin-bottom:18px}
.modal-close{position:absolute;top:16px;right:16px;background:var(--s3);border:1px solid var(--border2);color:var(--muted2);width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:.85rem;display:flex;align-items:center;justify-content:center}
.modal-close:hover{color:var(--text);border-color:var(--muted2)}
.ms-card{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px}
.ms-card.baseline{border-color:var(--gold);background:linear-gradient(135deg,#13161e,#17191e)}
.ms-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px}
.ms-label{font-family:var(--fd);font-size:1rem;color:var(--text)}
.ms-ts{font-family:var(--fm);font-size:.65rem;color:var(--muted);margin-bottom:10px}
.ms-total{font-family:var(--fm);font-size:1rem;color:var(--gold)}
.ms-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--s2);border:1px solid var(--border2);border-radius:999px;padding:10px 20px;font-family:var(--fm);font-size:.78rem;color:var(--text);z-index:200;pointer-events:none;animation:toastIn .3s ease;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.toast.warn{border-color:var(--gold);color:var(--gold)}.toast.err{border-color:var(--neg);color:var(--neg)}
@keyframes toastIn{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
.setup{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.setup-card{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:32px;width:100%;max-width:500px}
.setup-title{font-family:var(--fd);font-size:1.6rem;color:var(--gold);margin-bottom:8px}
.setup-sub{color:var(--muted2);font-size:.88rem;line-height:1.6;margin-bottom:24px}
.step{display:flex;gap:14px;margin-bottom:18px;align-items:flex-start}
.step-num{width:26px;height:26px;border-radius:50%;background:var(--gold);color:#0c0e13;font-family:var(--fm);font-size:.75rem;font-weight:500;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step-text{font-size:.85rem;line-height:1.6;color:var(--muted2)}
.step-text strong{color:var(--text)}.step-text a{color:var(--gold);text-decoration:none}.step-text a:hover{text-decoration:underline}
.step-text code{background:var(--s3);padding:1px 6px;border-radius:4px;font-family:var(--fm);font-size:.8rem;color:var(--text)}
.empty{text-align:center;padding:40px 20px;color:var(--muted);font-size:.9rem}
.empty-icon{font-size:2rem;margin-bottom:10px;opacity:.4}
.rec-row{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-family:var(--fm);font-size:.75rem}
.rec-row:last-child{border-bottom:none}
.bar-row{margin-bottom:12px}
.bar-row:last-child{margin-bottom:0}
.bar-row-top{display:flex;justify-content:space-between;align-items:center;font-size:.78rem;margin-bottom:5px}
.bar-pct{font-family:var(--fm);font-size:.65rem;color:var(--muted);margin-left:5px}
.bar-track{height:6px;background:var(--s3);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;transition:width .5s ease}
.vest-progress{background:var(--s2);border:1px solid var(--border);border-radius:var(--r2);padding:8px 12px;margin-bottom:10px}
.vest-track{height:5px;background:var(--s3);border-radius:3px;overflow:hidden}
.vest-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--gold),var(--pos));transition:width .5s ease}
.drag-handle{display:flex;align-items:center;justify-content:center;width:28px;min-height:44px;color:var(--muted);cursor:grab;opacity:0;transition:opacity .15s;touch-action:none;flex-shrink:0;margin-right:6px;border-radius:var(--r2)}
.drag-handle:active{cursor:grabbing}
.acc-card:hover .drag-handle{opacity:.5}
.drag-handle:hover{opacity:1!important;color:var(--muted2)}
@media(pointer:coarse){.drag-handle{opacity:.35}}
.acc-card-dragging{opacity:0!important}
.drag-overlay{box-shadow:0 16px 48px rgba(0,0,0,.7);transform:scale(1.02);border-color:var(--gold)!important}
/* ── Targets ── */
.tgt-card{background:var(--s2);border:1px solid var(--border2);border-radius:var(--r);padding:16px;margin-bottom:12px;transition:border-color .15s}
.tgt-card:hover{border-color:var(--gold)}
.tgt-card.achieved{border-color:var(--pos);opacity:.75}
.tgt-track{height:6px;background:var(--s3);border-radius:3px;overflow:hidden;margin:8px 0 4px}
.tgt-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--gold),var(--pos));transition:width .5s ease}
.tgt-fill.achieved{background:var(--pos)}
.tgt-hero{background:var(--s2);border:1px solid var(--border2);border-radius:var(--r2);padding:12px 14px;margin-top:12px}
/* ── Model/What-If ── */
.model-card{background:var(--s2);border:1px solid var(--border2);border-radius:var(--r);padding:16px;margin-bottom:12px}
.slider{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:2px;background:var(--s3);outline:none;cursor:pointer}
.slider::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--gold);cursor:pointer;border:2px solid var(--bg)}
.slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--gold);cursor:pointer;border:2px solid var(--bg)}
.scenario-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
/* ── Overview redesign ── */
.hero-baseline-row{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:14px;flex-wrap:wrap}
.hero-sel{appearance:none;-webkit-appearance:none;background:var(--s3);border:1px solid var(--border2);color:var(--muted2);padding:3px 10px;border-radius:999px;font-family:var(--fm);font-size:.65rem;cursor:pointer;outline:none;transition:border-color .15s;max-width:180px;text-overflow:ellipsis}
.hero-sel:focus,.hero-sel:hover{border-color:var(--gold);color:var(--gold)}
.alloc-tabs{display:flex;gap:4px;margin-bottom:16px;flex-wrap:wrap}
.alloc-tab{background:none;border:1px solid var(--border2);color:var(--muted);font-family:var(--fm);font-size:.62rem;padding:3px 10px;border-radius:999px;cursor:pointer;transition:all .15s;letter-spacing:.04em;white-space:nowrap}
.alloc-tab:hover{border-color:var(--muted2);color:var(--text)}
.alloc-tab.on{background:var(--s3);border-color:var(--gold);color:var(--gold)}
.gtgt-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:6px;font-family:var(--fm);font-size:.7rem}
.gtgt-edit-row{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:center;margin-top:6px}
.hero-input{background:var(--s3);border:1px solid var(--border2);color:var(--text);padding:3px 8px;border-radius:var(--r2);font-family:var(--fm);font-size:.7rem;width:90px;outline:none;transition:border-color .15s}
.hero-input:focus{border-color:var(--gold)}
.cf-summary{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--r2);overflow:hidden;margin-bottom:20px}
.cf-summary-cell{background:var(--s2);padding:14px 16px}
.cf-summary-label{font-family:var(--fm);font-size:.6rem;letter-spacing:.12em;color:var(--muted);text-transform:uppercase;margin-bottom:4px}
.cf-summary-val{font-family:var(--fd);font-size:1.2rem;font-weight:600}
.cf-summary-sub{font-family:var(--fm);font-size:.68rem;color:var(--muted2);margin-top:3px}
.cf-section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)}
.cf-section-title{font-family:var(--fm);font-size:.62rem;letter-spacing:.15em;color:var(--muted);text-transform:uppercase}
.cf-section-total{font-family:var(--fm);font-size:.75rem;font-weight:600}
.cf-group{margin-bottom:14px}
.cf-group-label{font-family:var(--fm);font-size:.6rem;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;margin-bottom:6px}
.cf-row{display:grid;grid-template-columns:1fr auto auto;gap:10px;padding:9px 14px;border:1px solid var(--border);border-radius:var(--r2);margin-bottom:5px;align-items:center;background:var(--s2);transition:border-color .12s}
.cf-row:hover{border-color:var(--border2)}
.cf-row-left{min-width:0}
.cf-row-name{font-size:.82rem;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cf-row-meta{font-family:var(--fm);font-size:.65rem;color:var(--muted2);margin-top:2px}
.cf-row-freq{font-family:var(--fm);font-size:.62rem;color:var(--muted);background:var(--s3);border-radius:999px;padding:2px 8px;white-space:nowrap}
.cf-row-amount{font-family:var(--fm);font-size:.8rem;font-weight:600;text-align:right;white-space:nowrap}
.cf-row-actions{display:flex;gap:3px;opacity:0;transition:opacity .12s}
.cf-row:hover .cf-row-actions{opacity:1}
.cf-ot-badge{font-family:var(--fm);font-size:.6rem;padding:1px 7px;border-radius:999px;border:1px solid;white-space:nowrap}
.cf-type-toggle{display:flex;border:1px solid var(--border2);border-radius:var(--r2);overflow:hidden;margin-bottom:14px}
.cf-type-btn{flex:1;padding:8px 0;font-family:var(--fm);font-size:.72rem;border:none;cursor:pointer;transition:all .15s;letter-spacing:.04em}
.cf-freq-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}
.cf-freq-opt{padding:6px 0;font-family:var(--fm);font-size:.68rem;border:1px solid var(--border2);border-radius:var(--r2);cursor:pointer;text-align:center;transition:all .15s;background:none;color:var(--muted2)}
.cf-freq-opt:hover{border-color:var(--muted2);color:var(--text)}
.cf-freq-opt.on{border-color:var(--gold);color:var(--gold);background:var(--s3)}
.cf-hero-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:6px;font-family:var(--fm);font-size:.7rem}
.cf-rate-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:999px;font-family:var(--fm);font-size:.65rem;font-weight:600}
`;

// ─────────────────────────────────────────────────────────────
//  LOADING
// ─────────────────────────────────────────────────────────────
function LoadingPage({ onCancel }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSlow(true), 8000); return () => clearTimeout(t); }, []);
  return (
    <div className="setup">
      <style>{STYLE}</style>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"var(--fd)",fontSize:"1.8rem",color:"var(--gold)",marginBottom:16,letterSpacing:".02em"}}>Net Worth Tracker</div>
        <div style={{fontFamily:"var(--fm)",fontSize:".65rem",color:"var(--muted)",letterSpacing:".18em",textTransform:"uppercase",marginBottom:20}}>Connecting…</div>
        {slow && onCancel && (
          <div style={{marginTop:8}}>
            <div style={{fontFamily:"var(--fm)",fontSize:".7rem",color:"var(--muted2)",marginBottom:12}}>Taking longer than expected.</div>
            <button onClick={onCancel} style={{background:"none",border:"1px solid var(--border2)",color:"var(--muted2)",fontFamily:"var(--fm)",fontSize:".72rem",padding:"6px 16px",borderRadius:999,cursor:"pointer"}}>Sign out &amp; retry</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  SIGN IN
// ─────────────────────────────────────────────────────────────
function SignInPage({ gsiReady }) {
  const btnRef = useRef(null);
  const [gsiTimeout, setGsiTimeout] = useState(false);
  useEffect(() => {
    if (!gsiReady || !btnRef.current) return;
    window.google.accounts.id.renderButton(btnRef.current, { theme:"outline", size:"large", shape:"pill", text:"signin_with" });
    window.google.accounts.id.prompt();
  }, [gsiReady]);
  useEffect(() => {
    if (gsiReady) return;
    const t = setTimeout(() => setGsiTimeout(true), 6000);
    return () => clearTimeout(t);
  }, [gsiReady]);
  return (
    <div className="setup">
      <style>{STYLE}</style>
      <div className="setup-card" style={{textAlign:"center"}}>
        <div className="setup-title">Net Worth Tracker</div>
        <div className="setup-sub">Sign in with an authorised Google account to continue.</div>
        {gsiReady
          ? <div ref={btnRef} style={{display:"flex",justifyContent:"center",marginTop:20}}/>
          : gsiTimeout
            ? <div style={{fontFamily:"var(--fm)",fontSize:".72rem",color:"var(--muted2)",marginTop:20,lineHeight:1.7}}>
                Google Sign-In failed to load.<br/>
                <span style={{color:"var(--muted)"}}>Check your connection or disable any ad blocker, then refresh.</span>
              </div>
            : <div style={{color:"var(--muted)",fontFamily:"var(--fm)",fontSize:".8rem",marginTop:20}}>Loading…</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  SETUP SCREEN
// ─────────────────────────────────────────────────────────────
function SetupScreen({ onConnect, connecting, connectErr }) {
  const [url, setUrl] = useState("");

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-title">Net Worth Tracker</div>
        <div className="setup-sub">
          Connect your Google Sheet to get started. This is a one-time setup — your Web App URL will be saved in this browser.
        </div>

        {[
          ["1", <>Go to <a href="https://sheets.google.com" target="_blank" rel="noreferrer">sheets.google.com</a> and create a new blank spreadsheet. Name it <strong>"Net Worth Tracker"</strong>. Share it with your partner (Editor access) if needed.</>],
          ["2", <>In the spreadsheet, click <strong>Extensions → Apps Script</strong>. Delete existing code. Paste in the full <strong>Code.gs</strong> script and press <strong>Ctrl+S</strong> to save.</>],
          ["3", <>Click <strong>Deploy → New deployment</strong>. Type: <strong>Web app</strong>. Execute as: <strong>Me</strong>. Who has access: <strong>Anyone</strong>. Click <strong>Deploy</strong> and authorise.</>],
          ["4", <>Copy the <strong>Web app URL</strong> (starts with <code>https://script.google.com/macros/s/…</code>) and paste it below.</>],
        ].map(([n, text]) => (
          <div className="step" key={n}>
            <div className="step-num">{n}</div>
            <div className="step-text">{text}</div>
          </div>
        ))}

        <div className="frow" style={{marginTop:24}}>
          <div className="label">Web App URL</div>
          <input
            className="input"
            placeholder="https://script.google.com/macros/s/..."
            value={url}
            onChange={e=>setUrl(e.target.value)}
          />
        </div>
        {connectErr && <div style={{color:"var(--neg)",fontFamily:"var(--fm)",fontSize:".75rem",marginBottom:12}}>{connectErr}</div>}
        <button className="btn btn-primary" style={{width:"100%"}} onClick={()=>onConnect(url.trim())} disabled={connecting||!url.trim()}>
          {connecting ? "Connecting…" : "Connect & Start"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  PILL
// ─────────────────────────────────────────────────────────────
function Pill({label, color}) {
  return (
    <span className="pill" style={{color,borderColor:color+"44",background:color+"11"}}>
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
//  DONUT CHART
// ─────────────────────────────────────────────────────────────
// segments: [{key, label, value, color}] — values must be positive, in displayCurrency units for sizing
function DonutChart({ segments, displayCurrency }) {
  const [hov, setHov] = useState(null);
  const cx=88, cy=88, outerR=70, innerR=46;

  const entries = (segments||[]).filter(e => e.value > 0);
  const posTotal = entries.reduce((s,e)=>s+e.value, 0);

  if (!posTotal) return <div className="chart-empty">No data yet</div>;

  let angle=-90;
  const segs = entries.map(e => {
    const sweep = (e.value/posTotal)*360;
    const gap = entries.length>1 ? 1.2 : 0;
    const seg = { ...e, sa: angle+gap/2, ea: angle+sweep-gap/2 };
    angle += sweep;
    return seg;
  });

  const active = hov!==null ? segs[hov] : null;

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 176 176" style={{width:"100%",maxWidth:180,display:"block",margin:"0 auto"}}>
        {segs.map((seg,i)=>(
          <path key={i} d={donutArc(cx,cy,hov===i?outerR+4:outerR,innerR,seg.sa,seg.ea)}
            fill={seg.color}
            style={{opacity:hov!==null&&hov!==i?0.35:1,cursor:"pointer",transition:"all .15s"}}
            onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)}/>
        ))}
        <text x={cx} y={cy-10} textAnchor="middle" style={{fontFamily:"var(--fd)",fontSize:"13px",fill:"var(--gold)",fontWeight:600}}>
          {fmt(active?active.value:posTotal, displayCurrency, true)}
        </text>
        <text x={cx} y={cy+5} textAnchor="middle" style={{fontFamily:"var(--fm)",fontSize:"7px",fill:"var(--muted)",letterSpacing:".1em",textTransform:"uppercase"}}>
          {active?active.label:"Total"}
        </text>
        {active&&<text x={cx} y={cy+18} textAnchor="middle" style={{fontFamily:"var(--fm)",fontSize:"9px",fill:"var(--muted2)"}}>
          {((active.value/posTotal)*100).toFixed(1)}%
        </text>}
      </svg>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  TREND CHART
// ─────────────────────────────────────────────────────────────
function TrendChart({ milestones, currentValue, displayCurrency, toDisplay, targets = [] }) {
  const [tipIdx, setTipIdx] = useState(null);
  const svgRef = useRef(null);

  const now = Date.now();
  const futureTgts = useMemo(() => (targets||[])
    .filter(t => Number(t.targetTs) > now)
    .map(t => ({
      ts: Number(t.targetTs),
      val: t.currency === displayCurrency ? t.amount : toDisplay(t.amount, t.currency),
      label: t.label || 'Target',
      isTgt: true,
    }))
    .sort((a,b) => a.ts - b.ts),
  [targets, displayCurrency, toDisplay]);

  const pts = useMemo(() => {
    const ms = [...milestones]
      .sort((a,b)=>Number(a.ts)-Number(b.ts))
      .map(m => {
        const cur = m.summary?.currency || displayCurrency;
        const val = cur===displayCurrency ? (m.summary?.total||0) : toDisplay(m.summary?.total||0, cur);
        return { ts: Number(m.ts), val, label: m.label||null };
      });
    return [...ms, { ts: now, val: currentValue, label: "Now", isNow: true }];
  }, [milestones, currentValue, displayCurrency, toDisplay]);

  if (pts.length < 2) return (
    <div className="chart-empty">
      <div style={{fontSize:"1.4rem",opacity:.3,marginBottom:8}}>📈</div>
      Save milestones to chart your net worth over time
    </div>
  );

  const allTs = [...pts, ...futureTgts].map(p => p.ts);
  const allVals = [...pts, ...futureTgts].map(p => p.val);
  const W=560, H=150, PAD={l:58,r:16,t:12,b:30};
  const iW=W-PAD.l-PAD.r, iH=H-PAD.t-PAD.b;
  const minV=Math.min(...allVals), maxV=Math.max(...allVals);
  const vSpan=(maxV-minV)||1;
  const minTs=Math.min(...allTs), maxTs=Math.max(...allTs);
  const tSpan=(maxTs-minTs)||1;
  const sx=t=>PAD.l+((t-minTs)/tSpan)*iW;
  const sy=v=>PAD.t+iH-((v-minV)/vSpan)*iH;
  const mapped=pts.map(p=>({...p,x:sx(p.ts),y:sy(p.val)}));
  const f=n=>n.toFixed(1);
  const linePath=mapped.map((p,i)=>`${i?"L":"M"}${f(p.x)},${f(p.y)}`).join(" ");
  const areaPath=`${linePath} L${f(mapped.at(-1).x)},${f(PAD.t+iH)} L${f(mapped[0].x)},${f(PAD.t+iH)} Z`;
  const yTicks=[0,0.5,1].map(frac=>({v:minV+frac*vSpan,y:sy(minV+frac*vSpan)}));
  const isUp=pts.at(-1).val>=pts[0].val;
  const lc=isUp?"#c9a96e":"#e07070";
  const nowX=sx(now), nowY=sy(currentValue);

  const handleMM=e=>{
    if(!svgRef.current) return;
    const rect=svgRef.current.getBoundingClientRect();
    const mx=(e.clientX-rect.left)/rect.width*W;
    let near=0,nearD=Infinity;
    mapped.forEach((p,i)=>{const d=Math.abs(p.x-mx);if(d<nearD){nearD=d;near=i;}});
    setTipIdx(near);
  };

  const tip=tipIdx!==null?mapped[tipIdx]:null;

  return (
    <div style={{position:"relative"}}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        style={{width:"100%",display:"block",overflow:"visible",cursor:"crosshair"}}
        onMouseMove={handleMM} onMouseLeave={()=>setTipIdx(null)}>
        <defs>
          <linearGradient id="tgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lc} stopOpacity=".22"/>
            <stop offset="100%" stopColor={lc} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {yTicks.map((t,i)=>(
          <g key={i}>
            <line x1={PAD.l} y1={t.y} x2={W-PAD.r} y2={t.y} stroke="var(--border)" strokeWidth=".6" strokeDasharray="3 3"/>
            <text x={PAD.l-6} y={t.y+4} textAnchor="end" style={{fontFamily:"var(--fm)",fontSize:"8.5px",fill:"var(--muted)"}}>
              {fmt(t.v,displayCurrency,true)}
            </text>
          </g>
        ))}
        <path d={areaPath} fill="url(#tgrad)"/>
        <path d={linePath} fill="none" stroke={lc} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
        {/* future target dashed lines */}
        {futureTgts.map((t,i)=>{
          const tx=sx(t.ts), ty=sy(t.val);
          const achieved=currentValue>=t.val;
          const tc=achieved?"var(--pos)":"#6fb5a2";
          return (
            <g key={i}>
              <line x1={nowX} y1={nowY} x2={tx} y2={ty}
                stroke={tc} strokeWidth="1.5" strokeDasharray="5 3" opacity=".7"/>
              <polygon points={`${f(tx)},${f(ty-6)} ${f(tx+5)},${f(ty+3)} ${f(tx-5)},${f(ty+3)}`}
                fill={tc} opacity=".9"/>
              <text x={tx} y={ty-9} textAnchor="middle"
                style={{fontFamily:"var(--fm)",fontSize:"7px",fill:tc,letterSpacing:".04em"}}>
                {t.label}
              </text>
            </g>
          );
        })}
        {mapped.map((p,i)=>(
          <circle key={i} cx={p.x} cy={p.y} r={tipIdx===i?5:3.5} fill={lc} stroke="var(--s1)" strokeWidth="1.5"/>
        ))}
        {tip&&<line x1={tip.x} y1={PAD.t} x2={tip.x} y2={PAD.t+iH} stroke="var(--border2)" strokeWidth="1" strokeDasharray="3 3"/>}
        <text x={mapped[0].x} y={H-5} textAnchor="start" style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--muted)"}}>
          {new Date(pts[0].ts).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"2-digit"})}
        </text>
        <text x={nowX} y={H-5} textAnchor={futureTgts.length?"middle":"end"} style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--muted)"}}>
          Now
        </text>
        {futureTgts.length > 0 && (
          <text x={sx(futureTgts.at(-1).ts)} y={H-5} textAnchor="end" style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--muted)"}}>
            {new Date(futureTgts.at(-1).ts).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"2-digit"})}
          </text>
        )}
      </svg>
      {tip&&(
        <div className="chart-tt" style={{left:`${(tip.x/W*100).toFixed(1)}%`}}>
          <div className="chart-tt-val" style={{color:lc}}>{fmt(tip.val,displayCurrency)}</div>
          <div className="chart-tt-date">
            {tip.isNow?"Now":tip.label||new Date(tip.ts).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  CURRENCY DROPDOWN
// ─────────────────────────────────────────────────────────────
function CurrencyDropdown({ currencies, value, rates, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);
  return (
    <div className="cur-drop" ref={ref}>
      <button className={`cur-btn${open?" open":""}`} onClick={() => setOpen(o => !o)}>
        {value} <span className="cur-chevron">▾</span>
      </button>
      {open && (
        <div className="cur-menu">
          {currencies.map(c => {
            const r = rates[c];
            const rateLabel = c !== value && r ? `1 ${value} = ${r.toFixed(c === "IDR" ? 0 : 4)} ${c}` : c === value ? "Current" : "Rate unavailable";
            return (
              <button key={c} className={`cur-opt${c === value ? " sel" : ""}`} onClick={() => { onChange(c); setOpen(false); }}>
                <span className="cur-opt-code">{c}</span>
                <span className="cur-opt-rate">{rateLabel}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  ACCOUNT MODAL
// ─────────────────────────────────────────────────────────────
function AccountModal({ initial, onSave, onClose }) {
  const empty = { name:"", currency:"GBP", liquidity:"liquid", risk:"very-low", class:"cash-savings", type:"asset", notes:"", vesting:null };
  const [form, setForm] = useState(initial || empty);
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

  const [vestEnabled, setVestEnabled] = useState(!!initial?.vesting);
  const [vestCliff, setVestCliff] = useState(initial?.vesting?.cliffDate ? dateToStr(initial.vesting.cliffDate) : '');
  const [vestBy, setVestBy] = useState(initial?.vesting?.vestByDate ? dateToStr(initial.vesting.vestByDate) : '');

  const handleSave = () => {
    if (!form.name.trim()) return;
    const vesting = vestEnabled && vestCliff && vestBy
      ? { cliffDate: strToDateMs(vestCliff), vestByDate: strToDateMs(vestBy) }
      : null;
    onSave({ ...form, vesting });
  };

  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal">
        <div className="modal-title">{initial?"Edit Account":"Add Account"}</div>
        <button className="modal-close" onClick={onClose}>✕</button>

        <div className="frow">
          <div className="label">Account Name</div>
          <input className="input" placeholder="e.g. Barclays Current Account" value={form.name} onChange={e=>set("name",e.target.value)}/>
        </div>
        <div className="fgrid">
          <div className="frow">
            <div className="label">Currency</div>
            <select className="sel" value={form.currency} onChange={e=>set("currency",e.target.value)}>
              {CURRENCIES.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="frow">
            <div className="label">Account Type</div>
            <select className="sel" value={form.type} onChange={e=>set("type",e.target.value)}>
              {TYPE_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label} — {o.desc}</option>)}
            </select>
          </div>
        </div>
        <div className="frow">
          <div className="label">Account Class</div>
          <select className="sel" value={form.class} onChange={e=>set("class",e.target.value)}>
            {CLASS_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="frow">
          <div className="label">Liquidity</div>
          <select className="sel" value={form.liquidity} onChange={e=>set("liquidity",e.target.value)}>
            {LIQUIDITY_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label} — {o.desc}</option>)}
          </select>
        </div>
        <div className="frow">
          <div className="label">Risk Level</div>
          <select className="sel" value={form.risk} onChange={e=>set("risk",e.target.value)}>
            {RISK_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label} — {o.desc}</option>)}
          </select>
        </div>
        <div className="frow">
          <div className="label">Notes (optional)</div>
          <input className="input" placeholder="Any notes…" value={form.notes} onChange={e=>set("notes",e.target.value)}/>
        </div>

        {/* Vesting schedule */}
        <div className="frow" style={{borderTop:"1px solid var(--border)",paddingTop:14,marginTop:2}}>
          <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer"}}>
            <input type="checkbox" checked={vestEnabled} onChange={e=>setVestEnabled(e.target.checked)}
              style={{accentColor:"var(--gold)",width:15,height:15,cursor:"pointer"}}/>
            <span style={{fontSize:".82rem",color:"var(--text)",fontWeight:500}}>This account has a vesting schedule</span>
          </label>
        </div>
        {vestEnabled && (
          <div style={{background:"var(--s2)",border:"1px solid var(--border)",borderRadius:"var(--r2)",padding:"12px 14px",marginBottom:14}}>
            <div style={{fontSize:".72rem",color:"var(--muted2)",marginBottom:10,lineHeight:1.5,fontFamily:"var(--fm)"}}>
              Only the vested portion counts toward net worth. Set the total grant value via "Update Balance" as usual.
            </div>
            <div className="fgrid">
              <div className="frow" style={{marginBottom:0}}>
                <div className="label">Cliff Date</div>
                <input className="input" type="date" value={vestCliff} onChange={e=>setVestCliff(e.target.value)}
                  style={{colorScheme:"dark"}}/>
                <div style={{fontSize:".63rem",color:"var(--muted)",marginTop:3,fontFamily:"var(--fm)"}}>Nothing vests before this date</div>
              </div>
              <div className="frow" style={{marginBottom:0}}>
                <div className="label">Fully Vested By</div>
                <input className="input" type="date" value={vestBy} onChange={e=>setVestBy(e.target.value)}
                  style={{colorScheme:"dark"}}/>
                <div style={{fontSize:".63rem",color:"var(--muted)",marginTop:3,fontFamily:"var(--fm)"}}>100% vested on this date</div>
              </div>
            </div>
          </div>
        )}

        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!form.name.trim()}>
            {initial?"Save Changes":"Add Account"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  RECORD MODAL
// ─────────────────────────────────────────────────────────────
function RecordModal({ account, onSave, onClose }) {
  const [amount, setAmount] = useState("");
  const [dateStr, setDateStr] = useState(()=>localDatetimeStr(Date.now()));
  const [showHistory, setShowHistory] = useState(false);
  const records = [...(account.records||[])].sort((a,b)=>Number(b.ts)-Number(a.ts));

  const ts = useMemo(()=>{ const t=new Date(dateStr).getTime(); return isNaN(t)?Date.now():t; },[dateStr]);
  const isBackdated = ts < Date.now() - 90_000;
  const nowStr = localDatetimeStr(Date.now());

  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal">
        <div className="modal-title">Update Balance</div>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div style={{color:"var(--muted2)",fontSize:".85rem",marginBottom:16}}>{account.name}</div>
        <div className="frow">
          <div className="label">Balance ({account.currency})</div>
          <input className="input" type="number" placeholder="0.00" value={amount} onChange={e=>setAmount(e.target.value)} autoFocus/>
        </div>
        <div className="frow">
          <div className="label" style={{display:"flex",justifyContent:"space-between"}}>
            <span>Date &amp; Time</span>
            {isBackdated && <span className="backdate-tag">backdating</span>}
          </div>
          <input className="input" type="datetime-local" value={dateStr} max={nowStr} onChange={e=>setDateStr(e.target.value)}/>
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginBottom:20}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={()=>{if(amount!=="")onSave({amount:parseFloat(amount),ts})}} disabled={amount===""}>
            Record Balance
          </button>
        </div>
        {records.length>0 && (
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div className="st" style={{margin:0}}>History</div>
              <button className="btn btn-ghost btn-xs" onClick={()=>setShowHistory(h=>!h)}>{showHistory?"Hide":"Show"}</button>
            </div>
            {showHistory && records.slice(0,20).map((r,i)=>(
              <div className="rec-row" key={i}>
                <span style={{color:"var(--muted)"}}>{fmtDate(r.ts)}</span>
                <span style={{color:account.type==="liability"?"var(--neg)":"var(--gold)"}}>{fmt(r.amount,account.currency)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  SAVE MILESTONE MODAL
// ─────────────────────────────────────────────────────────────
function SaveMilestoneModal({ accounts, displayCurrency, toDisplay, excluded, onSave, onClose }) {
  const [label, setLabel] = useState("");
  const [dateStr, setDateStr] = useState(()=>localDatetimeStr(Date.now()));
  const nowStr = localDatetimeStr(Date.now());

  const ts = useMemo(()=>{ const t=new Date(dateStr).getTime(); return isNaN(t)?Date.now():t; },[dateStr]);
  const isBackdated = ts < Date.now() - 90_000;

  // Compute summary at the chosen timestamp
  const preview = useMemo(()=>{
    const visible = accounts.filter(a=>!excluded.has(a.id)&&!excluded.has(`cls:${a.class}`));
    let total=0, assets=0, liabilities=0;
    const byLiq={}, byRisk={}, byCur={}, byCls={};
    for (const acc of visible) {
      const raw = vestedBalanceAt(acc, ts);
      if (raw===null) continue;
      const conv = toDisplay(raw, acc.currency);
      const signed = acc.type==="liability" ? -Math.abs(conv) : conv;
      total+=signed;
      byLiq[acc.liquidity]=(byLiq[acc.liquidity]||0)+signed;
      byRisk[acc.risk]=(byRisk[acc.risk]||0)+signed;
      byCur[acc.currency]=(byCur[acc.currency]||0)+raw;
      byCls[acc.class]=(byCls[acc.class]||0)+signed;
      if(acc.type==="asset") assets+=conv; else liabilities+=Math.abs(conv);
    }
    return {total,byLiq,byRisk,byCur,byCls,assets,liabilities,currency:displayCurrency};
  },[accounts, excluded, ts, toDisplay, displayCurrency]);

  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal">
        <div className="modal-title">Save Milestone</div>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="frow">
          <div className="label">Label (optional)</div>
          <input className="input" placeholder="e.g. Year end 2024" value={label} onChange={e=>setLabel(e.target.value)} autoFocus/>
        </div>
        <div className="frow">
          <div className="label" style={{display:"flex",justifyContent:"space-between"}}>
            <span>Date &amp; Time</span>
            {isBackdated && <span className="backdate-tag">backdating</span>}
          </div>
          <input className="input" type="datetime-local" value={dateStr} max={nowStr} onChange={e=>setDateStr(e.target.value)}/>
        </div>
        <div className="ms-preview">
          <div className="ms-preview-label">Net worth {isBackdated?"at this date":"now"}</div>
          <div className="ms-preview-val">{fmt(preview.total, displayCurrency)}</div>
          <div className="ms-preview-sub">
            Assets {fmt(preview.assets,displayCurrency,true)} · Liabilities {fmt(preview.liabilities,displayCurrency,true)}
          </div>
        </div>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={()=>onSave({label,ts,summary:preview})}>
            Save Milestone
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  OVERVIEW PAGE
// ─────────────────────────────────────────────────────────────
function OverviewPage({ accounts, milestones, targets, baselineId, displayCurrency, toDisplay, excluded, onToggleExcluded, onSaveMilestone, onSetBaseline, growthTarget, onSetGrowthTarget, netMonthlyCashflow }) {
  const [showSaveDlg, setShowSaveDlg] = useState(false);
  const [rateUnit, setRateUnit] = useState('ann'); // 'ann'|'mo'|'day'
  const [elapsedUnit, setElapsedUnit] = useState('day'); // 'day'|'mo'|'yr'
  const [allocTab, setAllocTab] = useState('class');
  const [editingGrowth, setEditingGrowth] = useState(false);
  const [growthInput, setGrowthInput] = useState('');

  const cycleRate = () => setRateUnit(u => u==='ann'?'mo':u==='mo'?'day':'ann');
  const cycleElapsed = () => setElapsedUnit(u => u==='day'?'mo':u==='mo'?'yr':'day');
  const rateUnitShort = rateUnit==='ann'?'yr':rateUnit==='mo'?'mo':'day';
  const toRate = ann => rateUnit==='ann' ? ann : rateUnit==='mo' ? (1+ann)**(1/12)-1 : (1+ann)**(1/365.25)-1;
  const hiddenCount = accounts.filter(a=>excluded.has(a.id)||excluded.has(`cls:${a.class}`)).length;

  // ── Totals ──────────────────────────────────────────────────
  const s = useMemo(() => {
    let total=0, assets=0, liabilities=0;
    const byLiq={}, byRisk={}, byCur={}, byCls={};
    for (const acc of accounts) {
      if (excluded.has(acc.id) || excluded.has(`cls:${acc.class}`)) continue;
      const raw = vestedBalance(acc);
      if (raw===null) continue;
      const conv = toDisplay(raw, acc.currency);
      const signed = acc.type==="liability" ? -Math.abs(conv) : conv;
      total+=signed;
      byLiq[acc.liquidity]=(byLiq[acc.liquidity]||0)+signed;
      byRisk[acc.risk]=(byRisk[acc.risk]||0)+signed;
      byCur[acc.currency]=(byCur[acc.currency]||0)+raw;
      byCls[acc.class]=(byCls[acc.class]||0)+signed;
      if(acc.type==="asset") assets+=conv; else liabilities+=Math.abs(conv);
    }
    return {total,byLiq,byRisk,byCur,byCls,assets,liabilities};
  }, [accounts, excluded, toDisplay]);

  // ── Baseline ─────────────────────────────────────────────────
  const baseline = milestones.find(m=>m.id===baselineId);
  const baseSavedCur = baseline?.summary?.currency || displayCurrency;
  const baseTotal = baseline?.summary?.total != null
    ? (baseSavedCur===displayCurrency ? baseline.summary.total : toDisplay(baseline.summary.total, baseSavedCur))
    : null;
  const delta = baseTotal!=null ? s.total - baseTotal : null;
  const elapsedMs = baseline ? Date.now() - Number(baseline.ts) : null;
  const elapsedDays = elapsedMs ? Math.floor(elapsedMs/86400000) : null;
  const elapsedStr = elapsedDays!=null
    ? elapsedUnit==='day' ? `${elapsedDays}d`
    : elapsedUnit==='mo' ? `${(elapsedDays/30.44).toFixed(1)}mo`
    : `${(elapsedDays/365.25).toFixed(1)}yr`
    : null;

  // ── Growth rate (annualised since baseline) ──────────────────
  const growthRateAnn = useMemo(() => {
    if (!baseline || baseTotal==null || baseTotal<=0 || !elapsedMs) return null;
    const yrs = elapsedMs/(365.25*86400000);
    if (yrs < 7/365.25) return null;
    return (s.total/baseTotal)**(1/yrs)-1;
  }, [baseline, baseTotal, elapsedMs, s.total]);

  const growthAbsPerUnit = growthRateAnn!=null ? s.total * toRate(growthRateAnn) : null;
  const growthPctInUnit  = growthRateAnn!=null ? toRate(growthRateAnn)*100 : null;

  // ── Growth target ─────────────────────────────────────────────
  const growthTargetInUnit = growthTarget
    ? (rateUnit==='ann' ? growthTarget.amount : rateUnit==='mo' ? growthTarget.amount/12 : growthTarget.amount/365.25)
    : null;
  const growthTargetDiff = (growthAbsPerUnit!=null && growthTargetInUnit!=null)
    ? growthAbsPerUnit - growthTargetInUnit : null;

  const saveGrowthTarget = () => {
    const v = parseFloat(growthInput);
    onSetGrowthTarget(!isNaN(v) && v>0 ? {amount:v, currency:displayCurrency} : null);
    setEditingGrowth(false);
  };

  // ── Allocation tab data ───────────────────────────────────────
  const allocData = useMemo(() => {
    const mkRows = (opts, byMap, colorMap, getDesc) => {
      const posTotal = Object.values(byMap).filter(v=>v>0).reduce((a,b)=>a+b,0);
      const maxAbs = Math.max(...Object.values(byMap).map(v=>Math.abs(v)), 1);
      return {
        donutSegs: opts.filter(o=>(byMap[o.value]||0)>0)
          .map(o=>({key:o.value,label:o.label,value:byMap[o.value],color:colorMap[o.value]||'#888'})),
        rows: opts.filter(o=>byMap[o.value]!==undefined).map(o=>({
          key:o.value, label:o.label, value:byMap[o.value],
          color:colorMap[o.value]||'#888',
          barPct:Math.min(Math.abs(byMap[o.value])/maxAbs*100,100),
          desc:getDesc?.(o),
        })),
        posTotal,
      };
    };

    if (allocTab==='liquidity') return mkRows(LIQUIDITY_OPTIONS, s.byLiq, LIQ_COLORS, o=>o.desc);
    if (allocTab==='risk')      return mkRows(RISK_OPTIONS, s.byRisk, RISK_COLORS, o=>o.desc);

    if (allocTab==='currency') {
      const convMap = Object.fromEntries(Object.entries(s.byCur).map(([c,v])=>[c, toDisplay(v,c)]));
      const maxConv = Math.max(...Object.values(convMap).map(v=>Math.abs(v)), 1);
      return {
        donutSegs: Object.entries(s.byCur).filter(([c])=>(convMap[c]||0)>0)
          .map(([c])=>({key:c,label:c,value:convMap[c],color:CUR_COLORS[c]||'#888'})),
        rows: Object.entries(s.byCur).map(([c,native])=>({
          key:c, label:c, value:native, color:CUR_COLORS[c]||'#888',
          barPct:Math.min(Math.abs(convMap[c]||0)/maxConv*100,100),
          isCurrency:true, currency:c,
        })),
        posTotal: Object.values(convMap).filter(v=>v>0).reduce((a,b)=>a+b,0),
      };
    }

    if (allocTab==='type') {
      const maxAbs = Math.max(s.assets, s.liabilities, 1);
      return {
        donutSegs: [
          ...(s.assets>0?[{key:'asset',label:'Assets',value:s.assets,color:'#7eb8a4'}]:[]),
          ...(s.liabilities>0?[{key:'liability',label:'Liabilities',value:s.liabilities,color:'#e07070'}]:[]),
        ],
        rows: [
          {key:'asset',label:'Assets',value:s.assets,color:'#7eb8a4',barPct:Math.min(s.assets/maxAbs*100,100)},
          {key:'liability',label:'Liabilities',value:-s.liabilities,color:'#e07070',barPct:Math.min(s.liabilities/maxAbs*100,100)},
        ].filter(r=>Math.abs(r.value||0)>0),
        posTotal: s.assets,
      };
    }

    // default: class
    const posTotal = Object.values(s.byCls).filter(v=>v>0).reduce((a,b)=>a+b,0);
    const maxAbs = Math.max(...Object.values(s.byCls).map(v=>Math.abs(v)), 1);
    return {
      donutSegs: CLASS_OPTIONS
        .filter(o=>(s.byCls[o.value]||0)>0 && !excluded.has(`cls:${o.value}`))
        .map(o=>({key:o.value,label:o.label,value:s.byCls[o.value],color:CLS_COLORS[o.value]||'#888'})),
      rows: CLASS_OPTIONS
        .filter(o=>s.byCls[o.value]!==undefined||excluded.has(`cls:${o.value}`))
        .map(o=>({
          key:o.value, label:o.label, value:s.byCls[o.value]??0,
          color:CLS_COLORS[o.value]||'#888',
          barPct:Math.min(Math.abs(s.byCls[o.value]||0)/maxAbs*100,100),
          sharePct:(s.byCls[o.value]||0)>0&&posTotal>0?((s.byCls[o.value]/posTotal)*100).toFixed(1):null,
          isExcl:excluded.has(`cls:${o.value}`), clsKey:`cls:${o.value}`,
        })),
      posTotal,
    };
  }, [allocTab, s, excluded, toDisplay]);

  return (
    <div className="page">

      {/* ── Hero ── */}
      <div className="hero">
        <div className="hero-label">Total Net Worth</div>
        <div className="hero-value">{fmt(s.total, displayCurrency)}</div>
        <div className="hero-sub">Assets {fmt(s.assets,displayCurrency,true)} · Liabilities {fmt(s.liabilities,displayCurrency,true)}</div>

        {/* Baseline selector + Save */}
        <div className="hero-baseline-row">
          <select className="hero-sel" value={baselineId||''} onChange={e=>onSetBaseline(e.target.value||null)}>
            <option value="">No baseline</option>
            {[...milestones].sort((a,b)=>Number(b.ts)-Number(a.ts)).map(m=>(
              <option key={m.id} value={m.id}>{m.label||fmtDate(m.ts)}</option>
            ))}
          </select>
          <button className="btn btn-ghost btn-xs" onClick={()=>setShowSaveDlg(true)}>📌 Save</button>
        </div>

        {/* Delta + elapsed */}
        {delta!=null && (
          <div style={{marginTop:10,display:"flex",alignItems:"center",justifyContent:"center",gap:8,flexWrap:"wrap"}}>
            <span className={`delta ${delta>=0?"pos":"neg"}`} style={{margin:0}}>
              {delta>=0?"▲":"▼"} {(delta>=0?"+":"")+fmt(delta,displayCurrency)}
              {baseTotal ? ` (${((delta/Math.abs(baseTotal))*100).toFixed(1)}%)` : ""}
            </span>
            {elapsedStr && (
              <button onClick={cycleElapsed} style={{background:"none",border:"1px solid var(--border2)",
                borderRadius:999,padding:"2px 8px",cursor:"pointer",
                color:"var(--muted2)",fontSize:".65rem",fontFamily:"var(--fm)"}}>
                {elapsedStr}
              </button>
            )}
          </div>
        )}

        {/* Growth rate */}
        {growthAbsPerUnit!=null && (
          <div style={{marginTop:6,display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            <span style={{fontFamily:"var(--fm)",fontSize:".68rem",color:"var(--muted)"}}>Rate</span>
            <button onClick={cycleRate} style={{background:"none",border:"none",padding:0,cursor:"pointer",
              color:growthAbsPerUnit>=0?"var(--pos)":"var(--neg)",
              fontSize:".78rem",fontFamily:"var(--fm)",fontWeight:600}}>
              {growthAbsPerUnit>=0?"+":""}{fmt(growthAbsPerUnit,displayCurrency,true)}/{rateUnitShort}
              {' '}({growthPctInUnit>=0?"+":""}{growthPctInUnit.toFixed(2)}%)
            </button>
          </div>
        )}

        {/* Growth target */}
        {editingGrowth ? (
          <div className="gtgt-edit-row">
            <span style={{fontFamily:"var(--fm)",fontSize:".65rem",color:"var(--muted)"}}>Target</span>
            <input className="hero-input" autoFocus value={growthInput}
              onChange={e=>setGrowthInput(e.target.value)}
              onKeyDown={e=>{if(e.key==='Enter')saveGrowthTarget();if(e.key==='Escape')setEditingGrowth(false);}}
              placeholder="e.g. 20000"/>
            <span style={{fontFamily:"var(--fm)",fontSize:".65rem",color:"var(--muted)"}}>{displayCurrency}/{rateUnitShort}</span>
            <button className="btn btn-primary btn-xs" onClick={saveGrowthTarget}>Save</button>
            <button className="btn btn-ghost btn-xs" onClick={()=>setEditingGrowth(false)}>✕</button>
          </div>
        ) : growthTarget ? (
          <div className="gtgt-row">
            <span style={{color:"var(--muted)"}}>Target</span>
            <span style={{color:"var(--text)",fontWeight:500}}>
              {fmt(growthTargetInUnit,displayCurrency,true)}/{rateUnitShort}
            </span>
            {growthTargetDiff!=null && (
              <span style={{color:growthTargetDiff>=0?"var(--pos)":"var(--neg)"}}>
                {growthTargetDiff>=0?"✓ +":"✗ "}{fmt(Math.abs(growthTargetDiff),displayCurrency,true)} {growthTargetDiff>=0?"ahead":"short"}
              </span>
            )}
            <button onClick={()=>{setGrowthInput(String(Math.round(growthTarget.amount)));setEditingGrowth(true);}}
              style={{background:"none",border:"none",padding:0,cursor:"pointer",color:"var(--muted)",fontSize:".7rem"}}>✎</button>
            <button onClick={()=>onSetGrowthTarget(null)}
              style={{background:"none",border:"none",padding:0,cursor:"pointer",color:"var(--muted)",fontSize:".7rem",opacity:.5}}>✕</button>
          </div>
        ) : (
          <div style={{marginTop:6}}>
            <button onClick={()=>{setGrowthInput('');setEditingGrowth(true);}}
              style={{background:"none",border:"1px solid var(--border2)",borderRadius:999,padding:"2px 10px",
                cursor:"pointer",color:"var(--muted)",fontSize:".65rem",fontFamily:"var(--fm)"}}>
              + Set growth target
            </button>
          </div>
        )}

        {/* Cashflow savings rate indicator */}
        {netMonthlyCashflow!=null && (()=>{
          const annualSavings = netMonthlyCashflow * 12;
          const tgtAnn = growthTarget?.amount ?? null;
          const diff = tgtAnn!=null ? annualSavings - tgtAnn : null;
          const pct = s.total>0 ? netMonthlyCashflow/s.total*100 : null;
          // status: green if within 0-10% short or ahead, amber if 10-30% short, red if >30% short
          const status = diff==null ? null : diff>=0?"pos":diff>=-tgtAnn*0.1?"pos":diff>=-tgtAnn*0.3?"warn":"neg";
          return (
            <div className="cf-hero-row">
              <span style={{color:"var(--muted)"}}>Cash</span>
              <span style={{color:netMonthlyCashflow>=0?"var(--pos)":"var(--neg)",fontWeight:500}}>
                {netMonthlyCashflow>=0?"+":""}{fmt(netMonthlyCashflow,displayCurrency,true)}/mo
              </span>
              {pct!=null&&<span style={{color:"var(--muted2)",fontSize:".65rem"}}>({pct.toFixed(1)}% of NW p.a.)</span>}
              {diff!=null&&(
                <span className="cf-rate-pill" style={{
                  background:status==="pos"?"rgba(111,181,162,.15)":status==="warn"?"rgba(200,169,110,.15)":"rgba(217,107,107,.15)",
                  color:status==="pos"?"var(--pos)":status==="warn"?"var(--gold)":"var(--neg)",
                }}>
                  {diff>=0?"✓ on track":`✗ ${fmt(Math.abs(diff),displayCurrency,true)}/yr short`}
                </span>
              )}
            </div>
          );
        })()}

        {/* Nearest upcoming target (from Targets page) */}
        {(()=>{
          const now = Date.now();
          const upcoming = (targets||[])
            .filter(t=>Number(t.targetTs)>now)
            .sort((a,b)=>Number(a.targetTs)-Number(b.targetTs));
          if (!upcoming.length) return null;
          const t = upcoming[0];
          const tVal = t.currency===displayCurrency ? t.amount : toDisplay(t.amount, t.currency);
          const pct = tVal>0 ? Math.min(s.total/tVal*100,100) : 0;
          const achieved = s.total >= tVal;
          const monthsLeft = (Number(t.targetTs)-now)/(30*86400000);
          let onTrack = null;
          if (growthRateAnn && !achieved) {
            const elYears = (Number(t.targetTs)-now)/(365.25*86400000);
            const projected = s.total * (1+growthRateAnn)**elYears;
            if (projected >= tVal) {
              onTrack = "on track";
            } else {
              const behindMo = Math.ceil(Math.log(tVal/s.total)/Math.log(1+growthRateAnn/12) - monthsLeft);
              onTrack = behindMo>0 ? `~${behindMo}mo behind` : "on track";
            }
          }
          return (
            <div className="tgt-hero">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",flexWrap:"wrap",gap:6}}>
                <span style={{fontSize:".7rem",fontFamily:"var(--fm)",color:"var(--gold)",letterSpacing:".06em",textTransform:"uppercase"}}>
                  🎯 {t.label||"Target"}
                </span>
                <span style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)"}}>
                  {achieved ? "✓ Achieved" : `${fmt(tVal,displayCurrency)} · ${Math.ceil(monthsLeft)}mo left`}
                  {onTrack && !achieved && <span style={{marginLeft:6,color:onTrack==="on track"?"var(--pos)":"var(--neg)"}}>{onTrack}</span>}
                </span>
              </div>
              <div className="tgt-track">
                <div className="tgt-fill" style={{width:pct+"%",...(achieved?{background:"var(--pos)"}:{})}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between"}}>
                <span style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)"}}>{pct.toFixed(1)}% complete</span>
                {upcoming.length>1&&<span style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)"}}>+{upcoming.length-1} more target{upcoming.length>2?"s":""}</span>}
              </div>
            </div>
          );
        })()}

        {hiddenCount>0 && (
          <div style={{fontSize:".6rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:10,letterSpacing:".04em"}}>
            {hiddenCount} account{hiddenCount>1?"s":""} hidden from totals
          </div>
        )}
      </div>

      {/* ── Net Worth Trend ── */}
      <div className="st">Net Worth Trend</div>
      <div className="card">
        <TrendChart milestones={milestones} currentValue={s.total} displayCurrency={displayCurrency} toDisplay={toDisplay} targets={targets}/>
      </div>

      {/* ── Allocation (consolidated) ── */}
      <div className="st">Allocation</div>
      <div className="card">
        <div className="alloc-tabs">
          {[['class','Class'],['liquidity','Liquidity'],['risk','Risk'],['currency','Currency'],['type','Type']].map(([v,l])=>(
            <button key={v} className={`alloc-tab${allocTab===v?' on':''}`} onClick={()=>setAllocTab(v)}>{l}</button>
          ))}
        </div>
        <div className="alloc-grid">
          <DonutChart segments={allocData.donutSegs} displayCurrency={displayCurrency}/>
          <div className="alloc-bars">
            {allocData.rows.map(row=>(
              <div className={`bar-row${row.isExcl?" excl-row":""}`} key={row.key}>
                <div className="bar-row-top">
                  <span style={{color:row.isExcl?"var(--muted)":"var(--text)",display:"flex",alignItems:"center",gap:6,flex:1,minWidth:0}}>
                    <span className="cls-dot" style={{background:row.color,flexShrink:0}}/>
                    <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row.label}</span>
                    {row.desc&&<span style={{color:"var(--muted)",fontSize:".62rem",fontFamily:"var(--fm)",flexShrink:0}}>{row.desc}</span>}
                  </span>
                  <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
                    {row.isExcl
                      ? <span className="excl-tag">hidden</span>
                      : <>
                          <span className={`crow-val ${(row.value||0)<0?"neg":(row.value||0)===0?"neu":"pos"}`}>
                            {row.isCurrency ? fmt(row.value,row.currency) : fmt(row.value,displayCurrency)}
                          </span>
                          {row.sharePct&&<span className="bar-pct">{row.sharePct}%</span>}
                        </>
                    }
                    {row.clsKey&&(
                      <button className="excl-btn" onClick={()=>onToggleExcluded(row.clsKey)}>
                        {row.isExcl?"Show":"Hide"}
                      </button>
                    )}
                  </div>
                </div>
                {!row.isExcl&&(
                  <div className="bar-track">
                    <div className="bar-fill" style={{width:(row.barPct||0)+"%",background:(row.value||0)<0?"var(--neg)":row.color}}/>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showSaveDlg && (
        <SaveMilestoneModal
          accounts={accounts} displayCurrency={displayCurrency} toDisplay={toDisplay} excluded={excluded}
          onSave={d=>{onSaveMilestone(d);setShowSaveDlg(false)}}
          onClose={()=>setShowSaveDlg(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  BALANCE CHART  (used inside AccountHistoryModal)
// ─────────────────────────────────────────────────────────────
function BalanceChart({ records, currency, isLiability }) {
  const [tipIdx, setTipIdx] = useState(null);
  const svgRef = useRef(null);
  const lc = isLiability ? "#e07070" : "#c9a96e";

  // records already sorted oldest→newest
  const pts = records.map(r=>({ ts: Number(r.ts), val: Number(r.amount) }));
  if (pts.length < 2) return (
    <div className="chart-empty" style={{padding:"20px 0"}}>Add at least two balance entries to see a chart.</div>
  );

  const W=520, H=140, PAD={l:58,r:14,t:10,b:28};
  const iW=W-PAD.l-PAD.r, iH=H-PAD.t-PAD.b;
  const vals=pts.map(p=>p.val);
  const minV=Math.min(...vals), maxV=Math.max(...vals);
  const vSpan=(maxV-minV)||Math.abs(minV)||1;
  const tSpan=pts.at(-1).ts-pts[0].ts||1;
  const sx=t=>PAD.l+((t-pts[0].ts)/tSpan)*iW;
  const sy=v=>PAD.t+iH-((v-minV)/vSpan)*iH;
  const mp=pts.map(p=>({...p,x:sx(p.ts),y:sy(p.val)}));
  const f=n=>n.toFixed(1);
  const line=mp.map((p,i)=>`${i?"L":"M"}${f(p.x)},${f(p.y)}`).join(" ");
  const area=`${line} L${f(mp.at(-1).x)},${f(PAD.t+iH)} L${f(mp[0].x)},${f(PAD.t+iH)} Z`;
  const yTicks=[0,0.5,1].map(fr=>({v:minV+fr*vSpan,y:sy(minV+fr*vSpan)}));

  const handleMM=e=>{
    if(!svgRef.current) return;
    const rect=svgRef.current.getBoundingClientRect();
    const mx=(e.clientX-rect.left)/rect.width*W;
    let near=0,nearD=Infinity;
    mp.forEach((p,i)=>{const d=Math.abs(p.x-mx);if(d<nearD){nearD=d;near=i;}});
    setTipIdx(near);
  };
  const tip=tipIdx!==null?mp[tipIdx]:null;

  return (
    <div style={{position:"relative"}}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        style={{width:"100%",display:"block",overflow:"visible",cursor:"crosshair"}}
        onMouseMove={handleMM} onMouseLeave={()=>setTipIdx(null)}>
        <defs>
          <linearGradient id="bgrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lc} stopOpacity=".2"/>
            <stop offset="100%" stopColor={lc} stopOpacity="0"/>
          </linearGradient>
        </defs>
        {yTicks.map((t,i)=>(
          <g key={i}>
            <line x1={PAD.l} y1={t.y} x2={W-PAD.r} y2={t.y} stroke="var(--border)" strokeWidth=".6" strokeDasharray="3 3"/>
            <text x={PAD.l-6} y={t.y+4} textAnchor="end" style={{fontFamily:"var(--fm)",fontSize:"8.5px",fill:"var(--muted)"}}>
              {fmt(t.v,currency,true)}
            </text>
          </g>
        ))}
        <path d={area} fill="url(#bgrad)"/>
        <path d={line} fill="none" stroke={lc} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"/>
        {mp.map((p,i)=>(
          <circle key={i} cx={p.x} cy={p.y} r={tipIdx===i?5:3} fill={lc} stroke="var(--s1)" strokeWidth="1.5"/>
        ))}
        {tip&&<line x1={tip.x} y1={PAD.t} x2={tip.x} y2={PAD.t+iH} stroke="var(--border2)" strokeWidth="1" strokeDasharray="3 3"/>}
        <text x={mp[0].x} y={H-4} textAnchor="start" style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--muted)"}}>
          {new Date(pts[0].ts).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"2-digit"})}
        </text>
        <text x={mp.at(-1).x} y={H-4} textAnchor="end" style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--muted)"}}>
          {new Date(pts.at(-1).ts).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"2-digit"})}
        </text>
      </svg>
      {tip&&(
        <div className="chart-tt" style={{left:`${(tip.x/W*100).toFixed(1)}%`}}>
          <div className="chart-tt-val" style={{color:lc}}>{fmt(tip.val,currency)}</div>
          <div className="chart-tt-date">{new Date(tip.ts).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}</div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  ACCOUNT HISTORY MODAL
// ─────────────────────────────────────────────────────────────
function AccountHistoryModal({ account, displayCurrency, toDisplay, onUpdateBalance, onEdit, onDeleteRecord, onClose }) {
  const isLiability = account.type === "liability";
  const accentColor = isLiability ? "var(--neg)" : "var(--gold)";
  const [confirmingDelete, setConfirmingDelete] = useState(null); // record id
  const sorted = useMemo(()=>
    [...(account.records||[])].sort((a,b)=>Number(b.ts)-Number(a.ts))
  ,[account.records]);
  const chronological = [...sorted].reverse();
  const bal = latestBalance(account);
  const frac = account.vesting ? vestedFraction(account.vesting) : 1;
  const vestedBal = bal!==null ? (account.vesting ? bal*frac : bal) : null;
  const unvestedBal = bal!==null && account.vesting ? bal*(1-frac) : null;
  const conv = vestedBal!==null ? toDisplay(vestedBal, account.currency) : null;
  const signed = conv!==null ? (isLiability ? -Math.abs(conv) : conv) : null;
  const vestPct = account.vesting ? Math.round(frac*100) : null;

  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal" style={{maxWidth:580}}>
        <button className="modal-close" onClick={onClose}>✕</button>

        {/* Header */}
        <div style={{marginBottom:14}}>
          <div className="modal-title" style={{marginBottom:6}}>{account.name}</div>
          <div className="acc-pills" style={{marginBottom:0}}>
            <Pill label={CLASS_OPTIONS.find(o=>o.value===account.class)?.label||account.class} color="var(--gold)"/>
            <Pill label={LIQUIDITY_OPTIONS.find(o=>o.value===account.liquidity)?.label||account.liquidity} color={LIQ_COLORS[account.liquidity]||"#6b7280"}/>
            <Pill label={(RISK_OPTIONS.find(o=>o.value===account.risk)?.label||account.risk)+" risk"} color={RISK_COLORS[account.risk]||"#6b7280"}/>
            <Pill label={isLiability?"Liability":"Asset"} color={isLiability?"var(--neg)":"var(--teal)"}/>
            {account.vesting&&<Pill label={frac===0?"Pre-cliff":frac===1?"Fully Vested":`${vestPct}% Vested`} color={frac===0?"var(--muted)":frac===1?"var(--pos)":"var(--gold)"}/>}
          </div>
        </div>

        {/* Vesting section */}
        {account.vesting && bal!==null && (
          <div style={{background:"var(--s2)",border:"1px solid var(--border)",borderRadius:"var(--r2)",padding:"14px 16px",marginBottom:14}}>
            <div style={{fontSize:".6rem",fontFamily:"var(--fm)",letterSpacing:".12em",color:"var(--muted)",textTransform:"uppercase",marginBottom:10}}>Vesting Schedule</div>
            <div className="vest-track" style={{marginBottom:10}}>
              <div className="vest-fill" style={{width:`${vestPct}%`}}/>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
              <div>
                <div style={{fontSize:".6rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:3}}>Cliff</div>
                <div style={{fontSize:".78rem",fontFamily:"var(--fm)",color:"var(--text)"}}>{new Date(Number(account.vesting.cliffDate)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}</div>
              </div>
              <div>
                <div style={{fontSize:".6rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:3}}>Full Vest</div>
                <div style={{fontSize:".78rem",fontFamily:"var(--fm)",color:"var(--text)"}}>{new Date(Number(account.vesting.vestByDate)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}</div>
              </div>
              <div>
                <div style={{fontSize:".6rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:3}}>Vested Today</div>
                <div style={{fontSize:".78rem",fontFamily:"var(--fm)",color:frac===0?"var(--neg)":frac===1?"var(--pos)":"var(--gold)"}}>{vestPct}%</div>
              </div>
            </div>
            {unvestedBal!==null&&(
              <div style={{display:"flex",justifyContent:"space-between",marginTop:10,paddingTop:10,borderTop:"1px solid var(--border)"}}>
                <div>
                  <div style={{fontSize:".6rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:2}}>Vested (counts toward net worth)</div>
                  <div style={{fontFamily:"var(--fm)",fontSize:".9rem",color:"var(--pos)"}}>{fmt(vestedBal,account.currency)}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  <div style={{fontSize:".6rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:2}}>Unvested (contingent)</div>
                  <div style={{fontFamily:"var(--fm)",fontSize:".9rem",color:"var(--muted2)"}}>{fmt(unvestedBal,account.currency)}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Current balance summary */}
        <div className="hist-summary">
          <div>
            <div className="hist-summary-label">{account.vesting?"Vested Balance":"Current Balance"}</div>
            <div className="hist-summary-val" style={{color:accentColor}}>
              {vestedBal!==null?fmt(vestedBal,account.currency):"—"}
            </div>
            {unvestedBal!==null&&unvestedBal>0&&(
              <div className="hist-summary-conv">Total grant: {fmt(bal,account.currency)}</div>
            )}
            {conv!==null&&account.currency!==displayCurrency&&(
              <div className="hist-summary-conv">≈ {fmt(signed,displayCurrency)}</div>
            )}
          </div>
          <div style={{textAlign:"right"}}>
            <div className="hist-summary-label">Records</div>
            <div className="hist-summary-val">{sorted.length}</div>
            <div className="hist-summary-conv">{latestTs(account)?"Last: "+new Date(Number(latestTs(account))).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}):"Never updated"}</div>
          </div>
        </div>

        {/* Chart */}
        <div style={{marginBottom:16}}>
          <BalanceChart records={chronological} currency={account.currency} isLiability={isLiability}/>
        </div>

        {/* Records table */}
        {sorted.length>0 && (
          <div className="hist-table-wrap">
            <div className="hist-table-head">
              <span>Date</span>
              <span style={{textAlign:"right"}}>Change</span>
              <span style={{textAlign:"right"}}>Balance</span>
              <span/>
            </div>
            {sorted.map((r,i)=>{
              if (confirmingDelete === r.id) {
                return (
                  <div className="hist-row-confirm" key={r.id||i}>
                    <span className="hist-confirm-label">Delete {fmtDate(r.ts)} entry ({fmt(r.amount,account.currency)})?</span>
                    <button className="hist-confirm-btn hist-confirm-yes" onClick={()=>{onDeleteRecord(account.id,r.id);setConfirmingDelete(null)}}>Delete</button>
                    <button className="hist-confirm-btn hist-confirm-no" onClick={()=>setConfirmingDelete(null)}>Cancel</button>
                  </div>
                );
              }
              const prev = sorted[i+1]; // older record
              const delta = prev ? Number(r.amount)-Number(prev.amount) : null;
              return (
                <div className="hist-row" key={r.id||i}>
                  <span className="hist-date">{fmtDate(r.ts)}</span>
                  <span className={`hist-delta ${delta===null?"neu":delta>0?isLiability?"neg":"pos":delta<0?isLiability?"pos":"neg":"neu"}`}>
                    {delta===null?"—":( (delta>0?"+":"")+fmt(delta,account.currency,true) )}
                  </span>
                  <span className="hist-amount" style={{color:accentColor}}>{fmt(r.amount,account.currency)}</span>
                  <button className="hist-del-btn" title="Delete this entry" onClick={()=>setConfirmingDelete(r.id)}>✕</button>
                </div>
              );
            })}
          </div>
        )}
        {sorted.length===0&&<div className="empty" style={{padding:"24px 0"}}>No balance records yet.</div>}

        {/* Actions */}
        {account.notes&&<div style={{fontFamily:"var(--fm)",fontSize:".75rem",color:"var(--muted2)",margin:"14px 0 0",fontStyle:"italic"}}>Note: {account.notes}</div>}
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:18,paddingTop:14,borderTop:"1px solid var(--border)"}}>
          <button className="btn btn-ghost btn-sm" onClick={onEdit}>Edit Account</button>
          <button className="btn btn-primary btn-sm" onClick={onUpdateBalance}>Update Balance</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  SORTABLE ACCOUNT CARD WRAPPER
// ─────────────────────────────────────────────────────────────
function DragHandleIcon() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
      {[0,1,2,3].flatMap(r=>[0,1].map(c=>(
        <circle key={`${r}-${c}`} cx={2+c*6} cy={2+r*4} r={1.5}/>
      )))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
//  ACCOUNT CARD (shared by list + drag overlay)
// ─────────────────────────────────────────────────────────────
function AccountCard({ acc, displayCurrency, toDisplay, excluded, onToggleExcluded, onDelete, onRecord, onEdit, onView, dragListeners, dragAttributes, isOverlay }) {
  const bal = latestBalance(acc);
  const frac = acc.vesting ? vestedFraction(acc.vesting) : 1;
  const vestedBal = bal !== null ? (acc.vesting ? bal * frac : bal) : null;
  const unvestedBal = bal !== null && acc.vesting ? bal * (1 - frac) : null;
  const conv = vestedBal !== null ? toDisplay(vestedBal, acc.currency) : null;
  const signed = conv !== null ? (acc.type === "liability" ? -Math.abs(conv) : conv) : null;
  const isExcl = excluded.has(acc.id) || excluded.has(`cls:${acc.class}`);
  const clsExcl = excluded.has(`cls:${acc.class}`);
  const vestPct = acc.vesting ? Math.round(frac * 100) : null;
  const isPrevest = acc.vesting && frac === 0;
  const isFullyVested = acc.vesting && frac === 1;

  return (
    <div className={`acc-card acc-card-click${isExcl ? " excl-card" : ""}${isOverlay ? " drag-overlay" : ""}`}
      onClick={() => !isOverlay && onView(acc)}>
      <div className="acc-top">
        <div className="drag-handle" {...(dragListeners||{})} {...(dragAttributes||{})}
          onClick={e => e.stopPropagation()} style={{touchAction:"none"}}>
          <DragHandleIcon />
        </div>
        <div style={{flex:1}}>
          <div className="acc-name">{acc.name}</div>
          <div style={{fontSize:".72rem",color:"var(--muted)",fontFamily:"var(--fm)",marginTop:2}}>{acc.currency}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div className={`acc-balance ${acc.type === "liability" ? "liability" : ""}`}>
            {vestedBal !== null ? fmt(vestedBal, acc.currency) : "No balance recorded"}
          </div>
          {unvestedBal !== null && unvestedBal > 0 && (
            <div style={{fontSize:".68rem",color:"var(--muted)",fontFamily:"var(--fm)"}}>+{fmt(unvestedBal, acc.currency)} unvested</div>
          )}
          {conv !== null && acc.currency !== displayCurrency && (
            <div style={{fontSize:".7rem",color:"var(--muted)",fontFamily:"var(--fm)"}}>≈ {fmt(signed, displayCurrency)}</div>
          )}
        </div>
      </div>
      {acc.vesting && bal !== null && (
        <div className="vest-progress">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <span style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase"}}>
              {isPrevest ? "Pre-cliff" : isFullyVested ? "Fully Vested" : `Vesting · ${vestPct}%`}
            </span>
            <span style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted2)"}}>
              {isFullyVested
                ? `Vested ${new Date(Number(acc.vesting.vestByDate)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}`
                : isPrevest
                  ? `Cliff ${new Date(Number(acc.vesting.cliffDate)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}`
                  : `Full vest ${new Date(Number(acc.vesting.vestByDate)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}`}
            </span>
          </div>
          <div className="vest-track"><div className="vest-fill" style={{width:`${vestPct}%`}}/></div>
        </div>
      )}
      <div className="acc-pills">
        <Pill label={CLASS_OPTIONS.find(o=>o.value===acc.class)?.label||acc.class} color="var(--gold)"/>
        <Pill label={LIQUIDITY_OPTIONS.find(o=>o.value===acc.liquidity)?.label||acc.liquidity} color={LIQ_COLORS[acc.liquidity]||"#6b7280"}/>
        <Pill label={(RISK_OPTIONS.find(o=>o.value===acc.risk)?.label||acc.risk)+" risk"} color={RISK_COLORS[acc.risk]||"#6b7280"}/>
        <Pill label={acc.type==="liability"?"Liability":"Asset"} color={acc.type==="liability"?"var(--neg)":"var(--teal)"}/>
        {acc.vesting&&<Pill label={isPrevest?"Pre-cliff":isFullyVested?"Fully Vested":`${vestPct}% Vested`} color={isPrevest?"var(--muted)":isFullyVested?"var(--pos)":"var(--gold)"}/>}
        {isExcl&&<Pill label={clsExcl?"Class hidden":"Hidden from overview"} color="var(--muted)"/>}
      </div>
      {!isOverlay && (
        <div className="acc-footer">
          <div className="acc-ts">
            {latestTs(acc) ? "Updated "+fmtDate(latestTs(acc)) : "Never updated"}
            {acc.notes&&<span style={{marginLeft:8,color:"var(--muted)"}}>· {acc.notes}</span>}
          </div>
          <div className="acc-actions" onClick={e=>e.stopPropagation()}>
            <button className="btn btn-ghost btn-xs" onClick={()=>onRecord(acc)}>Update Balance</button>
            <button className="btn btn-ghost btn-xs" onClick={()=>onEdit(acc)}>Edit</button>
            {!clsExcl&&(
              <button className={`btn btn-xs ${isExcl?"btn-ghost excl-active":"btn-ghost"}`}
                onClick={()=>onToggleExcluded(acc.id)}>
                {isExcl?"Unhide":"Hide"}
              </button>
            )}
            <button className="btn btn-danger btn-xs"
              onClick={()=>{if(window.confirm(`Remove "${acc.name}"?`))onDelete(acc.id)}}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SortableAccountCard({ acc, ...cardProps }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: acc.id });
  const style = {
    transform: CSS.Transform.toString(transform) || undefined,
    transition: transition || undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "acc-card-dragging" : ""}>
      <AccountCard acc={acc} dragListeners={listeners} dragAttributes={attributes} {...cardProps} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  ACCOUNTS PAGE
// ─────────────────────────────────────────────────────────────
function AccountsPage({ accounts, displayCurrency, toDisplay, excluded, onToggleExcluded, onAdd, onUpdate, onDelete, onRecord, onDeleteRecord, accountOrder, onReorder }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [recording, setRecording] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [filter, setFilter] = useState("all");
  const [activeId, setActiveId] = useState(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const sorted = useMemo(() => {
    const order = Array.isArray(accountOrder) ? accountOrder : [];
    if (!order.length) return accounts;
    const orderMap = new Map(order.map((id, i) => [id, i]));
    return [...accounts].sort((a, b) => (orderMap.get(a.id) ?? Infinity) - (orderMap.get(b.id) ?? Infinity));
  }, [accounts, accountOrder]);

  const filtered = filter === "all" ? sorted : sorted.filter(a => a.class === filter);
  const activeAcc = activeId ? accounts.find(a => a.id === activeId) : null;

  const handleDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const filteredIds = filtered.map(a => a.id);
    const newFilteredIds = arrayMove(filteredIds, filteredIds.indexOf(active.id), filteredIds.indexOf(over.id));
    const visibleSet = new Set(filteredIds);
    const base = (Array.isArray(accountOrder) && accountOrder.length) ? accountOrder : accounts.map(a => a.id);
    let vi = 0;
    const newOrder = base.map(id => visibleSet.has(id) ? newFilteredIds[vi++] : id);
    accounts.forEach(a => { if (!newOrder.includes(a.id)) newOrder.push(a.id); });
    onReorder(newOrder);
  };

  const cardProps = { displayCurrency, toDisplay, excluded, onToggleExcluded, onDelete,
    onRecord: acc => setRecording(acc), onEdit: acc => setEditing(acc), onView: acc => setViewing(acc) };

  return (
    <div className="page">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:14}}>
        <select className="cur-sel" value={filter} onChange={e=>setFilter(e.target.value)}>
          <option value="all">All Classes</option>
          {CLASS_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={()=>setShowAdd(true)}>+ Add Account</button>
      </div>

      {filtered.length===0&&(
        <div className="empty"><div className="empty-icon">🏦</div>No accounts yet. Add one to get started.</div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter}
        onDragStart={({active})=>setActiveId(active.id)} onDragEnd={handleDragEnd}>
        <SortableContext items={filtered.map(a=>a.id)} strategy={verticalListSortingStrategy}>
          {filtered.map(acc=>(
            <SortableAccountCard key={acc.id} acc={acc} {...cardProps}/>
          ))}
        </SortableContext>
        <DragOverlay dropAnimation={null}>
          {activeAcc && <AccountCard acc={activeAcc} {...cardProps} isOverlay={true}/>}
        </DragOverlay>
      </DndContext>

      {showAdd&&<AccountModal onSave={d=>{onAdd(d);setShowAdd(false)}} onClose={()=>setShowAdd(false)}/>}
      {editing&&<AccountModal initial={editing} onSave={d=>{onUpdate(editing.id,d);setEditing(null)}} onClose={()=>setEditing(null)}/>}
      {recording&&<RecordModal account={recording} onSave={a=>{onRecord(recording.id,a);setRecording(null)}} onClose={()=>setRecording(null)}/>}
      {viewing&&<AccountHistoryModal
        account={accounts.find(a=>a.id===viewing.id)||viewing}
        displayCurrency={displayCurrency} toDisplay={toDisplay}
        onUpdateBalance={()=>{setRecording(accounts.find(a=>a.id===viewing.id)||viewing);setViewing(null)}}
        onEdit={()=>{setEditing(accounts.find(a=>a.id===viewing.id)||viewing);setViewing(null)}}
        onDeleteRecord={onDeleteRecord}
        onClose={()=>setViewing(null)}
      />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  TARGET MODAL
// ─────────────────────────────────────────────────────────────
function TargetModal({ initial, displayCurrency, onSave, onClose }) {
  const [label, setLabel] = useState(initial?.label || "");
  const [amount, setAmount] = useState(initial ? String(initial.amount) : "");
  const [dateStr, setDateStr] = useState(() => {
    const d = initial ? new Date(Number(initial.targetTs)) : new Date(Date.now()+365*86400000);
    return d.toISOString().slice(0,10);
  });
  const minDate = new Date(Date.now()+86400000).toISOString().slice(0,10);
  const valid = label.trim() && Number(amount)>0 && dateStr >= minDate;
  const save = () => {
    if (!valid) return;
    onSave({
      label: label.trim(),
      amount: Number(amount),
      currency: displayCurrency,
      targetTs: new Date(dateStr+'T00:00:00').getTime(),
      ...(initial ? {id: initial.id, createdTs: initial.createdTs} : {id: uid(), createdTs: Date.now()}),
    });
  };
  return (
    <div className="modal-bg" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal">
        <div className="modal-title">{initial?"Edit Target":"New Target"}</div>
        <div className="label">Label</div>
        <input className="input" value={label} onChange={e=>setLabel(e.target.value)} placeholder="e.g. Financial Independence"/>
        <div className="label" style={{marginTop:10}}>Target Amount ({displayCurrency})</div>
        <input className="input" type="number" min="0" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="e.g. 500000"/>
        <div className="label" style={{marginTop:10}}>Target Date</div>
        <input className="input" type="date" value={dateStr} min={minDate} onChange={e=>setDateStr(e.target.value)}/>
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:16}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!valid}>
            {initial?"Save Changes":"Add Target"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  TARGETS PAGE
// ─────────────────────────────────────────────────────────────
function TargetsPage({ targets, displayCurrency, toDisplay, currentNW, onAdd, onUpdate, onDelete }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const now = Date.now();
  const sorted = [...targets].sort((a,b)=>Number(a.targetTs)-Number(b.targetTs));

  return (
    <div className="page">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <div style={{color:"var(--muted2)",fontSize:".85rem",lineHeight:1.5}}>
          Set net worth targets with deadlines. Progress is tracked on the Overview page.
        </div>
        <button className="btn btn-primary btn-sm" onClick={()=>setShowAdd(true)}>+ Add Target</button>
      </div>
      {sorted.length===0&&(
        <div className="empty"><div className="empty-icon">🎯</div>No targets yet. Add one to track your progress.</div>
      )}
      {sorted.map(t=>{
        const tVal = t.currency===displayCurrency ? t.amount : toDisplay(t.amount, t.currency);
        const pct = tVal>0 ? Math.min(currentNW/tVal*100,100) : 0;
        const achieved = currentNW >= tVal;
        const isPast = Number(t.targetTs) < now;
        const daysLeft = Math.ceil((Number(t.targetTs)-now)/86400000);
        return (
          <div className={`tgt-card${achieved?" achieved":""}`} key={t.id}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
              <div>
                <div style={{fontFamily:"var(--fd)",fontSize:"1rem",color:achieved?"var(--pos)":"var(--text)",marginBottom:2}}>
                  {achieved&&"✓ "}{t.label||"Untitled Target"}
                </div>
                <div style={{fontSize:".7rem",fontFamily:"var(--fm)",color:"var(--muted)"}}>
                  {new Date(Number(t.targetTs)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"})}
                  {!achieved&&!isPast&&<span style={{marginLeft:8}}>{daysLeft}d left</span>}
                  {isPast&&!achieved&&<span style={{marginLeft:8,color:"var(--neg)"}}>overdue</span>}
                </div>
              </div>
              <div style={{textAlign:"right",flexShrink:0}}>
                <div style={{fontSize:"1rem",fontFamily:"var(--fd)",color:achieved?"var(--pos)":"var(--gold)"}}>
                  {fmt(tVal,displayCurrency)}
                </div>
                <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)"}}>
                  {fmt(currentNW,displayCurrency)} now
                </div>
              </div>
            </div>
            <div className="tgt-track">
              <div className="tgt-fill" style={{width:pct+"%",...(achieved?{background:"var(--pos)"}:{})}}/>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:".7rem",fontFamily:"var(--fm)",color:"var(--muted2)"}}>{pct.toFixed(1)}% complete</span>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-ghost btn-xs" onClick={()=>setEditing(t)}>Edit</button>
                <button className="btn btn-danger btn-xs" onClick={()=>{if(window.confirm("Delete this target?"))onDelete(t.id)}}>Delete</button>
              </div>
            </div>
          </div>
        );
      })}
      {showAdd&&<TargetModal displayCurrency={displayCurrency} onSave={d=>{onAdd(d);setShowAdd(false)}} onClose={()=>setShowAdd(false)}/>}
      {editing&&<TargetModal initial={editing} displayCurrency={displayCurrency} onSave={d=>{onUpdate(d);setEditing(null)}} onClose={()=>setEditing(null)}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  MILESTONES PAGE
// ─────────────────────────────────────────────────────────────
function MilestonesPage({ milestones, baselineId, displayCurrency, toDisplay, onDelete, onSetBaseline, onUpdateLabel }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const sorted = [...milestones].sort((a,b)=>Number(b.ts)-Number(a.ts));

  return (
    <div className="page">
      <div style={{color:"var(--muted2)",fontSize:".85rem",marginBottom:16,lineHeight:1.6}}>
        Milestones are snapshots of your net worth. Set one as a <strong style={{color:"var(--text)"}}>baseline</strong> to track progress on the Overview page.
      </div>
      {sorted.length===0&&(
        <div className="empty"><div className="empty-icon">📌</div>No milestones yet. Go to Overview and press "Save as Milestone".</div>
      )}
      {sorted.map(m=>{
        const isBase=m.id===baselineId;
        const s=m.summary||{};
        const savedCur=s.currency||displayCurrency;
        const conv=v=>savedCur===displayCurrency?v:toDisplay(v,savedCur);
        return (
          <div className={`ms-card ${isBase?"baseline":""}`} key={m.id}>
            {isBase&&<div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--gold)",letterSpacing:".12em",textTransform:"uppercase",marginBottom:6}}>★ Baseline</div>}
            <div className="ms-top">
              <div>
                {editing===m.id?(
                  <div style={{display:"flex",gap:6}}>
                    <input className="input" style={{fontSize:".85rem",padding:"4px 8px"}} value={draft} onChange={e=>setDraft(e.target.value)} autoFocus/>
                    <button className="btn btn-primary btn-xs" onClick={()=>{onUpdateLabel(m.id,draft);setEditing(null)}}>Save</button>
                    <button className="btn btn-ghost btn-xs" onClick={()=>setEditing(null)}>✕</button>
                  </div>
                ):(
                  <div className="ms-label" style={{cursor:"pointer"}} onClick={()=>{setEditing(m.id);setDraft(m.label||"")}}>
                    {m.label||<span style={{color:"var(--muted)",fontStyle:"italic"}}>Untitled — click to name</span>}
                  </div>
                )}
                <div className="ms-ts">{fmtDate(m.ts)}</div>
              </div>
              <div className="ms-total">{fmt(conv(s.total),displayCurrency)}</div>
            </div>
            {s.byLiq&&(
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
                {Object.entries(s.byLiq).map(([k,v])=>(
                  <span key={k} style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted2)"}}>
                    {LIQUIDITY_OPTIONS.find(o=>o.value===k)?.label}: {fmt(conv(v),displayCurrency,true)}
                  </span>
                ))}
              </div>
            )}
            <div className="ms-actions">
              <button className="btn btn-ghost btn-xs" onClick={()=>onSetBaseline(isBase?null:m.id)}>
                {isBase?"Unset Baseline":"Set as Baseline"}
              </button>
              <button className="btn btn-danger btn-xs" onClick={()=>{if(window.confirm("Delete this milestone?"))onDelete(m.id)}}>Delete</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  PHASE 3 · PROJECTION ENGINE
// ─────────────────────────────────────────────────────────────
const projectNW = (start, annRate, monthlyContrib, months) => {
  const mr = (1 + annRate) ** (1/12) - 1;
  const pts = [start];
  let v = start;
  for (let i = 1; i <= months; i++) {
    v = v * (1 + mr) + monthlyContrib;
    pts.push(v);
  }
  return pts;
};

const monthsToReach = (start, annRate, monthlyContrib, target) => {
  if (start >= target) return 0;
  const mr = (1 + annRate) ** (1/12) - 1;
  let v = start, m = 0;
  while (v < target && m < 1200) { v = v * (1 + mr) + monthlyContrib; m++; }
  return v >= target ? m : null;
};

const solveRequiredRate = (start, monthlyContrib, target, months) => {
  if (months <= 0 || start >= target) return 0;
  let lo = -0.5, hi = 5.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const proj = projectNW(start, mid, monthlyContrib, months);
    if (proj.at(-1) >= target) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
};

// ─────────────────────────────────────────────────────────────
//  MODEL PAGE  (Phase 3 · What-If)
// ─────────────────────────────────────────────────────────────
function ModelPage({ currentNW, targets, historicalRate, displayCurrency, netMonthlyCashflow }) {
  const defaultRate = historicalRate != null ? Math.round(historicalRate * 1000) / 10 : 7;
  const [rateInput, setRateInput] = useState(String(defaultRate));
  const cfDefault = netMonthlyCashflow!=null ? Math.max(0, Math.round(netMonthlyCashflow)) : 0;
  const [monthly, setMonthly] = useState(cfDefault);
  const [monthlyOverridden, setMonthlyOverridden] = useState(false);
  const [horizon, setHorizon] = useState(120);
  const [showScenarios, setShowScenarios] = useState(false);
  const svgRef = useRef(null);
  const [tipMonth, setTipMonth] = useState(null);

  const annRate = parseFloat(rateInput) / 100 || 0;
  const months = horizon;

  const base = useMemo(() => projectNW(currentNW, annRate, monthly, months), [currentNW, annRate, monthly, months]);
  const pess = useMemo(() => showScenarios ? projectNW(currentNW, Math.max(annRate-0.02,-0.99), monthly, months) : null, [currentNW, annRate, monthly, months, showScenarios]);
  const opti = useMemo(() => showScenarios ? projectNW(currentNW, annRate+0.02, monthly, months) : null, [currentNW, annRate, monthly, months, showScenarios]);

  const nearestTarget = useMemo(() => {
    const now = Date.now();
    return (targets||[]).filter(t=>Number(t.targetTs)>now).sort((a,b)=>Number(a.targetTs)-Number(b.targetTs))[0] || null;
  }, [targets]);

  const tgtVal = nearestTarget ? nearestTarget.amount : null;

  const moToTarget = useMemo(() => tgtVal!=null ? monthsToReach(currentNW, annRate, monthly, tgtVal) : null, [currentNW, annRate, monthly, tgtVal]);

  const reqRate = useMemo(() => {
    if (!nearestTarget || tgtVal==null) return null;
    const mo = Math.ceil((Number(nearestTarget.targetTs)-Date.now())/2628000000);
    return mo>0 ? solveRequiredRate(currentNW, monthly, tgtVal, mo) : null;
  }, [currentNW, monthly, nearestTarget, tgtVal]);

  // SVG projection chart
  const allVals = [...base, ...(pess||[]), ...(opti||[])];
  const W=560, H=160, PAD={l:62,r:14,t:12,b:30};
  const iW=W-PAD.l-PAD.r, iH=H-PAD.t-PAD.b;
  const minV=Math.min(...allVals,tgtVal??Infinity), maxV=Math.max(...allVals);
  const vSpan=(maxV-minV)||1;
  const sx=m=>PAD.l+(m/months)*iW;
  const sy=v=>PAD.t+iH-((v-minV)/vSpan)*iH;
  const f=n=>n.toFixed(1);
  const path=arr=>arr.map((v,i)=>`${i?"L":"M"}${f(sx(i))},${f(sy(v))}`).join(" ");
  const yTicks=[0,0.5,1].map(fr=>({v:minV+fr*vSpan,y:sy(minV+fr*vSpan)}));

  const handleMM = e => {
    if(!svgRef.current) return;
    const rect=svgRef.current.getBoundingClientRect();
    const mx=(e.clientX-rect.left)/rect.width*W;
    const m=Math.round(Math.max(0,Math.min(months,(mx-PAD.l)/iW*months)));
    setTipMonth(m);
  };

  const tip = tipMonth!=null ? {m:tipMonth, base:base[tipMonth]??(base.at(-1)), pess:pess?.[tipMonth], opti:opti?.[tipMonth]} : null;
  const tgtY = tgtVal!=null && tgtVal>=minV && tgtVal<=maxV ? sy(tgtVal) : null;

  const xLabels = [0, Math.round(months/2), months].map(m => ({
    m, x: sx(m),
    label: m===0 ? "Now" : new Date(Date.now()+m*30*86400000).toLocaleDateString("en-GB",{month:"short",year:"2-digit"}),
  }));

  return (
    <div className="page">
      {/* controls */}
      <div className="model-card">
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,flexWrap:"wrap"}}>
          <div>
            <div className="label">Annual growth rate</div>
            <div style={{display:"flex",alignItems:"center",gap:10,marginTop:6}}>
              <input type="range" className="slider" min="-20" max="40" step="0.5"
                value={parseFloat(rateInput)||0}
                onChange={e=>setRateInput(String(e.target.value))}/>
              <input className="input" type="number" step="0.5"
                style={{width:70,padding:"4px 8px",fontSize:".8rem"}}
                value={rateInput} onChange={e=>setRateInput(e.target.value)}/>
              <span style={{color:"var(--muted)",fontFamily:"var(--fm)",fontSize:".75rem"}}>%</span>
            </div>
            {historicalRate!=null&&<div style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:4}}>
              Historical: {(historicalRate*100).toFixed(1)}% p.a.
            </div>}
          </div>
          <div>
            <div className="label">Monthly contribution</div>
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:6}}>
              <input className="input" type="number" min="0" step="100"
                style={{flex:1,padding:"4px 8px",fontSize:".8rem"}}
                value={monthly} onChange={e=>{setMonthly(Number(e.target.value)||0);setMonthlyOverridden(true);}}/>
              <span style={{color:"var(--muted)",fontFamily:"var(--fm)",fontSize:".75rem"}}>{displayCurrency}/mo</span>
            </div>
            {netMonthlyCashflow!=null&&(
              <div style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:4,display:"flex",alignItems:"center",gap:6}}>
                From cashflow: {fmt(Math.max(0,Math.round(netMonthlyCashflow)),displayCurrency,true)}/mo
                {monthlyOverridden&&<button onClick={()=>{setMonthly(cfDefault);setMonthlyOverridden(false);}}
                  style={{background:"none",border:"none",padding:0,cursor:"pointer",color:"var(--gold)",fontSize:".62rem"}}>↺ reset</button>}
              </div>
            )}
          </div>
        </div>
        <div style={{marginTop:12,display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <div>
            <span style={{fontSize:".7rem",fontFamily:"var(--fm)",color:"var(--muted)"}}>Horizon: </span>
            {[60,120,240,360].map(h=>(
              <button key={h} onClick={()=>setHorizon(h)}
                className="btn btn-ghost btn-xs"
                style={{marginLeft:4,...(horizon===h?{borderColor:"var(--gold)",color:"var(--gold)"}:{})}}>
                {h/12}y
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-xs" onClick={()=>setShowScenarios(s=>!s)}
            style={showScenarios?{borderColor:"var(--gold)",color:"var(--gold)"}:{}}>
            ±2% scenarios
          </button>
        </div>
      </div>

      {/* projection chart */}
      <div className="model-card">
        <div style={{position:"relative"}}>
          <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
            style={{width:"100%",display:"block",overflow:"visible",cursor:"crosshair"}}
            onMouseMove={handleMM} onMouseLeave={()=>setTipMonth(null)}>
            {yTicks.map((t,i)=>(
              <g key={i}>
                <line x1={PAD.l} y1={t.y} x2={W-PAD.r} y2={t.y} stroke="var(--border)" strokeWidth=".6" strokeDasharray="3 3"/>
                <text x={PAD.l-6} y={t.y+4} textAnchor="end" style={{fontFamily:"var(--fm)",fontSize:"8px",fill:"var(--muted)"}}>
                  {fmt(t.v,displayCurrency,true)}
                </text>
              </g>
            ))}
            {tgtY!=null&&(
              <g>
                <line x1={PAD.l} y1={tgtY} x2={W-PAD.r} y2={tgtY} stroke="var(--pos)" strokeWidth="1" strokeDasharray="4 3" opacity=".6"/>
                <text x={W-PAD.r+2} y={tgtY+4} style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--pos)"}}>
                  {nearestTarget?.label||"Target"}
                </text>
              </g>
            )}
            {showScenarios&&pess&&(
              <path d={path(pess)} fill="none" stroke="#e07070" strokeWidth="1.2" strokeDasharray="4 2" opacity=".5"/>
            )}
            {showScenarios&&opti&&(
              <path d={path(opti)} fill="none" stroke="#6fb5a2" strokeWidth="1.2" strokeDasharray="4 2" opacity=".5"/>
            )}
            <path d={path(base)} fill="none" stroke="var(--gold)" strokeWidth="2" strokeLinejoin="round"/>
            {tip&&<line x1={sx(tip.m)} y1={PAD.t} x2={sx(tip.m)} y2={PAD.t+iH} stroke="var(--border2)" strokeWidth="1" strokeDasharray="3 3"/>}
            {tip&&<circle cx={sx(tip.m)} cy={sy(tip.base)} r={4} fill="var(--gold)" stroke="var(--s1)" strokeWidth="1.5"/>}
            {xLabels.map(({m,x,label})=>(
              <text key={m} x={x} y={H-5} textAnchor={m===0?"start":m===months?"end":"middle"}
                style={{fontFamily:"var(--fm)",fontSize:"7.5px",fill:"var(--muted)"}}>
                {label}
              </text>
            ))}
          </svg>
          {tip&&(
            <div className="chart-tt" style={{left:`${((sx(tip.m)-PAD.l)/iW*100).toFixed(1)}%`}}>
              <div className="chart-tt-val" style={{color:"var(--gold)"}}>{fmt(tip.base,displayCurrency)}</div>
              {tip.pess&&<div style={{fontSize:".62rem",color:"#e07070",fontFamily:"var(--fm)"}}>Low: {fmt(tip.pess,displayCurrency,true)}</div>}
              {tip.opti&&<div style={{fontSize:".62rem",color:"#6fb5a2",fontFamily:"var(--fm)"}}>High: {fmt(tip.opti,displayCurrency,true)}</div>}
              <div className="chart-tt-date">
                {tip.m===0?"Now":new Date(Date.now()+tip.m*30*86400000).toLocaleDateString("en-GB",{month:"short",year:"numeric"})}
              </div>
            </div>
          )}
        </div>
        {showScenarios&&(
          <div style={{display:"flex",gap:16,marginTop:8,flexWrap:"wrap"}}>
            {[["var(--neg)","Pessimistic",annRate-0.02],["var(--gold)","Base",annRate],["var(--pos)","Optimistic",annRate+0.02]].map(([c,l,r])=>(
              <div key={l} style={{display:"flex",alignItems:"center",gap:5}}>
                <div className="scenario-dot" style={{background:c}}/>
                <span style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted2)"}}>
                  {l}: {(r*100).toFixed(1)}% → {fmt(projectNW(currentNW,r,monthly,months).at(-1),displayCurrency,true)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* summary stats */}
      <div className="model-card">
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12}}>
          <div>
            <div style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase"}}>In {horizon/12} years</div>
            <div style={{fontSize:"1.1rem",fontFamily:"var(--fd)",color:"var(--gold)",marginTop:2}}>{fmt(base.at(-1),displayCurrency)}</div>
            <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:1}}>
              {base.at(-1)>currentNW?`+${fmt(base.at(-1)-currentNW,displayCurrency,true)} gain`:"No growth"}
            </div>
          </div>
          {tgtVal!=null&&(
            <div>
              <div style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase"}}>
                Time to {nearestTarget?.label||"Target"}
              </div>
              <div style={{fontSize:"1.1rem",fontFamily:"var(--fd)",color:"var(--teal)",marginTop:2}}>
                {moToTarget===0?"Already reached":moToTarget===null?"Not reachable":`${moToTarget}mo`}
              </div>
              {moToTarget!=null&&moToTarget>0&&(
                <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:1}}>
                  {new Date(Date.now()+moToTarget*30*86400000).toLocaleDateString("en-GB",{month:"short",year:"numeric"})}
                </div>
              )}
            </div>
          )}
          {reqRate!=null&&(
            <div>
              <div style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase"}}>Required rate</div>
              <div style={{fontSize:"1.1rem",fontFamily:"var(--fd)",color:reqRate<=annRate?"var(--pos)":"var(--neg)",marginTop:2}}>
                {(reqRate*100).toFixed(1)}% p.a.
              </div>
              <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:1}}>
                to hit {nearestTarget?.label||"target"} on time
              </div>
            </div>
          )}
          {monthly>0&&(
            <div>
              <div style={{fontSize:".62rem",fontFamily:"var(--fm)",color:"var(--muted)",letterSpacing:".08em",textTransform:"uppercase"}}>Total contributed</div>
              <div style={{fontSize:"1.1rem",fontFamily:"var(--fd)",color:"var(--text)",marginTop:2}}>{fmt(monthly*months,displayCurrency,true)}</div>
              <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:1}}>
                {fmt(monthly,displayCurrency,true)}/mo × {months}mo
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  CASHFLOW MODAL
// ─────────────────────────────────────────────────────────────
function CashflowModal({ initial, displayCurrency, existingCats, onSave, onClose }) {
  const editing = !!initial;
  const [type, setType]         = useState(initial?.type||"income");
  const [name, setName]         = useState(initial?.name||"");
  const [amount, setAmount]     = useState(initial?.amount!=null?String(initial.amount):"");
  const [currency, setCurrency] = useState(initial?.currency||displayCurrency);
  const [category, setCategory] = useState(initial?.category||"");
  const [frequency, setFrequency] = useState(initial?.frequency||"monthly");
  const [date, setDate]         = useState(initial?.date ? new Date(Number(initial.date)).toISOString().slice(0,10) : "");
  const [startDate, setStartDate] = useState(initial?.startDate ? new Date(Number(initial.startDate)).toISOString().slice(0,10) : "");
  const [endDate, setEndDate]   = useState(initial?.endDate ? new Date(Number(initial.endDate)).toISOString().slice(0,10) : "");
  const [notes, setNotes]       = useState(initial?.notes||"");

  const predefined = type==="income" ? CF_INCOME_CATS : CF_EXPENSE_CATS;
  const customCats = (existingCats||[]).filter(c=>!predefined.includes(c));
  const allCats = [...predefined, ...customCats];
  const isOneTime = frequency==="one-time";

  const save = () => {
    if (!name.trim()||!amount||isNaN(Number(amount))) return;
    onSave({
      id: initial?.id||uid(), name:name.trim(), type, amount:Number(amount),
      currency, category: category||predefined[0], frequency,
      date:      isOneTime&&date      ? new Date(date).getTime()      : null,
      startDate: !isOneTime&&startDate ? new Date(startDate).getTime() : null,
      endDate:   !isOneTime&&endDate   ? new Date(endDate).getTime()   : null,
      notes: notes.trim(),
    });
  };

  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal" style={{maxWidth:460}}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="modal-title">{editing?"Edit":"Add"} Cashflow</div>

        {/* Income / Expense toggle */}
        <div className="cf-type-toggle">
          <button className="cf-type-btn" onClick={()=>setType("income")}
            style={{background:type==="income"?"var(--pos)":"var(--s2)",color:type==="income"?"#fff":"var(--muted)"}}>
            ▲ Income
          </button>
          <button className="cf-type-btn" onClick={()=>setType("expense")}
            style={{background:type==="expense"?"var(--neg)":"var(--s2)",color:type==="expense"?"#fff":"var(--muted)"}}>
            ▼ Expense
          </button>
        </div>

        <div className="label">Name</div>
        <input className="input" style={{marginBottom:12}} placeholder="e.g. Monthly salary"
          value={name} onChange={e=>setName(e.target.value)} autoFocus/>

        <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginBottom:12}}>
          <div>
            <div className="label">Amount</div>
            <input className="input" type="number" min="0" step="any"
              value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/>
          </div>
          <div>
            <div className="label">Currency</div>
            <select className="input" value={currency} onChange={e=>setCurrency(e.target.value)}>
              {CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div className="label">Category</div>
        <input className="input" style={{marginBottom:12}} list="cf-cats"
          value={category} onChange={e=>setCategory(e.target.value)}
          placeholder={type==="income"?"e.g. Salary":"e.g. Rent / Mortgage"}/>
        <datalist id="cf-cats">
          {allCats.map(c=><option key={c} value={c}/>)}
        </datalist>

        <div className="label">Frequency</div>
        <div className="cf-freq-grid" style={{marginBottom:14}}>
          {CF_FREQ.map(f=>(
            <button key={f.value} className={`cf-freq-opt${frequency===f.value?" on":""}`}
              onClick={()=>setFrequency(f.value)}>{f.label}</button>
          ))}
        </div>

        {isOneTime ? (
          <>
            <div className="label">Date</div>
            <input className="input" type="date" style={{marginBottom:12}}
              value={date} onChange={e=>setDate(e.target.value)}/>
          </>
        ) : (
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
            <div>
              <div className="label">Start date <span style={{color:"var(--muted)",fontWeight:400}}>(optional)</span></div>
              <input className="input" type="date" value={startDate} onChange={e=>setStartDate(e.target.value)}/>
            </div>
            <div>
              <div className="label">End date <span style={{color:"var(--muted)",fontWeight:400}}>(optional)</span></div>
              <input className="input" type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}/>
            </div>
          </div>
        )}

        <div className="label">Notes <span style={{color:"var(--muted)",fontWeight:400}}>(optional)</span></div>
        <textarea className="input" rows={2} style={{resize:"vertical",marginBottom:16}}
          value={notes} onChange={e=>setNotes(e.target.value)}/>

        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary btn-sm"
            onClick={save} disabled={!name.trim()||!amount||isNaN(Number(amount))}>
            {editing?"Save Changes":"Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  CASHFLOW PAGE
// ─────────────────────────────────────────────────────────────
const CF_VIEW_UNITS = [
  { value:"daily",       label:"Day",        suffix:"/day",  mult:12/365.25 },
  { value:"weekly",      label:"Week",       suffix:"/wk",   mult:12/52     },
  { value:"fortnightly", label:"Fortnight",  suffix:"/fn",   mult:12/26     },
  { value:"monthly",     label:"Month",      suffix:"/mo",   mult:1         },
  { value:"annual",      label:"Year",       suffix:"/yr",   mult:12        },
];

function CashflowPage({ cashflows, displayCurrency, toDisplay, onAdd, onUpdate, onDelete }) {
  const [modal, setModal] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [viewUnit, setViewUnit] = useState("monthly");
  const now = Date.now();

  const unitCfg = CF_VIEW_UNITS.find(u=>u.value===viewUnit) || CF_VIEW_UNITS[3];
  // scale a monthly amount to the selected view unit
  const toUnit = mo => mo * unitCfg.mult;

  // Derive custom categories from existing cashflows
  const existingCats = useMemo(() => {
    const pre = new Set([...CF_INCOME_CATS,...CF_EXPENSE_CATS]);
    return [...new Set(cashflows.map(c=>c.category).filter(c=>c&&!pre.has(c)))];
  }, [cashflows]);

  // Active recurring cashflows (not one-time, not expired, not future)
  const active = useMemo(()=>cashflows.filter(cf=>{
    if (cf.frequency==="one-time") return false;
    if (cf.endDate   && Number(cf.endDate)   < now) return false;
    if (cf.startDate && Number(cf.startDate) > now) return false;
    return true;
  }),[cashflows,now]);

  const income   = active.filter(c=>c.type==="income");
  const expenses = active.filter(c=>c.type==="expense");
  const oneTimes = cashflows.filter(c=>c.frequency==="one-time")
    .sort((a,b)=>Number(b.date||0)-Number(a.date||0));

  // All totals in monthly terms, scaled by unitCfg.mult for display
  const totalInMo  = income.reduce((s,c)=>s+cfMonthly(c,toDisplay),0);
  const totalOutMo = expenses.reduce((s,c)=>s+cfMonthly(c,toDisplay),0);
  const netMo      = totalInMo - totalOutMo;
  const totalIn    = toUnit(totalInMo);
  const totalOut   = toUnit(totalOutMo);
  const net        = toUnit(netMo);
  const saveRate   = totalInMo>0 ? netMo/totalInMo*100 : null;

  // Group expenses by category
  const expGroups = useMemo(()=>{
    const map = {};
    expenses.forEach(c=>{
      const cat = c.category||"Other";
      if (!map[cat]) map[cat]=[];
      map[cat].push(c);
    });
    return Object.entries(map)
      .map(([cat,items])=>({cat,items,total:items.reduce((s,c)=>s+cfMonthly(c,toDisplay),0)}))
      .sort((a,b)=>b.total-a.total);
  },[expenses,toDisplay]);

  const freqLabel = f => CF_FREQ.find(x=>x.value===f)?.label||f;
  const fmtShort = ts => ts ? new Date(Number(ts)).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}) : null;

  const openModal = (initialType) => setModal({_new: true, type: initialType});
  const handleSave = cf => { if (modal?._new) onAdd(cf); else onUpdate(cf); setModal(null); };

  const CfRow = ({cf}) => {
    const mo = cfMonthly(cf, toDisplay);
    const scaled = toUnit(mo);
    const isIncome = cf.type==="income";
    const expired = cf.endDate && Number(cf.endDate) < now;
    const future  = cf.startDate && Number(cf.startDate) > now;
    return (
      <div className="cf-row" style={{opacity:expired?0.45:1}}>
        <div className="cf-row-left">
          <div className="cf-row-name">
            {cf.name}
            {expired&&<span style={{marginLeft:6,fontFamily:"var(--fm)",fontSize:".6rem",color:"var(--muted)"}}>(ended)</span>}
            {future&&<span style={{marginLeft:6,fontFamily:"var(--fm)",fontSize:".6rem",color:"var(--muted)"}}>(starts {fmtShort(cf.startDate)})</span>}
          </div>
          <div className="cf-row-meta">{cf.category}{cf.currency!==displayCurrency?` · ${cf.currency}`:""}</div>
        </div>
        <span className="cf-row-freq">{freqLabel(cf.frequency)}</span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span className="cf-row-amount" style={{color:isIncome?"var(--pos)":"var(--neg)"}}>
            {isIncome?"+":"-"}{fmt(scaled,displayCurrency,true)}
            <span style={{fontFamily:"var(--fm)",fontSize:".6rem",color:"var(--muted)",fontWeight:400}}>{unitCfg.suffix}</span>
          </span>
          <div className="cf-row-actions">
            <button className="btn btn-ghost btn-xs" style={{padding:"1px 6px"}} onClick={()=>setModal(cf)}>✎</button>
            {confirmDel===cf.id
              ? <><button className="btn btn-xs" style={{background:"var(--neg)",border:"none",color:"#fff",padding:"1px 7px"}} onClick={()=>{onDelete(cf.id);setConfirmDel(null)}}>Delete</button>
                  <button className="btn btn-ghost btn-xs" style={{padding:"1px 6px"}} onClick={()=>setConfirmDel(null)}>✕</button></>
              : <button className="btn btn-ghost btn-xs" style={{padding:"1px 6px",color:"var(--muted)"}} onClick={()=>setConfirmDel(cf.id)}>✕</button>
            }
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      {/* Period toggle */}
      <div style={{display:"flex",gap:4,marginBottom:12,justifyContent:"flex-end"}}>
        {CF_VIEW_UNITS.map(u=>(
          <button key={u.value}
            className={`btn btn-xs${viewUnit===u.value?" btn-ghost":""}`}
            style={viewUnit===u.value
              ? {borderColor:"var(--gold)",color:"var(--gold)",background:"var(--s3)"}
              : {borderColor:"var(--border2)",color:"var(--muted)",background:"none"}}
            onClick={()=>setViewUnit(u.value)}>
            {u.label}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="cf-summary">
        <div className="cf-summary-cell">
          <div className="cf-summary-label">In{unitCfg.suffix}</div>
          <div className="cf-summary-val" style={{color:"var(--pos)"}}>{fmt(totalIn,displayCurrency,true)}</div>
          <div className="cf-summary-sub">{income.length} stream{income.length!==1?"s":""}</div>
        </div>
        <div className="cf-summary-cell">
          <div className="cf-summary-label">Out{unitCfg.suffix}</div>
          <div className="cf-summary-val" style={{color:"var(--neg)"}}>{fmt(totalOut,displayCurrency,true)}</div>
          <div className="cf-summary-sub">{expenses.length} expense{expenses.length!==1?"s":""}</div>
        </div>
        <div className="cf-summary-cell">
          <div className="cf-summary-label">Net / Saving rate</div>
          <div className="cf-summary-val" style={{color:net>=0?"var(--pos)":"var(--neg)"}}>{net>=0?"+":""}{fmt(net,displayCurrency,true)}</div>
          <div className="cf-summary-sub">{saveRate!=null?`${saveRate.toFixed(0)}% of income`:"—"}</div>
        </div>
      </div>

      {/* Add buttons */}
      <div style={{display:"flex",gap:8,marginBottom:20}}>
        <button className="btn btn-sm" style={{flex:1,borderColor:"var(--pos)",color:"var(--pos)"}} onClick={()=>openModal("income")}>+ Add Income</button>
        <button className="btn btn-sm" style={{flex:1,borderColor:"var(--neg)",color:"var(--neg)"}} onClick={()=>openModal("expense")}>+ Add Expense</button>
        <button className="btn btn-ghost btn-sm" onClick={()=>setModal({_new:true,type:"expense",frequency:"one-time"})}>+ One-time</button>
      </div>

      {/* Income */}
      {(income.length>0||cashflows.some(c=>c.type==="income"&&c.frequency!=="one-time")) && (
        <div style={{marginBottom:20}}>
          <div className="cf-section-head">
            <span className="cf-section-title">Income</span>
            <span className="cf-section-total" style={{color:"var(--pos)"}}>+{fmt(totalIn,displayCurrency,true)}{unitCfg.suffix}</span>
          </div>
          {[...income].sort((a,b)=>cfMonthly(b,toDisplay)-cfMonthly(a,toDisplay)).map(cf=><CfRow key={cf.id} cf={cf}/>)}
          {/* Inactive income */}
          {cashflows.filter(c=>c.type==="income"&&c.frequency!=="one-time"&&!income.includes(c))
            .map(cf=><CfRow key={cf.id} cf={cf}/>)}
        </div>
      )}

      {/* Expenses */}
      {(expenses.length>0||cashflows.some(c=>c.type==="expense"&&c.frequency!=="one-time")) && (
        <div style={{marginBottom:20}}>
          <div className="cf-section-head">
            <span className="cf-section-title">Expenses</span>
            <span className="cf-section-total" style={{color:"var(--neg)"}}>-{fmt(totalOut,displayCurrency,true)}{unitCfg.suffix}</span>
          </div>
          {expGroups.map(({cat,items,total})=>(
            <div key={cat} className="cf-group">
              <div className="cf-group-label" style={{display:"flex",justifyContent:"space-between"}}>
                <span>{cat}</span><span>{fmt(toUnit(total),displayCurrency,true)}{unitCfg.suffix}</span>
              </div>
              {[...items].sort((a,b)=>cfMonthly(b,toDisplay)-cfMonthly(a,toDisplay)).map(cf=><CfRow key={cf.id} cf={cf}/>)}
            </div>
          ))}
          {/* Inactive expenses */}
          {cashflows.filter(c=>c.type==="expense"&&c.frequency!=="one-time"&&!expenses.includes(c))
            .map(cf=><CfRow key={cf.id} cf={cf}/>)}
        </div>
      )}

      {/* One-time items */}
      {oneTimes.length>0 && (
        <div style={{marginBottom:20}}>
          <div className="cf-section-head">
            <span className="cf-section-title">One-time</span>
            <span style={{fontFamily:"var(--fm)",fontSize:".65rem",color:"var(--muted)"}}>{oneTimes.length} item{oneTimes.length!==1?"s":""}</span>
          </div>
          {oneTimes.map(cf=>{
            const isPast = cf.date && Number(cf.date)<now;
            const isIncome = cf.type==="income";
            return (
              <div key={cf.id} className="cf-row" style={{opacity:isPast?0.5:1}}>
                <div className="cf-row-left">
                  <div className="cf-row-name">{cf.name}</div>
                  <div className="cf-row-meta">{cf.category}{cf.currency!==displayCurrency?` · ${cf.currency}`:""}</div>
                </div>
                <div style={{textAlign:"right"}}>
                  {cf.date&&<div style={{fontFamily:"var(--fm)",fontSize:".68rem",color:isPast?"var(--muted)":"var(--text)"}}>{fmtShort(cf.date)}</div>}
                  <span className="cf-ot-badge" style={{color:isIncome?"var(--pos)":"var(--neg)",borderColor:isIncome?"var(--pos)":"var(--neg)"}}>
                    {isIncome?"+":"-"}{fmt(toDisplay(cf.amount,cf.currency),displayCurrency,true)}
                  </span>
                </div>
                <div className="cf-row-actions">
                  <button className="btn btn-ghost btn-xs" style={{padding:"1px 6px"}} onClick={()=>setModal(cf)}>✎</button>
                  {confirmDel===cf.id
                    ? <><button className="btn btn-xs" style={{background:"var(--neg)",border:"none",color:"#fff",padding:"1px 7px"}} onClick={()=>{onDelete(cf.id);setConfirmDel(null)}}>Delete</button>
                        <button className="btn btn-ghost btn-xs" style={{padding:"1px 6px"}} onClick={()=>setConfirmDel(null)}>✕</button></>
                    : <button className="btn btn-ghost btn-xs" style={{padding:"1px 6px",color:"var(--muted)"}} onClick={()=>setConfirmDel(cf.id)}>✕</button>
                  }
                </div>
              </div>
            );
          })}
        </div>
      )}

      {cashflows.length===0 && (
        <div className="empty">
          <div className="empty-icon">💸</div>
          Track your income and expenses to see your monthly cashflow.
        </div>
      )}

      {modal && (
        <CashflowModal
          initial={modal._new ? {type:modal.type||"income",frequency:modal.frequency||"monthly"} : modal}
          displayCurrency={displayCurrency}
          existingCats={existingCats}
          onSave={handleSave}
          onClose={()=>setModal(null)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  ROOT APP
// ─────────────────────────────────────────────────────────────
const IS_LOCAL_DEV = import.meta.env.DEV;

export default function App() {
  const [idToken, setIdToken] = useState(() => IS_LOCAL_DEV ? 'local-dev' : getStoredAuth());
  const [gsiReady, setGsiReady] = useState(false);
  const tokenRef = useRef(null);
  const hasAutoConnected = useRef(false);
  const expiryTimerRef = useRef(null);
  const [apiUrl, setApiUrl] = useState(()=>import.meta.env.VITE_API_URL||localStorage.getItem("nw_api_url")||"");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(()=>!!(localStorage.getItem("nw_api_url")&&getStoredAuth()));
  const [connectErr, setConnectErr] = useState(null);
  const [page, setPage] = useState("overview");
  const [accounts, setAccounts] = useState([]);
  const [accountOrder, setAccountOrder] = useState([]);
  const [growthTarget, setGrowthTarget] = useState(null);
  const [milestones, setMilestones] = useState([]);
  const [targets, setTargets] = useState([]);
  const [cashflows, setCashflows] = useState([]);
  const [baselineId, setBaselineId] = useState(null);
  const [displayCurrency, setDisplayCurrency] = useState("GBP");
  const [excluded, setExcluded] = useState(new Set());
  const [rates, setRates] = useState({});
  const [ratesError, setRatesError] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncErr, setSyncErr] = useState(null);
  const [lastSync, setLastSync] = useState(null);
  const [toast, setToast] = useState(null);
  const api = useRef(null);
  const vestingRef = useRef({});

  useEffect(() => { tokenRef.current = IS_LOCAL_DEV ? 'nw-local-dev-kjk-2025' : idToken; }, [idToken]);

  useEffect(() => {
    if (IS_LOCAL_DEV) return;
    const init = () => {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: ({ credential }) => {
          localStorage.setItem(AUTH_KEY, JSON.stringify({ credential, lastActive: Date.now() }));
          setIdToken(credential);
          const payload = parseJwt(credential);
          if (payload?.exp) {
            if (expiryTimerRef.current) clearTimeout(expiryTimerRef.current);
            const delay = payload.exp * 1000 - Date.now() - 60_000;
            expiryTimerRef.current = setTimeout(() => {
              setIdToken(null);
              localStorage.removeItem(AUTH_KEY);
            }, Math.max(delay, 0));
          }
        },
        auto_select: true,
      });
      setGsiReady(true);
    };
    if (window.google?.accounts?.id) { init(); return; }
    const timer = setInterval(() => { if (window.google?.accounts?.id) { clearInterval(timer); init(); } }, 100);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!idToken || IS_LOCAL_DEV) return;
    const touch = () => {
      const s = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if (s) localStorage.setItem(AUTH_KEY, JSON.stringify({ ...s, lastActive: Date.now() }));
    };
    const events = ['mousemove','keydown','click','touchstart','scroll'];
    events.forEach(e => window.addEventListener(e, touch, { passive: true }));
    const idleCheck = setInterval(() => {
      const s = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null');
      if (!s || Date.now() - s.lastActive > IDLE_MS) {
        localStorage.removeItem(AUTH_KEY);
        setIdToken(null);
      }
    }, 60_000);
    return () => {
      events.forEach(e => window.removeEventListener(e, touch));
      clearInterval(idleCheck);
    };
  }, [idToken]);

  const showToast = (msg, type="ok") => { setToast({msg,type}); setTimeout(()=>setToast(null),3000); };

  const loadAll = useCallback(async () => {
    setSyncing(true); setSyncErr(null);
    try {
      const data = await api.current.call("getAll");
      const vestMap = (() => { try { return JSON.parse(data.settings?.vestingSchedules||'{}'); } catch { return {}; } })();
      vestingRef.current = vestMap;
      setAccounts((data.accounts||[]).map(a=>({...a, vesting: vestMap[a.id]||null})));
      setMilestones(data.milestones||[]);
      setTargets(data.targets||[]);
      setCashflows(data.cashflows||[]);
      setBaselineId(data.baselineId||null);
      if (data.settings?.displayCurrency) setDisplayCurrency(data.settings.displayCurrency);
      if (data.settings?.excluded) setExcluded(new Set(data.settings.excluded));
      if (data.settings?.accountOrder) setAccountOrder(data.settings.accountOrder);
      try { if (data.settings?.growthTarget) setGrowthTarget(JSON.parse(data.settings.growthTarget)); } catch {}
      setLastSync(Date.now());
    } catch(e) { setSyncErr(e.message); }
    setSyncing(false);
  }, []);

  const connect = useCallback(async (url) => {
    if (!url) return;
    setConnecting(true); setConnectErr(null);
    try {
      api.current = createApi(url, () => tokenRef.current);
      const data = await api.current.call("getAll");
      const vestMap = (() => { try { return JSON.parse(data.settings?.vestingSchedules||'{}'); } catch { return {}; } })();
      vestingRef.current = vestMap;
      setAccounts((data.accounts||[]).map(a=>({...a, vesting: vestMap[a.id]||null})));
      setMilestones(data.milestones||[]);
      setTargets(data.targets||[]);
      setCashflows(data.cashflows||[]);
      setBaselineId(data.baselineId||null);
      if (data.settings?.displayCurrency) setDisplayCurrency(data.settings.displayCurrency);
      if (data.settings?.excluded) setExcluded(new Set(data.settings.excluded));
      if (data.settings?.accountOrder) setAccountOrder(data.settings.accountOrder);
      try { if (data.settings?.growthTarget) setGrowthTarget(JSON.parse(data.settings.growthTarget)); } catch {}
      localStorage.setItem("nw_api_url", url);
      setApiUrl(url);
      setConnected(true);
      setLastSync(Date.now());
    } catch(e) {
      setConnectErr(e.message || "Could not connect. Check the URL and that 'Who has access' is set to Anyone.");
    }
    setConnecting(false);
  }, []);

  useEffect(() => {
    if (apiUrl && idToken && !hasAutoConnected.current) {
      hasAutoConnected.current = true;
      connect(apiUrl);
    }
  }, [idToken]);

  useEffect(() => {
    if (!connected) return;
    setRates({}); // clear stale rates immediately on currency change
    const others = CURRENCIES.filter(c=>c!==displayCurrency).join(",");
    // Use frankfurter.dev (newer endpoint). Note: IDR and CNY may not be supported.
    // We request all desired currencies and gracefully skip any that are unsupported.
    fetch(`https://api.frankfurter.dev/v1/latest?base=${displayCurrency}`)
      .then(r=>r.json())
      .then(d => {
        // d.rates[X] = "how many X per 1 displayCurrency"
        // toDisplay(amount, fromCur) = amount / d.rates[fromCur]
        const available = {...d.rates, [displayCurrency]: 1};
        setRates(available);
        const missing = CURRENCIES.filter(c => c !== displayCurrency && !available[c]);
        if (missing.length > 0) {
          setRatesError(`No live rate for: ${missing.join(", ")} — shown in native currency`);
        } else {
          setRatesError(null);
        }
      })
      .catch(()=>setRatesError("Live rates unavailable"));
  }, [displayCurrency, connected]);

  const toDisplay = useCallback((amount, fromCur) => {
    if (fromCur === displayCurrency) return Number(amount);
    // rates[fromCur] = "how many fromCur per 1 displayCurrency"
    // so: displayAmount = fromAmount / rates[fromCur]
    // e.g. rates["IDR"]=16000 means 1 GBP=16000 IDR, so 16000 IDR / 16000 = 1 GBP ✓
    const r = rates[fromCur];
    if (!r) return Number(amount); // rate not loaded yet, return as-is
    return Number(amount) / r;
  }, [rates, displayCurrency]);

  const changeDisplayCurrency = async (cur) => {
    setDisplayCurrency(cur);
    try { await api.current.call("setSetting", {key:"displayCurrency", value:cur}); } catch {}
  };

  const toggleExcluded = useCallback((key) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { api.current.call("setSetting", {key:"excluded", value:[...next]}); } catch {}
      return next;
    });
  }, []);

  // CRUD
  const reorderAccounts = async (newOrder) => {
    setAccountOrder(newOrder);
    try { await api.current.call("setSetting", {key:"accountOrder", value:newOrder}); }
    catch(e) { showToast("Sync error: "+e.message,"err"); }
  };

  const pushVestingSettings = async () => {
    try { await api.current.call("setSetting", {key:"vestingSchedules", value:JSON.stringify(vestingRef.current)}); } catch {}
  };

  const addAccount = async (form) => {
    const acc={id:uid(),...form,createdTs:Date.now(),records:[]};
    if (acc.vesting) vestingRef.current={...vestingRef.current,[acc.id]:acc.vesting};
    setAccounts(p=>[...p,acc]); showToast(`"${acc.name}" added`);
    try {
      const {vesting,...accData}=acc;
      await api.current.callWithData("addAccount", accData);
      await pushVestingSettings();
    }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const updateAccount = async (id, form) => {
    const acc=accounts.find(a=>a.id===id);
    const merged={...acc,...form};
    if (merged.vesting) vestingRef.current={...vestingRef.current,[id]:merged.vesting};
    else { const v={...vestingRef.current}; delete v[id]; vestingRef.current=v; }
    setAccounts(p=>p.map(a=>a.id===id?{...a,...form}:a)); showToast("Account updated");
    try {
      const {vesting,...accData}=merged;
      await api.current.callWithData("updateAccount", accData);
      await pushVestingSettings();
    }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const deleteAccount = async (id) => {
    const acc=accounts.find(a=>a.id===id);
    const v={...vestingRef.current}; delete v[id]; vestingRef.current=v;
    setAccounts(p=>p.filter(a=>a.id!==id)); showToast(`"${acc?.name}" removed`,"warn");
    try {
      await api.current.call("deleteAccount", {id});
      await pushVestingSettings();
    }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const addRecord = async (accountId, {amount, ts}) => {
    const rec={id:uid(),accountId,amount,ts:ts||Date.now()};
    setAccounts(p=>p.map(a=>a.id===accountId?{...a,records:[...(a.records||[]),rec]}:a));
    showToast("Balance recorded");
    try { await api.current.callWithData("addRecord", rec); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const deleteRecord = async (accountId, recordId) => {
    setAccounts(p=>p.map(a=>a.id===accountId?{...a,records:(a.records||[]).filter(r=>r.id!==recordId)}:a));
    showToast("Record deleted","warn");
    try { await api.current.call("deleteRecord", {id:recordId}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const saveMilestone = async ({label, ts, summary}) => {
    const m={id:uid(),ts:ts||Date.now(),label:label||"",summary};
    setMilestones(p=>[...p,m]); showToast("Milestone saved!");
    try { await api.current.callWithData("addMilestone", m); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const deleteMilestone = async (id) => {
    setMilestones(p=>p.filter(m=>m.id!==id));
    if(baselineId===id) setBaselineId(null);
    try { await api.current.call("deleteMilestone", {id}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const addTarget = async (t) => {
    setTargets(p=>[...p,t]); showToast(`Target "${t.label}" added`);
    try { await api.current.callWithData("addTarget", t); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const updateTarget = async (t) => {
    setTargets(p=>p.map(x=>x.id===t.id?t:x)); showToast("Target updated");
    try { await api.current.callWithData("updateTarget", t); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const deleteTarget = async (id) => {
    setTargets(p=>p.filter(t=>t.id!==id)); showToast("Target removed","warn");
    try { await api.current.call("deleteTarget", {id}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const addCashflow = async (cf) => {
    setCashflows(p=>[...p,cf]); showToast("Cashflow added");
    try { await api.current.callWithData("addCashflow", cf); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const updateCashflow = async (cf) => {
    setCashflows(p=>p.map(x=>x.id===cf.id?cf:x)); showToast("Cashflow updated");
    try { await api.current.callWithData("updateCashflow", cf); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const deleteCashflow = async (id) => {
    setCashflows(p=>p.filter(x=>x.id!==id)); showToast("Cashflow removed","warn");
    try { await api.current.call("deleteCashflow", {id}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const setBaseline = async (id) => {
    setBaselineId(id); showToast(id?"Baseline set":"Baseline cleared");
    try { await api.current.call("setBaseline", {id: id||""}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const saveGrowthTargetSetting = async (target) => {
    setGrowthTarget(target);
    try { await api.current.call("setSetting", {key:"growthTarget", value:target?JSON.stringify(target):""}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const updateMilestoneLabel = async (id, label) => {
    const m=milestones.find(m=>m.id===id);
    setMilestones(p=>p.map(x=>x.id===id?{...x,label}:x));
    try { await api.current.callWithData("updateMilestone", {...m,label}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };

  const signOut = () => {
    localStorage.removeItem(AUTH_KEY);
    localStorage.removeItem("nw_api_url");
    setIdToken(null);
    setConnected(false);
    setConnecting(false);
    setConnectErr(null);
    hasAutoConnected.current = false;
  };

  if (!idToken) return <SignInPage gsiReady={gsiReady}/>;
  if (connecting || (apiUrl && !connected && !connectErr)) return <LoadingPage onCancel={signOut}/>;
  if (!connected) return (
    <>
      <style>{STYLE}</style>
      <SetupScreen onConnect={connect} connecting={connecting} connectErr={connectErr}/>
    </>
  );

  return (
    <>
      <style>{STYLE}</style>
      <div className="wrap">
        <div className="hdr">
          <div className="hdr-brand">
            Net Worth Tracker <span>Personal</span>
          </div>
          <a href="https://github.com/KennedyKusumo/networth-tracker" target="_blank" rel="noreferrer" style={{fontFamily:"var(--fm)",fontSize:".65rem",color:"var(--muted)",textDecoration:"none",letterSpacing:".06em"}} title="View on GitHub">GitHub</a>
          <div className="hdr-right">
            <div className="sync">
              <div className={`sync-dot ${syncing?"spin":syncErr?"err":"ok"}`}/>
              {syncing?"Syncing…":syncErr?"Sync error":lastSync?"Synced "+fmtDate(lastSync):"Connected"}
            </div>
            <button className="btn btn-ghost btn-xs" onClick={loadAll} disabled={syncing} title="Refresh data">↻</button>
            <CurrencyDropdown currencies={CURRENCIES} value={displayCurrency} rates={rates} onChange={changeDisplayCurrency} />
          </div>
        </div>

        <div className="nav">
          {[
            ["overview","Overview"],
            ["accounts",`Accounts (${accounts.length})`],
            ["milestones",`Milestones (${milestones.length})`],
            ["cash","Cash"],
            ["targets",`Targets (${targets.length})`],
            ["model","Model"],
          ].map(([id,label])=>(
            <button key={id} className={`nb ${page===id?"on":""}`} onClick={()=>setPage(id)}>{label}</button>
          ))}
        </div>

        {(()=>{
          const baseline = milestones.find(m=>m.id===baselineId);
          const baseTotal = baseline?.summary?.total ?? null;
          const baseSavedCur = baseline?.summary?.currency || displayCurrency;
          const baseConverted = baseTotal!==null ? (baseSavedCur===displayCurrency ? baseTotal : toDisplay(baseTotal,baseSavedCur)) : null;
          const currentNW = (() => {
            let t=0;
            for (const a of accounts) {
              if (excluded.has(a.id)||excluded.has(`cls:${a.class}`)) continue;
              const raw=vestedBalance(a); if(raw===null) continue;
              const conv=toDisplay(raw,a.currency);
              t += a.type==="liability"?-Math.abs(conv):conv;
            }
            return t;
          })();
          const historicalRate = (()=>{
            if (!baseline||baseConverted===null||baseConverted<=0) return null;
            const el=(Date.now()-Number(baseline.ts))/(365.25*86400000);
            if(el<7/365.25) return null;
            return (currentNW/baseConverted)**(1/el)-1;
          })();
          const nowTs = Date.now();
          const netMonthlyCashflow = cashflows.reduce((sum,cf)=>{
            if (cf.frequency==="one-time") return sum;
            if (cf.endDate   && Number(cf.endDate)   < nowTs) return sum;
            if (cf.startDate && Number(cf.startDate) > nowTs) return sum;
            const m = cfMonthly(cf, toDisplay);
            return sum + (cf.type==="income" ? m : -m);
          }, 0);
          return <>
            {page==="overview"&&<OverviewPage accounts={accounts} milestones={milestones} targets={targets} baselineId={baselineId} displayCurrency={displayCurrency} toDisplay={toDisplay} excluded={excluded} onToggleExcluded={toggleExcluded} onSaveMilestone={saveMilestone} onSetBaseline={setBaseline} growthTarget={growthTarget} onSetGrowthTarget={saveGrowthTargetSetting} netMonthlyCashflow={cashflows.length?netMonthlyCashflow:null}/>}
            {page==="accounts"&&<AccountsPage accounts={accounts} displayCurrency={displayCurrency} toDisplay={toDisplay} excluded={excluded} onToggleExcluded={toggleExcluded} onAdd={addAccount} onUpdate={updateAccount} onDelete={deleteAccount} onRecord={addRecord} onDeleteRecord={deleteRecord} accountOrder={accountOrder} onReorder={reorderAccounts}/>}
            {page==="milestones"&&<MilestonesPage milestones={milestones} baselineId={baselineId} displayCurrency={displayCurrency} toDisplay={toDisplay} onDelete={deleteMilestone} onSetBaseline={setBaseline} onUpdateLabel={updateMilestoneLabel}/>}
            {page==="targets"&&<TargetsPage targets={targets} displayCurrency={displayCurrency} toDisplay={toDisplay} currentNW={currentNW} onAdd={addTarget} onUpdate={updateTarget} onDelete={deleteTarget}/>}
            {page==="model"&&<ModelPage currentNW={currentNW} targets={targets} historicalRate={historicalRate} displayCurrency={displayCurrency} netMonthlyCashflow={cashflows.length?netMonthlyCashflow:null}/>}
            {page==="cash"&&<CashflowPage cashflows={cashflows} displayCurrency={displayCurrency} toDisplay={toDisplay} onAdd={addCashflow} onUpdate={updateCashflow} onDelete={deleteCashflow}/>}
          </>;
        })()}
      </div>

      {toast&&<div className={`toast ${toast.type==="warn"?"warn":toast.type==="err"?"err":""}`}>{toast.msg}</div>}
    </>
  );
}
