#!/bin/sh
# 把 dshr（或 herdr）的真实画面抓成纯文本，用于「看起来像不像」的比对。
#
#   sh tools/capture.sh                 # 抓 dshr（连 39081 那台 host）
#   sh tools/capture.sh dshr <baseUrl>  # 抓 dshr，指定 host
#   sh tools/capture.sh herdr           # 抓 herdr 作参照（隔离会话，不碰 default）
#
# 为什么要有这个：产品要求是「看起来就是 herdr」。
# 这种要求**只能靠并排看两张图**来验，测试断言不了。
# 第一版就是没看参照物、照着想象做的，结果差得很远（见 docs/herdr-reference.md）。
set -e

WHAT="${1:-dshr}"
COLS="${CAPTURE_COLS:-150}"
ROWS="${CAPTURE_ROWS:-45}"
SOCK="dshr-capture-$$"

cleanup() {
  tmux -L "$SOCK" kill-server 2>/dev/null || true
  if [ "$WHAT" = "herdr" ]; then
    herdr session stop "$HERDR_LOOK" >/dev/null 2>&1 || true
    herdr session delete "$HERDR_LOOK" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$WHAT" = "herdr" ]; then
  # 参照物。**必须用隔离会话**——绝不连到人正在用的 default 上。
  HERDR_LOOK="capture-$$"
  env -u HERDR_SOCKET_PATH -u HERDR_ENV -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
      -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
    tmux -L "$SOCK" new-session -d -x "$COLS" -y "$ROWS" "herdr --session $HERDR_LOOK"
else
  BASE="${2:-http://127.0.0.1:39081}"
  REPO="$(cd "$(dirname "$0")/.." && pwd)"
  ENTRY="$REPO/packages/cli/lib/main.js"
  if [ ! -f "$ENTRY" ]; then
    echo "先构建： npx tsc --build" >&2
    exit 1
  fi
  tmux -L "$SOCK" new-session -d -x "$COLS" -y "$ROWS" "node '$ENTRY' --connect '$BASE'"
fi

# 等它画出来。没有可靠的「已就绪」信号，只能给足时间。
i=0
while [ "$i" -lt 20 ]; do
  if tmux -L "$SOCK" capture-pane -p -t 0 2>/dev/null | grep -q '[^[:space:]]'; then
    sleep 3
    break
  fi
  sleep 1
  i=$((i + 1))
done

tmux -L "$SOCK" capture-pane -p -t 0
