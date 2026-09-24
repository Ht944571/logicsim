/* ============================================================================
 * GateView.js —— 运算符树 → 逻辑门电路图模型
 * ----------------------------------------------------------------------------
 * 与「选择器视图」的区别：
 *   选择器视图（ViewGen）：把【化简后】的布尔函数表示成 MUX 选择器网络。
 *                          节点是 SEL，回答"这个函数能用多少级选择实现"。
 *   逻辑门视图（本文件）：把【原表达式】直译成与/或/非门电路。
 *                          节点是标准逻辑门符号，回答"这个表达式长什么样"。
 *
 * 两者互补：前者看化简结果，后者看语法结构。用户要的「一眼认出是什么逻辑门」
 * 只能在门视图里满足 —— 选择器视图里根本不存在与门/或门/非门节点。
 *
 * 本文件是纯逻辑（不依赖 DOM），可在 Node 中直接测试。
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * ① 门的几何与符号（SVG path，局部坐标以节点左上角为原点）
 *    path 用 <path d>；有 circle 的（非门）额外画一个圆。
 * ------------------------------------------------------------------------ */
var GATE_GEOM = {
    AND: {
        w: 100, h: 68,
        path: "M0,0 L50,0 A34,34 0 0 1 50,68 L0,68 Z",
        circle: null,
        inputs: [{ id: "A", x: 0, y: 19 }, { id: "B", x: 0, y: 49 }],
        out: { x: 84, y: 34 },
        label: "与门", symbol: "∧"
    },
    OR: {
        w: 96, h: 68,
        path: "M0,0 Q24,34 0,68 Q48,68 92,34 Q48,0 0,0 Z",
        circle: null,
        inputs: [{ id: "A", x: 10, y: 20 }, { id: "B", x: 10, y: 48 }],
        out: { x: 92, y: 34 },
        label: "或门", symbol: "∨"
    },
    NOT: {
        w: 74, h: 68,
        path: "M0,0 L56,34 L0,68 Z",
        circle: { cx: 63, cy: 34, r: 8 },
        inputs: [{ id: "A", x: 0, y: 34 }],
        out: { x: 71, y: 34 },
        label: "非门", symbol: "¬"
    },
    /* 推出与等价不是基本门，电路图惯例用带符号的方框表示 */
    IMPLY: {
        w: 96, h: 68,
        path: null, box: true,
        circle: null,
        inputs: [{ id: "A", x: 0, y: 19 }, { id: "B", x: 0, y: 49 }],
        out: { x: 96, y: 34 },
        label: "推出门", symbol: "→"
    },
    IFF: {
        w: 96, h: 68,
        path: null, box: true,
        circle: null,
        inputs: [{ id: "A", x: 0, y: 19 }, { id: "B", x: 0, y: 49 }],
        out: { x: 96, y: 34 },
        label: "等价门", symbol: "↔"
    },
    /* 输入信号：用圆角胶囊表示，和门区分开 */
    VAR: {
        w: 80, h: 48,
        path: null, capsule: true,
        inputs: [],
        out: { x: 80, y: 24 },
        label: "", symbol: ""
    },
    /* 常量端 */
    CONST: {
        w: 56, h: 44,
        path: null, box: true,
        inputs: [],
        out: { x: 56, y: 22 },
        label: "", symbol: ""
    },
    /* 输出端 */
    OUT: {
        w: 84, h: 48,
        path: null, capsule: true,
        inputs: [{ id: "IN", x: 0, y: 24 }],
        out: null,
        label: "", symbol: ""
    },
    /* 量词盒：保留原表达式的量词结构，避免展开成难读的等价形式 */
    FORALL: {
        w: 88, h: 58,
        path: null, box: true, quantifier: true,
        inputs: [{ id: "A", x: 0, y: 29 }],
        out: { x: 88, y: 29 },
        label: "全称量词", symbol: "∀"
    },
    EXISTS: {
        w: 88, h: 58,
        path: null, box: true, quantifier: true,
        inputs: [{ id: "A", x: 0, y: 29 }],
        out: { x: 88, y: 29 },
        label: "存在量词", symbol: "∃"
    }
};

var GATE_OP_TO_TYPE = {
    and: "AND", or: "OR", not: "NOT", imply: "IMPLY", iff: "IFF",
    forall: "FORALL", exists: "EXISTS"
};

var GATE_TYPE_CN = {
    AND: "与门 ∧", OR: "或门 ∨", NOT: "非门 ¬", IMPLY: "推出门 →", IFF: "等价门 ↔",
    FORALL: "全称量词 ∀", EXISTS: "存在量词 ∃"
};

/* ---------------------------------------------------------------------------
 * ② GateViewGen —— 运算符树 → { nodeArray, linkArray }
 *
 * 节点类型： VAR（变量输入） / AND / OR / NOT / IMPLY / IFF / FORALL / EXISTS
 *            CONST0 / CONST1 （常量端）   GateOut （输出端）
 *
 * ⚠️ 类型名刻意与选择器视图区分开：
 *    选择器视图也用 "0" / "1" / "Export" 表示常量与输出，但两者的画法完全不同。
 *    如果这里复用同名，nodeCreate 就没法判断该走哪套渲染。因此门视图用
 *    CONST0 / CONST1 / GateOut，而变量输入复用 Import（两边画法一致，无需区分）。
 *
 * 端口：     门输入端 A（非门只有 A）、B；输出端 OUT
 *
 * 键名一律用 "k<序号>" 统一分配，避免变量名与内部编号撞车
 * （选择器视图用变量名当键，若变量名叫 "2" 会与 Export 的键 2 冲突 ——
 *  这是原实现遗留问题，本文件不改动它的契约，但新视图不再引入同类风险）。
 * ------------------------------------------------------------------------ */
function GateViewGen(gateTree) {
    var seq = 0;
    function nextKey() { return "k" + (seq++); }

    var outKey = nextKey();
    var nodes = [
        { key: outKey, type: "GateOut", name: "输出" }
    ];
    var links = [];

    var seenVar = {};
    var constNodes = {};

    /* 返回某个子树输出端的 {key, port} */
    function emit(node) {
        if ("string" === typeof (node)) {
            if ("0" === node || "1" === node) {
                if (!constNodes[node]) {
                    /* 注意：键要取生成的键，不能把"是否见过"的标记当键用 */
                    constNodes[node] = nextKey();
                    nodes.push({
                        key: constNodes[node],
                        type: ("1" === node) ? "CONST1" : "CONST0",
                        name: ("1" === node) ? "常量 1" : "常量 0"
                    });
                }
                return { key: constNodes[node], port: "OUT" };
            }
            if (!seenVar[node]) {
                seenVar[node] = nextKey();
                nodes.push({ key: seenVar[node], type: "VAR", name: node });
            }
            return { key: seenVar[node], port: "OUT" };
        }

        var type = GATE_OP_TO_TYPE[node.op];
        if (!type) { return null; }

        var key = nextKey();
        if ("NOT" === type) {
            var a1 = emit(node.a);
            nodes.push({ key: key, type: "NOT", name: GATE_TYPE_CN.NOT });
            links.push({ from: a1.key, frompid: a1.port, to: key, topid: "A" });
            return { key: key, port: "OUT" };
        }

        if ("FORALL" === type || "EXISTS" === type) {
            var inner = emit(node.a);
            nodes.push({
                key: key, type: type,
                name: GATE_TYPE_CN[type] + " " + node.v,
                bindVar: node.v
            });
            links.push({ from: inner.key, frompid: inner.port, to: key, topid: "A" });
            return { key: key, port: "OUT" };
        }

        var a = emit(node.a);
        var b = emit(node.b);
        nodes.push({ key: key, type: type, name: GATE_TYPE_CN[type] });
        links.push({ from: a.key, frompid: a.port, to: key, topid: "A" });
        links.push({ from: b.key, frompid: b.port, to: key, topid: "B" });
        return { key: key, port: "OUT" };
    }

    var root = emit(gateTree);
    if (!root) { return { nodeArray: [], linkArray: [], error: "EMPTY_TREE" }; }

    links.push({ from: root.key, frompid: root.port, to: outKey, topid: "IN" });

    return { nodeArray: nodes, linkArray: links };
}

/* 统计门视图的规模，供界面展示 */
function GateViewStats(view) {
    var counts = {
        VAR: 0, AND: 0, OR: 0, NOT: 0, IMPLY: 0, IFF: 0, FORALL: 0, EXISTS: 0,
        gates: 0, total: 0, links: 0
    };
    (view.nodeArray || []).forEach(function (n) {
        if (undefined !== counts[n.type]) { counts[n.type]++; }
        if (GATE_GEOM[n.type] && GATE_GEOM[n.type].inputs.length) { counts.gates++; }
        counts.total++;
    });
    counts.links = (view.linkArray || []).length;
    return counts;
}
