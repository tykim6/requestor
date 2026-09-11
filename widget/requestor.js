/* Requestor bug-report widget. Drop-in:
 *   <script src="https://your-requestor-host/requestor.js" data-endpoint="https://your-requestor-host/api/bugs"></script>
 * Optional data-attributes: data-position="bottom-left", data-label="Feedback", data-hidden="true" (no button; call Requestor.open()).
 * API: Requestor.open(), .close(), .identify({id,email,name}), .setContext({...}), .report({title,description,severity}), .snapshot()
 */
(function () {
  'use strict';
  if (window.Requestor && window.Requestor.__installed) return;

  var VERSION = '0.1.0';
  var script = document.currentScript;
  var ds = (script && script.dataset) || {};
  var origin = script && script.src ? new URL(script.src, location.href).origin : location.origin;
  var cfg = {
    endpoint: ds.endpoint || origin + '/api/bugs',
    position: ds.position || 'bottom-right',
    label: ds.label || 'Report a bug',
    hidden: ds.hidden === 'true',
    max: { console: 50, breadcrumbs: 40, errors: 20, network: 30 }
  };

  var state = { user: {}, context: {}, startedAt: Date.now(), errors: [], console: [], breadcrumbs: [], network: [] };

  // ---------- telemetry capture ----------
  function push(buf, item, max) { buf.push(item); if (buf.length > max) buf.splice(0, buf.length - max); }
  function safeString(v) {
    try {
      if (v instanceof Error) return v.name + ': ' + v.message;
      if (typeof v === 'string') return v;
      return JSON.stringify(v);
    } catch (e) { return String(v); }
  }
  function describeEl(el) {
    if (!el || !el.tagName) return '?';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    var text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (text && el.type !== 'password') s += ' "' + text + '"';
    return s;
  }
  function crumb(type, detail) { push(state.breadcrumbs, { ts: Date.now(), type: type, detail: detail }, cfg.max.breadcrumbs); }

  window.addEventListener('error', function (e) {
    push(state.errors, { ts: Date.now(), type: 'error', message: e.message || safeString(e.error), source: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack }, cfg.max.errors);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    push(state.errors, { ts: Date.now(), type: 'unhandledrejection', message: safeString(r), stack: r && r.stack }, cfg.max.errors);
  });
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      push(state.console, { ts: Date.now(), level: level, message: args.map(safeString).join(' ').slice(0, 500) }, cfg.max.console);
      return orig.apply(console, args);
    };
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('#requestor-root')) return;
    var el = t.closest('a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=tab],[role=menuitem]');
    // Non-interactive targets: keep the selector but drop the (often huge) text.
    crumb('click', el ? describeEl(el) : describeEl(t).replace(/ ".*"$/, ''));
  }, true);
  document.addEventListener('submit', function (e) { crumb('submit', describeEl(e.target)); }, true);
  window.addEventListener('popstate', function () { crumb('navigate', location.href); });
  window.addEventListener('hashchange', function () { crumb('navigate', location.href); });
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function () { var r = orig.apply(this, arguments); crumb('navigate', location.href); return r; };
  });
  crumb('navigate', location.href);

  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var started = Date.now();
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = (init && init.method) || (input && input.method) || 'GET';
      if (url.indexOf(cfg.endpoint) === 0) return origFetch.apply(this, arguments);
      return origFetch.apply(this, arguments).then(function (res) {
        if (!res.ok) push(state.network, { ts: started, method: method, url: url, status: res.status, durationMs: Date.now() - started }, cfg.max.network);
        return res;
      }, function (err) {
        push(state.network, { ts: started, method: method, url: url, error: safeString(err), durationMs: Date.now() - started }, cfg.max.network);
        throw err;
      });
    };
  }
  if (window.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__rq = { method: method, url: String(url) }; return xo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this, started = Date.now();
      xhr.addEventListener('loadend', function () {
        if (!xhr.__rq || xhr.__rq.url.indexOf(cfg.endpoint) === 0) return;
        if (xhr.status === 0 || xhr.status >= 400) push(state.network, { ts: started, method: xhr.__rq.method, url: xhr.__rq.url, status: xhr.status || 'network error', durationMs: Date.now() - started }, cfg.max.network);
      });
      return xs.apply(this, arguments);
    };
  }

  function snapshot() {
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    return {
      widgetVersion: VERSION,
      capturedAt: new Date().toISOString(),
      url: location.href,
      referrer: document.referrer,
      title: document.title,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      timezone: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio || 1 },
      online: navigator.onLine,
      cookiesEnabled: navigator.cookieEnabled,
      timeOnPageMs: Date.now() - state.startedAt,
      performance: nav ? { loadMs: Math.round(nav.loadEventEnd || nav.duration), domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd), transferSize: nav.transferSize } : null,
      errors: state.errors.slice(),
      console: state.console.slice(),
      breadcrumbs: state.breadcrumbs.slice(),
      network: state.network.slice()
    };
  }

  function submit(fields) {
    var payload = {
      title: fields.title,
      description: fields.description || '',
      severity: fields.severity || 'medium',
      reporter: Object.assign({}, state.user, fields.email ? { email: fields.email } : {}),
      context: state.context,
      telemetry: fields.includeTelemetry === false ? null : snapshot()
    };
    return fetch(cfg.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .then(function (res) { return res.json().then(function (body) { if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status)); return body; }); });
  }

  // ---------- UI ----------
  var BUG_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l1.88 1.88M14.12 3.88L16 2M9 7.13v-1a3.003 3.003 0 116 0v1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 014-4h4a4 4 0 014 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4"/></svg>';
  var CSS = ':host{all:initial}*{box-sizing:border-box}' +
    '.fab{position:fixed;z-index:2147483000;width:48px;height:48px;border-radius:50%;border:0;background:#111827;color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}' +
    '.fab:hover{background:#1f2937}.fab[hidden]{display:none}' +
    '.br{bottom:20px;right:20px}.bl{bottom:20px;left:20px}' +
    '.panel{position:fixed;z-index:2147483001;width:min(380px,calc(100vw - 32px));background:#fff;color:#111827;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px;display:none}' +
    '.panel.open{display:block}.panel.br{bottom:80px;right:20px}.panel.bl{bottom:80px;left:20px}' +
    'h2{font-size:16px;margin:0 0 12px;font-weight:600}label{display:block;font-size:12px;font-weight:600;color:#374151;margin:10px 0 4px}' +
    'input,textarea,select{width:100%;font:inherit;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:inherit}textarea{min-height:90px;resize:vertical}' +
    'input:focus,textarea:focus,select:focus{outline:2px solid #2563eb;outline-offset:-1px;border-color:#2563eb}' +
    '.row{display:flex;gap:10px}.row>*{flex:1}.check{display:flex;align-items:center;gap:8px;font-weight:400;margin-top:12px;font-size:12px;color:#4b5563}.check input{width:auto}' +
    '.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}' +
    'button.btn{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid #d1d5db;background:#fff;cursor:pointer}button.primary{background:#111827;color:#fff;border-color:#111827}button:disabled{opacity:.6;cursor:default}' +
    '.msg{font-size:13px;margin-top:10px}.msg.err{color:#b91c1c}.msg.ok{color:#047857}.hint{font-size:11px;color:#6b7280;margin-top:4px}a{color:#2563eb}';

  var root, shadow, fab, panel, form, msg;
  function h(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  function mount() {
    if (root) return;
    root = document.createElement('div'); root.id = 'requestor-root';
    shadow = root.attachShadow({ mode: 'open' });
    var style = document.createElement('style'); style.textContent = CSS; shadow.appendChild(style);
    var pos = cfg.position === 'bottom-left' ? 'bl' : 'br';

    fab = h('<button class="fab ' + pos + '" type="button" aria-label="' + cfg.label + '" title="' + cfg.label + '">' + BUG_ICON + '</button>');
    fab.hidden = cfg.hidden;
    fab.addEventListener('click', toggle);
    shadow.appendChild(fab);

    panel = h('<div class="panel ' + pos + '" role="dialog" aria-label="' + cfg.label + '">' +
      '<h2>' + cfg.label + '</h2>' +
      '<form>' +
      '<label>What went wrong?</label><input name="title" required maxlength="200" placeholder="Short summary" autocomplete="off">' +
      '<label>Details</label><textarea name="description" placeholder="What did you do, what did you expect, what happened instead?"></textarea>' +
      '<div class="row"><div><label>Severity</label><select name="severity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>' +
      '<div><label>Email (optional)</label><input name="email" type="email" placeholder="you@example.com"></div></div>' +
      '<label class="check"><input type="checkbox" name="includeTelemetry" checked> Include technical details <span class="hint" id="telemetry-hint"></span></label>' +
      '<div class="msg" hidden></div>' +
      '<div class="actions"><button class="btn" type="button" data-cancel>Cancel</button><button class="btn primary" type="submit">Send report</button></div>' +
      '</form></div>');
    form = panel.querySelector('form');
    msg = panel.querySelector('.msg');
    panel.querySelector('[data-cancel]').addEventListener('click', close);
    form.addEventListener('submit', onSubmit);
    shadow.appendChild(panel);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    (document.body || document.documentElement).appendChild(root);
  }

  function open() {
    mount();
    panel.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    msg.hidden = true; msg.className = 'msg';
    form.hidden = false;
    if (state.user.email && !form.email.value) form.email.value = state.user.email;
    panel.querySelector('#telemetry-hint').textContent = '(' + state.errors.length + ' errors, ' + state.network.length + ' failed requests, ' + state.breadcrumbs.length + ' actions)';
    setTimeout(function () { form.title.focus(); }, 0);
  }
  function close() { if (!panel) return; panel.classList.remove('open'); fab.setAttribute('aria-expanded', 'false'); }
  function toggle() { if (panel && panel.classList.contains('open')) close(); else open(); }

  function onSubmit(e) {
    e.preventDefault();
    var btn = form.querySelector('[type=submit]');
    btn.disabled = true; msg.hidden = true;
    submit({ title: form.title.value, description: form.description.value, severity: form.severity.value, email: form.email.value, includeTelemetry: form.includeTelemetry.checked })
      .then(function (res) {
        form.reset();
        form.hidden = true;
        msg.className = 'msg ok'; msg.hidden = false;
        msg.innerHTML = 'Thanks! Your report was sent' + (res.linear ? ' as <a href="' + res.linear.url + '" target="_blank" rel="noopener">' + res.linear.identifier + '</a>' : '') + '. <div class="actions"><button class="btn" type="button">Close</button></div>';
        msg.querySelector('button').addEventListener('click', close);
      })
      .catch(function (err) { msg.className = 'msg err'; msg.hidden = false; msg.textContent = 'Could not send report: ' + err.message; })
      .then(function () { btn.disabled = false; });
  }

  window.Requestor = {
    __installed: true,
    version: VERSION,
    open: open,
    close: close,
    identify: function (user) { state.user = Object.assign({}, state.user, user || {}); },
    setContext: function (ctx) { state.context = Object.assign({}, state.context, ctx || {}); },
    snapshot: snapshot,
    report: submit
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
