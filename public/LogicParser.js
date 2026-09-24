/* ============================================================================
 * logicsim 逻辑内核
 * ----------------------------------------------------------------------------
 * 本文件承载三段式管线的全部纯逻辑部分，不依赖 DOM，可直接用 Node 运行做回归。
 *
 *    LogicParser(输入串)  ->  ite 树 / MUX 树
 *    ModelGen(ite 树)     ->  路径集 { value, order }
 *    ViewGen(路径集)      ->  图模型 { nodeArray, linkArray }
 *
 * 改造记录（2026-09-24）：
 *   [3A] 输入健壮性重构
 *        · LogicParser 返回统一结果对象 { ok:true, tree, quant } / { ok:false, code, message }
 *          （旧版把「合法结果」和「错误信息」都用字符串返回，靠 typeof 区分，
 *            导致单变量 a、常量 1/0 被误判为错误，纯空白输入还会崩溃）
 *        · 修复结尾未结算的变量被静默丢弃（"a b" 曾丢弃 a）
 *        · 修复纯空白输入返回 undefined 导致 ModelGen 抛未捕获异常
 *        · 变量名与操作符之间不再强制要求空白（"a b." 现在可以正常解析）
 *        · ViewGen0 无公共根变量时不再返回 undefined
 *        · 变量数与计算量加上限，超出给出中文提示而非卡死
 *   [3B] 量词支持
 *        · 新增后缀一元算子 ? （存在量词 ∃）与 ! （全称量词 ∀）
 *        · 语法：<表达式> <变量名> ?   即  ∃变量.表达式
 *                <表达式> <变量名> !   即  ∀变量.表达式
 *        · 求值：∃x φ = φ[x:=0] ∨ φ[x:=1] ；  ∀x φ = φ[x:=0] ∧ φ[x:=1]
 *        · 选用 ? / ! 而非字母 E / A，因为分词器把任何非操作符 token 都当变量名，
 *          用字母会永久占用两个变量名，属破坏性变更
 *
 * 兼容性承诺：
 *   ModelGen 与 ViewGen 的输出契约保持向后兼容。任何既有合法表达式，
 *   其 { value, order } 与 { nodeArray, linkArray } 输出与改造前逐字节一致。
 *   量词信息不写进节点，而是作为模型 JSON 的可选顶层字段 quantPrefix，
 *   旧 JSON 不含该字段时按「无量词」处理，照常载入。
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * 上限与错误表
 * ------------------------------------------------------------------------ */
var LOGIC_LIMITS = {
    MAX_VARS: 8,        /* 单次表达式的变量数上限 */
    MAX_PATHS: 4096,    /* 化简后路径数上限 */
    MG_BUDGET: 200000   /* ModelGen 内部计算步数预算，防止指数爆炸卡死页面 */
};

var LOGIC_ERRORS = {
    E_EMPTY: "表达式为空：请输入逆波兰逻辑表达式。",
    E_ARITY_LOW: "操作数不足：有操作符缺少必需的参数。",
    E_ARITY_HIGH: "表达式不完整：存在多余的变量或操作数未被使用。",
    E_QUANT_TARGET: "量词绑定目标必须是变量名，不能是复合表达式。正确写法：<表达式> <变量名> ? 或 <表达式> <变量名> !",
    E_TOO_MANY_VARS: "变量过多：单次表达式最多支持 " + LOGIC_LIMITS.MAX_VARS + " 个不同变量。",
    E_TOO_MANY_PATHS: "表达式过于复杂：化简后路径数超过 " + LOGIC_LIMITS.MAX_PATHS + " 条，已中止渲染。",
    E_BUDGET: "表达式过于复杂：化简过程中计算量超出上限，请减少变量或简化表达式。",
    E_INTERNAL: "解析失败：内部错误。"
};

function logicErr(code) {
    return {
        ok: false,
        code: code,
        message: LOGIC_ERRORS[code] || LOGIC_ERRORS.E_INTERNAL
    };
}

/* ---------------------------------------------------------------------------
 * ① 布尔构造子：MUX / ite 树
 *    节点形如 { S: 选择子, "0": 低分支, "1": 高分支 }
 *    叶子为字符串："0" / "1" 是常量，其余字符串是变量名
 *    注意：S 装的是整棵子表达式而非变量名，所以这是 MUX 树，不是严格的 BDD
 * ------------------------------------------------------------------------ */
function andM(a, b) {
    return {
        "S": a,
        "0": "0",
        "1": { "S": b, "0": "0", "1": "1" }
    };
}

function orM(a, b) {
    return {
        "S": a,
        "0": { "S": b, "0": "0", "1": "1" },
        "1": "1"
    };
}

function notM(a) {
    return {
        "S": a,
        "0": "1",
        "1": "0"
    };
}

function infM(a, b) {
    return {
        "S": a,
        "0": "1",
        "1": { "S": b, "0": "0", "1": "1" }
    };
}

function equalM(a, b) {
    return {
        "S": a,
        "0": { "S": b, "0": "1", "1": "0" },
        "1": { "S": b, "0": "0", "1": "1" }
    };
}

/* ---------------------------------------------------------------------------
 * ② 量词辅助：变量代入与出现性判断
 *
 * 注意：这三个函数对【两种节点形态】都是多态的，靠节点形状自动判别。
 *   ite 节点  ： { S, "0", "1" }        —— 选择器 / MUX 树（默认）
 *   门节点    ： { op, a, b? }          —— 运算符树（逻辑门视图用）
 * 这样量词的代入与消去逻辑只需实现一次，两种表示法共用。
 * ------------------------------------------------------------------------ */

/* 把节点中所有名为 v 的变量叶子替换为常量 val（"0" 或 "1"） */
function substVar(node, v, val) {
    if ("string" === typeof (node)) {
        return (node === v) ? val : node;
    }
    if (undefined !== node.S) {
        return {
            "S": substVar(node.S, v, val),
            "0": substVar(node["0"], v, val),
            "1": substVar(node["1"], v, val)
        };
    }
    var gate = { op: node.op, a: substVar(node.a, v, val) };
    if (undefined !== node.b) { gate.b = substVar(node.b, v, val); }
    return gate;
}

/* 变量 v 是否在节点中出现 */
function occursIn(node, v) {
    if ("string" === typeof (node)) {
        return node === v;
    }
    if (undefined !== node.S) {
        return occursIn(node.S, v) || occursIn(node["0"], v) || occursIn(node["1"], v);
    }
    return occursIn(node.a, v) || (undefined !== node.b && occursIn(node.b, v));
}

/* 收集节点中出现的全部变量名（排除常量 0/1） */
function collectVars(node, out) {
    out = out || [];
    if ("string" === typeof (node)) {
        if ("0" !== node && "1" !== node && -1 === out.indexOf(node)) {
            out.push(node);
        }
        return out;
    }
    if (undefined !== node.S) {
        collectVars(node.S, out);
        collectVars(node["0"], out);
        collectVars(node["1"], out);
        return out;
    }
    collectVars(node.a, out);
    if (undefined !== node.b) { collectVars(node.b, out); }
    return out;
}

/* ---------------------------------------------------------------------------
 * ②b 两套节点构造子
 *   ITE_OPS  —— 默认，构造 { S, "0", "1" }
 *   GATE_OPS —— 构造 { op, a, b? }，供「逻辑门视图」使用
 * 语义完全一致，只是记录方式不同。
 * ------------------------------------------------------------------------ */
var GATE_OPS = {
    and: function (a, b) { return { op: "and", a: a, b: b }; },
    or: function (a, b) { return { op: "or", a: a, b: b }; },
    not: function (a) { return { op: "not", a: a }; },
    imply: function (a, b) { return { op: "imply", a: a, b: b }; },
    iff: function (a, b) { return { op: "iff", a: a, b: b }; }
};

var ITE_OPS = {
    and: andM,
    or: orM,
    not: notM,
    imply: infM,
    iff: equalM
};

/* ---------------------------------------------------------------------------
 * ③ LogicParser —— 语法分析
 *
 * 输入：逆波兰逻辑表达式字符串
 * 输入：npn（后缀表达式字符串）、opts（可选）
 *   opts.nodeKind === "gate" 时产出【运算符树】{op,a,b}，供「逻辑门视图」使用；
 *   缺省产出【ite / MUX 树】{S,"0","1"}，即原有行为，逐字节不变。
 * 输出：{ ok:true, tree, quant:[{var,type}] }
 *   或  { ok:false, code, message }
 *
 * 操作符表：
 *   .  二元  逻辑与        ,  二元  逻辑或
 *   <  一元  逻辑非        >  二元  逻辑推出
 *   =  二元  逻辑等价      ?  一元  存在量词（绑定紧随其后的变量名）
 *                          !  一元  全称量词（绑定紧随其后的变量名）
 *
 * 分词：按操作符与空白切分。变量名可由字母、数字、汉字组成；
 *       变量名之间用空白分隔；操作符可与前一个 token 紧邻（"a b." 等价于 "a b ."）。
 * ------------------------------------------------------------------------ */
function LogicParser(npn, opts) {
    if ("string" !== typeof (npn)) { return logicErr("E_EMPTY"); }

    /* 选定节点构造子：默认 ite（MUX）树，保证既有行为零变化 */
    var M = (opts && "gate" === opts.nodeKind) ? GATE_OPS : ITE_OPS;

    var tokens = npn.split(/(\.|,|<|>|=|\?|!|\s)/);
    var stack = [];          /* 求值栈 */
    var state = 0;           /* 0: 可以开始新 token   1: 刚读入一个变量名 */
    var nstate = 0;          /* 已结算的 token 数 */
    var quantLog = [];       /* 记录真正生效的量词绑定 [{var, type}] */

    /* 结算栈顶待提交的变量名 */
    function commitPending() {
        if (1 === state) {
            state = 0;
            nstate++;
        }
    }

    /* 从栈顶取出 n 个操作数，按「先入栈者在前」的顺序返回；不足则返回 null */
    function takeOperands(n) {
        if (stack.length < n) { return null; }
        var got = [];
        for (var i = 0; i < n; i++) { got.push(stack.pop()); }
        return got.reverse();
    }

    for (var t = 0; t < tokens.length; t++) {
        var n = tokens[t];

        if ("" === n) { continue; }

        /* 空白：结算一个变量名 */
        if (n.match(/\s/)) {
            commitPending();
            continue;
        }

        /* ---- 二元操作符 ---- */
        if ("." === n || "," === n || ">" === n || "=" === n) {
            commitPending();
            var ops2 = takeOperands(2);
            if (null === ops2) { return logicErr("E_ARITY_LOW"); }
            if ("." === n) { stack.push(M.and(ops2[0], ops2[1])); }
            else if ("," === n) { stack.push(M.or(ops2[0], ops2[1])); }
            else if (">" === n) { stack.push(M.imply(ops2[0], ops2[1])); }
            else { stack.push(M.iff(ops2[0], ops2[1])); }
            nstate--;
            continue;
        }

        /* ---- 一元操作符：逻辑非 ---- */
        if ("<" === n) {
            commitPending();
            var ops1 = takeOperands(1);
            if (null === ops1) { return logicErr("E_ARITY_LOW"); }
            stack.push(M.not(ops1[0]));
            continue;
        }

        /* ---- 一元操作符：量词 ---- */
        if ("?" === n || "!" === n) {
            commitPending();
            var qops = takeOperands(2);   /* [表达式, 被绑定的变量名] */
            if (null === qops) { return logicErr("E_ARITY_LOW"); }

            var body = qops[0];
            var bound = qops[1];

            if ("string" !== typeof (bound) || "0" === bound || "1" === bound) {
                return logicErr("E_QUANT_TARGET");
            }

            var type = ("?" === n) ? "exists" : "forall";

            /* 逻辑门视图：保留量词节点而不是就地展开。
               展开在语义上没错，但会得到 (0∨b) ∧ (1∨b) 这种读不懂的形状；
               保留成「∀x / ∃x 量词盒」更贴合原表达式。
               该开关只在 opts.keepQuantifier 时生效，默认行为完全不变。 */
            if (opts && opts.keepQuantifier && "gate" === opts.nodeKind) {
                stack.push({ op: type, v: bound, a: body });
                if (occursIn(body, bound)) {
                    quantLog.push({ "var": bound, "type": type });
                }
                nstate--;
                continue;
            }

            /* ∃x φ = φ[x:=0] ∨ φ[x:=1]  ；  ∀x φ = φ[x:=0] ∧ φ[x:=1]
               这里【不做】"x 未出现就直接返回 φ" 的恒等捷径：
               捷径会让已经量化的公式在栈上还原成裸字符串，从而在语法上
               伪装成变量名，使 ? / ! 接受本该拒绝的输入。
               实测确认 ModelGen 对恒等情形幂等（orM(φ,φ) 与 andM(φ,φ)
               化简结果与 φ 完全一致），所以去掉捷径不改变任何输出。 */
            var v0 = substVar(body, bound, "0");
            var v1 = substVar(body, bound, "1");
            stack.push(("exists" === type) ? M.or(v0, v1) : M.and(v0, v1));

            /* 只记录真正绑定到变量的量词：绑定变量未出现时语义上是恒等变换，
               不该出现在界面的量词前缀里 */
            if (occursIn(body, bound)) {
                quantLog.push({ "var": bound, "type": type });
            }
            nstate--;
            continue;
        }

        /* ---- 变量名 ---- */
        if (0 === state) {
            state = 1;
            stack.push(n);
        }
        /* state 已为 1 时忽略（同一段连续非空白字符视为同一个变量名） */
    }

    /* 提交结尾处未结算的变量名（旧版在此静默丢弃，导致 "a b" 丢掉 a） */
    commitPending();

    if (0 === stack.length) { return logicErr("E_EMPTY"); }
    if (1 !== stack.length || nstate > 1) { return logicErr("E_ARITY_HIGH"); }

    var tree = stack.pop();

    var vars = collectVars(tree);
    if (vars.length > LOGIC_LIMITS.MAX_VARS) { return logicErr("E_TOO_MANY_VARS"); }

    return { ok: true, tree: tree, quant: quantLog };
}

/* ---------------------------------------------------------------------------
 * ④ ModelGen —— 展开 + 归约，输出路径集
 *
 * 输出契约（保持不变）：
 *   { value: [ { ".":">"|"<", <变量名>:">"|"<", ... }, ... ], order: [变量名, ...] }
 *   · "." 是终结标记：">" 表示该路径输出 1，"<" 表示输出 0
 *   · value 是立方体（cube）集合，每条路径即一个蕴含项
 *   · order 是出现过的变量全集
 *
 * 算法：递归展开 + 交集合并；若所有路径都终结于常量，则塌缩为常量 0 / 1。
 * 复杂度：路径枚举式化简，最坏指数级 —— 已由 mgSteps 预算兜底。
 * ------------------------------------------------------------------------ */
var mgSteps = 0;

function resetModelGenBudget() {
    mgSteps = 0;
}

function ModelGen(np) {
    mgSteps++;
    if (mgSteps > LOGIC_LIMITS.MG_BUDGET) {
        var budgetError = new Error("LOGIC_BUDGET_EXCEEDED");
        budgetError.name = "LogicBudgetError";
        throw budgetError;
    }

    /* 0:"<"   1:">" */
    var result = {
        value: [],
        order: []
    };
    if ("string" == typeof (np)) {
        if ("1" == np) {
            result.value = [{ ".": ">" }];
            result.order = [];
        } else if ("0" == np) {
            result.value = [{ ".": "<" }];
            result.order = [];
        } else {
            var temp1 = { ".": ">" };
            var temp2 = { ".": "<" };
            temp1[np] = ">";
            temp2[np] = "<";
            result.value = [temp1, temp2];
            result.order = [np];
        }

    }
    else {
        var result1 = ModelGen(np.S);

        if (0 == result1.order.length) {
            if ("<" == result1.value[0]["."]) {
                result = ModelGen(np[0]);
            } else {
                result = ModelGen(np[1]);
            }
        }
        else {
            var myset = new Set(result1.order);

            var result2 = ModelGen(np[0]);
            var intersection2 = result2.order.filter(x => myset.has(x));

            var result3 = ModelGen(np[1]);
            var intersection3 = result3.order.filter(x => myset.has(x));

            var all0 = false;
            var all1 = false;

            for (let x of result1.value) {
                if ("<" == x["."]) {
                    for (let y of result2.value) {
                        var YesOrNot = true;
                        for (let z of intersection2) {
                            if (undefined != x[z] && undefined != y[z] && x[z] != y[z]) {
                                YesOrNot = false;
                                break;
                            }
                        };
                        if (YesOrNot) {
                            var newValue = {};
                            for (var k in x) {
                                var item = x[k];
                                newValue[k] = item;
                            }
                            for (let alpha of result2.order) {
                                if (undefined != y[alpha]) {
                                    newValue[alpha] = y[alpha];
                                }
                            };
                            newValue["."] = y["."];
                            if (">" == newValue["."]) {
                                all1 = true;
                            } else {
                                all0 = true;
                            };
                            result.value.push(newValue);
                        }
                    }
                }
                else {
                    for (let y of result3.value) {
                        var YesOrNot = true;
                        for (let z of intersection3) {
                            if (undefined != x[z] && undefined != y[z] && x[z] != y[z]) {
                                YesOrNot = false;
                                break;
                            }
                        };
                        if (YesOrNot) {
                            var newValue = {};
                            for (var k in x) {
                                var item = x[k];
                                newValue[k] = item;
                            }
                            for (let alpha of result3.order) {
                                if (undefined != y[alpha]) {
                                    newValue[alpha] = y[alpha];
                                }
                            };
                            newValue["."] = y["."];
                            if (">" == newValue["."]) {
                                all1 = true;
                            } else {
                                all0 = true;
                            };
                            result.value.push(newValue);
                        }
                    }
                }
            };
            if (all0 && !all1) {
                result = {
                    value: [{ ".": "<" }],
                    order: []
                }
            } else if (all1 && !all0) {
                result = {
                    value: [{ ".": ">" }],
                    order: []
                }
            }
            else {
                var tempOrder = new Set(
                    result1.order.concat(result2.order).concat(result3.order)
                );
                result.order = Array.from(tempOrder);
            }
        }
    }
    return result;
}

/* ---------------------------------------------------------------------------
 * ⑤ ViewGen —— 路径集 -> 图模型
 *
 * 输出契约（与改造前完全一致，逐字节不变）：
 *   { nodeArray: [{key,type,name}], linkArray: [{from,frompid,to,topid}] }
 *
 * 节点类型：
 *   "Import" 变量输入    "SEL" 选择器    "0"/"1" 常量端子    "Export" 输出
 *
 * 关于量词与图形的关系（实现期修正）：
 *   量词会【消去】被绑定的变量 —— ∃x φ 与 ∀x φ 的结果都不再依赖 x，
 *   因此结果图里不会存在该变量的 Import 节点，也就不存在「给被绑定变量
 *   加角标」这回事。量词信息改由两处承载：
 *     · 画布上方的只读量词前缀条（ViewGen.js 的 renderQuantPrefix）
 *     · 模型 JSON 的可选顶层字段 quantPrefix（不污染节点结构，向后兼容）
 * ------------------------------------------------------------------------ */
function ViewGen(pn) {
    var countKey = 2;
    var result = {
        nodeArray: [
            { "key": "0", "type": "0", "name": "Zero" },
            { "key": 1, "type": "1", "name": "One" },
            { "key": 2, "type": "Export", "name": "Out" }
        ],
        linkArray: []
    }
    function ViewGen0(pnp, NodeKey, PortId) {
        if (1 == pnp.value.length) {
            if ("<" == pnp.value[0]["."]) {
                return {
                    nodeArray: [],
                    linkArray: [{ "from": "0", "frompid": "OUT", "to": NodeKey, "topid": PortId }]
                };
            } else {
                return {
                    nodeArray: [],
                    linkArray: [{ "from": 1, "frompid": "OUT", "to": NodeKey, "topid": PortId }]
                };
            }
        }
        else {
            var CName = "";
            for (var CName0 of pnp.order) {
                if (pnp.value.length == pnp.value.filter(function (x) { return undefined != x[CName0] }).length) {
                    CName = CName0;
                }
            }

            if ("" != CName) {
                var TempOrder = pnp.order.filter(function (x) {
                    return x != CName
                });

                var pnp1 = {
                    value: pnp.value.filter(function (x) { return "<" == x[CName] }),
                    order: TempOrder
                };
                var pnp2 = {
                    value: pnp.value.filter(function (x) { return ">" == x[CName] }),
                    order: TempOrder
                };

                countKey++;
                var NodeKeyNow = countKey;
                var NodeLink1 = ViewGen0(pnp1, NodeKeyNow, "0");
                var NodeLink2 = ViewGen0(pnp2, NodeKeyNow, "1");

                return {
                    nodeArray: [{ "key": NodeKeyNow, "type": "SEL" }].concat(NodeLink1.nodeArray, NodeLink2.nodeArray),
                    linkArray: [{ "from": NodeKeyNow, "frompid": "N", "to": NodeKey, "topid": PortId },
                    { "from": CName, "frompid": "OUT", "to": NodeKeyNow, "topid": "SI" }].concat(NodeLink1.linkArray, NodeLink2.linkArray)
                };
            }

            /* [3A] 防御：找不到公共根变量时旧版会 fall through 返回 undefined，
               调用方随即抛 TypeError。现在改为返回带 error 标记的空图，
               由上层转成可读提示。 */
            return { nodeArray: [], linkArray: [], error: "NO_COMMON_ROOT" };
        }
    };

    for (var i = 0; i < pn.order.length; i++) {
        var oneVar = pn.order[i];
        result.nodeArray = result.nodeArray.concat({ "key": oneVar, "type": "Import", "name": oneVar });
    }

    var temp = ViewGen0(pn, countKey, "OUT");
    if (!temp) {
        temp = { nodeArray: [], linkArray: [] , error: "NO_COMMON_ROOT" };
    }
    result.nodeArray = result.nodeArray.concat(temp.nodeArray);
    result.linkArray = result.linkArray.concat(temp.linkArray);
    if (temp.error) {
        result.error = temp.error;
    }
    return result;
}

/* ---------------------------------------------------------------------------
 * ⑥ TruthTable —— 由路径集生成真值表
 *
 * 变量取 cube 集的 order，也就是【化简后函数的自由变量】。
 * 对含量词的表达式这是正确口径：被量词消去的变量不再是函数的自变量，
 * 列在表里没有意义。
 *
 * 返回：
 *   { vars:[...], rows:[ {bits:[0|1,...], out:0|1, index:n}, ... ], truncated:bool }
 *   vars 为空（表达式已化简为常量）时，rows 只有一行（空赋值）。
 * ------------------------------------------------------------------------ */
var TRUTH_MAX_VARS = 12;    /* 4096 行；再多人眼也读不了，且表格会拖慢渲染 */

function TruthTable(vars, cubes) {
    var n = vars.length;
    if (n > TRUTH_MAX_VARS) {
        return { vars: vars, rows: [], truncated: true };
    }

    /* 只保留输出为 1 的 cube —— 真值表的每一行只需判断"是否被某条真路径覆盖" */
    var trueCubes = [];
    for (var c = 0; c < cubes.length; c++) {
        if (">" === cubes[c]["."]) { trueCubes.push(cubes[c]); }
    }

    var rows = [];
    var total = (n === 0) ? 1 : (1 << n);
    for (var m = 0; m < total; m++) {
        var bits = [];
        /* 让 vars[0] 当最高位：这样按 m 递增列出来就是习惯上的二进制计数顺序
           （000, 001, 010, ...），第一列变化最慢，人眼好读 */
        for (var i = 0; i < n; i++) { bits.push((m >> (n - 1 - i)) & 1); }

        var out = 0;
        for (var k = 0; k < trueCubes.length; k++) {
            var cube = trueCubes[k];
            var match = true;
            for (var j = 0; j < n; j++) {
                var want = cube[vars[j]];
                if (undefined === want) { continue; }   /* 该 cube 不约束这个变量 */
                if ((">" === want ? 1 : 0) !== bits[j]) { match = false; break; }
            }
            if (match) { out = 1; break; }
        }
        rows.push({ bits: bits, out: out, index: m });
    }

    return { vars: vars, rows: rows, truncated: false };
}
