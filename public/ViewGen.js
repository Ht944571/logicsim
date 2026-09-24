var app = app || {};

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
    drawGrid: true,
    background: {
        color: '#fbfcfd'
    }

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
        color: '#f1f3f5'
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
        var model = elementView.model;
        var bbox = model.getBBox();
        var ellipseRadius = (1 - Math.cos(g.toRad(45)));
        var offset = model.attr(['pointers', 'pointerShape']) === 'ellipse'
            ? { x: -ellipseRadius * bbox.width / 2, y: ellipseRadius * bbox.height / 2 }
            : { x: -3, y: 3 };

        elementView.addTools(new joint.dia.ToolsView({
            tools: [
                new joint.elementTools.Remove({
                    useModelGeometry: true,
                    y: '0%',
                    x: '100%',
                    offset: offset
                }),
                new joint.elementTools.Boundary({
                    focusOpacity: 0.5,
                    padding: 10,
                    useModelGeometry: true
                })
            ]
        }));
    },
    'link:mouseenter': function (linkView) {
        linkView.addTools(new joint.dia.ToolsView({
            tools: [
                new joint.linkTools.Remove({
                    useModelGeometry: true,
                    y: '0%',
                    x: '100%',
                    offset: 1.0
                }),
                new joint.linkTools.Boundary({
                    focusOpacity: 0.5,
                    padding: 3,
                    useModelGeometry: true
                })
            ]
        }));
    },
    'element:pointerclick': function (elementView) {
        ERKeyNow = elementView.model.id;
        chosedElement.Nodes.add(ERKeyNow);
        ERHighlightLink(ERKeyNow);

        var ERName = document.getElementById("ERName");
        ERName.value = JSON.stringify(elementView.model.attr().label.text.split("\n"));
        //ERName.style = "width:" + ERName.value.length * 0.5 + "em";

        var ERMemo = document.getElementById("ERMemo");
        ERMemo.value = elementView.model.attr().name.text;

    },
    'cell:mouseleave': function (cellView) {
        cellView.removeTools();
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

/* 容器尺寸变化后重新把画布居中并同步小地图。
   注意【不重跑】dagre 布局：节点位置已经算好，重跑只会做无用功。
   这里只做 fitToContent + 容器/小地图同步，成本低且不会改变图形形状。 */
function relayout() {
    if (!mainContainer || !mainContainer.length) { return; }
    var w = mainContainer.width();
    var h = mainContainer.height();
    if (!w || !h) { return; }
    try {
        if (graph && graph.getCells().length) {
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
        label: {
            text: theLabel,
            fontSize: 12,
            fontFamily: 'monospace',
            fill: 'white',
            fontWeight: 'bold'
        },
        body: {
            fill: theColor,
            width: "100%",
            height: "100%",
            rx: 5,
            ry: 5,
            stroke: 'none'
        },
        image: {
            "xlink:href": theImgPath,
            width: 50,
            height: 50, x: theWidth / 2 - 25, y: theHeight / 2 - 25
        },
        name: {
            text: theName,
            fontSize: 12,
            fontFamily: 'monospace',
            fill: 'white',
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
    var result = {};
    if ("0" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            "#FE854F",
            "assets/zero.svg",
            [{ group: "out", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("1" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            "#31D0C6",
            "assets/one.svg",
            [{ group: "out", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("Import" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            "#ff0000",
            "assets/input.svg",
            [{ group: "out", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("Export" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            theNode.name,
            "#ff00ff",
            "assets/output.svg",
            [{ group: "in", id: "OUT", attrs: { portLabel: { text: "OUT" } } },]
        )
    }
    else if ("SEL" == theNode.type) {
        result = app.makeNode(
            theNode.key,
            theNode.type,
            "",
            "#ffcccc",
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
    return new joint.shapes.standard.Link(
        {
            source: { id: theNode.from, magnet: "portBody", port: theNode.frompid },
            target: { id: theNode.to, magnet: "portBody", port: theNode.topid },
            smooth: true,
            connector: { name: "jumpover", args: { size: 5 } },
            router: {
                name: 'metro',
                args: {
                    step: 10,
                    startDirections: ["right"],
                    endDirections: ["left"]
                }
            }
        })
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
            var elemType = oneElem.nodeType || oneElem.attrs.label.text;
            if ("SEL" == elemType) {
                result.nodeArray.push({
                    "key": oneElem.id,
                    "type": "SEL"
                });
            } else {
                result.nodeArray.push({
                    "key": oneElem.id,
                    "type": elemType,
                    "name": oneElem.attrs.name.text
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

app.parseLogic = function () {
    var exprText = document.getElementById("ReversePol").value;
    var resultParsed = LogicParser(exprText);

    /* 统一结果对象：{ ok:true, tree, quant } 或 { ok:false, code, message } */
    if (!resultParsed || !resultParsed.ok) {
        setStatus((resultParsed && resultParsed.message) || LOGIC_ERRORS.E_INTERNAL, "error");
        renderQuantPrefix([]);
        renderStats(null);
        return;
    }

    var model, viewModel;
    try {
        resetModelGenBudget();
        model = ModelGen(resultParsed.tree);

        if (model.value.length > LOGIC_LIMITS.MAX_PATHS) {
            setStatus(LOGIC_ERRORS.E_TOO_MANY_PATHS, "error");
            renderQuantPrefix([]);
            renderStats(null);
            return;
        }

        /* 量词不进入节点结构：它消去了被绑定变量，图上没有对应节点可标。
           量词信息只走两处 —— 画布上方的前缀条，与模型 JSON 的顶层可选字段。 */
        viewModel = ViewGen(model);
    } catch (e) {
        if (e && "LOGIC_BUDGET_EXCEEDED" === e.message) {
            setStatus(LOGIC_ERRORS.E_BUDGET, "error");
        } else {
            setStatus(LOGIC_ERRORS.E_INTERNAL + "（" + ((e && e.message) ? e.message : "未知原因") + "）", "error");
        }
        renderQuantPrefix([]);
        renderStats(null);
        return;
    }

    if (viewModel.error) {
        setStatus("化简结果无法生成图形：路径集中找不到公共根变量。", "error");
        renderQuantPrefix([]);
        renderStats(null);
        return;
    }

    origin = viewModel;
    currentQuant = resultParsed.quant || [];
    if (currentQuant.length) {
        origin.quantPrefix = currentQuant;
    }
    document.getElementById("myModel").value = JSON.stringify(origin);

    /* 解析后立即出图。
       原站是两步流程：先「解析文本」只产出 JSON，再点「文本转图」才渲染。
       实测确认那样做会让用户以为「解析」没生效。这里改为解析后直接渲染，
       「文本转图」按钮与手工改 JSON 的用法完全保留，能力只增不减。 */
    try {
        app.updateGraph();
    } catch (e) {
        setStatus("图形渲染失败：" + ((e && e.message) ? e.message : "未知原因"), "error");
        renderQuantPrefix(currentQuant);
        renderStats(model);
        return;
    }

    renderQuantPrefix(currentQuant);
    renderStats(model);

    var quantCount = resultParsed.quant.length;
    setStatus("解析完成，图形已生成。"
        + (quantCount ? "（已绑定 " + quantCount + " 个量词）" : "")
        + " 可在「模型 JSON」里手工修改后点「文本转图」重新渲染。", "ok");
};

/* 示例快捷入口：填入表达式并立即解析，方便首次上手与演示量词语法 */
app.useSample = function (expr) {
    var box = document.getElementById("ReversePol");
    if (!box) { return; }
    box.value = expr;
    app.parseLogic();
};

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



app.load();


