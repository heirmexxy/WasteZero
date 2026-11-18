import { escapeHtml } from "./util.js";

let publicBase = "";
/** Absolute address for link previews (og:image needs a full URL). */
export const setPublicBase = (url) => { publicBase = String(url || "").replace(/\/+$/, ""); };

// One look for every page: public site, sign-in, customer dashboard and admin console.
export const STYLE = `
:root{--ink:#14161b;--muted:#5b6170;--line:#e3e5ea;--accent:#0b7a53;--accent-bg:#eef6f2;--warn:#7a5b0b;--warn-bg:#f6f1e3;--bad:#b42318;--bad-bg:#fdecea;--bg:#fbfbf9;--card:#fff}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
a{color:inherit}main{max-width:960px;margin:0 auto;padding:18px 20px 80px}
header.top{border-bottom:1px solid var(--line);background:#fff;position:sticky;top:0;z-index:5}
header.top .in{max-width:960px;margin:0 auto;padding:12px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header.top .brand{font-weight:800;text-decoration:none;font-size:18px;letter-spacing:-.01em}
header.top nav{display:flex;gap:16px;flex-wrap:wrap;margin-left:auto;font-size:15px}
header.top nav a{text-decoration:none;color:var(--muted)}header.top nav a:hover,header.top nav a.on{color:var(--ink)}
header.top nav a.cta{color:#fff;background:var(--ink);padding:4px 12px;border-radius:6px}
h1{font-size:clamp(28px,5vw,44px);line-height:1.12;margin:22px 0 14px;letter-spacing:-.02em}
h2{font-size:21px;margin:36px 0 10px}h3{font-size:16px;margin:0 0 4px}
p{margin:0 0 12px}.muted{color:var(--muted)}.small{font-size:14px}.tiny{font-size:12px}
.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;border:0;font:inherit;font-weight:600;cursor:pointer}
.btn.alt{background:transparent;color:var(--ink);border:1.5px solid var(--ink)}.btn.sm{padding:5px 11px;font-size:14px}
.btn.good{background:var(--accent)}.btn.bad{background:var(--bad)}.btn:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:18px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
.stat{font-size:28px;font-weight:700;letter-spacing:-.01em}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--accent-bg);color:var(--accent);font-weight:600}
.tag.est,.tag.warn{background:var(--warn-bg);color:var(--warn)}.tag.bad{background:var(--bad-bg);color:var(--bad)}.tag.grey{background:#eef0f3;color:var(--muted)}
label{display:block;font-weight:600;margin:14px 0 6px}
input,textarea,select{width:100%;padding:10px;border:1px solid #c9ccd4;border-radius:8px;font:inherit;background:#fff}
textarea{min-height:110px;font-family:ui-monospace,monospace;font-size:13px}
.err{color:var(--bad)}.ok{color:var(--accent)}
.finding{border-left:4px solid var(--accent);padding:12px 16px;margin:12px 0;background:#fff;border-radius:0 8px 8px 0}
.money{font-weight:700;font-size:18px}
code{background:#eef0f3;padding:1px 5px;border-radius:4px;font-size:14px}
pre{background:#14161b;color:#e8eaf0;padding:14px;border-radius:8px;overflow:auto;font-size:13px;line-height:1.5}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px}
.tabs{display:flex;gap:6px;overflow-x:auto;border-bottom:1px solid var(--line);margin:8px 0 18px;padding-bottom:0}
.tabs button{background:none;border:0;padding:10px 12px;font:inherit;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tabs button.on{color:var(--ink);border-bottom-color:var(--ink);font-weight:600}
.side{display:grid;grid-template-columns:1fr 1fr;gap:10px}.side>div{background:#f6f7f9;border-radius:8px;padding:10px;font-size:13px;white-space:pre-wrap;max-height:220px;overflow:auto}
.notice{background:var(--warn-bg);border-radius:8px;padding:12px 14px;margin:12px 0}
.hidden{display:none}
@media(max-width:600px){.side{grid-template-columns:1fr}header.top nav{gap:12px;font-size:14px;margin-left:0;width:100%}}`;

const NAV = [
  ["/", "Home"], ["/audit", "Free audit"], ["/teams", "Teams"], ["/pricing", "Pricing"], ["/docs", "Docs"]
];

/** Full HTML page with the shared header. `nav` can override the links (dashboards use their own). */
export function layout(title, body, { desc = "", active = "", nav = null, script = "" } = {}) {
  const links = nav ?? [...NAV.map(([href, label]) => `<a href="${href}"${active === href ? ' class="on"' : ""}>${label}</a>`),
    `<a class="cta" href="/signin">Sign in</a>`].join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${desc ? `<meta name="description" content="${escapeHtml(desc)}">` : ""}
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png">
<meta name="theme-color" content="#14161B">
<meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(desc || "Find where your AI money leaks. Fix it without hurting quality. Pay only from what we save.")}">
<meta property="og:image" content="${publicBase}/brand/og-image-1200x630.png"><meta name="twitter:card" content="summary_large_image">
<style>${STYLE}</style></head>
<body><header class="top"><div class="in"><a class="brand" href="/"><img src="/brand/wastezero-logo.svg" alt="WasteZero" height="28" style="display:block;height:28px;width:auto"></a><nav>${links}</nav></div></header>
<main>${body}</main>
<footer style="border-top:1px solid var(--line);margin-top:40px"><div style="max-width:960px;margin:0 auto;padding:18px 20px;font-size:13px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap">
<span>© WasteZero</span><a href="/contact">Contact</a><a href="/teams">Teams</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/signin">Sign in</a></div></footer>
${script ? `<script>${script}</script>` : ""}</body></html>`;
}

export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(html);
}

export const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: Math.abs(n) < 100 ? 2 : 0, maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });
