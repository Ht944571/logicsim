/* ============================================================================
 * e2e-cdp.js —— 真实浏览器端到端验收
 * ----------------------------------------------------------------------------
 * 通过 Chrome DevTools Protocol 驱动无头 Edge（零依赖：只用 Node 内置 WebSocket）：
 *   A 后缀记法      B 中缀记法      C 两种记法等价    D 视图切换
 *   E 真值表        F 导出 PNG/SVG  G 手动添加与端口校验
 *   H 本机持久化    I 内联报错      J 实时预览       K/L 错误面
 *   M 截图          N 响应式堆叠
 *
 * 前置：Edge 已用 --remote-debugging-port=9333 启动，本地预览服务在 8080。
 * 运行：node tests/e2e-cdp.js [输出目录]
 *       E2E_URL=https://<线上地址>/ node tests/e2e-cdp.js
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const PORT = 9333;
/* 默认测本地预览；用 E2E_URL 指向线上站点可以做同一套验收 */
const TARGET_URL = process.env.E2E_URL || 'http://127.0.0.1:8080/index.html';
const OUTDIR = process.argv[2] || path.join(__dirname, 'artifacts');

class CDP {
    constructor(url) {
        this.ws = new WebSocket(url);
        this.seq = 0;
        this.pending = new Map();
        this.consoleErrors = [];
        this.exceptions = [];
        this.logErrors = [];
    }
    open() {
        return new Promise((resolve, reject) => {
            this.ws.addEventListener('open', () => resolve(), { once: true });
            this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
            this.ws.addEventListener('message', ev => {
                const msg = JSON.parse(ev.data);
                if (msg.id && this.pending.has(msg.id)) {
                    const p = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) { p.reject(new Error(JSON.stringify(msg.error))); }
                    else { p.resolve(msg.result); }
                    return;
                }
                if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
                    this.consoleErrors.push((msg.params.args || []).map(a => a.value || a.description || a.type).join(' '));
                }
                if (msg.method === 'Runtime.exceptionThrown') {
                    const d = msg.params.exceptionDetails || {};
                    this.exceptions.push((d.exception && (d.exception.description || d.exception.value)) || d.text || '未知异常');
                }
                if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
                    this.logErrors.push(msg.params.entry.text);
                }
            });
        });
    }
    send(method, params) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    async evalJS(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression: expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true
        });
        if (r.exceptionDetails) {
            const d = r.exceptionDetails;
            throw new Error('页面内求值异常: ' + ((d.exception && d.exception.description) || d.text));
        }
        return r.result.value;
    }
    async screenshot(file) {
        const r = await this.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true   /* 强制整页重新栅格化，规避合成器滞后 */
        });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return file;
    }
    close() { try { this.ws.close(); } catch (e) { } }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 在页面里执行的验收脚本 */
const HARNESS = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push('window.error: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', e => window.__errs.push('unhandledrejection: ' + e.reason));
  const _ce = console.error;
  console.error = function () { window.__errs.push('console.error: ' + [].join.call(arguments, ' ')); _ce.apply(console, arguments); };

  /* 每次验收都从同一初始状态开始。
     应用本身会把「记法 + 视图 + 工作区」存进 localStorage，上一次运行留下的
     视图模式会让下一次的起始状态不同 —— 这是正确且期望的产品行为，
     但测试必须自己复位，否则用例之间会互相污染。 */
  try { window.localStorage.removeItem('logicsim.workspace.v1'); } catch (e) { }
  appState.viewMode = 'selector';
  appState.inputMode = 'infix';
  appState.lastRpn = '';
  appState.lastModel = null;
  appState.lastGateTree = null;
  appState.lastExpr = '';
  applyViewModeUI();
  applyInputModeUI();
  graph.clear();
  updateCanvasHint();
  await wait(30);

  const $ = id => document.getElementById(id);

  function state() {
    const cellsLayer = $('paper').querySelector('.joint-cells-layer');
    var counts = {};
    graph.getElements().forEach(function (e) {
      var t = e.get('nodeType') || '?';
      counts[t] = (counts[t] || 0) + 1;
    });
    return {
      status: ($('status').textContent || '').trim(),
      statusClass: $('status').className,
      stats: ($('stats').textContent || '').trim(),
      quant: ($('quant-prefix').textContent || '').trim(),
      inlineVisible: !$('inline-error').hidden,
      inlineText: ($('inline-error').textContent || '').trim(),
      nodes: graph.getElements().length,
      links: graph.getLinks().length,
      svgCells: cellsLayer ? cellsLayer.children.length : -1,
      counts: counts,
      model: $('myModel').value,
      truthRows: document.querySelectorAll('#truth-table-wrap tbody tr').length,
      truthTrue: document.querySelectorAll('#truth-table-wrap tbody tr.is-true').length,
      view: appState.viewMode,
      mode: appState.inputMode
    };
  }

  function setMode(m) { if (appState.inputMode !== m) { app.setInputMode(m); } }
  function setView(v) { if (appState.viewMode !== v) { app.setViewMode(v); } }

  function runCase(expr, mode, expect) {
    setMode(mode);
    $('ReversePol').value = expr;
    var threw = null;
    try { app.parseLogic({ force: true }); } catch (e) { threw = e.message; }
    var st = state();
    var isErr = st.statusClass === 'status-error';
    var rendered = (expect === 'error') ? true : (st.nodes > 0 && st.svgCells === st.nodes + st.links);
    return Object.assign({
      expr: expr, mode: mode, expect: expect, threw: threw,
      pass: !threw && ((expect === 'error') === isErr) && rendered
    }, st);
  }

  const report = { cases: [], equivalences: [], views: [], truth: [], exports: [], manual: null, storage: null, responsive: null };

  /* ================= A. 后缀记法 ================= */
  const RPN_CASES = [
    ['a b . fe >', 'ok', '与后推出'],
    ['a b . fe ge > =', 'ok', '4 变量 9 路径'],
    ['a b ,', 'ok', '或'],
    ['a <', 'ok', '非'],
    ['a b =', 'ok', '等价'],
    ['latch', 'ok', '单变量出图'],
    ['1', 'ok', '常量 1'],
    ['0', 'ok', '常量 0'],
    ['a b . a ?', 'ok', '存在量词'],
    ['a b , a !', 'ok', '全称量词'],
    ['a b . z ?', 'ok', '量词绑定未出现变量'],
    ['a b.', 'ok', '操作符紧邻'],
    ['   ', 'error', '纯空白'],
    ['', 'error', '空串'],
    ['a b', 'error', '多余操作数'],
    ['a .', 'error', '操作数不足'],
    ['a b . a b . ?', 'error', '量词绑定目标不是变量名']
  ];
  for (const item of RPN_CASES) {
    report.cases.push(Object.assign(runCase(item[0], 'rpn', item[1]), { note: item[2] }));
  }

  /* ================= B. 中缀记法 ================= */
  const INFIX_CASES = [
    ['a AND b -> fe', 'ok', '最基础的中缀写法'],
    ['a && b || !c', 'ok', '符号写法'],
    ['a ∧ b ∨ ¬c', 'ok', '数学符号'],
    ['(a OR b) AND c', 'ok', '括号'],
    ['NOT a AND b', 'ok', '优先级：非高于与'],
    ['a -> b -> c', 'ok', '推出右结合'],
    ['∀x(a AND b)', 'ok', '全称量词'],
    ['∃x(a OR b)', 'ok', '存在量词'],
    ['ALL x(a) AND EX y(b)', 'ok', '单词写法量词'],
    ['载入位 AND 保持位', 'ok', '中文变量名'],
    ['a AND', 'error', '运算符后缺操作数'],
    ['(a AND b', 'error', '缺右括号'],
    ['a AND b)', 'error', '多右括号'],
    ['∀x a', 'error', '量词作用范围未界定'],
    ['a @ b', 'error', '非法字符'],
    ['', 'error', '空输入']
  ];
  for (const item of INFIX_CASES) {
    report.cases.push(Object.assign(runCase(item[0], 'infix', item[1]), { note: item[2] }));
  }

  /* ================= C. 两种记法必须等价 ================= */
  const PAIRS = [
    ['a b . fe >', 'a AND b -> fe'],
    ['a b , c .', '(a OR b) AND c'],
    ['a b c < . ,', 'a OR b AND NOT c'],
    ['a b . a ? c ,', '∃a(a AND b) OR c'],
    ['a b , a !', '∀a(a OR b)'],
    ['a b . fe ge > =', 'a AND b <-> fe -> ge']
  ];
  for (const pair of PAIRS) {
    const a = runCase(pair[0], 'rpn', 'ok');
    const b = runCase(pair[1], 'infix', 'ok');
    let same = false;
    try {
      const aTypes = JSON.stringify(JSON.parse(a.model).nodeArray.map(n => n.type + ':' + n.name).sort());
      const bTypes = JSON.stringify(JSON.parse(b.model).nodeArray.map(n => n.type + ':' + n.name).sort());
      same = aTypes === bTypes && a.nodes === b.nodes && a.links === b.links;
    } catch (e) { same = false; }
    report.equivalences.push({
      rpn: pair[0], infix: pair[1], same: same,
      rpnNodes: a.nodes, infixNodes: b.nodes, rpnLinks: a.links, infixLinks: b.links,
      pass: same
    });
  }

  /* ================= D. 视图切换 ================= */
  setMode('infix');
  $('ReversePol').value = '(a AND b) -> fe';
  app.parseLogic({ force: true });
  await wait(20);
  const selView = state();
  setView('gate');
  await wait(20);
  const gateView = state();
  setView('selector');
  await wait(20);
  const backView = state();
  report.views.push({ name: '选择器视图', nodes: selView.nodes, counts: selView.counts, selPresent: (selView.counts.SEL || 0) > 0, gatePresent: (selView.counts.AND || 0) > 0 });
  report.views.push({ name: '逻辑门视图', nodes: gateView.nodes, counts: gateView.counts, selPresent: (gateView.counts.SEL || 0) > 0, gatePresent: (gateView.counts.AND || 0) > 0 });
  report.views.push({ name: '切回选择器', nodes: backView.nodes, counts: backView.counts, selPresent: (backView.counts.SEL || 0) > 0, gatePresent: (backView.counts.AND || 0) > 0 });

  /* 带量词的表达式切到门视图，必须有量词盒 */
  setMode('infix');
  $('ReversePol').value = '∀a(a OR b)';
  app.parseLogic({ force: true });
  setView('gate');
  await wait(20);
  const qGate = state();
  report.views.push({ name: '门视图(含量词)', nodes: qGate.nodes, counts: qGate.counts, selPresent: false, gatePresent: (qGate.counts.FORALL || 0) > 0 });
  setView('selector');
  await wait(20);

  /* ================= E. 真值表 ================= */
  app.setTab('truth');
  const TRUTH_CASES = [
    ['a b .', 4, 1, '与：4 行 1 真'],
    ['a b ,', 4, 3, '或：4 行 3 真'],
    ['a <', 2, 1, '非：2 行 1 真'],
    ['a b =', 4, 2, '等价：4 行 2 真'],
    ['a b . fe ge > =', 16, 6, '4 变量：16 行 6 真（注意不是路径数 9）'],
    ['a b > a b > =', 1, 1, '恒真式：1 行且为真'],
    ['a b . a !', 1, 0, '恒假式：1 行且为假'],
    ['a b , a !', 2, 1, '量词化简后：2 行 1 真']
  ];
  for (const item of TRUTH_CASES) {
    const r = runCase(item[0], 'rpn', 'ok');
    report.truth.push({
      expr: item[0], note: item[3],
      rows: r.truthRows, trues: r.truthTrue, expectRows: item[1], expectTrues: item[2],
      pass: r.truthRows === item[1] && r.truthTrue === item[2]
    });
  }

  /* ================= F. 导出 SVG / PNG ================= */
  window.__downloads = [];
  const _createURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    window.__downloads.push(blob);
    return _createURL(new Blob(['x'], { type: 'text/plain' }));
  };
  const _click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { /* 无头环境不真的触发下载 */ };

  setMode('infix');
  $('ReversePol').value = '(a AND b) -> fe';
  app.parseLogic({ force: true });
  await wait(40);

  /* 导出是异步的（要把图标 fetch 回来内联成 data URI，PNG 还要过一遍 canvas），
     固定 sleep 在线上会因为网络延迟而抓不到 —— 改成轮询等待下载出现。 */
  async function waitForDownload(timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (window.__downloads.length) { return window.__downloads[0]; }
      await wait(50);
    }
    return null;
  }

  let svgThrew = null, pngThrew = null;
  window.__downloads = [];
  try { app.exportSVG(); } catch (e) { svgThrew = e.message; }
  const svgBlob = await waitForDownload(8000);

  window.__downloads = [];
  try { app.exportPNG(); } catch (e) { pngThrew = e.message; }
  const pngBlob = await waitForDownload(12000);

  HTMLAnchorElement.prototype.click = _click;

  report.exports.push({
    kind: 'SVG', threw: svgThrew, size: svgBlob ? svgBlob.size : 0, type: svgBlob ? svgBlob.type : '',
    pass: !svgThrew && !!svgBlob && svgBlob.size > 800 && /svg/.test(svgBlob.type)
  });
  report.exports.push({
    kind: 'PNG', threw: pngThrew, size: pngBlob ? pngBlob.size : 0, type: pngBlob ? pngBlob.type : '',
    pass: !pngThrew && !!pngBlob && pngBlob.size > 2000 && /png/.test(pngBlob.type)
  });
  report.exports.push({
    kind: '画布内容', threw: null, size: 0, type: '',
    pass: (function () {
      var svg = document.querySelector('#paper svg');
      if (!svg) { return false; }
      return svg.querySelectorAll('image').length > 0
        && svg.querySelectorAll('text').length > 0
        && (svg.querySelectorAll('path').length + svg.querySelectorAll('rect').length) > 0;
    })()
  });

  /* ================= G. 手动添加节点与端口校验 ================= */
  setMode('infix');
  $('ReversePol').value = '';
  app.parseLogic({ force: true });
  graph.clear();
  updateCanvasHint();
  await wait(20);

  let before = graph.getElements().length;
  app.addNode('AND');
  const andAdded = graph.getElements().length === before + 1;
  const andKey = graph.getElements()[graph.getElements().length - 1].id;
  before = graph.getElements().length;
  app.addNode('VAR');
  const varOk = graph.getElements().length === before + 1;
  const varKey = graph.getElements()[graph.getElements().length - 1].id;
  before = graph.getElements().length;
  app.addNode('NOT');
  const notOk = graph.getElements().length === before + 1;

  const andModel = graph.getCell(andKey);
  const varModel = graph.getCell(varKey);
  const portMeta = {
    varOut: app.portGroup(varModel, 'OUT'),
    andA: app.portGroup(andModel, 'A'),
    andB: app.portGroup(andModel, 'B'),
    andOut: app.portGroup(andModel, 'OUT')
  };

  const vv = varModel.findView(paper), va = andModel.findView(paper);
  const magnetOf = function (view, pid) {
    const ports = view.el.querySelectorAll('[port]');
    for (let i = 0; i < ports.length; i++) {
      if (ports[i].getAttribute('port') === pid) { return ports[i]; }
    }
    return null;
  };
  const mv = magnetOf(vv, 'OUT'), ma = magnetOf(va, 'A'), mao = magnetOf(va, 'OUT');
  let vcOk = null, vcSelf = null, vcReverse = null;
  try {
    vcOk = !!app.validateConnection(vv, mv, va, ma);
    vcSelf = !!app.validateConnection(va, mao, va, ma);
    vcReverse = !!app.validateConnection(va, mao, vv, mv);
  } catch (e) { vcOk = 'throw:' + e.message; }

  report.manual = {
    andAdded: andAdded, varOk: varOk, notOk: notOk,
    cellCount: graph.getElements().length,
    portMeta: portMeta,
    magnetFound: !!mv && !!ma && !!mao,
    vcOk: vcOk, vcSelf: vcSelf, vcReverse: vcReverse,
    pass: andAdded && varOk && notOk
      && portMeta.varOut === 'out' && portMeta.andA === 'in' && portMeta.andB === 'in' && portMeta.andOut === 'out'
      && vcOk === true && vcSelf === false && vcReverse === false
  };

  /* ================= H. 本机持久化 ================= */
  var storageResult = { wrote: false, restored: false, expr: '', mode: '' };
  try {
    setMode('infix');
    $('ReversePol').value = 'p AND q -> r';
    app.parseLogic({ force: true });
    var raw = window.localStorage.getItem('logicsim.workspace.v1');
    storageResult.wrote = !!raw;
    if (raw) {
      var saved = JSON.parse(raw);
      storageResult.savedExpr = saved.expr;
      storageResult.savedMode = saved.inputMode;
      storageResult.hasModel = !!(saved.model && saved.model.nodeArray && saved.model.nodeArray.length);
    }
    /* 清空内存状态后再恢复，验证真的读得回来 */
    $('ReversePol').value = '';
    appState.lastRpn = '';
    appState.lastModel = null;
    appState.lastExpr = '';
    graph.clear();
    var restored = restoreWorkspace();
    await wait(30);
    var stR = state();
    storageResult.restored = !!restored;
    storageResult.expr = $('ReversePol').value;
    storageResult.mode = appState.inputMode;
    storageResult.nodes = stR.nodes;
    storageResult.pass = storageResult.wrote && storageResult.restored
      && storageResult.expr === 'p AND q -> r' && stR.nodes > 0;
  } catch (e) {
    storageResult.pass = false;
    storageResult.error = e.message;
  }
  report.storage = storageResult;

  let clearThrew = null;
  try { app.clearStorage(); } catch (e) { clearThrew = e.message; }
  report.storage.clearThrew = clearThrew;

  /* ================= I. 内联报错 ================= */
  setMode('infix');
  $('ReversePol').value = 'a AND b)';
  app.parseLogic({ force: true });
  await wait(20);
  const inline = state();
  report.inlineError = {
    visible: inline.inlineVisible,
    text: inline.inlineText.slice(0, 140),
    hasCaret: inline.inlineText.indexOf('^') >= 0,
    inputMarked: $('ReversePol').classList.contains('is-invalid'),
    statusClass: inline.statusClass,
    pass: inline.inlineVisible && inline.inlineText.length > 0 && inline.statusClass === 'status-error'
  };
  $('ReversePol').value = 'a AND b';
  app.parseLogic({ force: true });
  await wait(20);
  report.inlineError.clearedAfterFix = !$('inline-error').hidden ? false : !$('ReversePol').classList.contains('is-invalid');

  /* ================= J. 实时预览 ================= */
  const ta = $('ReversePol');
  ta.value = '';
  app.parseLogic({ force: true });
  graph.clear();
  const beforePreview = graph.getElements().length;
  ta.value = 'u AND v';
  ta.dispatchEvent(new Event('input', { bubbles: true }));   /* 只打字，不点按钮 */
  await wait(800);
  const afterPreview = graph.getElements().length;

  const beforeBad = graph.getElements().length;
  ta.value = 'u AND v AND';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(800);
  const afterBad = state();

  report.preview = {
    before: beforePreview, after: afterPreview,
    keptOnError: afterBad.nodes === beforeBad && afterBad.nodes > 0,
    pass: beforePreview === 0 && afterPreview > 0 && afterBad.nodes === beforeBad && afterBad.nodes > 0
  };

  report.errs = window.__errs;

  /* 回到一个好看的桌面状态用于截图 */
  setMode('infix');
  $('ReversePol').value = '(a AND b) -> fe';
  app.parseLogic({ force: true });
  setView('gate');
  app.setTab('truth');
  await wait(300);

  return report;
})()`;

(async () => {
    fs.mkdirSync(OUTDIR, { recursive: true });

    const listRes = await fetch(`http://127.0.0.1:${PORT}/json`);
    const targets = await listRes.json();
    /* 优先挑一个"普通网页"类型的 target。
       刚启动的浏览器可能只有一个 edge:// 之类的特殊页，那种 target 会拒绝
       Emulation.setDeviceMetricsOverride（报 "Target does not support metrics override"）。 */
    const page = targets.find(t => t.type === 'page' && !/^(edge|chrome|devtools|about):/.test(t.url))
        || targets.find(t => t.type === 'page');
    if (!page) { throw new Error('未找到可用的浏览器页面 target，请确认 Edge 已用 --remote-debugging-port 启动'); }

    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');

    console.log('>> 载入 ' + TARGET_URL);
    await cdp.send('Page.navigate', { url: TARGET_URL });
    await sleep(2600);

    /* 视口必须在导航【之后】设置：导航前 target 可能还是特殊页，会拒绝 metrics override */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
    });
    await sleep(400);

    console.log('>> 执行验收脚本\n');
    const report = await cdp.evalJS(HARNESS);

    let pass = 0, fail = 0;
    const tally = (ok) => { if (ok) { pass++; } else { fail++; } };

    console.log('=== A/B. 功能用例（后缀 + 中缀） ===');
    for (const c of report.cases) {
        tally(c.pass);
        console.log(`  ${c.pass ? '[通过]' : '[失败]'} ${c.mode.padEnd(5)} ${JSON.stringify(c.expr).padEnd(22)} ${String(c.expect).padEnd(5)} 节点=${String(c.nodes).padStart(2)} 连线=${String(c.links).padStart(2)}  ${c.note}`);
        if (!c.pass) { console.log(`         状态: ${c.status}${c.threw ? '  << 抛异常: ' + c.threw : ''}`); }
    }

    console.log('\n=== C. 两种记法等价 ===');
    for (const e of report.equivalences) {
        tally(e.pass);
        console.log(`  ${e.pass ? '[等价]' : '[不等价]'} 后缀 ${JSON.stringify(e.rpn).padEnd(20)} ≡ 中缀 ${JSON.stringify(e.infix).padEnd(28)} 节点 ${e.rpnNodes}/${e.infixNodes} 连线 ${e.rpnLinks}/${e.infixLinks}`);
    }

    console.log('\n=== D. 视图切换 ===');
    for (const v of report.views) {
        const wantGate = v.name.indexOf('门') >= 0;
        const ok = wantGate ? (v.selPresent === false && v.gatePresent === true) : (v.selPresent === true);
        tally(ok);
        console.log(`  ${ok ? '[通过]' : '[失败]'} ${v.name.padEnd(16)} 节点=${String(v.nodes).padStart(2)}  含SEL=${v.selPresent}  含门/量词盒=${v.gatePresent}  分布=${JSON.stringify(v.counts)}`);
    }

    console.log('\n=== E. 真值表 ===');
    for (const t of report.truth) {
        tally(t.pass);
        console.log(`  ${t.pass ? '[通过]' : '[失败]'} ${t.expr.padEnd(18)} 行数 ${String(t.rows).padStart(3)}/${String(t.expectRows).padStart(3)}  真值数 ${String(t.trues).padStart(2)}/${String(t.expectTrues).padStart(2)}   ${t.note}`);
    }

    console.log('\n=== F. 导出 SVG / PNG ===');
    for (const e of report.exports) {
        tally(e.pass);
        console.log(`  ${e.pass ? '[通过]' : '[失败]'} ${e.kind.padEnd(10)} 大小=${String(e.size).padStart(7)} 类型=${e.type || '-'}${e.threw ? '  << ' + e.threw : ''}`);
    }

    console.log('\n=== G. 手动添加节点与端口校验 ===');
    const m = report.manual;
    tally(m.pass);
    console.log(`  添加 与门=${m.andAdded} 变量=${m.varOk} 非门=${m.notOk}  画布元素数=${m.cellCount}`);
    console.log(`  端口分组: 变量OUT=${m.portMeta.varOut}  与门A=${m.portMeta.andA}  与门B=${m.portMeta.andB}  与门OUT=${m.portMeta.andOut}`);
    console.log(`  端口元素可定位=${m.magnetFound}  合法连线(输出→输入)=${m.vcOk}  同节点=${m.vcSelf}  反向=${m.vcReverse}`);

    console.log('\n=== H. 本机持久化 ===');
    const s = report.storage;
    tally(s.pass);
    console.log(`  写入存档=${s.wrote}  恢复=${s.restored}  表达式="${s.expr}"  记法=${s.mode}  恢复后节点=${s.nodes}`);
    console.log(`  清除存档无异常=${!s.clearThrew}${s.error ? '  错误: ' + s.error : ''}`);

    console.log('\n=== I. 内联报错 ===');
    const ie = report.inlineError;
    tally(ie.pass && ie.clearedAfterFix);
    console.log(`  显示=${ie.visible}  含指位符=${ie.hasCaret}  输入框标红=${ie.inputMarked}  状态栏=${ie.statusClass}`);
    console.log(`  提示内容: ${ie.text.replace(/\n/g, ' ⏎ ')}`);
    console.log(`  修正后自动收起=${ie.clearedAfterFix}`);

    console.log('\n=== J. 实时预览（打字即出图） ===');
    tally(report.preview.pass);
    console.log(`  打字前节点=${report.preview.before}  打字后节点=${report.preview.after}  中间态保留旧图=${report.preview.keptOnError}`);

    console.log('\n=== K. 页面内未捕获错误 ===');
    if (report.errs.length === 0) { console.log('  （无）'); tally(true); }
    else { report.errs.forEach(e => console.log('  ' + e)); tally(false); }

    console.log('\n=== L. 浏览器级控制台错误 ===');
    const logs = [].concat(
        cdp.exceptions.map(e => 'exception: ' + e),
        cdp.consoleErrors.map(e => 'console.error: ' + e),
        cdp.logErrors.map(e => 'log: ' + e));
    if (logs.length === 0) { console.log('  （无）'); tally(true); }
    else { logs.forEach(e => console.log('  ' + e)); tally(false); }

    /* ---------- 截图：独立布置画面 + 等合成帧 + 丢弃预热帧 ---------- */
    console.log('\n=== M. 截图 ===');
    const VW = 1600, VH = 1000;
    const setup = async (expr, view, tab, settleMs) => {
        await cdp.evalJS(`(async () => {
          app.setInputMode('infix');
          document.getElementById('ReversePol').value = ${JSON.stringify(expr)};
          app.parseLogic({ force: true });
          app.setViewMode(${JSON.stringify(view)});
          app.setTab(${JSON.stringify(tab)});
          await new Promise(r => setTimeout(r, 400));
          return true;
        })()`);
        await sleep(250);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH + 1, deviceScaleFactor: 1, mobile: false });
        await sleep(250);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
        await sleep(settleMs || 500);
    };
    const snap = async (file) => {
        await cdp.screenshot(path.join(OUTDIR, '.warmup.png'));
        await sleep(400);
        await cdp.screenshot(file);
    };

    await setup('(a AND b) -> fe', 'gate', 'truth', 1400);
    const shotGate = path.join(OUTDIR, 'e2e-gate-view.png');
    await snap(shotGate);
    console.log('  ' + shotGate);

    await setup('(a AND b) -> fe', 'selector', 'model', 1400);
    const shotSel = path.join(OUTDIR, 'e2e-selector-view.png');
    await snap(shotSel);
    console.log('  ' + shotSel);

    /* ---------- 响应式 ---------- */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 720, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const narrow = await cdp.evalJS(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let threw = null;
      try { app.ResizeBlock(); relayout(); } catch (e) { threw = e.message; }
      await wait(320);
      const mc = document.querySelector('.main-container').getBoundingClientRect();
      const rc = document.querySelector('.right-container').getBoundingClientRect();
      const pc = document.getElementById('paper-container').getBoundingClientRect();
      /* 画布容器按设计【大于】可视区域（平移机制的基础），
         所以正确的不变量是「可视容器中心落在画布矩形内」 */
      const cx = mc.left + mc.width / 2, cy = mc.top + mc.height / 2;
      return {
        threw: threw,
        isNarrow: window.matchMedia('(max-width: 900px)').matches,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        main: Math.round(mc.width) + 'x' + Math.round(mc.height) + ' @' + Math.round(mc.left) + ',' + Math.round(mc.top),
        right: Math.round(rc.width) + 'x' + Math.round(rc.height) + ' @' + Math.round(rc.left) + ',' + Math.round(rc.top),
        centered: cx >= pc.left && cx <= pc.right && cy >= pc.top && cy <= pc.bottom,
        stacked: rc.top >= mc.bottom - 2,
        minimapHidden: getComputedStyle(document.querySelector('.mini-map')).display === 'none'
      };
    })()`);
    report.responsive = narrow;
    tally(narrow.isNarrow && narrow.centered && narrow.stacked && !narrow.threw);
    console.log('\n=== N. 响应式堆叠 ===');
    console.log(`  窄屏(${narrow.viewport}) 断点命中=${narrow.isNarrow} 画布 ${narrow.main} 面板 ${narrow.right}`);
    console.log(`  上下堆叠=${narrow.stacked} 画布居中=${narrow.centered} 小地图隐藏=${narrow.minimapHidden} 重排=${narrow.threw ? '抛异常 ' + narrow.threw : '正常'}`);
    const shotNarrow = path.join(OUTDIR, 'e2e-narrow.png');
    await snap(shotNarrow);
    console.log('  ' + shotNarrow);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const backWide = await cdp.evalJS(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let threw = null;
      try { relayout(); } catch (e) { threw = e.message; }
      await wait(320);
      const mc = document.querySelector('.main-container').getBoundingClientRect();
      const rc = document.querySelector('.right-container').getBoundingClientRect();
      const pc = document.getElementById('paper-container').getBoundingClientRect();
      const cx = mc.left + mc.width / 2, cy = mc.top + mc.height / 2;
      return {
        threw: threw,
        centered: cx >= pc.left && cx <= pc.right && cy >= pc.top && cy <= pc.bottom,
        sideBySide: rc.left >= mc.right - 2
      };
    })()`);
    tally(backWide.centered && backWide.sideBySide && !backWide.threw);
    console.log(`  切回宽屏: 画布居中=${backWide.centered} 面板回到右侧=${backWide.sideBySide} 重排=${backWide.threw ? '抛异常 ' + backWide.threw : '正常'}`);

    console.log(`\n=== 汇总：通过 ${pass} · 失败 ${fail} ===`);
    fs.writeFileSync(path.join(OUTDIR, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.log('  完整报告: ' + path.join(OUTDIR, 'e2e-report.json'));

    cdp.close();
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('验收脚本失败: ' + e.message);
    process.exit(2);
});
