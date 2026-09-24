/* ============================================================================
 * verify-gateview.js —— 逻辑门视图的正确性验证
 * ----------------------------------------------------------------------------
 * 检查三件事：
 *   1. 结构完好：无悬空连线、无非输出汇点、恰好一个输出端、图为树
 *   2. 语义等价：对门树做集合论求值，与「选择器视图」的 cube 路径集比对
 *   3. 门数吻合：与/或/非/推出/等价/量词盒的数量与表达式里的运算符一一对应
 *
 * 运行：node tests/verify-gateview.js
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = vm.createContext({ console: console });
for (const f of ['LogicParser.js', 'GateView.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', f), 'utf8'), ctx, { filename: f });
}

/* ---------------- 参考实现：对门树做集合论求值 ---------------- */
function collectVars(node, out) {
    out = out || [];
    if (typeof node === 'string') { if (node !== '0' && node !== '1' && out.indexOf(node) < 0) out.push(node); return out; }
    if (node.a) collectVars(node.a, out);
    if (node.b) collectVars(node.b, out);
    return out;
}

function refEval(node) {
    const vars = collectVars(node);
    const N = vars.length, FULL = N === 0 ? 0 : (1 << N) - 1;
    const bit = {}; vars.forEach((v, i) => { bit[v] = 1 << i; });
    const domain = []; for (let m = 0; m <= FULL; m++) domain.push(m);
    const comp = s => { const r = new Set(); for (const m of domain) if (!s.has(m)) r.add(m); return r; };
    const inter = (a, b) => { const r = new Set(); for (const m of a) if (b.has(m)) r.add(m); return r; };
    const uni = (a, b) => { const r = new Set(a); for (const m of b) r.add(m); return r; };

    function go(n) {
        if (typeof n === 'string') {
            if (n === '1') return new Set(domain);
            if (n === '0') return new Set();
            const bi = bit[n], s = new Set();
            for (const m of domain) if (m & bi) s.add(m);
            return s;
        }
        switch (n.op) {
            case 'not': return comp(go(n.a));
            case 'and': return inter(go(n.a), go(n.b));
            case 'or': return uni(go(n.a), go(n.b));
            case 'imply': return uni(comp(go(n.a)), go(n.b));
            case 'iff': { const A = go(n.a), B = go(n.b); return uni(inter(A, B), inter(comp(A), comp(B))); }
            case 'exists': { const body = go(n.a), bi = bit[n.v], s = new Set(); for (const m of body) { s.add(m & ~bi); s.add(m | bi); } return s; }
            case 'forall': { const body = go(n.a), bi = bit[n.v], s = new Set(); for (const m of domain) if (body.has(m | bi) && body.has(m & ~bi)) s.add(m); return s; }
        }
        throw new Error('未知门节点 ' + n.op);
    }
    return { vars, satSet: go(node) };
}

function cubesToSatSet(model) {
    const order = model.order, sat = new Set();
    for (const cube of model.value) {
        if (cube['.'] !== '>') continue;
        const fixed = [];
        order.forEach((v, i) => {
            if (cube[v] === '>') fixed.push([i, 1]);
            else if (cube[v] === '<') fixed.push([i, 0]);
        });
        for (let m = 0; m < (1 << order.length); m++) {
            if (fixed.every(([i, val]) => ((m >> i) & 1) === val)) sat.add(m);
        }
    }
    return sat;
}
function projectSatSet(ref, finalVars) {
    // 门视图的变量是原表达式全部变量；选择器视图的 order 是化简后的自由变量。
    // 要把参考集合投影到 order 上做比对（量词变量已被消去，投影即"不关心其取值"）。
    const pos = finalVars.map(v => ref.vars.indexOf(v)), out = new Set();
    for (const m of ref.satSet) {
        let p = 0;
        pos.forEach((src, i) => { if (src >= 0 && ((m >> src) & 1) === 1) p |= (1 << i); });
        out.add(p);
    }
    return out;
}
function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

/* ---------------- 结构检查 ---------------- */
function checkStructure(view) {
    const problems = [];
    const keys = {};
    view.nodeArray.forEach(n => {
        if (keys[n.key]) problems.push('节点键重复: ' + n.key);
        keys[n.key] = n;
    });

    let exportCount = 0;
    view.nodeArray.forEach(n => { if (n.type === 'GateOut') exportCount++; });
    if (exportCount !== 1) problems.push('Export 节点数量应为 1，实际 ' + exportCount);

    /* 除 Export 外每个节点都必须有出边（变量与常量是数据源，只有出边没有入边，
       早先版本用"入边数"判断变量节点，那是把数据流方向搞反了） */
    const hasOutEdge = {};
    view.linkArray.forEach((l, i) => {
        if (!keys[l.from]) problems.push(`连线 #${i} 的源节点不存在: ${l.from}`);
        if (!keys[l.to]) problems.push(`连线 #${i} 的目标节点不存在: ${l.to}`);
        hasOutEdge[l.from] = true;
        if (l.from === l.to) problems.push(`连线 #${i} 自环`);
    });

    view.nodeArray.forEach(n => {
        if (n.type !== 'GateOut' && !hasOutEdge[n.key]) {
            problems.push(`节点 ${n.key}(${n.type}) 没有任何出边，是死端`);
        }
    });

    /* 门节点入边数必须等于它的输入端数量；输出端必须恰好一条入边 */
    const inDeg = {};
    view.linkArray.forEach(l => { inDeg[l.to] = (inDeg[l.to] || 0) + 1; });

    const exportKey = (view.nodeArray.find(n => n.type === 'GateOut') || {}).key;
    if (exportKey !== undefined && inDeg[exportKey] !== 1) {
        problems.push(`输出端入边数应为 1，实际 ${inDeg[exportKey] || 0}`);
    }

    view.nodeArray.forEach(n => {
        const geom = ctx.GATE_GEOM[n.type];
        if (!geom) return;
        const expectIn = geom.inputs.length;
        if (expectIn > 0 && inDeg[n.key] !== expectIn) {
            problems.push(`门 ${n.type}(${n.key}) 入边数应为 ${expectIn}，实际 ${inDeg[n.key] || 0}`);
        }
    });

    /* 出边总数必须等于连线总数（每条连线恰好一个源） */
    const outDegreeTotal = Object.keys(hasOutEdge).length;
    const distinctSources = new Set(view.linkArray.map(l => l.from)).size;
    if (outDegreeTotal !== distinctSources) {
        problems.push(`有出边的节点数(${outDegreeTotal}) 与连线去重源数(${distinctSources}) 不一致`);
    }
    return problems;
}

/* ---------------- 用例 ---------------- */
const CASES = [
    ['a b .', '与'],
    ['a b ,', '或'],
    ['a <', '非'],
    ['a b >', '推出'],
    ['a b =', '等价'],
    ['a b . fe >', '与后推出'],
    ['a b . fe ge > =', '四变量混合'],
    ['a b c , ,', '三元或'],
    ['a b . a c . ,', '分配律'],
    ['a b , c .', '括号语义'],
    ['a b . c > d ,', '四变量'],
    ['a b . fe ge > = c .', '五变量'],
    ['a b , a !', '全称量词'],
    ['a b . a ?', '存在量词'],
    ['a b . x ? x ,', '量词后自由变量重现']
];

console.log('=== 逻辑门视图验证 ===');
let ok = 0, bad = 0;

for (const [rpn, note] of CASES) {
    /* 门树（保留量词节点） */
    const g = ctx.LogicParser(rpn, { nodeKind: 'gate', keepQuantifier: true });
    if (!g.ok) { console.log(`  [跳过] ${rpn} —— 解析失败 ${g.code}`); bad++; continue; }
    const view = ctx.GateViewGen(g.tree);
    const stats = ctx.GateViewStats(view);

    /* 语义：与选择器视图比对 */
    const def = ctx.LogicParser(rpn);
    ctx.resetModelGenBudget();
    const model = ctx.ModelGen(def.tree);
    const ref = refEval(g.tree);
    const implSat = cubesToSatSet(model);
    const refSat = projectSatSet(ref, model.order);
    const semOk = setsEqual(implSat, refSat);

    const problems = checkStructure(view);
    const pass = semOk && problems.length === 0;
    if (pass) { ok++; } else { bad++; }

    console.log(`  [${pass ? '通过' : '失败'}] ${rpn.padEnd(18)} 门=${String(stats.gates).padStart(2)} 变量=${stats.VAR} 节点=${stats.total} 连线=${stats.links}  量词盒=${stats.FORALL + stats.EXISTS}   // ${note}`);
    if (!semOk) {
        console.log(`      语义不一致  impl: ${[...implSat].sort((a, b) => a - b).join(',')}  ref: ${[...refSat].sort((a, b) => a - b).join(',')}`);
    }
    problems.forEach(p => console.log('      结构问题: ' + p));
}

/* ---------------- 门数与运算符数量必须吻合 ---------------- */
console.log('\n=== 门数与运算符数量对照 ===');
const COUNT_CASES = [
    ['a b .', { AND: 1 }, '一个与门'],
    ['a b ,', { OR: 1 }, '一个或门'],
    ['a <', { NOT: 1 }, '一个非门'],
    ['a b >', { IMPLY: 1 }, '一个推出门'],
    ['a b =', { IFF: 1 }, '一个等价门'],
    ['a b < ,', { OR: 1, NOT: 1 }, '非门+或门'],
    ['a b . fe ge > =', { AND: 1, IMPLY: 1, IFF: 1 }, '3 个门']
];
let countOk = 0;
for (const [rpn, expect, note] of COUNT_CASES) {
    const g = ctx.LogicParser(rpn, { nodeKind: 'gate', keepQuantifier: true });
    const view = ctx.GateViewGen(g.tree);
    const stats = ctx.GateViewStats(view);
    const mismatches = Object.keys(expect).filter(k => stats[k] !== expect[k]);
    if (mismatches.length === 0) countOk++;
    else bad++;
    console.log(`  ${mismatches.length === 0 ? '[通过]' : '[失败]'} ${rpn.padEnd(18)} 实际 ${JSON.stringify({ AND: stats.AND, OR: stats.OR, NOT: stats.NOT, IMPLY: stats.IMPLY, IFF: stats.IFF })}  期望 ${JSON.stringify(expect)}   // ${note}`);
}

console.log('\n=== 汇总 ===');
console.log(`语义与结构用例 通过 ${ok} / 失败 ${bad}`);
console.log(`门数用例       通过 ${countOk} / 共 ${COUNT_CASES.length}`);
const totalBad = bad + (COUNT_CASES.length - countOk);
console.log(`\n合计 失败 ${totalBad} 项  ${totalBad === 0 ? '✓' : '✗'}`);
process.exit(totalBad === 0 ? 0 : 1);
