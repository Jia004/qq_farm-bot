#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BOT_PORT="${ADMIN_PORT:-3900}"

cd "$ROOT_DIR"

# 优先使用 Corepack，以遵循 package.json 中锁定的 pnpm 版本。
if command -v corepack >/dev/null 2>&1; then
  PNPM=(corepack pnpm)
elif command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
else
  echo "[ERROR] 未找到 pnpm 或 corepack，请先安装 Node.js 20+。" >&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$BOT_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[INFO] QQ 农场已在运行，端口：$BOT_PORT"
  echo "[INFO] 面板：http://localhost:$BOT_PORT"
  exit 0
fi

if [[ ! -d core/node_modules || ! -d web/node_modules ]]; then
  echo "[INFO] 正在安装项目依赖..."
  "${PNPM[@]}" install -r
fi

if [[ ! -f web/dist/index.html ]]; then
  echo "[INFO] 构建前端需要 pnpm，构建完成后走已装的 core 依赖。"
  echo "[INFO] 正在构建前端（若失败说明缺少 web 依赖，请先执行 pnpm install -r）..."
  "${PNPM[@]}" -C web build
fi

echo "[INFO] 正在启动 QQ 农场..."
echo "[INFO] 面板：http://localhost:$BOT_PORT"
# 注意：不走 pnpm，直接 exec node —— pnpm 会再派生一个 node 子进程后自己退出，
# 导致 exec 失效、服务变孤儿进程；下次再 start 会重复拉起第二个实例（端口被占）。
# core 的依赖（express/socket.io 等）在 pnpm install 时已软链进 core/node_modules，node 可直接解析。
exec env ADMIN_PORT="$BOT_PORT" node core/client.js
