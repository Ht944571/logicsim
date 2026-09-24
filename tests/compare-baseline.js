/* ============================================================================
 * compare-baseline.js —— 改造回归闸门
 * ----------------------------------------------------------------------------
 * 用 Node 的 vm 把「改造前」(git tag: baseline-v0) 与「改造后」两份逻辑内核
 * 装进相互隔离的上下文，对同一批表达式跑完整管线，逐字节比对输出。
 *
 * 目的：证明 3A/3B 改造没有改变任何既有合法表达式的行为。
 *
 * 运行：node tests/compare-baseline.js
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NEW_FILE = path.join(ROOT, 'public', 'LogicParser.js');
const BASELINE_TAG = 'baseline-v0';
const BASELINE_FILE = 'public/LogicParser.js';

/* ---------- 载入两份实现 ---------- */
function loadContext(src, label) {
    const ctx = vm.createContext({ console: console });
    vm.runInContext(src, ctx, { filename: label });
    return ctx;
}

/* Windows 下从 Node 直接 spawn git 会 EBUSY，因此优先读预先导出的基线副本。
   导出方式（见 tests/export-baseline.sh）：
       git show baseline-v0:public/LogicParser.js > tests/.baseline/LogicParser.baseline.js */
const BASELINE_COPY = path.join(__dirname, '.baseline', 'LogicParser.baseline.js');

let baselineSrc;
if (fs.existsSync(BASELINE_COPY)) {
    baselineSrc = fs.readFileSync(BASELINE_COPY, 'utf8');
    console.log(`[基线来源] ${path.relative(ROOT, BASELINE_COPY)}`);
} else {
    try {
        baselineSrc = execFileSync('git', ['show', `${BASELINE_TAG}:${BASELINE_FILE}`], {
            cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
        });
        console.log(`[基线来源] git ${BASELINE_TAG}:${BASELINE_FILE}`);
    } catch (e) {
        console.error(`无法读取基线代码。请先执行：bash tests/export-baseline.sh`);
        process.exit(2);
    }
}

const baseCtx = loadContext(baselineSrc, 'baseline/LogicParser.js');
const newCtx = loadContext(fs.readFileSync(NEW_FILE, 'utf8'), 'public/LogicParser.js');

/* ---------- 基线（改造前）的调用方式：靠返回类型判断错误 ---------- */
function runBaseline(expr) {
    let parsed;
    try {
        parsed = baseCtx.LogicParser(expr);
    } catch (e) {
        return { kind: 'baseline-crash', value: e.message };
    }
    if ('string' === typeof parsed) {
        return { kind: 'rejected', value: parsed };
    }
    try {
        const model = baseCtx.ModelGen(parsed);
        const view = baseCtx.ViewGen(model);
        return { kind: 'ok', model: model, view: view };
    } catch (e) {
        /* 改造前会把某些输入漏进 ModelGen 并在这里抛未捕获异常 */
        return { kind: 'baseline-crash', value: e.message };
    }
}

/* ---------- 改造后的调用方式：统一结果对象 ---------- */
function runNew(expr, quantMap) {
    newCtx.resetModelGenBudget();
    const parsed = newCtx.LogicParser(expr);
    if (!parsed.ok) {
        return { kind: 'rejected', value: parsed.message, code: parsed.code };
    }
    const model = newCtx.ModelGen(parsed.tree);
    const view = newCtx.ViewGen(model, quantMap || {});
    return { kind: 'ok', model: model, view: view, quant: parsed.quant };
}

/* ---------- 既有合法表达式（改造前可正常出图的） ---------- */
const VALID = [
    'a b .', 'a b ,', 'a <', 'a b >', 'a b =',
    'a b . fe >', 'a b . fe ge > =', 'a b c , ,',
    'a a .', 'a b . a c . ,',
    'ab cd .', 'a1 b2 ,', '1 a .',
    'a b > a b > =',
    'a b , a b , =',
    'a b c . .', 'a b c , ,',
    'a < b < .',
    'a b > b a > .',
    'a b = c d = .',
    'x y . z ,',
    'a b c d . . .',
    'p q . r > s ='
];

/* ---------- 改造前报错的输入（用于确认改造后行为变化符合预期） ---------- */
const INVALID = [
    '', ' ', '   ', '\t', '\n',
    'a', 'a ', 'a b', 'a b ',
    '1', '0',
    'a .', '.', 'a b . .',
    'a b . .', '..', 'a b . . c',
    'a b . . fe'
];

/* ---------- 执行比对 ---------- */
let pass = 0, fail = 0;
const regressions = [];

console.log('=== A. 既有合法表达式：改造前后必须完全一致 ===');
for (const expr of VALID) {
    const b = runBaseline(expr);
    const n = runNew(expr);
    if (b.kind !== 'ok') {
        console.log(`  [跳过] ${JSON.stringify(expr)} —— 改造前即被拒绝(${b.value})`);
        continue;
    }
    const bModel = JSON.stringify(b.model);
    const nModel = JSON.stringify(n.model);
    const bView = JSON.stringify(b.view);
    const nView = JSON.stringify(n.view);
    const ok = (bModel === nModel) && (bView === nView);
    if (ok) {
        pass++;
        console.log(`  [一致] ${JSON.stringify(expr)}  路径=${b.model.value.length} 变量=[${b.model.order}]`);
    } else {
        fail++;
        regressions.push(expr);
        console.log(`  [!!不一致!!] ${JSON.stringify(expr)}`);
        if (bModel !== nModel) {
            console.log(`      model 前: ${bModel}`);
            console.log(`      model 后: ${nModel}`);
        }
        if (bView !== nView) {
            console.log(`      view 前: ${bView}`);
            console.log(`      view 后: ${nView}`);
        }
    }
}

console.log('\n=== B. 改造前被拒绝的输入：改造后的新行为 ===');
for (const expr of INVALID) {
    const b = runBaseline(expr);
    let n;
    try {
        n = runNew(expr);
    } catch (e) {
        console.log(`  [崩溃] ${JSON.stringify(expr)} -> ${e.constructor.name}: ${e.message}`);
        fail++;
        continue;
    }
    const bDesc = (b.kind === 'ok') ? `出图(路径${b.model.value.length})`
        : (b.kind === 'baseline-crash') ? `崩溃(${b.value})` : `拒绝(${b.value})`;
    const nDesc = (n.kind === 'ok') ? `出图(路径${n.model.value.length})` : `拒绝(${n.code})`;
    const changed = (b.kind !== n.kind) || (b.kind === 'rejected' && n.kind === 'rejected');
    console.log(`  ${changed ? '→ 行为已改变' : '  行为不变  '} ${JSON.stringify(expr).padEnd(12)} 前:${bDesc.padEnd(30)} 后:${nDesc}`);
}

console.log('\n=== 汇总 ===');
console.log(`既有合法表达式一致: ${pass} 项，不一致: ${fail} 项`);
if (regressions.length) {
    console.log('回归清单: ' + regressions.join(' | '));
    process.exit(1);
}
console.log('结论：改造未改变任何既有合法表达式的输出。');
