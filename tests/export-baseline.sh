#!/usr/bin/env bash
# 导出改造前的逻辑内核副本，供回归比对使用。
# 用途：证明 3A/3B 改造没有改变任何既有合法表达式的输出。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p tests/.baseline
git show baseline-v0:public/LogicParser.js > tests/.baseline/LogicParser.baseline.js
git show baseline-v0:public/index.html      > tests/.baseline/index.baseline.html
git show baseline-v0:public/style.css       > tests/.baseline/style.baseline.css
echo "已导出基线副本到 tests/.baseline/"
ls -l tests/.baseline/
