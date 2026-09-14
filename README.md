# QQ 农场智能助手（QQ Farm Bot）

> 一个自托管的 QQ 农场多账号自动化管理工具：游戏协议机器人 + Web 控制面板。
> 支持多账号挂机、自动种植收获、好友互动、活动任务、商城购买、图鉴收集，并内置**官方配置自动同步**，让工具数据始终跟上游戏新版本。

---

## ⚠️ 免责声明（请先阅读）

- 本项目**仅供学习与研究**使用。使用本工具可能违反游戏服务条款，由此产生的一切后果（包括但不限于封号、数据丢失）由使用者自行承担。
- 本项目**完全免费、开源**，不收取任何费用，也从未设置付费门槛或 VIP 限制。任何「付费购买源码」「收费代部署」「付费授权」「倒卖牟利」等行为均与作者无关。
- 请勿将本项目用于任何商业用途或非法用途。

---

## ✨ 功能特性

### 核心：多账号挂机

- **多账号独立 Worker**：每个账号独立进程运行，互不干扰；一个账号异常不影响其他账号。
- **多账号切换**：面板右上角与悬浮导航栏随时切换账号，无需退出重登。
- **一键启动 / 停止**：支持批量启停全部账号。
- **自动重连**：掉线自动重连，达到上限后停止并提示。

### 农场自动化

- **自动种植 / 收获**：支持背包种子优先、指定种子、播种顺序随机化、延迟控制。
- **种植提前止损**：识别无收益种植场景，自动止损。
- **多季作物收益口径**：按官方口径精确计算多季作物收益。
- **自动施肥**：智能化肥策略，按容器余量自动补充，支持普通 / 有机化肥。
- **自动除草 / 除虫 / 浇水**：可配置开关。
- **土地升级**：可开启自动升级土地。
- **四格作物优先种植**：自动为 2x2 作物安排合适土地。

### 好友互动

- **自动帮助好友**：浇水 / 除草 / 除虫。
- **自动偷菜（摘取）**：可设置偷取延迟。
- **极速务农**：批量请求优先模式，大幅提升好友操作速度。
- **自动捣蛋（放虫 / 放草）**：连续失败自动暂停至次日。
- **好友管理**：好友列表、搜索筛选、备注、删除、批量删除、黑名单。
- **QQ 好友自动同步**：支持从 GID 列表批量导入。
- **护主犬信息查询**：批量获取好友护主犬信息。

### 宠物系统（护主犬）

- **宠物全量信息**：宠物列表 / 出战状态 / 食物 / 礼包。
- **购买与激活**：支持购买并激活宠物（田园犬 / 牧羊犬 / 斑点狗 / 柯基 / 护主犬 / 比熊犬）。
- **出战护农**：设置看护宠物、收回宠物。
- **投喂狗粮**：给自家或好友的宠物投喂。
- **看护日志**：查询守护记录。
- **同气礼包**：一键领取全部礼包。
- **宠物皮肤 / 自定义名**：装备皮肤、设置自定义名称。
- **好友投喂**：查看好友投喂信息并回喂。

### 任务与活动

- **任务自动化**：每日任务、成长任务自动领取。
- **活动中心**：观星礼录、荷露商店、节令小札等。
- **每日礼包**：邮箱奖励、分享礼包、商城免费礼包自动领取。

### 商城与仓库

- **种子商店**：动态读取商品、按等级显示可购买状态、一键购买。
- **宠物商店 / 装扮商店**：动态读取清单，新商品自动出现。
- **商城（道具）**：化肥、狗粮礼包等。
- **神秘商人**：自动购买 / 请离。
- **背包管理**：按类别查看（果实 / 种子 / 道具）、出售、批量出售、使用。
- **仓库自动出售**：自动出售果实换金币，自动开启化肥礼包。

### 数据与统计

- **图鉴系统**：作物图鉴、变异图鉴、一键购买、奖励领取。
- **个人生涯**：历史累计收获、摘取统计、收获明细排行。
- **数据分析**：金币 / 经验收益趋势、操作统计。
- **实时日志**：多账号日志流、按账号筛选、关键词搜索。
- **数据统计**：今日收益、操作次数一目了然。

### 其他

- **应用宝扫码登录**：内置扫码登录能力。
- **抓包登录**：支持通过抓包获取登录凭证。
- **推送通知**：支持 Pushoo 等推送渠道。
- **后台管理**：用户管理、卡密系统、登录日志、系统配置。
- **亮 / 暗双主题**：全局毛玻璃质感，移动端 / 桌面端自适应。

---

## 🔄 官方配置自动同步（重点）

游戏会不断新增作物、道具和宠物。本项目内置**配置同步工具**，让本地数据始终跟上官方版本，无需手动补表。

### 工作原理

```
游戏客户端缓存 settings.json
        │  读取 bundleVers（版本号）
        ▼
官方 CDN config.<vers>.json（资源清单）
        │  定位配置表的 uuid + hash
        ▼
import/<uuid>.<hash>.json（XOR 加密）
        │  解密
        ▼
全量 JSON 配置表 → 合并进本地 gameConfig
```

### 服务端自动同步

- 服务启动后 **90 秒**首次检查，之后**每 6 小时**巡检一次。
- **仅在检测到官方版本号变化时**才联网拉取（版本未变时零网络开销）。
- 同步完成后自动**热加载** `gameConfig`，新道具 / 新作物即时生效。
- 无游戏客户端缓存的部署环境（如纯服务器）会静默跳过，不影响服务运行。

### 手动同步

```bash
# 对比官方与本地差异
node scripts/sync-game-config.js check

# 拉取全量数据并写入（ItemInfo / Plant / RoleLevel）
node scripts/sync-game-config.js sync --write

# 补全缺失物品图标
node scripts/sync-game-config.js icons --write

# 数据 + 图标一起同步
node scripts/sync-game-config.js all

# 列出官方全部配置表
node scripts/sync-game-config.js tables

# 导出单张表
node scripts/sync-game-config.js raw ItemInfo
```

**后续官方更新流程**：打开一次游戏客户端（客户端自动刷新缓存的版本号）→ 服务启动时自动同步，或手动运行 `check` 查看差异 → `sync --write` + `icons --write` 落地。

### 合并策略（保护本地数据）

- 官方字段优先覆盖。
- 仅本地存在的字段（`price` / `price_id` 等）保留。
- 官方已下架的本地独有条目保留不删。
- 官方名称确认后自动清理 `_name_unknown` 占位标记。

---

## 🚀 快速开始

### 环境要求

- **Node.js 20+**
- **pnpm**（推荐通过 `corepack enable` 启用）
- Docker（可选，仅 Docker 部署需要）

### 方式一：源码运行（推荐本地使用）

```bash
git clone https://github.com/Jia004/qq_farm-bot.git
cd qq_farm-bot

corepack enable
pnpm install
pnpm build:web
pnpm dev:core
```

启动后访问：

- 本机：`http://localhost:3900`
- 局域网：`http://<你的IP>:3900`

默认管理员账号：`admin` / `admin`（**部署后请立即修改密码**）

> **Windows 端口提示**：默认端口 `3900`。原 3007 常被 Hyper-V / WSL 保留导致 `EACCES`，故迁移至 3900。
> 如需修改端口：`ADMIN_PORT=你的端口 pnpm dev:core`（Windows：`$env:ADMIN_PORT="你的端口"; pnpm dev:core`）

### 方式二：Docker 部署

```bash
git clone https://github.com/Jia004/qq_farm-bot.git
cd qq_farm-bot

docker compose up -d --build
docker compose logs -f
```

停止并移除容器：

```bash
docker compose down
```

### 方式三：二进制发布版

```bash
pnpm install
pnpm package:release
```

产物输出在 `dist/` 目录：

| 平台 | 文件名 |
| --- | --- |
| Windows x64 | `qq-farm-bot-win-x64.exe` |
| Linux x64 | `qq-farm-bot` |
| macOS Intel | `qq-farm-bot-x64` |
| macOS Apple Silicon | `qq-farm-bot-arm64` |

程序会在可执行文件同级目录自动创建 `data/`，用于保存账号、用户、日志和缓存等运行时数据。

---

## 📁 项目结构

```text
qq_farm-bot/
├── core/                       # 后端（Node.js 机器人引擎）
│   ├── src/
│   │   ├── config/             # 配置管理、游戏配置加载
│   │   ├── controllers/        # HTTP API 路由（43 个模块）
│   │   ├── gameConfig/         # 游戏静态数据（ItemInfo / Plant / RoleLevel + 图标）
│   │   ├── models/             # 数据模型与持久化
│   │   ├── proto/              # Protobuf 协议定义（游戏通信）
│   │   ├── runtime/            # 运行时引擎与 Worker 管理
│   │   ├── services/           # 业务逻辑（农场/好友/宠物/任务等，41 个模块）
│   │   ├── capture/            # 内置抓包服务（MITM）
│   │   └── utils/              # 工具（网络 / 协议 / 加密 / TSDK）
│   ├── test/                   # 单元测试
│   └── client.js               # 后端入口
├── web/                        # 前端（Vue 3 + Vite）
│   ├── src/
│   │   ├── api/                # API 客户端
│   │   ├── components/         # Vue 组件
│   │   ├── stores/             # Pinia 状态管理
│   │   └── views/              # 页面视图
│   └── dist/                   # 前端构建产物
├── scripts/                    # 工具脚本
│   ├── sync-game-config.js     # 官方配置全量同步工具 ★
│   ├── extract_item_icons.py   # 物品图标批量提取
│   └── extract_seed_icons.py   # 种子图标提取
├── docker-compose.yml
├── start.sh / start.bat
└── package.json
```

---

## 🛠 常用命令

```bash
# 安装全部依赖
pnpm install -r

# 构建前端
pnpm build:web

# 启动后端 + 面板
pnpm dev:core

# 前端开发模式（热更新）
pnpm dev:web

# 前后端代码检查
pnpm lint

# 运行测试
pnpm -C core test

# 打包发布版
pnpm package:release
```

---

## ⚙️ 配置说明

### 后台管理

- 面板首次访问需要登录，默认 `admin` / `admin`。
- **部署后请立即修改默认密码。**

### 数据与隐私

以下内容已通过 `.gitignore` 排除，**不应**提交到仓库：

- `core/data/`（账号、用户、登录日志、好友缓存、统计数据等）
- `node_modules/`
- `web/dist/`
- `.env` / `.env.*`
- `*.log` / `logs/` / `tmp/`

`core/data/` 会在运行时自动生成，可能包含账号等敏感信息。备份或迁移服务器时请单独处理该目录，不要提交到 GitHub。

---

## 🔧 技术栈

**后端**

- Node.js 20+ / CommonJS
- Express 4（HTTP API）
- Socket.IO 4（实时日志与状态推送）
- Protobuf.js（游戏协议）
- TSDK / ACE 安全链路（WASM）

**前端**

- Vue 3 + Vite 7
- TypeScript 5
- Pinia 3（状态管理）
- UnoCSS（样式）

**部署**

- pnpm 10 workspace
- Docker
- pkg（二进制打包）

---

## ❓ 常见问题

**Q：面板打不开 / 端口报 EACCES？**
A：Windows 上 3002-3101 端口区间常被 Hyper-V / WSL 保留。本项目默认使用 3900。若仍报错，执行 `netsh interface ipv4 show excludedportrange protocol=tcp` 查看保留区间，换一个不在其中的端口。

**Q：游戏更新后，新作物 / 新道具不显示？**
A：运行 `node scripts/sync-game-config.js check` 查看差异，然后 `sync --write` + `icons --write`。若服务在运行，它也会自动巡检同步。前提是**本机需要先打开过一次游戏客户端**（用于刷新官方版本号缓存）。

**Q：账号登录不上 / 提示需要更新 Code？**
A：游戏登录 code 有效期较短。在面板中更新账号 Code 后重启该账号。

**Q：Node 报 `getaddrinfo ENOTFOUND gate-*.nqf.qq.com`？**
A：部分 Windows 环境下 Node 的 DNS 解析器读不到系统 DNS。本项目已在 `core/client.js` 内置公共 DNS 兜底，一般无需处理。

---

## 🙏 致谢

本项目为**二次修改（二改）维护分支**，基于以下开源项目：

- 上游基础：[cwser/qq-farm-bot-private](https://github.com/cwser/qq-farm-bot-private)
-  [Aoluis1005/qq-farm-bot](https://github.com/Aoluis1005/qq-farm-bot)
- UI 基础：[Penty-d/qq-farm-bot-ui](https://github.com/Penty-d/qq-farm-bot-ui)
- 核心功能：[linguo2625469/qq-farm-bot](https://github.com/linguo2625469/qq-farm-bot)
- 部分功能：[QianChenJun/qq-farm-bot](https://github.com/QianChenJun/qq-farm-bot)
- 扫码登录：[lkeme/QRLib](https://github.com/lkeme/QRLib)
- 推送通知：[imaegoo/pushoo](https://github.com/imaegoo/pushoo)

感谢所有上游作者的开源贡献。

---

## 📄 许可与使用

- 本仓库为二改维护分支，请遵守上游项目的开源协议。
- 本项目仅供学习研究，禁止任何形式的商业售卖与倒卖。
- 使用本工具产生的一切后果由使用者自行承担。
