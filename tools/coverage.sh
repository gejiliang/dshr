#!/bin/sh
# 重算 docs/coverage.md 的分母。改完代码就跑一次。
#
#   sh tools/coverage.sh
#
# 三个坑，都数错过：
#
# 1. **RPC 全表从上游类型读，不要照抄文档。** `docs/dsh-contract.md` §三 的标题写「51 个」，
#    但它自己列的表是 52 条，上游 `RpcMethodMap` 也是 52 条。文档措辞会过期，类型不会。
# 2. **必须与全表求交集，不能只 grep 点号形式的字符串。** 命令注册表里的命令名
#    （`session.interrupt` / `session.switch`）长得跟 RPC 一模一样，直接 grep 会算进去，数字虚高。
# 3. **别用 `find node_modules/.pnpm -path '*dsh-host-apiproxy*' | head -1`。**
#    pnpm store 里**同时躺着好几个版本**（升过级就有：rc.6 / rc.7 / rc.8 全在），
#    `head -1` 取到哪个由文件系统顺序决定——**不确定，且经常是旧的那个**。
#    2026-08-20 升 rc.8 时实测：它取到的是 **rc.6** 的表，于是「rc.8 契约没变」
#    这个结论其实是拿 rc.6 的表自证的，等于没验。
#    改成跟着 pnpm 真实解析出来的软链走：`packages/protocol` 依赖 apiproxy，
#    apiproxy 自己的 node_modules 里有 dsh-session——两跳都是确定的。
set -e
cd "$(dirname "$0")/.."

MAP_PKG=packages/protocol/node_modules/@deepseek-ai/dsh-host-apiproxy
MAP="$MAP_PKG/lib/types/api/rpc-map.d.ts"
KNOWN="$MAP_PKG/../dsh-session/lib/types/known-event-types.js"

if [ ! -f "$MAP" ]; then
  echo "找不到 $MAP —— 先跑 pnpm install" >&2
  exit 1
fi
if [ ! -f "$KNOWN" ]; then
  echo "找不到 $KNOWN —— 先跑 pnpm install" >&2
  exit 1
fi

# 把实际读到的版本印出来。**不印版本的覆盖率数字不可信**——见上面第 3 条。
VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$MAP_PKG/package.json" | head -1)
echo "读的是 @deepseek-ai/dsh-host-apiproxy@$VER"
echo

ALL=$(mktemp)
USED=$(mktemp)
grep -oE "^[[:space:]]+'?[a-zA-Z]+\.[a-zA-Z]+'?:" "$MAP" | tr -d " ':" | sort -u > "$ALL"
grep -rhoE "'[a-zA-Z]+\.[a-zA-Z]+'" packages/*/src | tr -d "'" | sort -u > "$USED"

echo "── dshr 调到的 RPC ──"
comm -12 "$ALL" "$USED"
echo
echo "RPC 方法: $(comm -12 "$ALL" "$USED" | wc -l | tr -d ' ') / $(wc -l < "$ALL" | tr -d ' ')"

echo
echo "── 还没调的 ──"
comm -23 "$ALL" "$USED" | tr '\n' ' '
echo

echo
echo "上游已知会话事件: $(grep -oE "'[a-z]+/[a-z/_-]+'" "$KNOWN" | tr -d "'" | sort -u | wc -l | tr -d ' ')"
echo "state 里出现过的 '<a>/<b>' 串: $(grep -rhoE "'[a-z]+/[a-z/_-]+'" packages/state/src | tr -d "'" | sort -u | wc -l | tr -d ' ')（含 mux/host 帧名，不全是会话事件）"

rm -f "$ALL" "$USED"
