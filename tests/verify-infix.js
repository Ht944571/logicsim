/* ============================================================================
 * verify-infix.js —— 中缀解析的语义正确性验证
 * ----------------------------------------------------------------------------
 * 中文输入法写的表达式，经「中缀 → 后缀 → 既有管线」之后，得到的布尔函数
 * 是否与直接对中缀 AST 求值一致？
 *
 * 这里同样【不信任被测实现】：
 *   · 被测路径：InfixToRPN → LogicParser → ModelGen → cube 路径集
 *   · 参考路径：直接对 InfixParser 产出的 AST 做「满足赋值集合」求值
 *               （表示法不同：cube 集 vs 掩码集合）
 * 两者归约到同一可观测语义后做集合比对。
 *
 * 运行：node tests/verify-infix.js
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = vm.createContext({ console: console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'LogicParser.js'), 'utf8'), ctx, { filename: 'LogicParser.js' });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'InfixParser.js'), 'utf8'), ctx, { filename: 'InfixParser.js' });

/* ---------------- 参考实现：对中缀 AST 直接做集合论求值 ---------------- */
function collectVars(ast, out) {
    out = out || [];
    if (!ast) return out;
    if (ast.t === 'var') { if (out.indexOf(ast.name) < 0) out.push(ast.name); return out; }
    if (ast.t === 'const') return out;
    if (ast.t === 'not') { collectVars(ast.a, out); return out; }
    collectVars(ast.a, out); collectVars(ast.b, out);
    return out;
}

function refEval(ast) {
    const vars = collectVars(ast);
    const N = vars.length, FULL = N === 0 ? 0 : (1 << N) - 1;
    const bit = {}; vars.forEach((v, i) => { bit[v] = 1 << i; });
    const domain = []; for (let m = 0; m <= FULL; m++) domain.push(m);

    const complement = s => { const r = new Set(); for (const m of domain) if (!s.has(m)) r.add(m); return r; };
    const inter = (a, b) => { const r = new Set(); for (const m of a) if (b.has(m)) r.add(m); return r; };
    const union = (a, b) => { const r = new Set(a); for (const m of b) r.add(m); return r; };

    function go(n) {
        switch (n.t) {
            case 'const': return n.v === '1' ? new Set(domain) : new Set();
            case 'var': { const bi = bit[n.name], s = new Set(); for (const m of domain) if (m & bi) s.add(m); return s; }
            case 'not': return complement(go(n.a));
            case 'and': return inter(go(n.a), go(n.b));
            case 'or': return union(go(n.a), go(n.b));
            case 'imply': return union(complement(go(n.a)), go(n.b));
            case 'iff': { const A = go(n.a), B = go(n.b); return union(inter(A, B), inter(complement(A), complement(B))); }
            case 'exists': { const body = go(n.a), bi = bit[n.v], s = new Set(); for (const m of body) { s.add(m & ~bi); s.add(m | bi); } return s; }
            case 'forall': { const body = go(n.a), bi = bit[n.v], s = new Set(); for (const m of domain) if (body.has(m | bi) && body.has(m & ~bi)) s.add(m); return s; }
        }
        throw new Error('未知 AST 节点 ' + n.t);
    }
    return { vars, satSet: go(ast) };
}

/* ---------------- 被测实现：中缀 → 后缀 → 既有管线 ---------------- */
function implEval(infixSrc) {
    const conv = ctx.InfixToRPN(infixSrc);
    if (!conv.ok) return { ok: false, message: conv.message };
    ctx.resetModelGenBudget();
    const parsed = ctx.LogicParser(conv.rpn);
    if (!parsed.ok) return { ok: false, message: parsed.message, rpn: conv.rpn };
    const model = ctx.ModelGen(parsed.tree);
    return { ok: true, rpn: conv.rpn, model, quant: parsed.quant, ast: conv.ast };
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
    const pos = finalVars.map(v => ref.vars.indexOf(v)), out = new Set();
    for (const m of ref.satSet) {
        let p = 0;
        pos.forEach((src, i) => { if (((m >> src) & 1) === 1) p |= (1 << i); });
        out.add(p);
    }
    return out;
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

/* ---------------- 用例 ---------------- */
const CASES = [
    /* 基本联结词的最简写法 */
    'a AND b', 'a OR b', 'NOT a', 'a -> b', 'a IFF b',
    'a && b', 'a || b', '!a', 'a => b', 'a <-> b',
    'a ∧ b', 'a ∨ b', '¬a', 'a → b', 'a ↔ b',
    'a & b', 'a | b', '~a', 'a * b', 'a + b',

    /* 优先级与结合性 */
    'a OR b AND c',                 /* 应为 a ∨ (b ∧ c) */
    'NOT a AND b',                  /* 应为 (¬a) ∧ b */
    'a -> b -> c',                  /* 推出右结合：a → (b → c) */
    'a AND b -> c',
    'a AND b -> c IFF a AND b -> c',

    /* 括号 */
    '(a OR b) AND c',
    '((a))',
    '(a AND b) -> (c OR d)',
    'NOT (a AND b)',
    'NOT (a OR b) AND c',

    /* 与后缀模式等价性交叉检查 */
    'a AND b OR c AND d',

    /* 量词 */
    '∀x(a AND b)',
    '∀x (a AND b)',
    'EX x(a AND b)',
    '∃x(a OR b)',
    'ALL x(a OR b)',
    '∀x. a AND b',                   /* 点号形式只绑定紧随的一元项 */
    '∀x(a AND b) AND c',
    '∀x,y(a AND b)',
    '∀x(a) AND ∃y(b)',

    /* 常量 */
    '1', '0', '1 AND a', '0 OR a', 'a AND 1',

    /* 多字符与中文变量名 */
    'fe AND ge -> out',
    '载入位 AND 保持位',
    'p1 OR p2 AND p3'
];

console.log('=== 中缀表达式语义验证（中缀→后缀→既有管线 vs 直接对 AST 求值） ===');
let pass = 0, fail = 0;
const failures = [];

for (const src of CASES) {
    const impl = implEval(src);
    if (!impl.ok) {
        console.log(`  [拒绝] ${JSON.stringify(src).padEnd(34)} ${impl.message}`);
        fail++;
        failures.push({ src, why: '被拒绝：' + impl.message });
        continue;
    }
    const ref = refEval(impl.ast);
    const implSat = cubesToSatSet(impl.model);
    const refSat = projectSatSet(ref, impl.model.order);
    const same = setsEqual(implSat, refSat);
    if (same) pass++; else { fail++; failures.push({ src, why: '满足集不一致' }); }

    console.log(`  [${same ? '一致' : '!!不一致!!'}] ${JSON.stringify(src).padEnd(34)} 后缀=“${impl.rpn}”  变量=[${impl.model.order}]`);
    if (!same) {
        console.log(`      impl: ${[...implSat].sort((x, y) => x - y).join(',')}`);
        console.log(`      ref : ${[...refSat].sort((x, y) => x - y).join(',')}`);
    }
}

/* ---------------- 错误提示：位置必须准确 ---------------- */
console.log('\n=== 错误提示与字符位置 ===');
const ERR_CASES = [
    ['a AND', '运算符后缺操作数'],
    ['(a AND b', '缺右括号'],
    ['a AND b)', '多右括号'],
    ['∀x a', '量词作用范围未界定'],
    ['∀ a', '量词后不是变量名'],
    ['a b', '两个变量直接相邻'],
    ['', '空输入'],
    ['a @ b', '非法字符']
];
let errPass = 0;
for (const [src, note] of ERR_CASES) {
    const r = ctx.InfixToRPN(src);
    const ok = !r.ok && typeof r.index === 'number' && r.index >= 0 && r.index <= src.length && !!r.message;
    if (ok) errPass++;
    const caret = ok ? ' '.repeat(r.index) + '^' : '';
    console.log(`  ${ok ? '[通过]' : '[失败]'} ${JSON.stringify(src).padEnd(12)} 位置=${ok ? r.index : '无'}  ${ok ? r.message : '未给出定位'}   // ${note}`);
    if (ok && src.length > 0) console.log(`         ${src}\n         ${caret}`);
}

console.log('\n=== 汇总 ===');
console.log(`语义用例  通过 ${pass} / 失败 ${fail}`);
console.log(`错误用例  通过 ${errPass} / 共 ${ERR_CASES.length}`);
if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach(f => console.log(`  ${JSON.stringify(f.src)} —— ${f.why}`));
}
const bad = fail + (ERR_CASES.length - errPass);
console.log(`\n合计 失败 ${bad} 项  ${bad === 0 ? '✓' : '✗'}`);
process.exit(bad === 0 ? 0 : 1);
