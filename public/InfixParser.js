/* ============================================================================
 * InfixParser.js —— 中缀表达式 → 后缀（逆波兰）
 * ----------------------------------------------------------------------------
 * 目的：降低输入门槛。用户可以直接写
 *         (a AND b) -> fe
 *         ∀x(a AND b)
 *         a && (b || !c)
 *       而不必先手工翻译成 a b . fe >
 *
 * 设计要点：
 *   1. 本模块只做【中缀 → 后缀】的翻译，产出的是一个逆波兰字符串，
 *      之后直接走既有的 LogicParser → ModelGen → ViewGen 管线。
 *      好处：下游零改动，量词等既有能力自动可用，且不可能引入回归。
 *   2. 同时产出一棵运算符 AST，供「逻辑门视图」与独立验证使用。
 *   3. 错误带【字符位置】，供界面在输入框里标红指出。
 *
 * 运算符表（大小写不敏感）：
 *   ¬ 非   : NOT  ¬  ~  !
 *   ∧ 与   : AND  ∧  &  &&  ·  /\  *
 *   ∨ 或   : OR   ∨  |  ||  +  \/  ,
 *   → 推出 : IMPLY  IMPLIES  →
 *   ↔ 等价 : IFF  EQUIV  ↔  ≡
 *   量词   : ∀x / ALL x / FORALL x     ∃x / EX x / EXISTS x / SOME x
 *
 * 优先级（低 → 高）：  ↔  <  →（右结合）  <  ∨  <  ∧  <  一元 ¬ / 量词
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * ① 词法扫描
 * ------------------------------------------------------------------------ */

/* 多字符符号表，按长度倒序匹配，避免 '->' 被 '<-' 抢先吃掉 */
var INFIX_SYMBOLS = [
    ['<-->', 'iff'], ['<=>', 'iff'], ['<->', 'iff'],
    ['-->', 'imply'], ['->', 'imply'], ['=>', 'imply'],
    ['&&', 'and'], ['/\\', 'and'],
    ['||', 'or'], ['\\/', 'or'],
    ['¬', 'not'], ['~', 'not'], ['!', 'not'],
    ['∧', 'and'], ['&', 'and'], ['·', 'and'], ['*', 'and'],
    ['∨', 'or'], ['|', 'or'], ['+', 'or'], [',', 'or'],
    ['→', 'imply'], ['↔', 'iff'], ['≡', 'iff'],
    ['∀', 'forall'], ['∃', 'exists'],
    ['(', '('], ['[', '('], [')', ')'], [']', ')'],
    ['.', 'dot']
];

/* 单词型运算符（大小写不敏感）。注意：用了这些词就不能再拿它们当变量名 */
var INFIX_KEYWORDS = {
    'NOT': 'not', 'NEG': 'not',
    'AND': 'and', 'OR': 'or',
    'IMPLY': 'imply', 'IMPLIES': 'imply',
    'IFF': 'iff', 'EQUIV': 'iff', 'XNOR': 'iff',
    'ALL': 'forall', 'FORALL': 'forall',
    'EX': 'exists', 'EXISTS': 'exists', 'SOME': 'exists'
};

function isIdentStart(ch) {
    return /[A-Za-z_\u4e00-\u9fa5]/.test(ch);
}
function isIdentChar(ch) {
    return /[A-Za-z0-9_\u4e00-\u9fa5]/.test(ch);
}

function scanInfix(src) {
    var tokens = [];
    var i = 0;
    while (i < src.length) {
        var ch = src[i];
        if (/\s/.test(ch)) { i++; continue; }

        /* 变量名 / 单词运算符 / 常量 */
        if (isIdentStart(ch) || /[0-9]/.test(ch)) {
            var start = i;
            while (i < src.length && isIdentChar(src[i])) { i++; }
            var raw = src.slice(start, i);
            var upper = raw.toUpperCase();
            if (INFIX_KEYWORDS[upper]) {
                tokens.push({ t: INFIX_KEYWORDS[upper], raw: raw, i: start, len: raw.length });
            } else if (/^[01]$/.test(raw)) {
                /* 0 / 1 是常量，与后缀模式保持一致 */
                tokens.push({ t: 'const', value: raw, raw: raw, i: start, len: raw.length });
            } else {
                tokens.push({ t: 'ident', value: raw, raw: raw, i: start, len: raw.length });
            }
            continue;
        }

        /* 符号运算符：按长度倒序匹配 */
        var matched = null;
        for (var k = 0; k < INFIX_SYMBOLS.length; k++) {
            var lit = INFIX_SYMBOLS[k][0];
            if (src.substr(i, lit.length) === lit) { matched = INFIX_SYMBOLS[k]; break; }
        }
        if (matched) {
            tokens.push({ t: matched[1], raw: matched[0], i: i, len: matched[0].length });
            i += matched[0].length;
            continue;
        }

        /* 无法识别的字符 */
        tokens.push({ t: 'bad', raw: ch, i: i, len: 1 });
        i++;
    }
    return tokens;
}

/* ---------------------------------------------------------------------------
 * ② 语法分析（递归下降）→ AST
 *
 * AST 节点：
 *   { t:'var',    name }
 *   { t:'const',  v:'0'|'1' }
 *   { t:'not',    a }
 *   { t:'and'|'or'|'imply'|'iff', a, b }
 *   { t:'forall'|'exists', v, a }
 * ------------------------------------------------------------------------ */
function parseInfix(src) {
    var tokens = scanInfix(src);
    var pos = 0;
    var endPos = src.length;

    function peek() { return tokens[pos]; }
    function nextTok() { return tokens[pos++]; }
    function fail(message, tok) {
        var e = new Error(message);
        e.infix = {
            index: tok ? tok.i : endPos,
            length: tok ? tok.len : 1
        };
        throw e;
    }

    function rIff() {
        var left = rImply();
        while (peek() && peek().t === 'iff') {
            nextTok();
            var right = rImply();
            left = { t: 'iff', a: left, b: right };
        }
        return left;
    }

    function rImply() {
        var left = rOr();
        if (peek() && peek().t === 'imply') {
            nextTok();
            /* 推出是右结合：a -> b -> c 等价于 a -> (b -> c) */
            var right = rImply();
            return { t: 'imply', a: left, b: right };
        }
        return left;
    }

    function rOr() {
        var left = rAnd();
        while (peek() && peek().t === 'or') {
            nextTok();
            left = { t: 'or', a: left, b: rAnd() };
        }
        return left;
    }

    function rAnd() {
        var left = rUnary();
        while (peek() && peek().t === 'and') {
            nextTok();
            left = { t: 'and', a: left, b: rUnary() };
        }
        return left;
    }

    function rUnary() {
        var t = peek();
        if (!t) { fail('表达式意外结束，这里还需要一个变量或括号表达式。', null); }

        if (t.t === 'not') {
            nextTok();
            return { t: 'not', a: rUnary() };
        }
        if (t.t === 'forall' || t.t === 'exists') {
            nextTok();
            return rQuantifier(t);
        }
        return rPrimary();
    }

    /* 量词：∀x(φ) / ∀x. φ / ∀x,y(φ) */
    function rQuantifier(qTok) {
        var bound = [];
        for (; ;) {
            var v = peek();
            if (!v || v.t !== 'ident') {
                fail('量词后面必须紧跟要绑定的变量名，例如 ' + qTok.raw + 'x(a AND b)。', v || qTok);
            }
            nextTok();
            bound.push(v.value);
            /* 支持 ∀x,y(φ) 的逗号分隔写法。
               注意 ',' 在符号表里映射成 or，这里按原始字面量判断，
               所以 ∀x , y 会被当成多变量绑定，而 ∀(x | y) 不会。 */
            if (peek() && peek().raw === ',') { nextTok(); continue; }
            break;
        }

        var after = peek();
        var body;
        if (after && after.t === 'dot') {
            nextTok();
            body = rUnary();
        } else if (after && after.t === '(') {
            body = rPrimary();
        } else {
            /* 这里没有后续 token 时，把光标指到表达式末尾比指向量词符号更贴切 */
            fail('量词的作用范围需要用括号或点号界定，例如 ' + qTok.raw + bound[0] + '(a AND b) 或 '
                + qTok.raw + bound[0] + '. a', after || null);
        }

        /* ∀x,y(φ) 即 ∀x(∀y(φ))：内层先绑定，故倒序包裹 */
        for (var j = bound.length - 1; j >= 0; j--) {
            body = { t: (qTok.t === 'exists' ? 'exists' : 'forall'), v: bound[j], a: body };
        }
        return body;
    }

    function rPrimary() {
        var t = nextTok();
        if (!t) { fail('表达式意外结束，这里还需要一个变量或括号表达式。', null); }

        if (t.t === 'ident') { return { t: 'var', name: t.value }; }
        if (t.t === 'const') { return { t: 'const', v: t.value }; }

        if (t.t === '(') {
            var inner = rIff();
            var close = nextTok();
            if (!close || close.t !== ')') {
                /* 把光标指到表达式末尾（缺的东西在末尾），而不是指向那个左括号 */
                fail('括号没有闭合：缺少与第 ' + (t.i + 1) + ' 个字符处的 “(” 配对的 “)”。', close || null);
            }
            return inner;
        }

        if (t.t === ')') { fail('多了一个右括号。', t); }
        if (t.t === 'bad') { fail('无法识别的字符 “' + t.raw + '”。', t); }
        fail('这里需要一个变量名或括号表达式，实际遇到 “' + t.raw + '”。', t);
    }

    /* ---- 入口 ---- */
    try {
        if (tokens.length === 0) {
            return { ok: false, message: '表达式为空：请输入逻辑表达式。', index: 0, length: 0 };
        }
        var ast = rIff();
        var rest = peek();
        if (rest) {
            if (rest.t === 'bad') {
                return {
                    ok: false,
                    message: '无法识别的字符 “' + rest.raw + '”。可用的逻辑运算符见右侧「帮助」。',
                    index: rest.i,
                    length: rest.len
                };
            }
            return {
                ok: false,
                message: '表达式末尾有多余的内容：“' + rest.raw + '”。请检查运算符是否写全。',
                index: rest.i,
                length: rest.len
            };
        }
        return { ok: true, ast: ast };
    } catch (e) {
        if (e && e.infix) {
            return { ok: false, message: e.message, index: e.infix.index, length: e.infix.length };
        }
        return { ok: false, message: '解析失败：' + ((e && e.message) || '未知错误'), index: 0, length: 1 };
    }
}

/* ---------------------------------------------------------------------------
 * ③ AST → 逆波兰
 * 映射到后缀模式的操作符： ¬→<  ∧→.  ∨→,  →→>  ↔→=  ∃→?  ∀→!
 * ------------------------------------------------------------------------ */
var INFIX_RPN_OP = {
    'not': '<', 'and': '.', 'or': ',', 'imply': '>', 'iff': '='
};

function infixAstToRPN(ast) {
    var out = [];
    (function go(n) {
        if (!n) { return; }
        switch (n.t) {
            case 'var': out.push(n.name); break;
            case 'const': out.push(n.v); break;
            case 'not': go(n.a); out.push('<'); break;
            case 'and': case 'or': case 'imply': case 'iff':
                go(n.a); go(n.b); out.push(INFIX_RPN_OP[n.t]); break;
            case 'forall': case 'exists':
                go(n.a);
                out.push(n.v);
                out.push(n.t === 'exists' ? '?' : '!');
                break;
        }
    })(ast);
    return out.join(' ');
}

/* ---------------------------------------------------------------------------
 * ④ 对外入口
 *
 * 返回：{ ok:true, rpn, ast } 或 { ok:false, message, index, length }
 * ------------------------------------------------------------------------ */
function InfixToRPN(src) {
    var parsed = parseInfix(src);
    if (!parsed.ok) { return parsed; }
    return {
        ok: true,
        rpn: infixAstToRPN(parsed.ast),
        ast: parsed.ast
    };
}
