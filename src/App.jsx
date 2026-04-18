import { useState, useEffect, useCallback, useRef } from "react";

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

// ─────────────────────────────────────────────────────────────
//  GOOGLE SHEETS API
// ─────────────────────────────────────────────────────────────
const createApi = (url, getToken) => ({
  call: async (action, params={}) => {
    const qs = new URLSearchParams({action, idToken: getToken?.() || '', ...params}).toString();
    const res = await fetch(`${url}?${qs}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  },
  callWithData: async (action, data, extra={}) => {
    const qs = new URLSearchParams({action, idToken: getToken?.() || '', data: JSON.stringify(data), ...extra}).toString();
    const res = await fetch(`${url}?${qs}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    return json;
  },
});

// ─────────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────────
const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;1,400&family=Fira+Code:wght@300;400;500&family=Jost:wght@300;400;500;600&display=swap');
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
.input:focus{border-color:var(--gold)}.input::placeholder{color:var(--muted)}
.sel{appearance:none;background:var(--s3);border:1px solid var(--border2);color:var(--text);padding:9px 12px;border-radius:var(--r2);font-family:var(--fb);font-size:.88rem;width:100%;outline:none;cursor:pointer}
.sel:focus{border-color:var(--gold)}
.label{font-size:.75rem;color:var(--muted2);margin-bottom:5px;font-weight:500}
.frow{margin-bottom:14px}
.fgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:500px){.fgrid{grid-template-columns:1fr}}
.acc-card{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px;transition:border-color .2s}
.acc-card:hover{border-color:var(--border2)}
.acc-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
.acc-name{font-family:var(--fd);font-size:1.05rem;color:var(--text);font-weight:600}
.acc-balance{font-family:var(--fm);font-size:1.1rem;color:var(--gold);white-space:nowrap}
.acc-balance.liability{color:var(--neg)}
.acc-pills{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.acc-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.acc-ts{font-family:var(--fm);font-size:.65rem;color:var(--muted)}
.acc-actions{display:flex;gap:6px}
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
.bar-row{margin-bottom:10px}
.bar-row-top{display:flex;justify-content:space-between;font-size:.78rem;margin-bottom:4px}
.bar-track{height:6px;background:var(--s3);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;transition:width .5s ease}
`;

// ─────────────────────────────────────────────────────────────
//  LOADING
// ─────────────────────────────────────────────────────────────
function LoadingPage() {
  return (
    <div className="setup">
      <style>{STYLE}</style>
      <div style={{textAlign:"center"}}>
        <div style={{fontFamily:"var(--fd)",fontSize:"1.8rem",color:"var(--gold)",marginBottom:20,letterSpacing:".02em"}}>Net Worth Tracker</div>
        <div style={{fontFamily:"var(--fm)",fontSize:".65rem",color:"var(--muted)",letterSpacing:".18em",textTransform:"uppercase"}}>Loading…</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  SIGN IN
// ─────────────────────────────────────────────────────────────
function SignInPage({ gsiReady }) {
  const btnRef = useRef(null);
  useEffect(() => {
    if (!gsiReady || !btnRef.current) return;
    window.google.accounts.id.renderButton(btnRef.current, { theme:"outline", size:"large", shape:"pill", text:"signin_with" });
    window.google.accounts.id.prompt();
  }, [gsiReady]);
  return (
    <div className="setup">
      <style>{STYLE}</style>
      <div className="setup-card" style={{textAlign:"center"}}>
        <div className="setup-title">Net Worth Tracker</div>
        <div className="setup-sub">Sign in with an authorised Google account to continue.</div>
        {gsiReady
          ? <div ref={btnRef} style={{display:"flex",justifyContent:"center",marginTop:20}}/>
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
  const empty = { name:"", currency:"GBP", liquidity:"liquid", risk:"very-low", class:"cash-savings", type:"asset", notes:"" };
  const [form, setForm] = useState(initial || empty);
  const set = (k,v) => setForm(f=>({...f,[k]:v}));

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
        <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={()=>form.name.trim()&&onSave(form)} disabled={!form.name.trim()}>
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
  const [showHistory, setShowHistory] = useState(false);
  const records = [...(account.records||[])].sort((a,b)=>Number(b.ts)-Number(a.ts));

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
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginBottom:20}}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={()=>{if(amount!=="")onSave(parseFloat(amount))}} disabled={amount===""}>
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
//  OVERVIEW PAGE
// ─────────────────────────────────────────────────────────────
function OverviewPage({ accounts, milestones, baselineId, displayCurrency, rates, toDisplay, excluded, onToggleExcluded, onSaveMilestone }) {
  const visible = accounts.filter(a => !excluded.has(a.id) && !excluded.has(`cls:${a.class}`));
  const hiddenCount = accounts.length - visible.length;

  const s = (() => {
    let total=0, assets=0, liabilities=0;
    const byLiq={}, byRisk={}, byCur={}, byCls={};
    for (const acc of visible) {
      const raw = latestBalance(acc);
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
  })();

  const baseline = milestones.find(m=>m.id===baselineId);
  const baseRaw = baseline?.summary?.total ?? null;
  const baseSavedCur = baseline?.summary?.currency || displayCurrency;
  const baseTotal = baseRaw!==null ? (baseSavedCur===displayCurrency ? baseRaw : toDisplay(baseRaw, baseSavedCur)) : null;
  const delta = baseTotal!==null ? s.total - baseTotal : null;
  const maxAbs = Math.max(...Object.values(s.byCls).map(v=>Math.abs(v)),1);

  return (
    <div className="page">
      <div className="hero">
        <div className="hero-label">Total Net Worth</div>
        <div className="hero-value">{fmt(s.total, displayCurrency)}</div>
        <div className="hero-sub">Assets {fmt(s.assets,displayCurrency,true)} · Liabilities {fmt(s.liabilities,displayCurrency,true)}</div>
        {delta!==null && (
          <div>
            <span className={`delta ${delta>=0?"pos":"neg"}`}>
              {delta>=0?"▲":"▼"} {(delta>=0?"+":"")+fmt(delta,displayCurrency)}
              {baseTotal!==0 ? ` (${((delta/Math.abs(baseTotal))*100).toFixed(1)}%)` : ""} vs baseline
            </span>
          </div>
        )}
        {baseline && <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:6}}>Baseline: {baseline.label||fmtDate(baseline.ts)}</div>}
        {hiddenCount>0 && <div style={{fontSize:".65rem",fontFamily:"var(--fm)",color:"var(--muted)",marginTop:6,letterSpacing:".04em"}}>{hiddenCount} account{hiddenCount>1?"s":""} hidden from totals</div>}
      </div>

      <div style={{display:"flex",justifyContent:"flex-end",marginBottom:16}}>
        <button className="btn btn-ghost btn-sm" onClick={()=>onSaveMilestone(s)}>📌 Save as Milestone</button>
      </div>

      <div className="st">By Account Class</div>
      <div className="card">
        {CLASS_OPTIONS.map(opt=>{
          const clsKey = `cls:${opt.value}`;
          const isExcl = excluded.has(clsKey);
          const val = s.byCls[opt.value];
          if (val===undefined && !isExcl) return null;
          const pct = val!==undefined ? Math.min(Math.abs(val)/maxAbs*100,100) : 0;
          return (
            <div className={`bar-row${isExcl?" excl-row":""}`} key={opt.value}>
              <div className="bar-row-top">
                <span style={{color:isExcl?"var(--muted)":"var(--text)"}}>{opt.label}</span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  {isExcl
                    ? <span className="excl-tag">hidden</span>
                    : <span className={`crow-val ${val<0?"neg":val===0?"neu":"pos"}`}>{fmt(val,displayCurrency)}</span>
                  }
                  <button className="excl-btn" onClick={()=>onToggleExcluded(clsKey)} title={isExcl?"Show class in overview":"Hide class from overview"}>
                    {isExcl?"Show":"Hide"}
                  </button>
                </div>
              </div>
              {!isExcl && val!==undefined && (
                <div className="bar-track">
                  <div className="bar-fill" style={{width:pct+"%",background:val<0?"var(--neg)":"var(--gold)"}}/>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="st">By Liquidity</div>
      <div className="card">
        {LIQUIDITY_OPTIONS.map(opt=>{
          const val=s.byLiq[opt.value];
          if(val===undefined) return null;
          return (
            <div className="crow" key={opt.value}>
              <div className="crow-left">
                <div className="crow-label">{opt.label}</div>
                <div className="crow-desc">{opt.desc}</div>
              </div>
              <div className={`crow-val ${val<0?"neg":val===0?"neu":"pos"}`}>{fmt(val,displayCurrency)}</div>
            </div>
          );
        })}
      </div>

      <div className="st">By Risk Level</div>
      <div className="card">
        {RISK_OPTIONS.map(opt=>{
          const val=s.byRisk[opt.value];
          if(val===undefined) return null;
          return (
            <div className="crow" key={opt.value}>
              <div className="crow-left">
                <div className="crow-label">{opt.label}</div>
                <div className="crow-desc">{opt.desc}</div>
              </div>
              <div className={`crow-val ${val<0?"neg":val===0?"neu":"pos"}`}>{fmt(val,displayCurrency)}</div>
            </div>
          );
        })}
      </div>

      <div className="st">By Currency (native amounts)</div>
      <div className="card">
        {Object.entries(s.byCur).length===0 && <div className="empty">No accounts yet</div>}
        {Object.entries(s.byCur).map(([cur,val])=>(
          <div className="crow" key={cur}>
            <div className="crow-label">{cur}</div>
            <div className={`crow-val ${val<0?"neg":val===0?"neu":"pos"}`}>{fmt(val,cur)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  ACCOUNTS PAGE
// ─────────────────────────────────────────────────────────────
function AccountsPage({ accounts, displayCurrency, toDisplay, excluded, onToggleExcluded, onAdd, onUpdate, onDelete, onRecord }) {
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [recording, setRecording] = useState(null);
  const [filter, setFilter] = useState("all");
  const filtered = filter==="all" ? accounts : accounts.filter(a=>a.class===filter);

  return (
    <div className="page">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8,marginBottom:14}}>
        <select className="cur-sel" value={filter} onChange={e=>setFilter(e.target.value)}>
          <option value="all">All Classes</option>
          {CLASS_OPTIONS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={()=>setShowAdd(true)}>+ Add Account</button>
      </div>

      {filtered.length===0 && (
        <div className="empty"><div className="empty-icon">🏦</div>No accounts yet. Add one to get started.</div>
      )}

      {filtered.map(acc=>{
        const bal=latestBalance(acc);
        const conv=bal!==null?toDisplay(bal,acc.currency):null;
        const signed=conv!==null?(acc.type==="liability"?-Math.abs(conv):conv):null;
        const isExcl = excluded.has(acc.id) || excluded.has(`cls:${acc.class}`);
        const clsExcl = excluded.has(`cls:${acc.class}`);
        return (
          <div className={`acc-card${isExcl?" excl-card":""}`} key={acc.id}>
            <div className="acc-top">
              <div>
                <div className="acc-name">{acc.name}</div>
                <div style={{fontSize:".72rem",color:"var(--muted)",fontFamily:"var(--fm)",marginTop:2}}>{acc.currency}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div className={`acc-balance ${acc.type==="liability"?"liability":""}`}>
                  {bal!==null?fmt(bal,acc.currency):"No balance recorded"}
                </div>
                {conv!==null&&acc.currency!==displayCurrency&&(
                  <div style={{fontSize:".7rem",color:"var(--muted)",fontFamily:"var(--fm)"}}>≈ {fmt(signed,displayCurrency)}</div>
                )}
              </div>
            </div>
            <div className="acc-pills">
              <Pill label={CLASS_OPTIONS.find(o=>o.value===acc.class)?.label||acc.class} color="var(--gold)"/>
              <Pill label={LIQUIDITY_OPTIONS.find(o=>o.value===acc.liquidity)?.label||acc.liquidity} color={LIQ_COLORS[acc.liquidity]||"#6b7280"}/>
              <Pill label={(RISK_OPTIONS.find(o=>o.value===acc.risk)?.label||acc.risk)+" risk"} color={RISK_COLORS[acc.risk]||"#6b7280"}/>
              <Pill label={acc.type==="liability"?"Liability":"Asset"} color={acc.type==="liability"?"var(--neg)":"var(--teal)"}/>
              {isExcl && <Pill label={clsExcl?"Class hidden":"Hidden from overview"} color="var(--muted)"/>}
            </div>
            <div className="acc-footer">
              <div className="acc-ts">
                {latestTs(acc)?"Updated "+fmtDate(latestTs(acc)):"Never updated"}
                {acc.notes&&<span style={{marginLeft:8,color:"var(--muted)"}}>· {acc.notes}</span>}
              </div>
              <div className="acc-actions">
                <button className="btn btn-ghost btn-xs" onClick={()=>setRecording(acc)}>Update Balance</button>
                <button className="btn btn-ghost btn-xs" onClick={()=>setEditing(acc)}>Edit</button>
                {!clsExcl && (
                  <button className={`btn btn-xs ${isExcl?"btn-ghost excl-active":"btn-ghost"}`} onClick={()=>onToggleExcluded(acc.id)} title={isExcl?"Show in overview":"Hide from overview"}>
                    {isExcl?"Unhide":"Hide"}
                  </button>
                )}
                <button className="btn btn-danger btn-xs" onClick={()=>{if(window.confirm(`Remove "${acc.name}"?`))onDelete(acc.id)}}>✕</button>
              </div>
            </div>
          </div>
        );
      })}

      {showAdd&&<AccountModal onSave={d=>{onAdd(d);setShowAdd(false)}} onClose={()=>setShowAdd(false)}/>}
      {editing&&<AccountModal initial={editing} onSave={d=>{onUpdate(editing.id,d);setEditing(null)}} onClose={()=>setEditing(null)}/>}
      {recording&&<RecordModal account={recording} onSave={a=>{onRecord(recording.id,a);setRecording(null)}} onClose={()=>setRecording(null)}/>}
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
//  ROOT APP
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [idToken, setIdToken] = useState(getStoredAuth);
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
  const [milestones, setMilestones] = useState([]);
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

  useEffect(() => { tokenRef.current = idToken; }, [idToken]);

  useEffect(() => {
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
    if (!idToken) return;
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
      setAccounts(data.accounts||[]);
      setMilestones(data.milestones||[]);
      setBaselineId(data.baselineId||null);
      if (data.settings?.displayCurrency) setDisplayCurrency(data.settings.displayCurrency);
      if (data.settings?.excluded) setExcluded(new Set(data.settings.excluded));
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
      setAccounts(data.accounts||[]);
      setMilestones(data.milestones||[]);
      setBaselineId(data.baselineId||null);
      if (data.settings?.displayCurrency) setDisplayCurrency(data.settings.displayCurrency);
      if (data.settings?.excluded) setExcluded(new Set(data.settings.excluded));
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
  const addAccount = async (form) => {
    const acc={id:uid(),...form,createdTs:Date.now(),records:[]};
    setAccounts(p=>[...p,acc]); showToast(`"${acc.name}" added`);
    try { await api.current.callWithData("addAccount", acc); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const updateAccount = async (id, form) => {
    const acc=accounts.find(a=>a.id===id);
    setAccounts(p=>p.map(a=>a.id===id?{...a,...form}:a)); showToast("Account updated");
    try { await api.current.callWithData("updateAccount", {...acc,...form}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const deleteAccount = async (id) => {
    const acc=accounts.find(a=>a.id===id);
    setAccounts(p=>p.filter(a=>a.id!==id)); showToast(`"${acc?.name}" removed`,"warn");
    try { await api.current.call("deleteAccount", {id}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const addRecord = async (accountId, amount) => {
    const rec={id:uid(),accountId,amount,ts:Date.now()};
    setAccounts(p=>p.map(a=>a.id===accountId?{...a,records:[...(a.records||[]),rec]}:a));
    showToast("Balance recorded");
    try { await api.current.callWithData("addRecord", rec); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const saveMilestone = async (summary) => {
    const m={id:uid(),ts:Date.now(),label:"",summary:{...summary,currency:displayCurrency}};
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
  const setBaseline = async (id) => {
    setBaselineId(id); showToast(id?"Baseline set":"Baseline cleared");
    try { await api.current.call("setBaseline", {id: id||""}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };
  const updateMilestoneLabel = async (id, label) => {
    const m=milestones.find(m=>m.id===id);
    setMilestones(p=>p.map(x=>x.id===id?{...x,label}:x));
    try { await api.current.callWithData("updateMilestone", {...m,label}); }
    catch(e){ showToast("Sync error: "+e.message,"err"); }
  };

  if (!idToken) return <SignInPage gsiReady={gsiReady}/>;
  if (connecting || (apiUrl && !connected && !connectErr)) return <LoadingPage/>;
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
          {[["overview","Overview"],["accounts",`Accounts (${accounts.length})`],["milestones",`Milestones (${milestones.length})`]].map(([id,label])=>(
            <button key={id} className={`nb ${page===id?"on":""}`} onClick={()=>setPage(id)}>{label}</button>
          ))}
        </div>

        {page==="overview"&&<OverviewPage accounts={accounts} milestones={milestones} baselineId={baselineId} displayCurrency={displayCurrency} rates={rates} toDisplay={toDisplay} excluded={excluded} onToggleExcluded={toggleExcluded} onSaveMilestone={saveMilestone}/>}
        {page==="accounts"&&<AccountsPage accounts={accounts} displayCurrency={displayCurrency} toDisplay={toDisplay} excluded={excluded} onToggleExcluded={toggleExcluded} onAdd={addAccount} onUpdate={updateAccount} onDelete={deleteAccount} onRecord={addRecord}/>}
        {page==="milestones"&&<MilestonesPage milestones={milestones} baselineId={baselineId} displayCurrency={displayCurrency} toDisplay={toDisplay} onDelete={deleteMilestone} onSetBaseline={setBaseline} onUpdateLabel={updateMilestoneLabel}/>}
      </div>

      {toast&&<div className={`toast ${toast.type==="warn"?"warn":toast.type==="err"?"err":""}`}>{toast.msg}</div>}
    </>
  );
}
