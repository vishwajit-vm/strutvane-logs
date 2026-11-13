/**
 * The viewer's single HTML page: no build step, no external assets, no framework.
 *
 * XSS defences (log text is attacker-controlled: paths, headers, messages):
 *
 * - Log data is rendered **only with `textContent`**, never `innerHTML`, so markup in a log line
 *   is shown as text.
 * - The page's own style and script carry a **per-response CSP nonce**; nothing else can run.
 *   No inline event handlers are used (CSP blocks them anyway).
 * - The base path reaches the script through an escaped `data-` attribute, never by string
 *   concatenation into the script.
 *
 * @module
 */

/** Escape text for an HTML attribute value or text node. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLE = `
:root{--bg:#f7f7f8;--panel:#fff;--text:#1d1d22;--muted:#5f6170;--border:#d9dae0;--accent:#2f5bd3;
--trace:#7a7f8c;--debug:#5c6ac4;--info:#1f7a4d;--warn:#9a6200;--error:#c0362c;--fatal:#fff;--fatal-bg:#a3122b;
--row-hover:#f0f1f5;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]):not([data-theme=contrast]){--bg:#121317;--panel:#1b1c22;
--text:#e8e8ec;--muted:#a0a2b0;--border:#30323b;--accent:#8fa8ff;--trace:#9095a3;--debug:#a3adff;--info:#6fd3a0;
--warn:#f0b75a;--error:#ff7b70;--row-hover:#23242c;color-scheme:dark}}
:root[data-theme=dark]{--bg:#121317;--panel:#1b1c22;--text:#e8e8ec;--muted:#a0a2b0;--border:#30323b;--accent:#8fa8ff;
--trace:#9095a3;--debug:#a3adff;--info:#6fd3a0;--warn:#f0b75a;--error:#ff7b70;--row-hover:#23242c;color-scheme:dark}
:root[data-theme=contrast]{--bg:#000;--panel:#000;--text:#fff;--muted:#fff;--border:#fff;--accent:#ffff00;--trace:#fff;
--debug:#fff;--info:#00ff7f;--warn:#ffff00;--error:#ff6b6b;--fatal:#000;--fatal-bg:#ffff00;--row-hover:#222;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:12px 16px;
border-bottom:1px solid var(--border);background:var(--panel)}
h1{font-size:16px;margin:0}
main{padding:12px 16px;max-width:1400px;margin:0 auto}
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-bottom:12px}
label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:2px}
input,select,button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--border);
border-radius:6px;padding:5px 8px;min-height:32px}
button{cursor:pointer}
button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}
button.danger{color:var(--error);border-color:var(--error)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.status{color:var(--muted);font-size:12px;min-height:18px;margin:4px 0}
ul.rows{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:8px;background:var(--panel)}
li.row{border-bottom:1px solid var(--border);padding:6px 10px}
li.row:last-child{border-bottom:0}
li.row:hover{background:var(--row-hover)}
.line{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.time{color:var(--muted);font-variant-numeric:tabular-nums;min-width:72px}
.badge{font-size:11px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:4px;border:1px solid currentColor}
.lvl-trace{color:var(--trace)}.lvl-debug{color:var(--debug)}.lvl-info{color:var(--info)}.lvl-warn{color:var(--warn)}
.lvl-error{color:var(--error)}.lvl-fatal{color:var(--fatal);background:var(--fatal-bg);border-color:var(--fatal-bg)}
.msg{word-break:break-word;flex:1;min-width:200px}
.rid{color:var(--muted);font-size:12px;font-family:ui-monospace,Consolas,monospace}
details pre{margin:6px 0 2px;padding:8px;overflow:auto;background:var(--bg);border-radius:6px;font-size:12px;
font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
summary{cursor:pointer;color:var(--muted);font-size:12px}
.files{margin-top:16px}
.files li{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 0}
a{color:var(--accent)}
dialog{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:10px;max-width:440px}
dialog::backdrop{background:rgba(0,0,0,.5)}
.actions{display:flex;gap:8px;justify-content:end;margin-top:12px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:600px){.time{min-width:0}.filters label{flex:1 1 140px}}
`

const SCRIPT = `
(function () {
  'use strict';
  var base = document.body.dataset.base || '';
  var $ = function (id) { return document.getElementById(id); };
  var rows = $('rows'), status = $('message'), more = $('more');
  var cursor = null, source = null, csrf = null, MAX_ROWS = 2000;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function say(text) { status.textContent = text; }
  function str(v) { return typeof v === 'string' ? v : ''; }

  function relative(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function row(record) {
    var level = str(record.level) || 'info';
    var li = el('li', 'row');
    var line = el('div', 'line');
    var time = el('time', 'time', relative(str(record.time)));
    time.dateTime = str(record.time);
    time.title = str(record.time);
    line.appendChild(time);
    line.appendChild(el('span', 'badge lvl-' + (/^[a-z]+$/.test(level) ? level : 'info'), level));
    line.appendChild(el('span', 'msg', str(record.msg)));
    if (record.requestId) line.appendChild(el('span', 'rid', str(record.requestId)));
    li.appendChild(line);
    var details = el('details');
    details.appendChild(el('summary', null, 'Details'));
    details.appendChild(el('pre', null, JSON.stringify(record, null, 2)));
    li.appendChild(details);
    return li;
  }

  function params() {
    var p = new URLSearchParams();
    var levels = Array.prototype.filter.call(document.querySelectorAll('input[name=level]'), function (c) { return c.checked; })
      .map(function (c) { return c.value; });
    if (levels.length && levels.length < 6) p.set('level', levels.join(','));
    ['q', 'route', 'status', 'requestId'].forEach(function (k) { var v = $(k).value.trim(); if (v) p.set(k, v); });
    var from = $('from').value, to = $('to').value;
    if (from) p.set('from', new Date(from).toISOString());
    if (to) p.set('to', new Date(to).toISOString());
    return p;
  }

  function api(path, init) {
    return fetch(base + '/api/' + path, Object.assign({ credentials: 'same-origin' }, init || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error((body && body.detail) || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  function load(reset) {
    if (reset) { cursor = null; rows.replaceChildren(); }
    var p = params();
    p.set('limit', '100');
    if (cursor) p.set('cursor', cursor);
    say('Loading...');
    return api('records?' + p.toString()).then(function (page) {
      page.records.forEach(function (r) { rows.appendChild(row(r)); });
      cursor = page.nextCursor || null;
      more.hidden = !cursor;
      say(rows.children.length ? rows.children.length + ' records shown' : 'No records match.');
    }).catch(function (e) { say('Could not load records: ' + e.message); });
  }

  function tail(on) {
    if (source) { source.close(); source = null; }
    if (!on) { say('Live tail stopped.'); return; }
    source = new EventSource(base + '/api/tail?' + params().toString());
    source.onopen = function () { say('Live tail: waiting for new records...'); };
    source.onmessage = function (event) {
      try {
        rows.insertBefore(row(JSON.parse(event.data)), rows.firstChild);
        while (rows.children.length > MAX_ROWS) rows.removeChild(rows.lastChild);
      } catch (e) { /* ignore malformed events */ }
    };
    source.onerror = function () { say('Live tail disconnected; retrying...'); };
  }

  function files() {
    var list = $('files');
    api('files').then(function (body) {
      list.replaceChildren();
      var days = [];
      body.files.forEach(function (f) { if (days.indexOf(f.day) === -1) days.push(f.day); });
      if (!days.length) list.appendChild(el('li', null, 'No log files yet.'));
      days.forEach(function (day) {
        var size = body.files.filter(function (f) { return f.day === day; })
          .reduce(function (n, f) { return n + f.size; }, 0);
        var li = el('li');
        li.appendChild(el('strong', null, day));
        li.appendChild(el('span', 'rid', (size / 1024).toFixed(1) + ' KB'));
        ['ndjson', 'csv'].forEach(function (format) {
          var a = el('a', null, 'Download ' + format.toUpperCase());
          a.href = base + '/api/download?day=' + encodeURIComponent(day) + '&format=' + format;
          a.setAttribute('download', '');
          li.appendChild(a);
        });
        list.appendChild(li);
      });
    }).catch(function (e) { list.replaceChildren(el('li', null, 'Could not list files: ' + e.message)); });
  }

  function session() {
    return csrf ? Promise.resolve(csrf) : api('session').then(function (s) { csrf = s.csrfToken; return csrf; });
  }

  var dialog = $('clear-dialog');
  $('clear').addEventListener('click', function () { $('confirm').value = ''; $('clear-result').textContent = ''; dialog.showModal(); });
  $('cancel').addEventListener('click', function () { dialog.close(); });
  $('do-clear').addEventListener('click', function () {
    if ($('confirm').value !== 'DELETE') { $('clear-result').textContent = 'Type DELETE to confirm.'; return; }
    session().then(function (token) {
      return api('clear', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ confirm: 'DELETE' })
      });
    }).then(function (result) {
      $('clear-result').textContent = 'Deleted ' + result.deleted.length + ' file(s). Today\\'s logs are kept.';
      files(); load(true);
    }).catch(function (e) { $('clear-result').textContent = 'Could not clear: ' + e.message; });
  });

  var theme = $('theme');
  try { theme.value = localStorage.getItem('sv-logs-theme') || 'auto'; } catch (e) { theme.value = 'auto'; }
  function applyTheme() {
    if (theme.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    try { localStorage.setItem('sv-logs-theme', theme.value); } catch (e) { /* storage blocked */ }
  }
  theme.addEventListener('change', applyTheme);
  applyTheme();

  $('filters').addEventListener('submit', function (e) { e.preventDefault(); load(true); if ($('live').checked) tail(true); });
  more.addEventListener('click', function () { load(false); });
  $('live').addEventListener('change', function (e) { tail(e.target.checked); });
  $('refresh').addEventListener('click', function () { load(true); files(); });
  setInterval(function () {
    Array.prototype.forEach.call(document.querySelectorAll('time.time'), function (t) { t.textContent = relative(t.dateTime); });
  }, 30000);

  load(true);
  files();
})();
`

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

/** Render the viewer page. `basePath` must already be validated; it is escaped regardless. */
export function renderViewerPage(options: {
  readonly nonce: string
  readonly basePath: string
}): string {
  const nonce = escapeHtml(options.nonce)
  const levelBoxes = LEVELS.map(
    (l) =>
      `<label class="lvl-${l}" for="level-${l}"><span>${l}</span><input type="checkbox" name="level" id="level-${l}" value="${l}"${l === 'trace' || l === 'debug' ? '' : ' checked'}></label>`,
  ).join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Strutvane Logs</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body data-base="${escapeHtml(options.basePath)}">
<header>
<h1>Strutvane Logs</h1>
<div class="filters">
<label class="live" for="live"><span>Live tail</span><input type="checkbox" id="live"></label>
<button type="button" id="refresh">Refresh</button>
<label for="theme"><span>Theme</span><select id="theme"><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option><option value="contrast">High contrast</option></select></label>
<button type="button" class="danger" id="clear">Clear old logs</button>
</div>
</header>
<main>
<form id="filters" class="filters" role="search">
${levelBoxes}
<label for="q"><span>Search</span><input id="q" type="search" maxlength="200" placeholder="text in message or fields"></label>
<label for="route"><span>Route</span><input id="route" maxlength="200" placeholder="/invoices/:id"></label>
<label for="status"><span>Status</span><input id="status" maxlength="3" size="4" placeholder="5xx"></label>
<label for="requestId"><span>Request id</span><input id="requestId" maxlength="128"></label>
<label for="from"><span>From</span><input id="from" type="datetime-local"></label>
<label for="to"><span>To</span><input id="to" type="datetime-local"></label>
<button type="submit" class="primary">Apply</button>
</form>
<p id="message" class="status" role="status" aria-live="polite"></p>
<ul id="rows" class="rows" aria-label="Log records, newest first"></ul>
<p><button type="button" id="more" hidden>Load older records</button></p>
<section class="files"><h2>Files</h2><ul id="files"></ul></section>
</main>
<dialog id="clear-dialog" aria-labelledby="clear-title">
<h2 id="clear-title">Clear old logs?</h2>
<p>This permanently deletes every log file before today. Today's logs are kept. This cannot be undone.</p>
<label for="confirm"><span>Type DELETE to confirm</span><input id="confirm" autocomplete="off"></label>
<p id="clear-result" class="status" role="status"></p>
<div class="actions"><button type="button" id="cancel">Cancel</button><button type="button" class="danger" id="do-clear">Delete</button></div>
</dialog>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`
}
