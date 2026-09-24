/* ============================================================================
 * e2e-cdp.js —— 真实浏览器端到端验收
 * ----------------------------------------------------------------------------
 * 通过 Chrome DevTools Protocol 驱动无头 Edge，做四件事：
 *   1. 真正加载页面，捕获所有 JS 异常与 console.error
 *   2. 逐个跑测试向量：填表达式 -> 解析 -> 读回状态/统计/量词前缀/图形节点数
 *   3. 验证双向转换（解析 -> 图转文本 -> 文本转图）与异常输入的健壮性
 *   4. 截图（桌面宽屏 + 窄屏堆叠），产出可肉眼复核的 PNG
 *
 * 前置：Edge 已用 --remote-debugging-port=9333 启动，本地预览服务在 8080。
 * 运行：node tests/e2e-cdp.js <输出目录>
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');

const PORT = 9333;
const TARGET_URL = 'http://127.0.0.1:8080/index.html';
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
            this.ws.addEventListener('error', e => reject(new Error('WebSocket 连接失败')), { once: true });
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

/* 在页面里执行的验收脚本。返回结构化报告。 */
const HARNESS = `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));

  /* 装上错误探针，任何未捕获异常都会被记录 */
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push('window.error: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', e => window.__errs.push('unhandledrejection: ' + e.reason));
  const _ce = console.error;
  console.error = function () { window.__errs.push('console.error: ' + [].join.call(arguments, ' ')); _ce.apply(console, arguments); };

  const $ = id => document.getElementById(id);
  const paperEl = $('paper');

  /* 计数用 graph 里的真实对象，而不是靠 DOM 类名猜。
     同时读一遍已渲染单元格的数量，确保「模型有」且「画面也有」。
     早期版本用 #paper .element 选择器统计，恒为 0，
     会让往返比对退化成 0==0 的假通过。 */
  function state() {
    const cellsLayer = paperEl.querySelector('.joint-cells-layer');
    return {
      status: ($('status').textContent || '').trim(),
      statusClass: $('status').className,
      stats: ($('stats').textContent || '').trim(),
      quant: ($('quant-prefix').textContent || '').trim(),
      nodes: graph.getElements().length,
      links: graph.getLinks().length,
      svgCells: cellsLayer ? cellsLayer.children.length : -1,
      model: $('myModel').value
    };
  }

  const report = { cases: [], roundTrip: null, rename: null, narrow: null, bootErrors: [] };

  /* ---------- 用例 ---------- */
  const cases = [
    { expr: 'a b . fe >',        expect: 'ok',    note: '原有功能：推出' },
    { expr: 'a b . fe ge > =',   expect: 'ok',    note: '原有功能：4 变量 9 路径' },
    { expr: 'a b ,',             expect: 'ok',    note: '原有功能：或' },
    { expr: 'a <',               expect: 'ok',    note: '原有功能：非' },
    { expr: 'a b =',             expect: 'ok',    note: '原有功能：等价' },
    { expr: 'latch',             expect: 'ok',    note: '单变量出图（改造前会误判为错误）' },
    { expr: '1',                 expect: 'ok',    note: '常量 1（改造前误判为错误）' },
    { expr: '0',                 expect: 'ok',    note: '常量 0（改造前误判为错误）' },
    { expr: 'a b . a ?',         expect: 'ok',    note: '量词：存在量词化简' },
    { expr: 'a b , a !',         expect: 'ok',    note: '量词：全称量词化简' },
    { expr: 'a b . z ?',         expect: 'ok',    note: '量词：绑定未出现变量（恒等）' },
    { expr: 'a b .',             expect: 'ok',    note: '无空格紧邻操作符' },
    { expr: '   ',               expect: 'error', note: '异常输入：纯空白（改造前会崩溃）' },
    { expr: '',                  expect: 'error', note: '异常输入：空串' },
    { expr: 'a b',               expect: 'error', note: '异常输入：多余操作数' },
    { expr: 'a .',               expect: 'error', note: '异常输入：操作数不足' },
    { expr: 'a b . a b . ?',     expect: 'error', note: '异常输入：量词绑定目标不是变量名' }
  ];

  for (const c of cases) {
    $('ReversePol').value = c.expr;
    let threw = null;
    try { app.parseLogic(); } catch (e) { threw = e.message; }
    await wait(16);
    const st = state();
    const isErr = st.statusClass === 'status-error';
    /* 成功用例还必须真的出图：模型里有对象，且已渲染到 SVG */
    const rendered = (c.expect === 'error') ? true : (st.nodes > 0 && st.svgCells === st.nodes + st.links);
    const pass = !threw && ((c.expect === 'error') === isErr) && rendered;
    report.cases.push({
      expr: c.expr, note: c.note, expect: c.expect,
      status: st.status.slice(0, 60), statusClass: st.statusClass,
      stats: st.stats, quant: st.quant,
      nodes: st.nodes, links: st.links, svgCells: st.svgCells,
      rendered: rendered, threw: threw, pass: pass
    });
    if (c.expr === 'a b . fe >') { report.modelSample = st.model; }
  }

  /* ---------- 双向转换往返 ---------- */
  $('ReversePol').value = 'a b . fe >';
  app.parseLogic();
  await wait(16);
  const before = state();
  app.save();
  await wait(16);
  const savedJson = $('myModel').value;
  app.load();
  await wait(16);
  const after = state();
  report.roundTrip = {
    beforeNodes: before.nodes, beforeLinks: before.links,
    afterNodes: after.nodes, afterLinks: after.links,
    same: before.nodes > 0 && before.links > 0 && before.nodes === after.nodes && before.links === after.links,
    linkCountInJson: (JSON.parse(savedJson).linkArray || []).length,
    nodeCountInJson: (JSON.parse(savedJson).nodeArray || []).length
  };

  /* ---------- 量词前缀往返（顶层可选字段） ---------- */
  $('ReversePol').value = 'a b , a !';
  app.parseLogic();
  await wait(16);
  const qBefore = state().quant;
  app.save();
  await wait(16);
  const qJson = $('myModel').value;
  const parsedQ = JSON.parse(qJson);
  app.load();
  await wait(16);
  report.quantRoundTrip = {
    before: qBefore, after: state().quant,
    hasTopField: !!parsedQ.quantPrefix,
    quantPrefix: parsedQ.quantPrefix || null,
    nodeHasQuant: (parsedQ.nodeArray || []).some(n => n.quant),
    same: qBefore === state().quant
  };

  /* ---------- 改名健壮性（未选中元素时不应抛异常） ---------- */
  ERKeyNow = undefined;
  let renameThrew = null;
  try { app.ChangeName(); } catch (e) { renameThrew = e.message; }
  report.rename = { threw: renameThrew, status: state().status.slice(0, 40), statusClass: state().statusClass };

  /* ---------- 旧格式 JSON 兼容（无 nodeType 属性） ---------- */
  const legacy = {
    nodeArray: [
      { key: '0', type: '0', name: 'Zero' },
      { key: 1, type: '1', name: 'One' },
      { key: 2, type: 'Export', name: 'Out' },
      { key: 'a', type: 'Import', name: 'a' }
    ],
    linkArray: [{ from: 'a', frompid: 'OUT', to: 2, topid: 'OUT' }]
  };
  $('myModel').value = JSON.stringify(legacy);
  app.load();
  await wait(16);
  const legacyState = state();
  app.save();
  await wait(16);
  report.legacyJson = {
    nodes: legacyState.nodes, links: legacyState.links,
    statusClass: legacyState.statusClass,
    dumped: $('myModel').value
  };

  /* ---------- 坏 JSON 兜底 ---------- */
  $('myModel').value = '{ 这不是 JSON';
  let badThrew = null;
  try { app.load(); } catch (e) { badThrew = e.message; }
  await wait(16);
  report.badJson = { threw: badThrew, statusClass: state().statusClass, nodes: state().nodes };

  /* ---------- 回到一个好看的状态用于截图 ---------- */
  $('ReversePol').value = 'a b . fe > =';
  app.parseLogic();
  await wait(200);

  report.errs = window.__errs;
  return report;
})()`;

(async () => {
    fs.mkdirSync(OUTDIR, { recursive: true });

    /* 找到页面 target */
    const listRes = await fetch(`http://127.0.0.1:${PORT}/json`);
    const targets = await listRes.json();
    const page = targets.find(t => t.type === 'page');
    if (!page) { throw new Error('未找到可用的浏览器页面 target，请确认 Edge 已用 --remote-debugging-port 启动'); }

    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false
    });

    console.log('>> 载入 ' + TARGET_URL);
    await cdp.send('Page.navigate', { url: TARGET_URL });
    await sleep(2500);

    console.log('>> 执行验收脚本\n');
    const report = await cdp.evalJS(HARNESS);

    /* ---------- 输出 ---------- */
    let pass = 0, fail = 0;
    console.log('=== A. 功能用例 ===');
    for (const c of report.cases) {
        if (c.pass) { pass++; } else { fail++; }
        console.log(`  ${c.pass ? '[通过]' : '[失败]'} ${JSON.stringify(c.expr).padEnd(16)} ${String(c.expect).padEnd(5)} 节点=${String(c.nodes).padStart(2)} 连线=${String(c.links).padStart(2)} SVG=${String(c.svgCells).padStart(2)} 统计="${c.stats}" 量词="${c.quant}"`);
        console.log(`          ${c.note}`);
        console.log(`          状态: ${c.status}${c.threw ? '  << 抛异常: ' + c.threw : ''}${c.rendered ? '' : '  << 未出图'}`);
    }

    console.log('\n=== B. 双向转换往返 ===');
    const rt = report.roundTrip;
    console.log(`  解析后 节点=${rt.beforeNodes} 连线=${rt.beforeLinks}  ->  图转文本 -> 文本转图  ->  节点=${rt.afterNodes} 连线=${rt.afterLinks}   ${rt.same ? '一致' : '不一致'}`);
    console.log(`  JSON 中 nodeArray=${rt.nodeCountInJson} linkArray=${rt.linkCountInJson}`);
    if (!rt.same) { fail++; } else { pass++; }

    console.log('\n=== C. 量词前缀往返 ===');
    const q = report.quantRoundTrip;
    console.log(`  解析后前缀="${q.before}"  载入后前缀="${q.after}"   ${q.same ? '一致' : '不一致'}`);
    console.log(`  JSON 顶层 quantPrefix=${JSON.stringify(q.quantPrefix)}  节点级 quant 字段=${q.nodeHasQuant ? '有（不应出现）' : '无（正确）'}`);
    if (!q.same || q.nodeHasQuant) { fail++; } else { pass++; }

    console.log('\n=== D. 健壮性 ===');
    console.log(`  未选中元素时改名: ${report.rename.threw ? '抛异常 ' + report.rename.threw : '未抛异常'} · 状态="${report.rename.status}" (${report.rename.statusClass})`);
    if (report.rename.threw) { fail++; } else { pass++; }
    console.log(`  旧格式 JSON（无 nodeType）载入: 节点=${report.legacyJson.nodes} 连线=${report.legacyJson.links} (${report.legacyJson.statusClass})`);
    if (report.legacyJson.nodes !== 4 || report.legacyJson.links !== 1) { console.log('  << 旧格式兼容失败：应为 4 节点 1 连线'); fail++; } else { pass++; }
    console.log(`  坏 JSON 兜底: ${report.badJson.threw ? '抛异常 ' + report.badJson.threw : '未抛异常'} (${report.badJson.statusClass})`);
    if (report.badJson.threw) { fail++; } else { pass++; }

    console.log('\n=== E. 页面内未捕获错误 ===');
    if (report.errs.length === 0) { console.log('  （无）'); pass++; }
    else { report.errs.forEach(e => console.log('  ' + e)); fail++; }

    console.log('\n=== F. 浏览器级控制台错误 ===');
    const allLogs = [].concat(cdp.exceptions.map(e => 'exception: ' + e), cdp.consoleErrors.map(e => 'console.error: ' + e), cdp.logErrors.map(e => 'log: ' + e));
    if (allLogs.length === 0) { console.log('  （无）'); pass++; }
    else { allLogs.forEach(e => console.log('  ' + e)); fail++; }

    /* ---------- 截图 ----------
       注意：必须在独立的一次求值里布置好画面，再在 CDP 层等待若干个合成帧，
       否则 headless 下 captureScreenshot 会抓到过期的合成结果
       （表现为输入框是新状态、画布与状态栏还是旧状态）。 */
    console.log('\n=== G. 截图 ===');

    const VW = 1600, VH = 1000;

    /* headless 下 compositor 会滞后一帧：首次 captureScreenshot 常常拿到上一次
       合成结果（表现为输入框已更新、画布和状态栏还是旧的）。
       对策两步走：① 轻微改动视口尺寸强制整表面重新合成；
                  ② 先丢一帧预热，再截真正要留的那张。 */
    const setup = async (expr, settleMs) => {
        const settle = settleMs || 450;
        await cdp.evalJS(`(async () => {
          document.getElementById('ReversePol').value = ${JSON.stringify(expr)};
          app.parseLogic();
          await new Promise(r => setTimeout(r, 400));
          return true;
        })()`);
        await sleep(250);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH + 1, deviceScaleFactor: 1, mobile: false });
        await sleep(250);
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
        await sleep(settle);
    };

    const snap = async (file) => {
        await cdp.screenshot(path.join(OUTDIR, '.warmup.png'));
        await sleep(400);
        await cdp.screenshot(file);
    };

    /* 量词用例：同时展示前缀条与化简结果，信息量最大，先拍这张 */
    await setup('a b . a ? c ,');
    const shotQuant = path.join(OUTDIR, 'e2e-quantifier.png');
    await snap(shotQuant);
    console.log('  ' + shotQuant);

    /* 窄屏：验证响应式堆叠与重排不报错 */
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
      /* 注意 #paper-container 按设计【大于】可视容器 —— 这是平移机制的基础，
         所以不能断言它「在容器内」。正确的不变量是：可视容器的中心点
         落在画布矩形之内，即画布相对容器居中。 */
      const cx = mc.left + mc.width / 2, cy = mc.top + mc.height / 2;
      const centered = cx >= pc.left && cx <= pc.right && cy >= pc.top && cy <= pc.bottom;
      return {
        threw: threw,
        isNarrow: window.matchMedia('(max-width: 900px)').matches,
        viewport: window.innerWidth + 'x' + window.innerHeight,
        main: Math.round(mc.width) + 'x' + Math.round(mc.height) + ' @' + Math.round(mc.left) + ',' + Math.round(mc.top),
        right: Math.round(rc.width) + 'x' + Math.round(rc.height) + ' @' + Math.round(rc.left) + ',' + Math.round(rc.top),
        paper: Math.round(pc.width) + 'x' + Math.round(pc.height),
        minimapHidden: getComputedStyle(document.querySelector('.mini-map')).display === 'none',
        resizeHidden: getComputedStyle(document.getElementById('app-resize')).display === 'none',
        centered: centered,
        stacked: rc.top >= mc.bottom - 2
      };
    })()`);
    report.narrow = narrow;
    console.log(`  窄屏(${narrow.viewport}) 断点命中=${narrow.isNarrow}`);
    console.log(`    画布容器 ${narrow.main}  右侧面板 ${narrow.right}  画布矩形 ${narrow.paper}`);
    console.log(`    小地图隐藏=${narrow.minimapHidden}  拖拽条隐藏=${narrow.resizeHidden}`);
    console.log(`    上下堆叠(面板在画布下方)=${narrow.stacked}  画布居中对齐=${narrow.centered}  重排调用=${narrow.threw ? '抛异常 ' + narrow.threw : '正常'}`);
    if (narrow.threw || !narrow.isNarrow || !narrow.centered || !narrow.stacked) { fail++; } else { pass++; }
    const shotNarrow = path.join(OUTDIR, 'e2e-narrow.png');
    await snap(shotNarrow);
    console.log('  ' + shotNarrow);

    /* 切回宽屏再确认一次，保证来回切换都稳 */
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
    await sleep(700);
    const backWide = await cdp.evalJS(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let threw = null;
      try { relayout(); } catch (e) { threw = e.message; }
      await wait(320);
      const mc = document.querySelector('.main-container').getBoundingClientRect();
      const pc = document.getElementById('paper-container').getBoundingClientRect();
      const cx = mc.left + mc.width / 2, cy = mc.top + mc.height / 2;
      const rc = document.querySelector('.right-container').getBoundingClientRect();
      return {
        threw: threw,
        main: Math.round(mc.width) + 'x' + Math.round(mc.height),
        centered: cx >= pc.left && cx <= pc.right && cy >= pc.top && cy <= pc.bottom,
        sideBySide: rc.left >= mc.right - 2
      };
    })()`);
    console.log(`  切回宽屏: 画布 ${backWide.main}  画布居中=${backWide.centered}  面板回到右侧=${backWide.sideBySide}  重排=${backWide.threw ? '抛异常 ' + backWide.threw : '正常'}`);
    if (backWide.threw || !backWide.centered || !backWide.sideBySide) { fail++; } else { pass++; }

    /* 桌面全貌放在最后拍。用中等规模的表达式（9 节点 10 连线）并留足 settle 时间：
       大图（15 节点 25 连线）的 SVG 重栅格化会超过 500ms，先前抓到的一直是旧帧。 */
    await setup('a b . fe >', 2500);
    const shotWide = path.join(OUTDIR, 'e2e-desktop.png');
    await snap(shotWide);
    console.log('  ' + shotWide);

    console.log(`\n=== 汇总：通过 ${pass} · 失败 ${fail} ===`);
    fs.writeFileSync(path.join(OUTDIR, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.log('  完整报告: ' + path.join(OUTDIR, 'e2e-report.json'));

    cdp.close();
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.error('验收脚本失败: ' + e.message);
    process.exit(2);
});
