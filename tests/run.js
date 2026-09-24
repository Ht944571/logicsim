/* ============================================================================
 * run.js —— 逻辑层回归测试
 * ----------------------------------------------------------------------------
 * 读取 tests/vectors.json 中的测试向量，对 public/LogicParser.js 逐条断言。
 * 覆盖：三段式管线的输出（order / value / 图模型签名）+ 错误码 + 量词语义。
 * 不依赖浏览器，纯 Node 运行，秒级完成。
 *
 *   node tests/run.js             跑测试
 *   node tests/run.js --update    用当前实现重新生成 vectors.json
 *                                 （仅在确认行为变更符合预期后才用）
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const VECTOR_FILE = path.join(__dirname, 'vectors.json');
const UPDATE = process.argv.indexOf('--update') >= 0;

const ctx = vm.createContext({ console: console });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'LogicParser.js'), 'utf8'), ctx,
    { filename: 'public/LogicParser.js' });

/* 稳定的字符串哈希，用于把图模型压成一个短签名 */
function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; }
    return h.toString(16);
}

function evaluate(expr) {
    ctx.resetModelGenBudget();
    const parsed = ctx.LogicParser(expr);
    if (!parsed.ok) {
        return { kind: 'error', code: parsed.code, message: parsed.message };
    }
    const model = ctx.ModelGen(parsed.tree);
    const view = ctx.ViewGen(model);
    return {
        kind: 'ok',
        tree: JSON.stringify(parsed.tree),
        quant: parsed.quant,
        order: model.order,
        value: model.value,
        viewSig: {
            nodes: view.nodeArray.length,
            links: view.linkArray.length,
            hash: hash(JSON.stringify(view))
        },
        view: view
    };
}

/* ---------------------------------------------------------------------------
 * 测试向量定义。expect 为期望值，由 --update 生成后可人工复核。
 * 分组含义：
 *   legacy  —— 改造前就能正常出图的表达式，行为必须与改造前逐字节一致
 *   fixed   —— 改造前被误判或崩溃、改造后应正常处理的输入
 *   quant   —— 量词（本次新增能力）
 *   error   —— 应被拒绝并给出错误码的输入
 * ------------------------------------------------------------------------ */
const CASES = [
    /* legacy：原有能力 */
    { g: 'legacy', expr: 'a b .', note: '与' },
    { g: 'legacy', expr: 'a b ,', note: '或' },
    { g: 'legacy', expr: 'a <', note: '非' },
    { g: 'legacy', expr: 'a b >', note: '推出' },
    { g: 'legacy', expr: 'a b =', note: '等价' },
    { g: 'legacy', expr: 'a b . fe >', note: '组合：与后推出' },
    { g: 'legacy', expr: 'a b . fe ge > =', note: '4 变量，16 种组合化简为 9 条路径' },
    { g: 'legacy', expr: 'a b c , ,', note: '三元或' },
    { g: 'legacy', expr: 'a a .', note: '幂等：a∧a 应化简为 a' },
    { g: 'legacy', expr: 'a b . a c . ,', note: '分配律' },
    { g: 'legacy', expr: 'ab cd .', note: '多字符变量名' },
    { g: 'legacy', expr: 'a1 b2 ,', note: '带数字的变量名' },
    { g: 'legacy', expr: '1 a .', note: '常量参与运算' },
    { g: 'legacy', expr: 'a b > a b > =', note: '恒真式 -> 常量 1' },
    { g: 'legacy', expr: 'a b , a b , =', note: '恒真式 -> 常量 1' },
    { g: 'legacy', expr: 'a b c . .', note: '三元与' },
    { g: 'legacy', expr: 'a < b < .', note: '双重否定' },
    { g: 'legacy', expr: 'a b > b a > .', note: '等价展开' },
    { g: 'legacy', expr: 'a b = c d = .', note: '4 变量等价组合' },
    { g: 'legacy', expr: 'x y . z ,', note: '三变量混合' },
    { g: 'legacy', expr: 'a b c d . . .', note: '四元与' },
    { g: 'legacy', expr: 'p q . r > s =', note: '四变量混合' },

    /* fixed：改造前被误判/崩溃的输入 */
    { g: 'fixed', expr: 'a', note: '单变量（改造前被当作错误信息）' },
    { g: 'fixed', expr: 'a ', note: '单变量带尾空格' },
    { g: 'fixed', expr: '1', note: '常量 1（改造前被当作错误信息）' },
    { g: 'fixed', expr: '0', note: '常量 0（改造前被当作错误信息）' },
    { g: 'fixed', expr: 'a b.', note: '操作符紧邻前一个 token' },
    { g: 'fixed', expr: 'a<', note: '一元操作符紧邻' },

    /* quant：量词（新增能力，语义已由 tests/verify-quantifiers.js 独立验证） */
    { g: 'quant', expr: 'a b . a ?', note: '∃a.(a∧b) 化简为 b' },
    { g: 'quant', expr: 'a b , a !', note: '∀a.(a∨b) 化简为 b' },
    { g: 'quant', expr: 'a b , a ?', note: '∃a.(a∨b) 恒真' },
    { g: 'quant', expr: 'a b . a !', note: '∀a.(a∧b) 恒假' },
    { g: 'quant', expr: 'a b > a ?', note: '∃a.(a→b) 恒真' },
    { g: 'quant', expr: 'a b > a !', note: '∀a.(a→b) 化简为 b' },
    { g: 'quant', expr: 'a b = a ?', note: '∃a.(a↔b) 恒真' },
    { g: 'quant', expr: 'a b = a !', note: '∀a.(a↔b) 恒假' },
    { g: 'quant', expr: 'a < a ?', note: '∃a.¬a 恒真' },
    { g: 'quant', expr: 'a < a !', note: '∀a.¬a 恒假' },
    { g: 'quant', expr: 'a b . z ?', note: '绑定未出现变量：恒等，不记入前缀' },
    { g: 'quant', expr: 'a b , c . a ?', note: '∃a.((a∨b)∧c)' },
    { g: 'quant', expr: 'a b . c > a !', note: '∀a.((a∧b)→c)' },
    { g: 'quant', expr: 'a b . a ? c ,', note: '∃a(a∧b) ∨ c -> b∨c' },
    { g: 'quant', expr: 'a b , a ! c .', note: '∀a(a∨b) ∧ c -> b∧c' },
    { g: 'quant', expr: 'a b . a ? b !', note: '嵌套：∀b∃a(a∧b) 恒假' },
    { g: 'quant', expr: 'a b , a ? b !', note: '嵌套：∀b∃a(a∨b) 恒真' },
    { g: 'quant', expr: 'a < b , a !', note: '∀a.(¬a∨b) 化简为 b' },
    { g: 'quant', expr: 'a b . x ? x ,', note: '先消去 x 再引入自由 x' },

    /* error：应被拒绝 */
    { g: 'error', expr: '', note: '空串' },
    { g: 'error', expr: ' ', note: '单个空格（改造前会崩溃）' },
    { g: 'error', expr: '   ', note: '多个空格（改造前会崩溃）' },
    { g: 'error', expr: '\t', note: '制表符（改造前会崩溃）' },
    { g: 'error', expr: '\n', note: '换行（改造前会崩溃）' },
    { g: 'error', expr: 'a b', note: '多余操作数（改造前静默丢弃 a）' },
    { g: 'error', expr: 'a b ', note: '多余操作数带尾空格' },
    { g: 'error', expr: 'a .', note: '操作数不足' },
    { g: 'error', expr: '.', note: '只有操作符' },
    { g: 'error', expr: 'a b . .', note: '操作数不足' },
    { g: 'error', expr: 'a b . a b . ?', note: '量词绑定目标不是变量名' },
    { g: 'error', expr: '1 0 ?', note: '量词绑定目标是常量' },
    { g: 'error', expr: 'a b c d e f g h i . . . . . . . .', note: '超过 8 个变量上限' }
];

/* ---------------------------------------------------------------------------
 * 生成 / 校验
 * ------------------------------------------------------------------------ */
if (UPDATE) {
    const vectors = CASES.map(c => {
        const r = evaluate(c.expr);
        const v = { group: c.g, expr: c.expr, note: c.note, expect: r.kind };
        if (r.kind === 'ok') {
            v.quant = r.quant;
            v.order = r.order;
            v.value = r.value;
            v.viewSig = r.viewSig;
            v.treeHash = hash(r.tree);
        } else {
            v.code = r.code;
        }
        return v;
    });
    fs.writeFileSync(VECTOR_FILE, JSON.stringify(vectors, null, 1) + '\n');
    console.log(`已生成 ${vectors.length} 条测试向量 -> ${path.relative(ROOT, VECTOR_FILE)}`);
    process.exit(0);
}

if (!fs.existsSync(VECTOR_FILE)) {
    console.error('缺少 tests/vectors.json，请先运行：node tests/run.js --update');
    process.exit(2);
}

const vectors = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
let pass = 0;
const failures = [];
const byGroup = {};

for (const v of vectors) {
    const r = evaluate(v.expr);
    const problems = [];

    if (r.kind !== v.expect) {
        problems.push(`期望 ${v.expect}，实际 ${r.kind}`);
    } else if (r.kind === 'error') {
        if (r.code !== v.code) { problems.push(`错误码期望 ${v.code}，实际 ${r.code}`); }
    } else {
        if (JSON.stringify(r.order) !== JSON.stringify(v.order)) {
            problems.push(`order 期望 ${JSON.stringify(v.order)}，实际 ${JSON.stringify(r.order)}`);
        }
        if (JSON.stringify(r.value) !== JSON.stringify(v.value)) {
            problems.push(`value 不一致`);
        }
        if (r.viewSig.nodes !== v.viewSig.nodes || r.viewSig.links !== v.viewSig.links) {
            problems.push(`图模型规模期望 ${v.viewSig.nodes}节点/${v.viewSig.links}连线，实际 ${r.viewSig.nodes}/${r.viewSig.links}`);
        }
        if (r.viewSig.hash !== v.viewSig.hash) {
            problems.push(`图模型哈希不一致（期望 ${v.viewSig.hash}，实际 ${r.viewSig.hash}）`);
        }
        if (JSON.stringify(r.quant) !== JSON.stringify(v.quant || [])) {
            problems.push(`量词记录期望 ${JSON.stringify(v.quant || [])}，实际 ${JSON.stringify(r.quant)}`);
        }
        if (hash(r.tree) !== v.treeHash) {
            problems.push(`ite 树哈希不一致（期望 ${v.treeHash}，实际 ${hash(r.tree)}）`);
        }
    }

    const g = byGroup[v.group] = byGroup[v.group] || { pass: 0, fail: 0 };
    if (problems.length === 0) { pass++; g.pass++; }
    else { g.fail++; failures.push({ v, problems }); }
}

console.log('=== 逻辑层回归测试 ===');
for (const key of Object.keys(byGroup)) {
    const g = byGroup[key];
    console.log(`  ${key.padEnd(8)} 通过 ${String(g.pass).padStart(2)} / 失败 ${g.fail}`);
}
if (failures.length) {
    console.log('\n失败明细：');
    for (const f of failures) {
        console.log(`  [${f.v.group}] ${JSON.stringify(f.v.expr)}  —— ${f.v.note}`);
        f.problems.forEach(p => console.log(`      · ${p}`));
    }
}
console.log(`\n合计：通过 ${pass} / 失败 ${failures.length}  ${failures.length === 0 ? '✓' : '✗'}`);
process.exit(failures.length === 0 ? 0 : 1);
