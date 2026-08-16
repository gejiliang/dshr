#!/bin/sh
# 把 `dshr` 装成一条能直接敲的命令。
#
#   sh tools/install.sh              # 装到 PATH 里第一个可写的常见位置
#   sh tools/install.sh ~/.local/bin # 或者指定
#
# 装的是一层薄包装（不是软链），因为它要多做一件事：
# **自动把凭据带进环境**。dsh 的 `apiKeyEnv` 是引用，值必须在环境里，
# 否则每开一个新终端都得先 source 一次——那就不叫能用了。
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$REPO/packages/cli/lib/main.js"

if [ ! -f "$ENTRY" ]; then
  echo "先构建： cd $REPO && pnpm install && npx tsc --build" >&2
  exit 1
fi

BIN="$1"
if [ -z "$BIN" ]; then
  for candidate in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
    case ":$PATH:" in
      *":$candidate:"*) if [ -d "$candidate" ] && [ -w "$candidate" ]; then BIN="$candidate"; break; fi ;;
    esac
  done
fi
if [ -z "$BIN" ]; then
  echo "PATH 里没找到可写的 bin 目录，指定一个： sh tools/install.sh ~/.local/bin" >&2
  exit 1
fi

mkdir -p "$BIN"
cat > "$BIN/dshr" <<EOF
#!/bin/sh
# dshr —— dsh 的终端 workspace（由 tools/install.sh 生成）
DSHR_REPO="\${DSHR_REPO:-$REPO}"
DSHR_ENTRY="\$DSHR_REPO/packages/cli/lib/main.js"

# 凭据：dsh 的 apiKeyEnv 是引用，值从这里来。
if [ -f "\$HOME/.dsh/env.sh" ]; then
  . "\$HOME/.dsh/env.sh"
fi

if [ ! -f "\$DSHR_ENTRY" ]; then
  echo "dshr: 找不到构建产物 \$DSHR_ENTRY" >&2
  echo "      在 \$DSHR_REPO 里跑一次： pnpm install && npx tsc --build" >&2
  exit 1
fi

exec node "\$DSHR_ENTRY" "\$@"
EOF
chmod +x "$BIN/dshr"

echo "装好了： $BIN/dshr  →  $ENTRY"
echo
echo "还差模型配置的话，看 docs/using-it.md 第二节："
echo "  ~/.dsh/settings.yaml  声明 provider 与默认模型"
echo "  ~/.dsh/env.sh         提供 apiKeyEnv 引用的那个环境变量"
