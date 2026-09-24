var app = app || {};

/* ===========================================================================
 * 画布配色（与 style.css 的设计令牌同源，取自参考图实测色）
 * ---------------------------------------------------------------------------
 * 画布里的颜色由 JointJS 直接写进 SVG，CSS 变量到不了这里，所以在此集中定义，
 * 并与 style.css 的 --node-* / --line-* 保持一一对应。
 * ========================================================================*/
var CANVAS_PALETTE = {
    paper: '#FDFBF8',        /* 画布底：暖白 */
    gridFine: '#F4F0F2',     /* 细格 10px */
    gridCoarse: '#E7E0E5',   /* 粗格 50px */
    link: '#8E7F92',         /* 连线：暖紫灰 */
    portIn: '#4C4C7A',       /* 输入端口：藏青 */
    portOut: '#5F7A62',      /* 输出端口：苔绿 */
    ink: '#2A1F2E',          /* 深墨（浅底上的文字） */
    inkMuted: '#544458',     /* 次级墨（节点下方名称） */
    cream: '#FDFBF8',        /* 奶白（深底上的文字 / 图标） */
    /* 选择器视图的节点色 */
    nodeVar: '#8C3A4E',      /* 变量输入：酒红 */
    nodeSel: '#EFE2E8',      /* 选择器：浅腮红（数量最多，刻意做浅使其后退） */
    nodeZero: '#8E7F92',     /* 常量 0：雾紫 */
    nodeOne: '#5F7A62',      /* 常量 1：苔绿 */
    nodeOut: '#4C4C7A'       /* 输出：藏青 */
};

/* 依据底色明度选前景色：深底用奶白，浅底用深墨。
   原实现把节点文字一律写成白色，底色一改就会出现"白字白底"。 */
function textOn(fillHex) {
    var h = String(fillHex || '').replace('#', '');
    if (6 !== h.length) { return CANVAS_PALETTE.cream; }
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    /* 相对亮度（WCAG） */
    var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return (lum > 0.62) ? CANVAS_PALETTE.ink : CANVAS_PALETTE.cream;
}

/* ===========================================================================
 * 连线工厂与端口校验
 * 这两个必须在 Paper 初始化之前定义好 —— 创建 Paper 时就要引用它们。
 * ========================================================================*/

/* 连线外观：加箭头表示数据流向（原版是无方向的纯线） */
app.LINK_ATTRS = {
    line: {
        stroke: CANVAS_PALETTE.link,
        strokeWidth: 1.6,
        targetMarker: {
            type: 'path',
            d: 'M 9 -4 0 0 9 4 z',
            fill: CANVAS_PALETTE.link,
            stroke: 'none'
        }
    }
};

app.makeLink = function (src, dst) {
    var cfg = {
        smooth: true,
        connector: { name: 'jumpover', args: { size: 5 } },
        router: {
            name: 'metro',
            args: { step: 10, startDirections: ["right"], endDirections: ["left"] }
        },
        attrs: app.LINK_ATTRS
    };
    if (src) { cfg.source = src; }
    if (dst) { cfg.target = dst; }
    return new joint.shapes.standard.Link(cfg);
};

/* 取端口所属的分组（"in" / "out"）。
   不依赖 JointJS 的 getPort（v3.3.1 未必有），直接查模型上的 ports.items。 */
app.portGroup = function (model, portId) {
    if (!portId || !model || !model.get) { return null; }
    var ports = model.get('ports');
    if (!ports || !ports.items) { return null; }
    for (var i = 0; i < ports.items.length; i++) {
        if (ports.items[i].id === portId) { return ports.items[i].group; }
    }
    return null;
};

app.isOutputPort = function (model, portId) { return "out" === app.portGroup(model, portId); };
app.isInputPort = function (model, portId) { return "in" === app.portGroup(model, portId); };

/* 只允许「输出端 → 输入端」，且不允许自环。
   端口分组在两种视图里含义一致：Import/常量/门的输出是 out，门与 SEL 的输入是 in。 */
app.validateConnection = function (cellViewS, magnetS, cellViewT, magnetT) {
    if (!cellViewS || !cellViewT || cellViewS === cellViewT) { return false; }
    var portS = cellViewS.findAttribute ? cellViewS.findAttribute('port', magnetS) : null;
    var portT = cellViewT.findAttribute ? cellViewT.findAttribute('port', magnetT) : null;
    return app.isOutputPort(cellViewS.model, portS) && app.isInputPort(cellViewT.model, portT);
};

var origin = {
    nodeArray: [],
    linkArray: []
};

var chosedElement = {
    Nodes: new Set([]),
    Links: new Set([]),
    Routing: new Set([])
}

var graph = new joint.dia.Graph;

var paper = new joint.dia.Paper({
    el: document.getElementById('paper'),
    model: graph,
    width: 800,
    height: 600,
    gridSize: 10,
    /* 双层网格：细格 10px + 粗格 50px，方便对齐摆放。
       原版是纯色背景，看不出网格，用户反馈"画布是空白的"。 */
    drawGrid: {
        name: 'doubleMesh',
        args: [
            { color: CANVAS_PALETTE.gridFine, thickness: 1 },
            { color: CANVAS_PALETTE.gridCoarse, thickness: 1, scaleFactor: 5 }
        ]
    },
    background: {
        color: CANVAS_PALETTE.paper
    },
    /* 手动连线：允许从端口拖出连线；拖到空白处丢弃（不留悬空线头） */
    linkPinning: false,
    snapLinks: { radius: 24 },
    markAvailable: true,
    validateConnection: app.validateConnection,
    defaultLink: function () { return app.makeLink(); },
    /* 元素自由拖动；连线端点可拖动改接 */
    interactive: { elementMove: true, linkMove: true, arrowheadMove: true }

});

var startPoint = { x: 0, y: 0 };
var newScale = 1;
var originSize = { height: 0, width: 0, tx: 0, ty: 0 };
var mainContainer = $(".main-container");
var paperContainer = $("#paper-container");
var paperContent = $("#paper");

var VarPad = 50;

var miniScale = 0.1;
var miniMap = $(".mini-map");
var miniPaper = $("#mini-paper");
var miniPaperJ = new joint.dia.Paper({
    el: document.getElementById('mini-paper'),
    model: graph,
    width: 800 * miniScale,
    height: 600 * miniScale,
    background: {
        color: CANVAS_PALETTE.paper
    }

});
var miniView = $("#mini-view");
var appResize = $("#app-resize");


miniView.css({
    border: "2px solid #31d0c6",
    position: "absolute",
    backgroundColor: "rgba(250, 200, 200, 0.2)",
    cursor: "move"
});
var centerPivot = {
    left: (mainContainer.width() / 2 - paperContainer.position.left) * miniScale,
    top: (mainContainer.height() / 2 - paperContainer.position.top) * miniScale
};
var miniResize = $("#mini-resize");
var rightContainer = $(".right-container");

function setContainerAndMini() {
    var newWidth = paper.options.width + 200;
    var newHeight = paper.options.height + 100;
    var newTop = 0;
    var newLeft = 0;
    if (newWidth > (2 * newHeight)) {
        newHeight = newWidth / 2;
        newLeft = (newWidth - paper.options.width) / 2;
        newTop = (newHeight - paper.options.height) / 2;
    } else {
        newWidth = 2 * newHeight;
        newLeft = (newWidth - paper.options.width) / 2;
        newTop = (newHeight - paper.options.height) / 2;
    };
    paperContent.css({
        left: newLeft,
        top: newTop
    });

    miniScale = 300 / newWidth;
    paperContainer.css({ height: newHeight, width: newWidth });

    miniPaperJ.setDimensions(miniScale * paper.options.width, miniScale * paper.options.height);
    miniPaperJ.scaleContentToFit({ padding: VarPad * miniScale })


    miniPaper.css("left", miniScale * newLeft);
    miniPaper.css("top", miniScale * newTop);
    miniView.css({
        height: miniScale * mainContainer.height(), width: miniScale * mainContainer.width(),
        left: -1 * miniScale * paperContainer.position().left,
        top: -1 * miniScale * paperContainer.position().top
    });
}


miniMap.on(
    {
        "mousedown": function (evt) {
            evt.preventDefault();
            evt.stopPropagation();
            miniView.css({
                left: Math.round(evt.pageX - (miniView.width() / 2)),
                top: Math.round(evt.pageY - (miniView.height() / 2)),
            });
            paperContainer.css({
                left: -1 * Math.round(miniView.position().left / miniScale),
                top: -1 * Math.round(miniView.position().top / miniScale)
            });
            $("body").on("mousemove", function (evt) {
                miniView.css({
                    left: Math.round(evt.pageX - (miniView.width() / 2)),
                    top: Math.round(evt.pageY - (miniView.height() / 2)),
                });
                paperContainer.css({
                    left: -1 * Math.round(miniView.position().left / miniScale),
                    top: -1 * Math.round(miniView.position().top / miniScale)
                });

            });
            $("body").on("mouseup", function (evt) {
                $(this).off("mousemove mouseup");
            })
        }
    }
);
miniView.on(
    {
        "mousedown": function (evt) {
            evt.preventDefault();
            evt.stopPropagation();
            var tempX = evt.pageX;
            var tempY = evt.pageY;
            var tempLT = miniView.position();
            $("body").on("mousemove", function (evt) {
                miniView.css({
                    left: evt.pageX - tempX + tempLT.left,
                    top: evt.pageY - tempY + tempLT.top,
                });
                paperContainer.css({
                    left: -1 * Math.round(miniView.position().left / miniScale),
                    top: -1 * Math.round(miniView.position().top / miniScale)
                });

            });
            $("body").on("mouseup", function (evt) {
                $(this).off("mousemove mouseup");
            })
        }
    }
);
var contentSize = paper.getContentBBox();
var ERKeyNow = undefined;
const ERMask = joint.highlighters.mask;
const ERMaskRect = joint.dia.HighlighterView.extend({

    tagName: 'rect',

    attributes: {
        'stroke': 'red',
        'fill': '#fff000',
        'fill-opacity': 0.5,
        'pointer-events': 'none'
    },

    options: {
        padding: 5
    },

    // Method called to highlight a CellView
    highlight(_cellView, _node) {
        const { padding } = this.options;
        const bbox = _cellView.model.getBBox();
        // Highlighter is always rendered relatively to the CellView origin
        bbox.x = bbox.y = 0;
        // Increase the size of the highlighter
        bbox.inflate(padding);
        this.vel.attr(bbox.toJSON());
    },

    // Method called to unhighlight a CellView
    unhighlight(_cellView, _node) {
        // Cleaning required when the highlighter adds
        // attributes/nodes to the CellView or Paper.
        // This highlighter only renders a rectangle.
    }

});

const ERHighlightLink = function (id) {
    ERMask.add(paper.findViewByModel(id), 'body', 'highlight-red', {
        deep: true,
        attrs: {
            'stroke': '#FF4365',
            'stroke-width': 2
        }
    });
    ERMaskRect.add(graph.getCell(id).findView(miniPaperJ), 'root', 'highlight-mini', {
        layer: 'front' // "layer" is an option inherited from the base class
    });
    graph.getLinks().filter(function (cell) { return cell.attributes.source.id == id || cell.attributes.target.id == id }).forEach(function (cell) {
        chosedElement.Links.add(cell.id);
        ERMask.add(cell.findView(paper), 'line', 'highlight-yellow', {
            padding: 1,
            deep: true,
            attrs: {
                'stroke': '#fff000',
                'stroke-width': 2
            }
        });
    });
};
const ERUnhighlight = function (id) {
    if (undefined != graph.getCell(id)) {
        joint.dia.HighlighterView.remove(graph.getCell(id).findView(paper));
        joint.dia.HighlighterView.remove(graph.getCell(id).findView(miniPaperJ));
    }
};

/* ===========================================================================
 * 悬停工具：删除按钮与外框
 * ---------------------------------------------------------------------------
 * 原实现直接用 JointJS 默认的删除按钮，实测暴露两个问题：
 *   1. 按钮半径只有 7（直径 14px）—— 只有鼠标可用下限 24px 的 58%，
 *      瞄不准；而且原位置在元素方框外，鼠标容易滑出去。
 *   2. 鼠标一离开元素就立刻 removeTools()，于是"没点中滑出去 → 按钮消失 →
 *      只能重新悬停"，越急越点不中。
 *
 * 三处改进：
 *   · 直径放大到 26px（用 JointJS 的 r 与图标路径一起缩放），加白色描边
 *   · 位置挪到元素方框【斜上方外侧】，避开输出端口，也不会遮住节点内容
 *   · 隐藏加 360ms 宽限期（按 cell 各自计时），鼠标短暂离开不会被立刻抹掉
 *
 * 另外补了键盘删除作为兜底：选中元素后按 Delete / Backspace 即可删掉，
 * 永远比瞄准一个小圆更省事。
 * ========================================================================*/
var HOVER_TOOL = {
    radius: 13,        /* 直径 26px，满足鼠标可用的 24px 下限 */
    hideDelay: 360    /* 宽限期：给鼠标"移过去点"的时间 */
};

var toolHideTimers = {};   /* cellId -> timer，按元素各自计时，互不干扰 */

function cancelToolHide(id) {
    if (toolHideTimers[id]) {
        clearTimeout(toolHideTimers[id]);
        delete toolHideTimers[id];
    }
}

function scheduleToolHide(cellView) {
    if (!cellView || !cellView.model) { return; }
    var id = cellView.model.id;
    cancelToolHide(id);
    toolHideTimers[id] = setTimeout(function () {
        delete toolHideTimers[id];
        try {
            cellView.removeTools();
        } catch (e) {
            /* 元素在这期间已被删除：忽略即可 */
        }
    }, HOVER_TOOL.hideDelay);
}

/* ⚠️ 按钮尺寸必须靠【子类化覆盖 children】来改。
   实测：给 elementTools.Remove 传 attrs 选项【完全无效】——它的 children 里
   把 r 写死成 7，attrs 到不了那一层，按钮还是 14px。
   子类化覆盖 children 才生效（实测 r=13 / 直径 26px）。

   children 里同时把图标路径按比例放大（-3 → -5.5），否则圆变大了叉还是小小的。 */
var REMOVE_BTN_CHILDREN = [
    {
        tagName: "circle",
        selector: "button",
        attributes: {
            r: HOVER_TOOL.radius,
            fill: "#B23A3A",
            stroke: "#FFFFFF",
            "stroke-width": 2.5,
            cursor: "pointer"
        }
    },
    {
        tagName: "path",
        selector: "icon",
        attributes: {
            d: "M -5.5 -5.5 5.5 5.5 M -5.5 5.5 5.5 -5.5",
            fill: "none",
            stroke: "#FFFFFF",
            "stroke-width": 2.8,
            "stroke-linecap": "round",
            "pointer-events": "none"
        }
    }
];

var BigElementRemove = joint.elementTools.Remove.extend({ children: REMOVE_BTN_CHILDREN });
var BigLinkRemove = joint.linkTools.Remove.extend({ children: REMOVE_BTN_CHILDREN });

function showElementTools(elementView) {
    if (!elementView || !elementView.model) { return; }
    cancelToolHide(elementView.model.id);
    elementView.removeTools();
    elementView.addTools(new joint.dia.ToolsView({
        tools: [
            new BigElementRemove({
                useModelGeometry: true,
                x: "100%",
                y: "0%",
                /* 往左上各挪一个半径：按钮落在方框斜上方外侧。
                   这样不会压住输出端口（端口在中部）也不会遮住节点内容，
                   同时仍在元素附近，鼠标不用长距离移动。 */
                offset: { x: -HOVER_TOOL.radius, y: -HOVER_TOOL.radius }
            }),
            new joint.elementTools.Boundary({
                focusOpacity: 0.5,
                padding: 10,
                useModelGeometry: true
            })
        ]
    }));
}

function showLinkTools(linkView) {
    if (!linkView || !linkView.model) { return; }
    cancelToolHide(linkView.model.id);
    linkView.removeTools();
    linkView.addTools(new joint.dia.ToolsView({
        tools: [
            new BigLinkRemove({
                useModelGeometry: true,
                /* 连线用方框中点再往上抬，比原来的"方框右上角"更靠近视线落点 */
                x: "50%",
                y: "50%",
                offset: { x: 0, y: -(HOVER_TOOL.radius + 8) }
            }),
            new joint.linkTools.Boundary({
                focusOpacity: 0.5,
                padding: 3,
                useModelGeometry: true
            })
        ]
    }));
}

/* 删除当前选中的元素（键盘快捷键与删除按钮共用） */
function deleteSelectedCell() {
    var id = ERKeyNow;
    if (undefined === id || null === id) { return false; }
    var cell = graph.getCell(id);
    if (!cell) { return false; }

    var what = (cell.isLink && cell.isLink()) ? "连线" : "元素";
    cancelToolHide(id);
    cell.remove();
    ERKeyNow = undefined;
    chosedElement.Nodes.delete(id);
    chosedElement.Links.delete(id);
    chosedElement.Routing.delete(id);
    fillPropsPanel(null);
    updateCanvasHint();
    app.save();
    setStatus("已删除该" + what + "。", "info");
    return true;
}

paper.on({
    'cell:pointerup': function (cellView) {
        var contentSize2 = paper.getContentBBox();
        var changex = Math.abs(contentSize2.width - contentSize.width);
        var changey = Math.abs(contentSize2.height - contentSize.height);

        if (changex > 20 * newScale || changey > 20 * newScale) {
            VarPad = 50 * newScale;
            paper.fitToContent({
                padding: VarPad,
                allowNewOrigin: "any"
            });
            setContainerAndMini();
            contentSize = contentSize2;
        }
        else {

        }

    },
    'blank:pointerdown': function (evt) {
        startPoint.x = evt.clientX;
        startPoint.y = evt.clientY;
        var nowOffSet = paperContainer.position();
        $("body").on("mousemove", function (evt) {
            var changes = {
                x: evt.clientX - startPoint.x,
                y: evt.clientY - startPoint.y
            };
            var newtop = nowOffSet.top + changes.y;
            var newleft = nowOffSet.left + changes.x;

            paperContainer.css({
                top: newtop,
                left: newleft
            });

            miniView.css({
                height: miniScale * mainContainer.height(), width: miniScale * mainContainer.width(),
                left: -1 * miniScale * paperContainer.position().left,
                top: -1 * miniScale * paperContainer.position().top
            });

        });
        $("body").on("mouseup", function (evt) {
            $(this).off("mousemove mouseup");
        });


    },
    'blank:pointerdblclick': function (evt) {
        /*highlight off */

        chosedElement.Nodes.forEach(ERUnhighlight);

        chosedElement.Links.forEach(ERUnhighlight);
        chosedElement.Routing.forEach(ERUnhighlight);
        chosedElement.Nodes.clear();

        chosedElement.Links.clear();
        chosedElement.Routing.clear();
        /* graph.getCells().forEach(function (cell) {
            joint.dia.HighlighterView.remove(cell.findView(paper));
        }) */
    },
    'element:mouseenter': function (elementView) {
        showElementTools(elementView);
    },
    'link:mouseenter': function (linkView) {
        showLinkTools(linkView);
    },
    'element:pointerclick': function (elementView) {
        ERKeyNow = elementView.model.id;
        chosedElement.Nodes.add(ERKeyNow);
        ERHighlightLink(ERKeyNow);

        /* 统一走 fillPropsPanel：门节点没有 label 属性，
           原实现直接读 attr().label.text 会抛 TypeError（点门就报错） */
        fillPropsPanel(elementView.model);

        /* 刻意【不】自动跳到「属性」页：用户可能正在看真值表或模型，
           一点节点就被拽走会很烦。改为在状态栏提示去哪儿改 —— 既不打断，
           也让人知道"这个还能改名"。（「手动添加」走的是 selectCell，
           那条路径会主动跳到属性页，因为刚建完节点就是要命名。） */
        var nmAttr = elementView.model.attr() || {};
        var shown = (nmAttr.name && nmAttr.name.text) ? nmAttr.name.text
            : (nmAttr.symbol && nmAttr.symbol.text) ? nmAttr.symbol.text
                : (elementView.model.get("nodeType") || "元素");
        setStatus("已选中「" + shown + "」。可在「属性」页改标签与名称，按 Delete 删除。", "info");
    },
    'cell:mouseleave': function (cellView) {
        /* 延迟隐藏，给用户"把鼠标移到删除按钮上"的时间。
           原实现是立即 removeTools()，鼠标一旦没点中滑出去按钮就消失，
           越点不中越消失。 */
        scheduleToolHide(cellView);
    },
    'blank:contextmenu': function (evt, x, y) {
        /* 原实现是用 alert 弹出坐标（调试残留，会打断操作）。
           改为写状态栏，并阻止浏览器右键菜单。 */
        if (evt && evt.preventDefault) { evt.preventDefault(); }
        setStatus("画布坐标： left " + Math.round(x) + " · top " + Math.round(y), "info");
    }/* ,
    'cell:mouseover': function (cellView, evt) {
        var pos = paper.clientToLocalPoint(evt.clientX, evt.clientY);
        document.getElementById("pointx").textContent = pos.x;
        document.getElementById("pointy").textContent = pos.y;
    },
    'blank:mouseover': function (evt) {
        var pos = paper.clientToLocalPoint(evt.clientX, evt.clientY);
        document.getElementById("pointx").textContent = pos.x;
        document.getElementById("pointy").textContent = pos.y;
    } */
});
function viewScale(rate) {
    originSize = {
        width: paper.options.width,
        height: paper.options.height,
        tx: paper.translate().tx,
        ty: paper.translate().ty
    };
    var centerX = mainContainer.width() / 2;
    var centerY = mainContainer.height() / 2;
    centerPivot = {
        left: (centerX - paperContainer.position().left) * miniScale,
        top: (centerY - paperContainer.position().top) * miniScale
    }

    newScale = newScale * rate;
    if (newScale > 0.1 && newScale < 10) {
        //paper.scale(newScale, newScale, p.x, p.y);
        originSize = {
            width: rate * originSize.width,
            height: rate * originSize.height,
            tx: rate * originSize.tx,
            ty: rate * originSize.ty
        };
        VarPad = 50 * newScale;
        paper.setDimensions(originSize.width, originSize.height);
        paper.scaleContentToFit({ padding: VarPad });
        //paper.translate(originSize.tx, originSize.ty);

        setContainerAndMini();
        paperContainer.css({
            left: centerX - (centerPivot.left / miniScale),
            top: centerY - (centerPivot.top / miniScale)
        });
        miniView.css({
            left: -1 * miniScale * paperContainer.position().left,
            top: -1 * miniScale * paperContainer.position().top
        });
    }
    else {
        newScale = newScale / rate;
    }
}
//paper.$el
mainContainer.on('mousewheel DOMMouseScroll', function (e) {
    //function onMouseWheel(e){
    e.preventDefault();
    // e = e.originalEvent;
    // e.stopPropagation();
    var delta = Math.max(-1, Math.min(1, (e.wheelDelta || -e.detail))) / 10;
    var rate = (newScale + delta) / newScale;
    var p = paper.clientToLocalPoint({ x: e.clientX, y: e.clientY });
    viewScale(rate);
    //console.log(' delta' + delta + ' ' + 'offsetX' + p.x + 'offsety' + p.y + 'newScale' + newScale)
});

miniResize.on(
    {
        "mousedown": function (evt) {
            evt.preventDefault();
            evt.stopPropagation();
            centerPivot = {
                left: miniView.width() / 2 + miniView.position().left,
                top: miniView.height() / 2 + miniView.position().top
            };
            $("body").on("mousemove", function (evt) {
                var rate = miniView.width() / (2 * (evt.pageX - centerPivot.left));
                if ((10 / rate) > newScale) {
                    viewScale(rate);
                } else {
                    rate = 10 / newScale;
                    viewScale(rate);
                }
            });
            $("body").on("mouseup", function (evt) {
                $(this).off("mousemove mouseup");
            })
        }
    }
);

appResize.on({
    "mousedown": function (evt) {
        evt.preventDefault();
        evt.stopPropagation();
        var tempX = evt.pageX;
        var tempRight1 = parseInt(appResize.css("right").split("px")[0]);
        $("body").on("mousemove", function (evt) {
            var xDelta = Math.round(tempX - evt.pageX) + tempRight1;
            appResize.css({
                right: xDelta
            });
            rightContainer.css({
                width: xDelta
            });
            mainContainer.css({
                right: xDelta + 6
            })

        });
        $("body").on("mouseup", function (evt) {
            $(this).off("mousemove mouseup");
        })
    }
})

app.ResizeBlock = function () {
    /* 窄屏堆叠布局下右侧面板由 CSS 接管（全宽、绝对定位），
       这里若继续写行内 width/right 会与媒体查询打架，故直接返回。 */
    if (isNarrowLayout()) { return; }
    if (rightContainer.width() < 280) {
        appResize.css({
            right: 300
        });
        rightContainer.css({
            width: 300
        });
        mainContainer.css({
            right: 306
        });
        appResize.children().css({ "background-image": "url(assets/box-arrow-in-right.svg)" });
    } else {
        appResize.css({
            right: 0
        });
        rightContainer.css({
            width: 0
        });
        mainContainer.css({
            right: 6
        });
        appResize.children().css({ "background-image": "url(assets/box-arrow-in-left.svg)" });
    }
}

$("body").on('keydown', function (e) {
    // e.preventDefault();
    // e = e.originalEvent;
    // e.stopPropagation();

    /* Delete / Backspace 删除当前选中元素。
       小按钮点不中的兜底 —— 选中后按键删除永远比瞄准 26px 的圆更省事。
       在输入框里打字时不触发。 */
    if (46 === e.which || 8 === e.which) {
        var tgt = e.target || {};
        var tag = String(tgt.tagName || "").toLowerCase();
        if ("input" === tag || "textarea" === tag || tgt.isContentEditable) { return; }
        if (undefined === ERKeyNow || null === ERKeyNow || !graph.getCell(ERKeyNow)) { return; }
        e.preventDefault();
        deleteSelectedCell();
        return;
    }

    if (e.altKey) {
        var delta = 0.2;
        if (38 == e.which) {
            var rate = (newScale + delta) / newScale;
            viewScale(rate);
        } else if (40 == e.which) {
            var rate = (newScale - delta) / newScale;
            viewScale(rate);
        } else if (219 == e.which || 221 == e.which) {
            app.ResizeBlock();
        }
    }
    //console.log(' delta' + delta + ' ' + 'offsetX' + p.x + 'offsety' + p.y + 'newScale' + newScale)
});


const status = document.getElementById('status');

/* ===========================================================================
 * 状态栏 / 布局重算（改造新增）
 * ========================================================================*/
function setStatus(text, kind) {
    status.textContent = text;
    status.className = "status-" + (kind || "info");
}

/* 当前是否处于窄屏堆叠布局（与 style.css 里 @media (max-width: 900px) 保持一致） */
function isNarrowLayout() {
    return !!(window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
}

/* 窄屏专用：把画布尺寸压到与可视区一致，再由 scaleContentToFit 把内容整体缩进视口。
   ⚠️ 只在窄屏走这条路。宽屏上「画布大于视口」是平移机制的基础，
      而且缩放记账（newScale / VarPad / setContainerAndMini 三者互相耦合）不该轻动。 */
function fitCanvasToViewport(w, h) {
    newScale = 1;
    paper.setDimensions(Math.max(240, w - 24), Math.max(160, h - 24));
    if (graph && graph.getCells().length) {
        paper.scaleContentToFit({ padding: 12 });
    }
}

/* 容器尺寸变化后重新把画布居中并同步小地图。
   注意【不重跑】dagre 布局：节点位置已经算好，重跑只会做无用功。
   这里只做适配 + 容器/小地图同步，成本低且不会改变图形形状。 */
function relayout() {
    if (!mainContainer || !mainContainer.length) { return; }
    var w = mainContainer.width();
    var h = mainContainer.height();
    if (!w || !h) { return; }
    try {
        if (isNarrowLayout()) {
            fitCanvasToViewport(w, h);
        } else if (graph && graph.getCells().length) {
            newScale = 1;
            paper.fitToContent({ padding: 50, allowNewOrigin: "any" });
        }
        setContainerAndMini();
        paperContainer.css({
            left: Math.round((w - paperContainer.width()) / 2),
            top: Math.round((h - paperContainer.height()) / 2),
            position: "absolute"
        });
        miniView.css({
            height: miniScale * h,
            width: miniScale * w,
            left: -1 * miniScale * paperContainer.position().left,
            top: -1 * miniScale * paperContainer.position().top
        });
    } catch (e) {
        /* 布局重算失败不应打断页面交互 */
    }
}

/* 视口尺寸变化 -> 防抖后重算画布。窄屏切换布局方向后必须触发一次，
   否则画布仍按旧容器尺寸计算，会出现错位。 */
var relayoutTimer = null;
function scheduleRelayout() {
    if (relayoutTimer) { clearTimeout(relayoutTimer); }
    relayoutTimer = setTimeout(function () {
        relayoutTimer = null;
        relayout();
    }, 160);
}
$(window).on("resize orientationchange", scheduleRelayout);

app.makeNode = function (theKey, theLabel, theName, theColor, theImgPath, thePorts) {
    var portColor = "#61549c";
    var theWidth = 100;
    var theHeight = 100;

    var nodeAttrs = {
        /* label 渲染在节点【上方】（画布底上），所以用次级墨色，
           不能跟随底色 —— 否则浅色画布上会出现白字白底 */
        label: {
            text: theLabel,
            fontSize: 11,
            fontFamily: 'monospace',
            fill: CANVAS_PALETTE.inkMuted,
            fontWeight: 'normal'
        },
        body: {
            fill: theColor,
            width: "100%",
            height: "100%",
            rx: 8,
            ry: 8,
            stroke: 'rgba(42,31,46,0.14)',
            strokeWidth: 1
        },
        image: {
            "xlink:href": theImgPath,
            width: 48,
            height: 48, x: theWidth / 2 - 24, y: theHeight / 2 - 24
        },
        /* name 渲染在节点【内部】下方，所以要按底色明度取反，保证对比度 */
        name: {
            text: theName,
            fontSize: 12,
            fontFamily: 'monospace',
            fill: textOn(theColor),
            fontWeight: 'bold'
        }
    };

    var nodeMarkup = [
        {
            tagName: 'rect',
            selector: 'body',
        },
        {
            tagName: 'text',
            selector: 'label',
            attributes: {
                y: -2 * theHeight / 5
            }
        },
        {
            tagName: "image",
            selector: "image"
        },
        {
            tagName: 'text',
            selector: 'name',
            attributes: {
                transform: "matrix(1,0,0,1," + theWidth / 2 + "," + 8 * theHeight / 10 + ")",
                "text-anchor": "middle",

            }
        }];

    return new joint.shapes.standard.Rectangle({
        id: theKey,
        size: { width: theWidth, height: theHeight },
        /* nodeType 不参与渲染（markup 里没有对应 selector），
           仅用于「图转文本」时把节点类型写回 JSON。
           原实现用 attrs.label.text 当类型，但「保存修改」会改写 label.text，
           导致改名后类型丢失 —— 因此用独立属性固化，保证可往返。 */
        nodeType: theLabel,
        attrs: nodeAttrs,
        markup: nodeMarkup,
        ports: {
            groups: {
                in: {
                    attrs: {
                        portBody: { magnet: true, fill: portColor, stokeWidth: 0 },
                        portLabel: { fill: portColor, fontSize: 11, fontWeight: "Normal" }
                    },
                    markup: [{
                        tagName: "rect",
                        selector: "portBody",
                        attributes: {
                            height: 10,
                            width: 10,
                            x: -5,
                            y: -5
                        }
                    },
                    {
                        tagName: "text",
                        selector: "portLabel",
                        attributes: {
                            x: 6,
                            y: 3
                        }
                    }],
                    position: { name: "left" }
                },
                out: {
                    attrs: {
                        portBody: { magnet: true, fill: portColor, stokeWidth: 0 },
                        portLabel: { fill: portColor, fontSize: 11, fontWeight: "Normal" }
                    },
                    markup: [{
                        tagName: "rect",
                        selector: "portBody",
                        attributes: {
                            height: 10,
                            width: 10,
                            x: -5,
                            y: -5
                        }
                    },
                    {
                        tagName: "text",
                        selector: "portLabel",
                        attributes: {
                            x: -6,
                            y: 3,
                            "text-anchor": "end"
                        }
                    }],
                    position: { name: "right" }
                }
            },
            items: thePorts
        }
    });
};
app.nodeCreate = function (theNode) {
    /* 逻辑门类型（AND/OR/NOT/IMPLY/IFF/FORALL/EXISTS/VAR/0/1/Export）走门渲染 */
    var gateNode = app.makeGateNode(theNode);
    if (gateNode) { return gateNode; }

    var result = {};
    if ("0" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            CANVAS_PALETTE.nodeZero,
            "assets/zero.svg",
            [{ group: "out", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("1" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            CANVAS_PALETTE.nodeOne,
            "assets/one.svg",
            [{ group: "out", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("Import" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            CANVAS_PALETTE.nodeVar,
            "assets/input.svg",
            [{ group: "out", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("Export" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            CANVAS_PALETTE.nodeOut,
            "assets/output.svg",
            [{ group: "in", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("SEL" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            "",
            CANVAS_PALETTE.nodeSel,
            "assets/SEL.svg",
            [{
                group: "in", id: "SI",
                attrs: { portLabel: { text: "SI" } }
            },
            {
                group: "in", id: "0", attrs: { portLabel: { text: "0" } }
            },
            {
                group: "in", id: "1", attrs: { portLabel: { text: "1" } }
            },
            { group: "out", id: "SO", attrs: { portLabel: { text: "SO" } } },
            { group: "out", id: "N", attrs: { portLabel: { text: "N" } } },
            { group: "out", id: "P", attrs: { portLabel: { text: "P" } } }]

        );
    };
    return result;
};
app.linkCreate = function (theNode) {
    return app.makeLink(
        { id: theNode.from, magnet: "portBody", port: theNode.frompid },
        { id: theNode.to, magnet: "portBody", port: theNode.topid }
    );
};

/* ===========================================================================
 * 逻辑门节点渲染
 * ---------------------------------------------------------------------------
 * 几何与符号路径来自 GateView.js 的 GATE_GEOM（纯数据），这里只负责把它
 * 变成 JointJS 模型。与/或/非用 standard.Path 画标准逻辑符号；
 * 推出、等价、量词不是基本门，按电路图惯例用带符号的方框。
 * ========================================================================*/

/* 各门符号文字的画法位置（局部坐标） */
var GATE_SYMBOL_POS = {
    AND: { x: 36, y: 34 },
    OR: { x: 36, y: 34 },
    NOT: { x: 22, y: 34 },
    IMPLY: { x: 48, y: 27 },
    IFF: { x: 48, y: 27 },
    FORALL: { x: 44, y: 24 },
    EXISTS: { x: 44, y: 24 }
};

/* 各门的外观配色 */
var GATE_STYLE = {
    /* 逻辑门统一走藏青家族：一个门就是一个门，不必用颜色区分运算类型，
       形状（D 形 / 月牙形 / 三角）已经说清楚了 */
    AND: { fill: "#EDEDF5", stroke: "#4C4C7A" },
    OR: { fill: "#EDEDF5", stroke: "#4C4C7A" },
    IMPLY: { fill: "#EDEDF5", stroke: "#4C4C7A" },
    IFF: { fill: "#EDEDF5", stroke: "#4C4C7A" },
    /* 非门是唯一的一元门，挪到雾紫家族以作区别 */
    NOT: { fill: "#F2EDF2", stroke: "#7A6B7E" },
    /* 量词盒：酒红家族，和"门"区分开 */
    FORALL: { fill: "#F6EBEF", stroke: "#7A3A4E" },
    EXISTS: { fill: "#F6EBEF", stroke: "#7A3A4E" },
    /* 数据来源与结果：苔绿 / 藏青 */
    VAR: { fill: "#E4E8D8", stroke: "#5F7A62" },
    CONST1: { fill: "#5F7A62", stroke: "#4A6349" },
    CONST0: { fill: "#8E7F92", stroke: "#6B5A6E" },
    OUT: { fill: "#DCDDEE", stroke: "#3E3E68" }
};

/* 门节点的端口分组：用绝对坐标摆放，保证落在符号的引线上 */
function gatePortGroups() {
    return {
        in: {
            position: { name: "absolute", args: { x: 0, y: 0 } },
            attrs: {
                portBody: { magnet: true, fill: CANVAS_PALETTE.portIn, stroke: "#3E3E68", strokeWidth: 1 },
                portLabel: { fill: CANVAS_PALETTE.inkMuted, fontSize: 10, fontWeight: "Normal" }
            },
            markup: [
                { tagName: "rect", selector: "portBody", attributes: { height: 8, width: 8, x: -4, y: -4, rx: 2 } },
                { tagName: "text", selector: "portLabel", attributes: { x: -8, y: 3, "text-anchor": "end" } }
            ]
        },
        out: {
            position: { name: "absolute", args: { x: 0, y: 0 } },
            attrs: {
                portBody: { magnet: true, fill: CANVAS_PALETTE.portOut, stroke: "#4A6349", strokeWidth: 1 },
                portLabel: { fill: CANVAS_PALETTE.inkMuted, fontSize: 10, fontWeight: "Normal" }
            },
            markup: [
                { tagName: "rect", selector: "portBody", attributes: { height: 8, width: 8, x: -4, y: -4, rx: 2 } },
                { tagName: "text", selector: "portLabel", attributes: { x: 8, y: 3, "text-anchor": "start" } }
            ]
        }
    };
}

/* 返回 JointJS 模型；theNode.type 不是门类型时返回 null，由调用方走原有分支 */
app.makeGateNode = function (theNode) {
    var type = theNode.type;
    /* 门视图用 CONST0 / CONST1 / GateOut，与选择器视图的 "0"/"1"/"Export" 区分开 */
    var isConst = ("CONST0" === type || "CONST1" === type);
    var isOut = ("GateOut" === type);
    var geomKey = isConst ? "CONST" : (isOut ? "OUT" : type);
    var geom = GATE_GEOM[geomKey];
    if (!geom) { return null; }

    var w = geom.w, h = geom.h;
    var styleKey = isConst ? type : (isOut ? "OUT" : type);
    var style = GATE_STYLE[styleKey] || GATE_STYLE.VAR;

    /* 符号文字与下方名称。
       名称的位置分两种：门/量词放在图形下方；变量输入放在胶囊内部居中。 */
    var symbolText = "";
    var nameText = theNode.name || "";
    var symbolSize = 20;
    var nameBelow = true;

    if (isConst) {
        symbolText = ("CONST1" === type) ? "1" : "0";
        symbolSize = 16;
        nameText = "";                      /* 常量只看里面的 1/0，不再另加名称 */
    } else if (isOut) {
        symbolText = "输出";
        symbolSize = 13;
        nameText = "";
    } else if ("VAR" === type) {
        symbolText = "";                    /* 变量名直接用 name 居中显示 */
        nameText = theNode.name || "变量";
        nameBelow = false;
    } else {
        symbolText = geom.symbol;
    }

    var symPos = GATE_SYMBOL_POS[type] || { x: w / 2, y: h / 2 };
    if ("VAR" === type || isConst || isOut) { symPos = { x: w / 2, y: h / 2 }; }

    /* ---- 造型 ----
       ⚠️ 门形不能写进 standard.Path 的 body.d。
       该形状在设置尺寸时会用自身默认路径（M 0 0 H calc(w) V calc(h) H 0 Z）
       覆盖掉自定义的 d —— 实测 D 形会静默退化成矩形（模型里 d 是对的，渲染出来是矩形）。

       所以基类统一用 standard.Rectangle，造型交给自定义选择器 `gate`：
       Rectangle 只认 body / label，不会去动 gate。文字设成不接收指针事件，
       拖拽与端口连线都靠 gate 形状本身。 */
    var attrs = {};
    var markup = [];

    if (geom.path) {
        markup.push({ tagName: "path", selector: "gate" });
        attrs.gate = {
            d: geom.path,
            fill: style.fill,
            stroke: style.stroke,
            strokeWidth: 1.6,
            strokeLinejoin: "round"
        };
    } else {
        markup.push({ tagName: "rect", selector: "gate" });
        attrs.gate = {
            width: w, height: h,
            rx: geom.capsule ? h / 2 : 6,
            ry: geom.capsule ? h / 2 : 6,
            fill: style.fill, stroke: style.stroke, strokeWidth: 1.4
        };
    }

    if (geom.circle) {
        markup.push({ tagName: "circle", selector: "bubble" });
        attrs.bubble = {
            cx: geom.circle.cx, cy: geom.circle.cy, r: geom.circle.r,
            fill: "#ffffff", stroke: style.stroke, strokeWidth: 1.6,
            pointerEvents: "none"
        };
    }

    markup.push({
        tagName: "text", selector: "symbol",
        attributes: { "text-anchor": "middle", "dominant-baseline": "central" }
    });
    attrs.symbol = {
        text: symbolText,
        x: symPos.x, y: symPos.y,
        fontSize: symbolSize,
        /* 随底色明度取反：浅底用深墨、深底用奶白 */
        fill: textOn(style.fill),
        fontFamily: "'TsangerYuYangT03', 'Segoe UI', sans-serif",
        fontWeight: "500"
    };

    if (nameText) {
        markup.push({
            tagName: "text", selector: "name",
            attributes: {
                "text-anchor": "middle",
                "dominant-baseline": nameBelow ? "hanging" : "central",
                "pointer-events": "none"
            }
        });
        attrs.name = {
            text: nameText,
            x: w / 2,
            y: nameBelow ? (h + 3) : (h / 2),
            fontSize: nameBelow ? 11 : 14,
            fill: nameBelow ? CANVAS_PALETTE.inkMuted : CANVAS_PALETTE.ink,
            fontFamily: "'TsangerYuYangT03', 'Segoe UI', sans-serif",
            fontWeight: nameBelow ? "400" : "500"
        };
    } else {
        /* 没有可见名称时也要保留 attrs.name —— ELDump 靠它还原 JSON 的 name 字段 */
        attrs.name = { text: "" };
    }

    var ports = [];
    geom.inputs.forEach(function (p) {
        ports.push({ group: "in", id: p.id, args: { x: p.x, y: p.y }, attrs: { portLabel: { text: p.id } } });
    });
    if (geom.out) {
        ports.push({ group: "out", id: "OUT", args: { x: geom.out.x, y: geom.out.y } });
    }

    /* 必须用带合法 type 字符串的具名形状：直接 new joint.dia.Element 基类没有 type，
       graph.resetCells 会报 "cell type must be a string"。
       统一用 Rectangle —— Path 会覆盖自定义 d（见上），Rectangle 不会碰 gate 选择器。 */
    var Shape = joint.shapes.standard.Rectangle;

    return new Shape({
        id: theNode.key,
        position: { x: 0, y: 0 },
        size: { width: w, height: h },
        /* nodeType 承载节点类型，供「图转文本」写回 JSON（与选择器视图同一套机制） */
        nodeType: type,
        attrs: attrs,
        markup: markup,
        ports: { groups: gatePortGroups(), items: ports }
    });
};
app.ELCreate = function (GraphDesc) {
    var result = [];
    for (oneNode of GraphDesc.nodeArray) {
        result.push(app.nodeCreate(oneNode));
    }
    for (oneLink of GraphDesc.linkArray) {
        result.push(app.linkCreate(oneLink));
    }
    return result;
};
app.ELDump = function (JsonCells) {
    var result = {
        nodeArray: [],
        linkArray: []
    };
    for (oneElem of JsonCells) {
        if ("standard.Link" == oneElem.type) {
            result.linkArray.push({
                "from": oneElem.source.id,
                "frompid": oneElem.source.port,
                "to":oneElem.target.id,
                "topid":oneElem.target.port
            });
        }
        else {
            /* 优先读 nodeType（改造新增，不受改名影响）；
               回退到 attrs.label.text 以兼容改造前生成的图与旧 JSON。 */
            var elemType = (oneElem.nodeType) || (oneElem.attrs && oneElem.attrs.label ? oneElem.attrs.label.text : null);
            if ("SEL" == elemType) {
                result.nodeArray.push({
                    "key": oneElem.id,
                    "type": "SEL"
                });
            } else {
                result.nodeArray.push({
                    "key": oneElem.id,
                    "type": elemType,
                    /* 手改过的 JSON 或早期生成的图可能没有 name，这里兜底避免抛异常 */
                    "name": (oneElem.attrs && oneElem.attrs.name && undefined !== oneElem.attrs.name.text)
                        ? oneElem.attrs.name.text : ""
                });
            }
        }
    };
    return result;
}


/* ===========================================================================
 * 状态栏、量词前缀条与规模统计（改造新增）
 * ========================================================================*/

/* 把量词记录渲染成画布上方的只读前缀条。
   展示顺序取【由外到内】：quantLog 按应用顺序（内层先）记录，因此倒序输出。 */
function renderQuantPrefix(quant) {
    var strip = document.getElementById("quant-prefix");
    if (!strip) { return; }
    var list = (quant || []).slice().reverse();
    var html = '';
    if (0 === list.length) {
        html = '<span class="qp-empty">本表达式不含量词</span>';
    } else {
        html = '<span class="qp-label">量词前缀</span>';
        for (var i = 0; i < list.length; i++) {
            var q = list[i];
            var sym = ("exists" === q.type) ? "∃" : "∀";
            var word = ("exists" === q.type) ? "存在" : "全称";
            html += '<span class="qp-item qp-' + q.type + '" title="' + word + '量词">'
                + '<i>' + sym + '</i>' + escapeHtml(q["var"]) + '</span>';
        }
    }
    strip.innerHTML = html;
}

/* 量词前缀的来源：
   1) 本会话刚解析过 -> 直接用解析结果
   2) 从 JSON 载入 -> 读顶层可选字段 quantPrefix
   两者都没有时返回空数组（等价于「不含量词」）。 */
function quantFromModel(model) {
    if (model && model.quantPrefix instanceof Array) {
        return model.quantPrefix;
    }
    return [];
}

/* 当前图中模型携带的量词前缀。app.save() 会把它写回 JSON，
   保证「解析 -> 图转文本 -> 文本转图」这条往返链路不丢量词信息。 */
var currentQuant = [];

/* 规模统计：解析路径走 model（有变量数/路径数），
   JSON 载入路径走 graphDesc（只能统计节点数） */
function renderStats(model, graphDesc) {
    var stats = document.getElementById("stats");
    if (!stats) { return; }
    if (model) {
        stats.textContent = "变量 " + model.order.length + " · 路径 " + model.value.length;
        return;
    }
    if (graphDesc) {
        var arr = graphDesc.nodeArray || [];
        var importCount = arr.filter(function (n) { return n && "Import" === n.type; }).length;
        stats.textContent = "变量 " + importCount + " · 节点 " + arr.length;
        return;
    }
    stats.textContent = "";
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
}

/* ===========================================================================
 * 解析流程
 * ---------------------------------------------------------------------------
 * · 两种输入记法：中缀（默认，好读）/ 后缀（逆波兰）
 *   中缀先翻译成后缀，再走完全相同的既有管线 —— 下游零改动，不可能引入回归
 * · 实时预览：输入防抖 400ms 自动解析；失败时【保留上一张图】，只在输入框下报错，
 *   避免用户打到一半就被清空画布
 * · 两种视图：选择器（化简后的 MUX 网络）/ 逻辑门（原表达式的门电路）
 * ========================================================================*/

var appState = {
    inputMode: "infix",     /* "infix" | "rpn" */
    viewMode: "selector",   /* "selector" | "gate" */
    lastRpn: "",            /* 最近一次成功解析所用的后缀式 */
    lastExpr: "",           /* 最近一次成功解析的原始输入 */
    lastQuant: [],
    lastModel: null,        /* 选择器视图：cube 路径集 */
    lastGateTree: null,     /* 逻辑门视图：运算符树 */
    previewTimer: null
};

/* ---------------- 输入框内联错误 ---------------- */
function repeatChar(ch, n) {
    var s = "";
    for (var i = 0; i < n; i++) { s += ch; }
    return s;
}

/* 在输入框下方标红报错；带位置时附一行指位符 */
function showInlineError(message, text, index, length) {
    var box = document.getElementById("inline-error");
    var ta = document.getElementById("ReversePol");
    if (!box) { return; }
    box.innerHTML = "";

    var msg = document.createElement("div");
    msg.className = "ie-msg";
    msg.textContent = message;
    box.appendChild(msg);

    if ("number" === typeof index && text && text.length) {
        var at = Math.max(0, Math.min(index, text.length));
        var width = Math.max(1, length || 1);
        if (at + width > text.length) { width = Math.max(1, text.length - at); }
        var pre = document.createElement("pre");
        pre.textContent = text + "\n" + repeatChar(" ", at) + repeatChar("^", width);
        box.appendChild(pre);
    }
    box.hidden = false;
    if (ta) { ta.classList.add("is-invalid"); }
}

function clearInlineError() {
    var box = document.getElementById("inline-error");
    var ta = document.getElementById("ReversePol");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    if (ta) { ta.classList.remove("is-invalid"); }
}

/* ---------------- 画布重建 ---------------- */
function buildCurrentView() {
    if ("gate" === appState.viewMode) {
        if (!appState.lastGateTree) { return { nodeArray: [], linkArray: [] }; }
        return GateViewGen(appState.lastGateTree);
    }
    if (!appState.lastModel) { return { nodeArray: [], linkArray: [] }; }
    return ViewGen(appState.lastModel);
}

function updateCanvasHint() {
    var hint = document.getElementById("canvas-hint");
    if (!hint) { return; }
    hint.hidden = graph.getCells().length > 0;
}

/* 按当前视图重建画布，并把结果同步到「模型」JSON、真值表与本地存档 */
function renderCurrentView() {
    var view = buildCurrentView();
    if (view.error) {
        setStatus("图形生成失败：" + view.error, "error");
        return null;
    }
    origin = view;
    currentQuant = appState.lastQuant || [];
    if (currentQuant.length) { origin.quantPrefix = currentQuant; }
    document.getElementById("myModel").value = JSON.stringify(origin);

    app.updateGraph();
    updateCanvasHint();
    renderQuantPrefix(currentQuant);
    renderStats(appState.lastModel);
    renderTruthTable();
    persistWorkspace();
    return view;
}

/* ---------------- 解析主流程 ---------------- */
app.parseLogic = function (opts) {
    var force = !!(opts && opts.force);
    var src = document.getElementById("ReversePol").value;

    /* ① 中缀先翻译成后缀；后缀模式直接用原串 */
    var conv = ("rpn" === appState.inputMode) ? { ok: true, rpn: src } : InfixToRPN(src);
    if (!conv.ok) {
        showInlineError(conv.message, src, conv.index, conv.length);
        setStatus(conv.message, "error");
        return false;                       /* 保留上一张图，不破坏用户已有成果 */
    }
    var rpn = conv.rpn;

    /* ② 走既有的后缀管线 */
    var resultParsed = LogicParser(rpn);
    if (!resultParsed || !resultParsed.ok) {
        var rMsg = (resultParsed && resultParsed.message) || LOGIC_ERRORS.E_INTERNAL;
        showInlineError(rMsg, src,
            resultParsed ? resultParsed.index : null,
            resultParsed ? resultParsed.length : null);
        setStatus(rMsg, "error");
        return false;
    }

    /* ③ 逻辑门视图另取一棵树：保留量词结构，避免展开成 (0∨b)∧(1∨b) 这种读不懂的形状 */
    var gateParsed = LogicParser(rpn, { nodeKind: "gate", keepQuantifier: true });

    /* ④ 化简 */
    var model;
    try {
        resetModelGenBudget();
        model = ModelGen(resultParsed.tree);
        if (model.value.length > LOGIC_LIMITS.MAX_PATHS) {
            showInlineError(LOGIC_ERRORS.E_TOO_MANY_PATHS, src, null, null);
            setStatus(LOGIC_ERRORS.E_TOO_MANY_PATHS, "error");
            return false;
        }
    } catch (e) {
        var bMsg = (e && "LOGIC_BUDGET_EXCEEDED" === e.message)
            ? LOGIC_ERRORS.E_BUDGET
            : LOGIC_ERRORS.E_INTERNAL + "（" + ((e && e.message) ? e.message : "未知原因") + "）";
        showInlineError(bMsg, src, null, null);
        setStatus(bMsg, "error");
        return false;
    }

    /* ⑤ 成功：更新状态并（必要时）重建画布 */
    clearInlineError();

    var changed = (rpn !== appState.lastRpn) || force;
    appState.lastRpn = rpn;
    appState.lastExpr = src;
    appState.lastQuant = resultParsed.quant || [];
    appState.lastModel = model;
    appState.lastGateTree = gateParsed.ok ? gateParsed.tree : null;

    if (changed || 0 === graph.getCells().length) {
        if (!renderCurrentView()) { return false; }
    } else {
        renderQuantPrefix(appState.lastQuant);
        renderStats(model);
        renderTruthTable();
    }

    var modeName = ("gate" === appState.viewMode) ? "逻辑门视图" : "选择器视图";
    var qt = appState.lastQuant.length;
    setStatus("解析完成（" + modeName + "）。"
        + (qt ? "已绑定 " + qt + " 个量词。" : "")
        + " 等价后缀式：" + (rpn || "（空）"), "ok");
    return true;
};

/* 输入防抖自动预览：用户反馈"边打边出图" */
function schedulePreview() {
    if (appState.previewTimer) { clearTimeout(appState.previewTimer); }
    appState.previewTimer = setTimeout(function () {
        appState.previewTimer = null;
        app.parseLogic({ preview: true });
    }, 400);
}

/* 示例快捷入口 */
app.useSample = function (expr) {
    var box = document.getElementById("ReversePol");
    if (!box) { return; }
    box.value = expr;
    app.parseLogic({ force: true });
    box.focus();
};

/* ===========================================================================
 * 输入记法切换
 * ========================================================================*/
var SAMPLES = {
    infix: [
        ["(a AND b) -> fe", "(a AND b) → fe"],
        ["a OR b AND NOT c", "a ∨ b ∧ ¬c"],
        ["∀x(a AND b)", "∀x(a ∧ b)"],
        ["a OR b IFF b OR a", "交换律"]
    ],
    rpn: [
        ["a b . fe >", "a b . fe >"],
        ["a b c < . ,", "a b c < . ,"],
        ["a b . x !", "a b . x !"],
        ["a b , b a , =", "a b , b a , ="]
    ]
};

var PLACEHOLDER = {
    infix: "例如：(a AND b) -> fe     支持 AND / OR / NOT / -> / <-> ，以及量词 ∀x() ∃x()",
    rpn: "例如：a b . fe >     操作数在前、操作符在后；量词写作 a b . x ?"
};

function renderSamples() {
    var wrap = document.getElementById("samples");
    if (!wrap) { return; }
    wrap.innerHTML = '<span class="samples-label">示例</span>';
    (SAMPLES[appState.inputMode] || []).forEach(function (item) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = item[1];
        b.title = "填入：" + item[0];
        b.addEventListener("click", function () { app.useSample(item[0]); });
        wrap.appendChild(b);
    });
}

/* 只同步记法的界面表现，不产生副作用（供初始化与恢复存档调用） */
function applyInputModeUI() {
    var mode = appState.inputMode;
    var segs = document.querySelectorAll("#mode-switch .seg");
    for (var i = 0; i < segs.length; i++) {
        segs[i].classList.toggle("is-active", segs[i].getAttribute("data-mode") === mode);
    }
    var ta = document.getElementById("ReversePol");
    if (ta) { ta.placeholder = PLACEHOLDER[mode]; }
    renderSamples();
}

app.setInputMode = function (mode) {
    if ("infix" !== mode && "rpn" !== mode) { return; }
    if (mode === appState.inputMode) { return; }

    /* 若输入框里正是刚解析成功的那条，顺便翻译成另一种记法，省得用户重打 */
    var box = document.getElementById("ReversePol");
    var current = box ? box.value.trim() : "";
    if (box && current && current === appState.lastExpr && appState.lastRpn) {
        box.value = ("rpn" === mode) ? appState.lastRpn : current;
    }

    appState.inputMode = mode;
    applyInputModeUI();
    clearInlineError();
    persistWorkspace();
    setStatus(("infix" === mode)
        ? "已切到中缀写法：直接写 a AND b -> c 即可。"
        : "已切到后缀写法：操作数在前、操作符在后。", "info");
};

/* ===========================================================================
 * 视图切换
 * ========================================================================*/
function applyViewModeUI() {
    var segs = document.querySelectorAll("#view-switch .seg");
    for (var i = 0; i < segs.length; i++) {
        segs[i].classList.toggle("is-active", segs[i].getAttribute("data-view") === appState.viewMode);
    }
}

/* 当前图形是否被手工改动过（用来在切视图前提醒会重新生成） */
function hasManualEdits() {
    if (!graph.getCells().length) { return false; }
    try {
        var now = app.ELDump(graph.toJSON().cells);
        return JSON.stringify(now.nodeArray) !== JSON.stringify(origin.nodeArray || [])
            || JSON.stringify(now.linkArray) !== JSON.stringify(origin.linkArray || []);
    } catch (e) {
        return false;
    }
}

app.setViewMode = function (mode) {
    if ("selector" !== mode && "gate" !== mode) { return; }
    if (mode === appState.viewMode) { return; }

    if ("gate" === mode && !appState.lastGateTree) {
        setStatus("逻辑门视图需要先解析一个表达式。当前图形保持不变。", "error");
        return;
    }

    var manual = hasManualEdits();
    appState.viewMode = mode;
    applyViewModeUI();

    if (appState.lastModel) {
        renderCurrentView();
        setStatus("已切到" + (("gate" === mode) ? "逻辑门视图（原表达式的与/或/非门电路）" : "选择器视图（化简后的 MUX 网络）")
            + "。" + (manual ? "手工添加的节点已按表达式重新生成。" : ""), "info");
    } else {
        persistWorkspace();
    }
};

/* ===========================================================================
 * 右侧标签页
 * ========================================================================*/
app.setTab = function (name) {
    var tabs = document.querySelectorAll("#tabs .tab");
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle("is-active", tabs[i].getAttribute("data-tab") === name);
    }
    var panels = document.querySelectorAll(".tab-panel");
    for (var j = 0; j < panels.length; j++) {
        var on = panels[j].getAttribute("data-panel") === name;
        panels[j].classList.toggle("is-active", on);
        panels[j].hidden = !on;
    }
};

/* ===========================================================================
 * 真值表
 * ========================================================================*/
function renderTruthTable() {
    var wrap = document.getElementById("truth-table-wrap");
    var summary = document.getElementById("truth-summary");
    if (!wrap || !summary) { return; }
    wrap.innerHTML = "";

    if (!appState.lastModel) {
        summary.textContent = "解析后这里会列出真值表。";
        return;
    }

    var vars = appState.lastModel.order || [];
    var table = TruthTable(vars, appState.lastModel.value || []);

    if (table.truncated) {
        summary.textContent = "变量过多（" + vars.length + " 个），真值表超过 " + (1 << TRUTH_MAX_VARS) + " 行，未展开。";
        return;
    }

    var trueCount = 0;
    table.rows.forEach(function (r) { if (1 === r.out) { trueCount++; } });

    summary.innerHTML = "";
    var line1 = document.createElement("div");
    line1.innerHTML = "自变量 <b>"
        + (vars.length ? vars.join(", ") : "（无，已化简为常量）")
        + "</b><br>共 <b>" + table.rows.length + "</b> 种取值，输出为 1 的有 <b>" + trueCount + "</b> 种";
    summary.appendChild(line1);

    var line2 = document.createElement("div");
    line2.className = "hint";
    line2.textContent = (trueCount === table.rows.length)
        ? "该表达式恒真（永真式）。"
        : (0 === trueCount ? "该表达式恒假（矛盾式）。" : "标绿的行表示输出为 1 的取值组合。");
    summary.appendChild(line2);

    var tbl = document.createElement("table");
    tbl.className = "truth-table";

    var thead = document.createElement("thead");
    var trh = document.createElement("tr");
    var thNo = document.createElement("th");
    thNo.textContent = "#";
    trh.appendChild(thNo);
    vars.forEach(function (v) {
        var th = document.createElement("th");
        th.textContent = v;
        trh.appendChild(th);
    });
    var thOut = document.createElement("th");
    thOut.textContent = "结果";
    thOut.className = "is-out";
    trh.appendChild(thOut);
    thead.appendChild(trh);
    tbl.appendChild(thead);

    var tbody = document.createElement("tbody");
    table.rows.forEach(function (r, i) {
        var tr = document.createElement("tr");
        if (1 === r.out) { tr.className = "is-true"; }

        var tdNo = document.createElement("td");
        tdNo.textContent = i + 1;
        tdNo.className = "is-var-0";
        tr.appendChild(tdNo);

        r.bits.forEach(function (b) {
            var td = document.createElement("td");
            td.textContent = b;
            td.className = (1 === b) ? "is-var-1" : "is-var-0";
            tr.appendChild(td);
        });

        var tdOut = document.createElement("td");
        tdOut.textContent = r.out;
        tdOut.className = (1 === r.out) ? "is-out-1" : "is-out-0";
        tr.appendChild(tdOut);

        tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
}

/* ===========================================================================
 * 画布操作：适应窗口 / 手动添加节点 / 选中元素
 * ========================================================================*/
/* 「适应窗口」直接复用 relayout：宽屏走 fitToContent、窄屏走视口缩放，
   两条路都在 relayout 里定义好了，不必重复一遍居中与小地图同步 */
app.fitView = function () {
    if (!graph.getCells().length) {
        setStatus("画布是空的，没有可适应的内容。", "info");
        return;
    }
    relayout();
    setStatus("已适应窗口。", "info");
};

/* 视口中心对应的模型坐标：用来把新节点放在眼前而不是某个角落 */
function viewportCenter() {
    var el = mainContainer && mainContainer.length ? mainContainer[0] : null;
    if (!el) { return { x: 0, y: 0 }; }
    var r = el.getBoundingClientRect();
    return paper.clientToLocalPoint({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
}

app.addNode = function (type) {
    var key, node;
    var stamp = Date.now().toString(36);

    if ("VAR" === type) {
        var n = 1;
        while (graph.getCell("add-var-" + n)) { n++; }
        key = "add-var-" + n;
        node = { key: key, type: "VAR", name: "x" + n };
    } else if ("0" === type || "1" === type) {
        key = "add-const-" + type + "-" + stamp;
        node = {
            key: key,
            type: ("1" === type) ? "CONST1" : "CONST0",
            name: ("1" === type) ? "常量 1" : "常量 0"
        };
    } else {
        key = "add-" + String(type).toLowerCase() + "-" + stamp;
        node = { key: key, type: type, name: (GATE_TYPE_CN[type] || type) };
    }

    var cell = app.makeGateNode(node);
    if (!cell) {
        setStatus("未知的节点类型：" + type, "error");
        return;
    }

    var c = viewportCenter();
    cell.position(Math.round(c.x - cell.size().width / 2), Math.round(c.y - cell.size().height / 2));
    graph.addCell(cell);
    updateCanvasHint();

    app.selectCell(key);
    setStatus("已添加「" + (node.name || type) + "」。拖动可移动位置；从输出端按住拖到输入端即可连线。", "ok");
};

/* 选中一个元素：高亮 + 填入属性面板 + 切到属性页 */
app.selectCell = function (id) {
    if (undefined === id || null === id || !graph.getCell(id)) { return; }
    ERKeyNow = id;
    chosedElement.Nodes.add(id);
    ERHighlightLink(id);
    fillPropsPanel(graph.getCell(id));
    app.setTab("props");
};

function hasSelector(cell, sel) {
    var markup = cell.get("markup") || [];
    for (var i = 0; i < markup.length; i++) {
        if (markup[i].selector === sel) { return true; }
    }
    return false;
}

function fillPropsPanel(cell) {
    var labelEl = document.getElementById("ERName");
    var nameEl = document.getElementById("ERMemo");
    if (!cell) {
        if (labelEl) { labelEl.value = ""; }
        if (nameEl) { nameEl.value = ""; }
        return;
    }
    var attrs = cell.attr() || {};
    var labelText = (attrs.label && undefined !== attrs.label.text) ? attrs.label.text : "";
    var nameText = "";
    if (attrs.name && undefined !== attrs.name.text) { nameText = attrs.name.text; }
    else if (attrs.symbol && undefined !== attrs.symbol.text) { nameText = attrs.symbol.text; }
    if (labelEl) { labelEl.value = labelText; }
    if (nameEl) { nameEl.value = nameText; }
}

/* ===========================================================================
 * 导出图片（SVG / PNG）
 * ---------------------------------------------------------------------------
 * JointJS v3.3.1 这个构建里没有 paper.toSVG，所以自己来：
 *   克隆画布 SVG → 去掉网格 → 裁到内容 bbox → 内联图标 → 下载
 * 内联图标是必须的：不内联的话，导出的独立 SVG 里相对路径会断链，
 * PNG 经 canvas 绘制时也会被判为跨源污染而无法导出。
 * ========================================================================*/
var SVG_NS = "http://www.w3.org/2000/svg";

function inlineSvgImages(root) {
    var imgs = Array.prototype.slice.call(root.querySelectorAll("image"));
    if (!imgs.length) { return Promise.resolve(); }
    return Promise.all(imgs.map(function (img) {
        var href = img.getAttribute("xlink:href") || img.getAttribute("href");
        if (!href || 0 === href.indexOf("data:")) { return Promise.resolve(); }
        return fetch(href).then(function (res) {
            if (!res.ok) { throw new Error("HTTP " + res.status); }
            return res.arrayBuffer();
        }).then(function (buf) {
            var bytes = new Uint8Array(buf);
            var bin = "";
            for (var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
            var mime = /\.png$/i.test(href) ? "image/png" : "image/svg+xml";
            var uri = "data:" + mime + ";base64," + btoa(bin);
            img.setAttribute("xlink:href", uri);
            img.setAttribute("href", uri);
        }).catch(function () { /* 单个图标失败不阻断整体导出 */ });
    }));
}

function buildExportSvg() {
    var src = document.querySelector("#paper svg");
    if (!src) { return null; }

    var clone = src.cloneNode(true);

    /* 导成图片时网格是噪音，去掉 */
    var grid = clone.querySelector(".joint-paper-grid");
    if (grid && grid.parentNode) { grid.parentNode.removeChild(grid); }

    var bbox = paper.getContentBBox();
    var pad = 24;
    if (!bbox || !(bbox.width > 0)) { bbox = { x: 0, y: 0, width: 400, height: 200 }; }
    var w = Math.ceil(bbox.width + pad * 2);
    var h = Math.ceil(bbox.height + pad * 2);

    clone.setAttribute("xmlns", SVG_NS);
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("viewBox", (bbox.x - pad) + " " + (bbox.y - pad) + " " + w + " " + h);
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);
    clone.removeAttribute("style");

    /* 铺一层白底：SVG 本身无背景，贴到深色背景上会看不清 */
    var bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", bbox.x - pad);
    bg.setAttribute("y", bbox.y - pad);
    bg.setAttribute("width", w);
    bg.setAttribute("height", h);
    bg.setAttribute("fill", "#ffffff");
    clone.insertBefore(bg, clone.firstChild);

    return { svg: clone, width: w, height: h };
}

function downloadBlob(blob, filename) {
    var url = window.URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.download = filename;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { window.URL.revokeObjectURL(url); }, 1500);
}

function exportFileName(ext) {
    var base = "logicsim";
    if (appState.lastExpr) {
        var slug = appState.lastExpr.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
        if (slug) { base = slug; }
    }
    return base + "." + ext;
}

app.exportSVG = function () {
    var built = buildExportSvg();
    if (!built) { setStatus("导出失败：找不到画布。", "error"); return; }
    inlineSvgImages(built.svg).then(function () {
        var str = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + new XMLSerializer().serializeToString(built.svg);
        downloadBlob(new Blob([str], { type: "image/svg+xml;charset=utf-8" }), exportFileName("svg"));
        setStatus("已导出 SVG（矢量，可无损放大，适合放进 PPT）。", "ok");
    }).catch(function (e) {
        setStatus("导出 SVG 失败：" + e.message, "error");
    });
};

app.exportPNG = function () {
    var built = buildExportSvg();
    if (!built) { setStatus("导出失败：找不到画布。", "error"); return; }
    inlineSvgImages(built.svg).then(function () {
        var str = new XMLSerializer().serializeToString(built.svg);
        var img = new Image();
        img.onload = function () {
            var scale = 2;                       /* 2 倍分辨率，贴进文档不糊 */
            var canvas = document.createElement("canvas");
            canvas.width = built.width * scale;
            canvas.height = built.height * scale;
            var c2 = canvas.getContext("2d");
            c2.fillStyle = "#ffffff";
            c2.fillRect(0, 0, canvas.width, canvas.height);
            c2.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(function (blob) {
                if (!blob) { setStatus("导出 PNG 失败：浏览器未能生成图片。", "error"); return; }
                downloadBlob(blob, exportFileName("png"));
                setStatus("已导出 PNG（2 倍分辨率）。", "ok");
            }, "image/png");
        };
        img.onerror = function () { setStatus("导出 PNG 失败：SVG 渲染出错。", "error"); };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(str);
    }).catch(function (e) {
        setStatus("导出 PNG 失败：" + e.message, "error");
    });
};

/* ===========================================================================
 * 本机持久化（localStorage）
 * ---------------------------------------------------------------------------
 * 「保存修改」只改当前图形并同步到 JSON 文本框，不落磁盘；真正落盘要「导出文件」。
 * 工作区（表达式 + 视图 + 模型）自动存在浏览器本地，关掉页面再打开还在。
 * ========================================================================*/
var STORAGE_KEY = "logicsim.workspace.v1";

function persistWorkspace() {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
            v: 1,
            inputMode: appState.inputMode,
            viewMode: appState.viewMode,
            expr: document.getElementById("ReversePol").value,
            rpn: appState.lastRpn,
            model: origin
        }));
    } catch (e) {
        /* 隐私模式或配额用满：静默降级，不影响正常使用 */
    }
}

function restoreWorkspace() {
    var raw = null;
    try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (e) { return false; }
    if (!raw) { return false; }

    var data;
    try { data = JSON.parse(raw); } catch (e) { return false; }
    if (!data || 1 !== data.v) { return false; }

    if ("rpn" === data.inputMode || "infix" === data.inputMode) {
        appState.inputMode = data.inputMode;
    }
    if ("gate" === data.viewMode || "selector" === data.viewMode) {
        appState.viewMode = data.viewMode;
    }
    applyInputModeUI();
    applyViewModeUI();

    if (data.expr) {
        var box = document.getElementById("ReversePol");
        if (box) { box.value = data.expr; }
        /* 先按表达式重建：这样真值表、量词前缀、后缀式都能一起恢复 */
        if (app.parseLogic({ force: true })) {
            setStatus("已恢复上次的工作区。", "info");
            return true;
        }
        /* 表达式已不可解析（例如手工编辑过 JSON）→ 退回直接渲染存档里的模型 */
        clearInlineError();
    }

    if (data.model && data.model.nodeArray) {
        origin = data.model;
        currentQuant = quantFromModel(origin);
        document.getElementById("myModel").value = JSON.stringify(origin);
        app.updateGraph();
        updateCanvasHint();
        renderQuantPrefix(currentQuant);
        renderStats(null, origin);
        setStatus("已恢复上次的工作区（含手工编辑过的图形）。", "info");
        return true;
    }
    return false;
}

app.clearStorage = function () {
    try {
        window.localStorage.removeItem(STORAGE_KEY);
        setStatus("已清除本机存档。当前图形仍在，刷新后会从空白开始。", "info");
    } catch (e) {
        setStatus("清除失败：" + e.message, "error");
    }
};

/* ===========================================================================
 * 事件绑定与初始化
 * ========================================================================*/
function bindInputEvents() {
    var ta = document.getElementById("ReversePol");
    if (ta) {
        /* 实时预览：边打边出图 */
        ta.addEventListener("input", function () {
            schedulePreview();
        });
        /* Ctrl/Cmd + Enter 立即解析 */
        ta.addEventListener("keydown", function (e) {
            if ((e.ctrlKey || e.metaKey) && 13 === e.keyCode) {
                e.preventDefault();
                if (appState.previewTimer) { clearTimeout(appState.previewTimer); appState.previewTimer = null; }
                app.parseLogic({ force: true });
            }
        });
    }
}

app.updateGraph = function () {
    graph.resetCells(app.ELCreate(origin));
    joint.layout.DirectedGraph.layout(graph, {
        setLinkVertices: false,
        nodeSep: 100,
        edgeSep: 50,
        rankSep: 100,
        rankDir: "LR"
    });
    newScale = 1;
    paper.fitToContent({
        padding: 50,
        allowNewOrigin: "any"
    });
    setContainerAndMini();
    paperContainer.css({
        left: Math.round((mainContainer.width() - paperContainer.width()) / 2),
        top: Math.round((mainContainer.height() - paperContainer.height()) / 2),
        position: "absolute"
    });
    miniView.css({
        height: miniScale * mainContainer.height(), width: miniScale * mainContainer.width(),
        left: -1 * miniScale * paperContainer.position().left,
        top: -1 * miniScale * paperContainer.position().top
    });
}

/*从文本框区域内载入*/
app.load = function () {
    var fromJson = true;
    try {
        origin = JSON.parse(document.getElementById("myModel").value);
    }
    catch (error) {
        origin = { nodeArray: [], linkArray: [] };
        fromJson = false;
    }
    /* 结构校验：缺字段会让渲染阶段静默出错，这里统一补默认值 */
    if (!origin || !(origin.nodeArray instanceof Array)) {
        origin = { nodeArray: [], linkArray: [] };
        fromJson = false;
    }
    if (!(origin.linkArray instanceof Array)) {
        origin.linkArray = [];
        fromJson = false;
    }
    if (!fromJson) {
        document.getElementById("myModel").value = JSON.stringify(origin);
    }

    app.updateGraph();

    currentQuant = quantFromModel(origin);
    renderQuantPrefix(currentQuant);
    renderStats(null, origin);
    if (fromJson) {
        setStatus("已按 JSON 模型渲染图形。可拖动节点、滚轮缩放，或用「图转文本」导回 JSON。", "ok");
    } else {
        setStatus("JSON 格式有误，已按空模型处理。", "error");
    }
};

app.save = function () {
    origin = app.ELDump(graph.toJSON().cells);
    /* 把当前量词前缀写回顶层可选字段，保证往返不丢信息。
       不含量词时不写该字段，输出与改造前完全一致。 */
    if (currentQuant && currentQuant.length) {
        origin.quantPrefix = currentQuant;
    }
    document.getElementById("myModel").value = JSON.stringify(origin);
    renderQuantPrefix(currentQuant);
    renderStats(null, origin);
    setStatus("图形已导出为 JSON 模型。", "ok");
};

/* [已移除] 全局函数 updateGraph() —— 全文件搜索确认无任何调用点，
   且函数体引用了两处并不存在的全局（裸 ELCreate、chosedElement.Sheets），
   一旦被调用必然抛异常。属纯粹的死代码，故删除。 */




/*从本地载入文件，保存文件到本地 */
if (window.FileList && window.File && window.FileReader) {
    document.getElementById("fileToLoad").addEventListener('change', event => {
        const fileToLoad = event.target.files[0];
        if (!fileToLoad) { return; }
        const reader = new FileReader();
        reader.addEventListener('load', function (evt) {
            document.getElementById("myModel").value = evt.target.result;
            app.load();
        });
        reader.addEventListener('error', function () {
            setStatus("文件读取失败：请确认文件存在且是可读的 UTF-8 文本。", "error");
        });
        reader.readAsText(fileToLoad, "UTF-8");
    })

}

function destroyClickedElement(event) {
    document.body.removeChild(event.target);
};

app.saveTextAsFile = function () {
    var textToSave = document.getElementById("myModel").value;
    var textToSaveAsBlob = new Blob([textToSave], { type: "application/json" });
    var textToSaveAsURL = window.URL.createObjectURL(textToSaveAsBlob);
    var fileNameToSaveAs = document.getElementById("inputFileNameToSaveAs").value;

    var downloadLink = document.createElement("a");
    downloadLink.download = fileNameToSaveAs;
    downloadLink.innerHTML = "Download File";
    downloadLink.href = textToSaveAsURL;
    downloadLink.onclick = destroyClickedElement;
    downloadLink.style.display = "none";
    document.body.appendChild(downloadLink);

    downloadLink.click();
};



/* if (0 == Object.keys(origin).length) {
    origin = {
        nodeArray: [],
        linkArray: []
    };
} */

/* [已移除] sheet3Node / app.UpdateOption()
   原实现把 select2 绑到 #sheet3，但 index.html 从来没有这个元素，
   jQuery 在空集合上调用插件是 no-op —— 即整段是无效代码。
   移除后同时去掉 select2 的资源引用。原「按名称查找元素」的意图，
   改由右侧属性面板 + 画布内节点高亮承担。 */

app.ChangeName = function () {
    /* 未选中任何元素时直接提示，避免 findViewByModel(undefined) 抛异常 */
    if (undefined === ERKeyNow || null === ERKeyNow || undefined === graph.getCell(ERKeyNow)) {
        setStatus("请先在画布上点选一个元素，再保存修改。", "error");
        return false;
    }

    var sheets;
    try {
        sheets = JSON.parse(document.getElementById("ERName").value);
    } catch (e) {
        setStatus("标签格式有误：应为 JSON 字符串数组，例如 [\"第一行\",\"第二行\"]。", "error");
        return false;
    }
    if (!(sheets instanceof Array) || 0 === sheets.length) {
        setStatus("标签格式有误：应为非空的 JSON 字符串数组，例如 [\"第一行\",\"第二行\"]。", "error");
        return false;
    }

    var memoText = document.getElementById("ERMemo").value;
    var changedCell = graph.getCell(ERKeyNow);

    ERUnhighlight(ERKeyNow);
    /* 只改显示标签，不动 nodeType —— 类型由独立属性承载，改名不会破坏「图转文本」 */
    changedCell.attr({
        label: { text: sheets.join("\n"), memo: memoText }
    });
    app.save();
    setStatus("已保存元素修改。", "ok");
}



/* ===========================================================================
 * 启动
 * ========================================================================*/
bindInputEvents();
applyInputModeUI();
applyViewModeUI();
if (!restoreWorkspace()) {
    app.load();
    setStatus("就绪：输入表达式后会实时出图；也可以点「手动添加」从空白画布开始搭。", "ok");
}
