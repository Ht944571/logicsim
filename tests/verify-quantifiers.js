/* ============================================================================
 * verify-quantifiers.js —— 量词语义的独立数学验证
 * ----------------------------------------------------------------------------
 * 不信任被测实现。这里另外写一个「集合论参考求值器」：
 *   · 把布尔函数表示为「满足赋值集合」（掩码集合），而非被测实现的 cube 路径集
 *   · ∃x S = { m | (m & ~bit) ∈ S  或  (m | bit) ∈ S }
 *   · ∀x S = { m | (m | bit) ∈ S  且  (m & ~bit) ∈ S }
 * 然后枚举所有满足赋值，与被测实现 ModelGen 输出的 cube 路径集求出的
 * 满足赋值集做集合比对。两者必须完全相等。
 *
 * 运行：node tests/verify-quantifiers.js
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = vm.createContext({ console: console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'LogicParser.js'), 'utf8'), ctx,
    { filename: 'public/LogicParser.js' });

const OP_RE = /^[.,<>?!=]$/;
const SPLIT_RE = /(\.|,|<|>|=|\?|!|\s)/;

function tokenize(expr) {
    return expr.split(SPLIT_RE).filter(t => t !== '' && !/^\s*$/.test(t));
}

/* ---------------- 参考实现之一：独立 AST 解析器 ----------------
   与被测实现完全独立：自己分词、自己按同一套逆波兰约定建语法树。
   量词的绑定目标在【语法层】校验 —— 必须是一个裸变量节点。
   这一步很关键：`a a b ? ?` 里第二个 ? 的绑定目标，语法上是 token `a`，
   是一个合法的变量节点，因此这个表达式语法合法（语义为 ∃a.a = 真）。
   只有等到对「求值后的集合」做判断，才会误判成非法。 */
function refParse(expr) {
    const tokens = tokenize(expr);
    const stack = [];
    const need = n => (stack.length < n ? null : stack.splice(stack.length - n, n));

    for (const t of tokens) {
        if (t === '.' || t === ',' || t === '>' || t === '=') {
            const o = need(2); if (!o) { return { error: 'E_ARITY_LOW' }; }
            const kind = t === '.' ? 'and' : t === ',' ? 'or' : t === '>' ? 'imp' : 'eq';
            stack.push({ t: kind, a: o[0], b: o[1] });
        } else if (t === '<') {
            const o = need(1); if (!o) { return { error: 'E_ARITY_LOW' }; }
            stack.push({ t: 'not', a: o[0] });
        } else if (t === '?' || t === '!') {
            const o = need(2); if (!o) { return { error: 'E_ARITY_LOW' }; }
            const body = o[0], q = o[1];
            if (!q || q.t !== 'var') { return { error: 'E_QUANT_TARGET' }; }
            stack.push({ t: t === '?' ? 'exists' : 'forall', v: q.name, a: body });
        } else if (OP_RE.test(t)) {
            return { error: 'E_UNKNOWN_TOKEN' };
        } else {
            stack.push({ t: 'var', name: t });
        }
    }
    if (stack.length !== 1) { return { error: 'E_ARITY_HIGH' }; }
    return { ast: stack[0] };
}

/* ---------------- 参考实现之二：AST -> 满足赋值集合 ---------------- */
function refEvalAST(ast, vars) {
    const N = vars.length;
    const FULL = N === 0 ? 0 : (1 << N) - 1;
    const bit = {};
    vars.forEach((v, i) => { bit[v] = 1 << i; });

    const domain = [];
    for (let m = 0; m <= FULL; m++) { domain.push(m); }

    const complement = s => { const r = new Set(); for (const m of domain) { if (!s.has(m)) { r.add(m); } } return r; };
    const inter = (a, b) => { const r = new Set(); for (const m of a) { if (b.has(m)) { r.add(m); } } return r; };
    const union = (a, b) => { const r = new Set(a); for (const m of b) { r.add(m); } return r; };

    function go(node) {
        switch (node.t) {
            case 'var': {
                const bi = bit[node.name];
                const s = new Set();
                for (const m of domain) { if (m & bi) { s.add(m); } }
                return s;
            }
            case 'and': return inter(go(node.a), go(node.b));
            case 'or': return union(go(node.a), go(node.b));
            case 'imp': return union(complement(go(node.a)), go(node.b));
            case 'eq': {
                const A = go(node.a), B = go(node.b);
                return union(inter(A, B), inter(complement(A), complement(B)));
            }
            case 'not': return complement(go(node.a));
            case 'exists': {
                const body = go(node.a), bi = bit[node.v];
                const s = new Set();
                for (const m of body) { s.add(m & ~bi); s.add(m | bi); }
                return s;
            }
            case 'forall': {
                const body = go(node.a), bi = bit[node.v];
                const s = new Set();
                for (const m of domain) { if (body.has(m | bi) && body.has(m & ~bi)) { s.add(m); } }
                return s;
            }
        }
        throw new Error('未知 AST 节点 ' + node.t);
    }
    return go(ast);
}

function refEval(expr) {
    const parsed = refParse(expr);
    if (parsed.error) { return { error: parsed.error }; }

    const vars = [];
    (function walk(node) {
        if (!node) { return; }
        if (node.t === 'var') { if (!vars.includes(node.name)) { vars.push(node.name); } return; }
        walk(node.a); walk(node.b);
    })(parsed.ast);

    return { vars, satSet: refEvalAST(parsed.ast, vars) };
}

/* ---------------- 被测实现：cube 路径集 -> 满足赋值集合 ---------------- */
function implEval(expr) {
    ctx.resetModelGenBudget();
    const parsed = ctx.LogicParser(expr);
    if (!parsed.ok) { return { ok: false, code: parsed.code, message: parsed.message }; }
    const model = ctx.ModelGen(parsed.tree);
    const view = ctx.ViewGen(model, {});
    return { ok: true, model, view, quant: parsed.quant };
}

/* 把 cube 路径集转成「最终变量集上的满足赋值掩码集合」 */
function cubesToSatSet(model) {
    const order = model.order;
    const idx = {};
    order.forEach((v, i) => { idx[v] = i; });
    const sat = new Set();
    for (const cube of model.value) {
        if (cube['.'] !== '>') { continue; }
        /* 该 cube 允许的全部赋值：未出现的变量自由取值 */
        const fixed = [];
        for (let i = 0; i < order.length; i++) {
            const v = order[i];
            if (cube[v] === '>') { fixed.push([i, 1]); }
            else if (cube[v] === '<') { fixed.push([i, 0]); }
        }
        for (let m = 0; m < (1 << order.length); m++) {
            let good = true;
            for (const [i, val] of fixed) {
                if (((m >> i) & 1) !== val) { good = false; break; }
            }
            if (good) { sat.add(m); }
        }
    }
    return sat;
}

/* 把参考求值器的满足集合投影到最终变量集上 */
function projectSatSet(ref, finalVars) {
    const pos = finalVars.map(v => ref.vars.indexOf(v));
    const out = new Set();
    for (const m of ref.satSet) {
        let p = 0;
        pos.forEach((srcIdx, i) => {
            if (((m >> srcIdx) & 1) === 1) { p |= (1 << i); }
        });
        out.add(p);
    }
    return out;
}

function setsEqual(a, b) {
    if (a.size !== b.size) { return false; }
    for (const x of a) { if (!b.has(x)) { return false; } }
    return true;
}

/* ---------------- 用例 ---------------- */
const NAMED = [
    ['a b . a ?', '∃a.(a∧b) 应化简为 b'],
    ['a b , a !', '∀a.(a∨b) 应化简为 b'],
    ['a b , a ?', '∃a.(a∨b) 应恒真'],
    ['a b . a !', '∀a.(a∧b) 应恒假'],
    ['a b > a ?', '∃a.(a→b) 应恒真'],
    ['a b > a !', '∀a.(a→b) 应化简为 b'],
    ['a b = a ?', '∃a.(a↔b) 应恒真'],
    ['a b = a !', '∀a.(a↔b) 应恒假'],
    ['a < a ?', '∃a.¬a 应恒真'],
    ['a < a !', '∀a.¬a 应恒假'],
    ['a b . z ?', '量词绑定未出现变量 -> 应保持 a∧b'],
    ['a b , c . a ?', '∃a.((a∨b)∧c)'],
    ['a b . c > a !', '∀a.((a∧b)→c)'],
    ['a b . a ? c ,', '∃a(a∧b) ∨ c  -> b∨c'],
    ['a b , a ! c .', '∀a(a∨b) ∧ c  -> b∧c'],
    ['a b . c , a ?', '∃a((a∧b)∨c)'],
    ['a b . a ? b !', '嵌套：∀b ∃a(a∧b) 应为假'],
    ['a b , a ? b !', '嵌套：∀b ∃a(a∨b) 应为真'],
    ['a < b , a !', '∀a.(¬a∨b) 应化简为 b']
];

/* 自动枚举：包含 ? / ! 的表达式，做全量集合比对 */
function* generate(maxTokens, vars, ops, arity) {
    function* rec(tokens, depth, usedVars) {
        if (tokens.length >= maxTokens) { return; }
        if (depth === 1 && usedVars > 0) { yield tokens.join(' '); }
        if (depth < 3) {
            for (const v of vars) {
                tokens.push(v);
                yield* rec(tokens, depth + 1, usedVars + 1);
                tokens.pop();
            }
        }
        for (const o of ops) {
            const n = arity[o];
            if (depth >= n) {
                tokens.push(o);
                yield* rec(tokens, depth - n + 1, usedVars);
                tokens.pop();
            }
        }
    }
    yield* rec([], 0, 0);
}

console.log('=== A. 具名量词用例（语义 + 集合比对） ===');
let passA = 0, failA = 0;
for (const [expr, note] of NAMED) {
    const impl = implEval(expr);
    if (!impl.ok) {
        console.log(`  [拒绝] ${expr.padEnd(18)} ${impl.code}  <-- ${note}`);
        failA++;
        continue;
    }
    const ref = refEval(expr);
    if (ref.error) {
        console.log(`  [!!参考实现不可用!!] ${expr.padEnd(18)} ${ref.error}  <-- ${note}`);
        failA++;
        continue;
    }
    const implSat = cubesToSatSet(impl.model);
    const refSat = projectSatSet(ref, impl.model.order);
    const same = setsEqual(implSat, refSat);
    if (same) { passA++; } else { failA++; }
    const orderDesc = impl.model.order.length ? impl.model.order.join(',') : '(常量)';
    console.log(`  [${same ? '一致' : '!!不一致!!'}] ${expr.padEnd(18)} 变量=[${orderDesc}] 路径=${impl.model.value.length} 量词=${impl.quant.map(q => (q.type === 'exists' ? '∃' : '∀') + q.var).join(' ') || '无'}  // ${note}`);
    if (!same) {
        console.log(`      impl 满足集: ${[...implSat].sort((x, y) => x - y).join(',')}`);
        console.log(`      ref  满足集: ${[...refSat].sort((x, y) => x - y).join(',')}`);
    }
}

console.log('\n=== B. 自动枚举全量比对（含 ? 与 ! 的表达式） ===');
const ops = ['.', ',', '<', '>', '=', '?', '!'];
const arity = { '.': 2, ',': 2, '<': 1, '>': 2, '=': 2, '?': 2, '!': 2 };
let tested = 0, quantCases = 0, passB = 0, failB = 0;
const failures = [];

for (const expr of generate(7, ['a', 'b', 'c'], ops, arity)) {
    if (tested >= 30000) { break; }
    const impl = implEval(expr);
    if (!impl.ok) { continue; }
    tested++;
    const hasQuant = impl.quant.length > 0;
    if (hasQuant) { quantCases++; }

    const ref = refEval(expr);
    if (ref.error) {
        /* 被测实现接受了、但参考实现判定语法非法 —— 说明语法校验口径不一致，记为失败 */
        failB++;
        if (failures.length < 8) { failures.push({ expr, implSat: [], refSat: ['参考实现判定：' + ref.error], order: impl.model.order }); }
        continue;
    }
    const implSat = cubesToSatSet(impl.model);
    const refSat = projectSatSet(ref, impl.model.order);
    if (setsEqual(implSat, refSat)) {
        passB++;
    } else {
        failB++;
        if (failures.length < 8) { failures.push({ expr, implSat: [...implSat], refSat: [...refSat], order: impl.model.order }); }
    }
}

console.log(`  参与比对表达式: ${tested}（其中含量词的: ${quantCases}）`);
console.log(`  集合一致: ${passB}   不一致: ${failB}`);
for (const f of failures) {
    console.log(`  [!!不一致!!] "${f.expr}"  变量=[${f.order}]`);
    console.log(`      impl: ${f.implSat.join(',')}`);
    console.log(`      ref : ${f.refSat.join(',')}`);
}

console.log('\n=== 汇总 ===');
const total = passA + passB;
const bad = failA + failB;
console.log(`具名用例 通过 ${passA} / 失败 ${failA}`);
console.log(`枚举用例 通过 ${passB} / 失败 ${failB}`);
console.log(`合计     通过 ${total} / 失败 ${bad}`);
process.exit(bad === 0 ? 0 : 1);
