#!/bin/sh
# 重算 docs/coverage.md 的分母。改完代码就跑一次。
#
#   sh tools/coverage.sh
#
# 两个坑，都数错过：
#
# 1. **RPC 全表从上游类型读，不要照抄文档。** `docs/dsh-contract.md` §三 的标题写「51 个」，
#    但它自己列的表是 52 条，上游 `RpcMethodMap` 也是 52 条。文档措辞会过期，类型不会。
# 2. **必须与全表求交集，不能只 grep 点号形式的字符串。** 命令注册表里的命令名
#    （`session.interrupt` / `session.switch`）长得跟 RPC 一模一样，直接 grep 会算进去，数字虚高。
set -e
cd "$(dirname "$0")/.."

MAP=$(find node_modules/.pnpm -path '*dsh-host-apiproxy*/lib/types/api/rpc-map.d.ts' | head -1)
if [ -z "$MAP" ]; then
  echo "找不到 rpc-map.d.ts —— 先跑 pnpm install" >&2
  exit 1
fi

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
comm -13 "$ALL" "$USED" > /dev/null 2>&1 || true
comm -23 "$ALL" "$USED" | tr '\n' ' '
echo

KNOWN=$(find node_modules/.pnpm -path '*dsh-session*/lib/types/known-event-types.js' | head -1)
echo
echo "上游已知会话事件: $(grep -oE "'[a-z]+/[a-z/_-]+'" "$KNOWN" | tr -d "'" | sort -u | wc -l | tr -d ' ')"
echo "state 里出现过的 '<a>/<b>' 串: $(grep -rhoE "'[a-z]+/[a-z/_-]+'" packages/state/src | tr -d "'" | sort -u | wc -l | tr -d ' ')（含 mux/host 帧名，不全是会话事件）"

rm -f "$ALL" "$USED"
