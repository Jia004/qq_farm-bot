# QQ 农场更新日志

这里记录最近更新了什么。

## 2026-09-13（Aoluis1005 维护分支）

### 新增功能

- **官方配置自动同步（服务端调度）**：服务启动后 90 秒自动检查一次游戏版本，之后每 6 小时巡检；仅在检测到官方 `bundleVers` 变化时才联网拉取（版本未变时零网络开销），同步完成后自动热加载 `gameConfig` 使新道具/新作物即时生效。新增 `core/src/services/config-sync-scheduler.js`，接入 `core/client.js` 启动流程；无游戏客户端缓存的部署环境（如纯服务器）会静默跳过，不影响服务运行。
- **官方配置全量同步工具 `scripts/sync-game-config.js`**：把「缺什么补什么」的按需维护，升级为「一次拉全官方数据」。
  - 数据链路（已逆向验证）：游戏客户端缓存 `settings.json` 里的 `bundleVers` → 官方 CDN `config.<vers>.json` 资源清单 → 各配置表的 uuid + hash → `import/<uuid>.<hash>.json`（XOR 加密）→ 解密得到全量 JSON。
  - 支持命令：`check`（对比官方与本地差异）、`sync`（拉取 ItemInfo / Plant / RoleLevel 全量数据，`--write` 写入）、`icons`（补全缺失物品图标，`--write` 下载）、`tables`（列出官方全部 103 张配置表）、`raw <表名>`（导出单张表）、`all`（数据 + 图标一起同步）、`auto`（版本感知自动同步，供服务端调用）。
  - **合并策略保护本地数据**：官方字段优先覆盖；仅本地存在的字段（`price` / `price_id` 等）保留；官方已下架的本地独有条目保留不删；官方名称确认后自动清理 `_name_unknown` 占位标记。
  - **图标补全双通道**：清单里直接可下载的 PNG 直接拉取；被打进图集的 sprite（`extraRes` 的 pack）自动建立图集帧索引并**纯 Node 裁剪**（无需外部图像库），支持 rotated 帧。动态合成资源（种子解锁卡 `icon_card_crop_*`、自选礼包 `giftpack_*`）自动识别跳过并说明原因。
  - **版本感知**：记录上次同步的 `bundleVers` 至 `core/src/gameConfig/.sync-meta.json`；版本未变时 `check` 直接提示「已是最新」。
  - 后续官方更新流程：**打开一次游戏客户端**（客户端自动刷新缓存的版本号）→ 服务启动时自动同步，或手动运行 `node scripts/sync-game-config.js check` 查看差异 → `sync --write` + `icons --write` 落地。
  - 本次同步结果：`ItemInfo.json` 716 → 775 条（官方新增 59 条，含鹊羽/天气瓶/比熊乐园/头像框等）、`Plant.json` 255 → 270 条（新增狗尾草、小红花、芦苇、枸杞、寒兰、金币果、经验蘑菇等 8 个新作物及其黄金变种）、物品图标补全 145+ 个。
  - 配套单元测试：`core/test/sync-game-config.test.js`（14 例：XOR 解密 / UUID 解码 / 合并策略 / PNG 编解码与图集裁剪）、`core/test/config-sync-scheduler.test.js`（7 例：生命周期 / 并发保护 / 结果分类）。

## 2026-09-12（Aoluis1005 维护分支）

### 新增功能

- **抓包资源存档（补齐新物品图标的关键一步）**：内置抓包服务现在会把游戏客户端下载的 CDN 资源响应体落盘到 `core/data/capture-assets/`（含资源清单 `manifest.json` 与 `.astc` 图集）。原理：MITM 代理按 TLS 连接对响应做顺序归因（请求队列 + Content-Length / chunked 帧解析），只存档文本类（json/js/manifest）与纹理类资源，单文件 8MB/32MB、总量 512MB 上限，完全旁路不影响转发。
  - 新增 `GET /api/admin/capture-assets`：面板查看已抓资源列表；
  - 新增 `POST /api/admin/capture-assets/export-manifest`：把抓到的资源清单导出为 `core/src/gameConfig/manifest-from-capture.json`；
  - `scripts/extract_item_icons.py` 新增 `--manifest` 参数：直接吃抓包得到的 `manifest.json`（游戏格式），补齐 `manifest.csv` 里没有的新物品图标。
- **`capture-asset-store.js`**：新增抓包资源存档模块（落盘器 + 连接级响应跟踪器），配套 10 个测试（纯函数 / 多请求归因 / chunked+gzip / MITM 端到端）。

## 2026-07-31（Aoluis1005 维护分支）

### 新增功能

- **观星礼录（二十八星宿·每日馈赠）**：活动中心新增「观星」页签，展示 28 星宿每日进度、已解锁/已领取/可领取状态与奖励明细；支持一键领取全部已解锁星宿奖励，并带「自动领取」开关（localStorage 持久化，进入页签自动领一次）。后端新增 `GET /api/activity/guanxing`、`POST /api/activity/guanxing/claim`，解析活动 GetGroup/Operate 回包（星宿数据字段 110、扩展字段 119 贴合官方客户端）。
- **星纱（SAIJI）商店 16 件商品图标**：14 件装扮（萤火/月光小屋、街道、狗屋、木牌、仓库、栅栏、围栏）与 2 个头像框（萤火星房 2156 / 月光营地 2157）接入 `skinDetail` 干净图标（`icon_skin_*` / `img_avatar_S2_*`），`getItemImageById` 按 itemId 前缀自动解析，`/api/activity/helu` 的 `exchangeShop.items[].image` 全部有图。
- **植物数据表扩充**：`ItemInfo.json` 700 条（+101：星纱货币 1019/1021/1022/1023、头像框 2152-2157、新种子等）、`Plant.json` 255 条（+50 新植物）；新增 13 张 `Crop_*_Seed.png` 种子图标与 `scripts/extract_seed_icons.py` 提取脚本。
- **种子/果实名称 Plant.json 兜底**：`getPlantNameOrNull` / `getPlantBySeedId` / `getPlantByFruitId` 加入 `gameConfig.js`；仓库、背包、图鉴、土地分析等在 `ItemInfo` 缺失时统一回退到 `Plant.json`（含变异果实 `1040xxx→1120xxx` 换算）。

### Bug 修复

- **活动图标名称优先级**：`HeluDrawPanel` 等面板的兜底首字优先取 `item.name`（中文真名），`itemName` 兜底。
- **仓库种子判定统一**：`warehouse.js` 改为以 `Plant.json` 为唯一种子/果实判定依据，删除旧的启发式兜底路径，记录疑似漏配种子便于补表。

### 优化

- **月光营地滤镜**：萤火/月光两套皮肤共用同一张 `skinDetail` 图，`ActivityItemImage.vue` 对名称含「月光」的物品叠加冷色调滤镜（`hue-rotate-180 brightness-90 saturate-125`），视觉上区分两套装扮。

## 2026-07-27（Aoluis1005 维护分支）

### 新增功能

- **个人生涯统计弹窗**：点击概览页微信头像即可弹出，展示玩家头像 / 昵称 / 等级 / 经验 / 角色编号，以及「历史累计收获」与「累计摘取好友作物」两项统计；下方为收获明细网格（含前三名金银铜标牌）。新增后端 `gamepb.careerpb.CareerService/CareerInfoGet` 接口与 `GET /api/career`（需 `x-admin-token` 与 `x-account-id`）。

### Bug 修复

- **修复生涯弹窗收获列表为空**：后端 `proto.js` 全局开启 `keepCase:true`，而 `career-api.js` 误用 `fruitId` / `statsTotal` 等 camelCase 字段，导致解码取不到数值、列表被过滤为空；已统一改为 `fruit_id` / `stats_total` / `level_stats` / `achieved_levels` 等 snake_case，实测返回 174 条收获数据。
- **修复好友页面导致服务崩溃 / 反复重启**：`admin.js` 注册好友路由时漏传 `getAccountIdFromRequest` 等依赖，打开「好友」页面调用 `/api/friends` 会抛出 `TypeError` 使整个 Node 进程退出，触发容器重启、登录掉线、账号自动停止；已补全路由依赖，并新增 `process.on('unhandledRejection')` 全局守卫，单个坏请求不再拖垮全服。
- **修复生涯弹窗 API 超时体验**：后端 `sendMsgAsync` 超时由 20s 降到 10s，路由出错时返回 `{ok:false, error}`（不再误报 `ok:true` 造成弹窗空白）；前端超时提示文案改为「加载超时，请确认该账号已在游戏中上线后重试」并保留重试按钮。

### 优化

- **生涯弹窗移动端体验**：改为居中毛玻璃卡片（`backdrop-blur-2xl` + 半透明底色），四周留白、不再贴边/顶屏；层级抬到 `z-[1100]` 避免被底部悬浮导航栏遮挡；并隐藏滚动条（保留滚动能力），排版更美观。

## 2026-07-22（Aoluis1005 维护分支）

### Bug 修复

- 修复应用宝离线重连「无限重连」：重连失败分支（`ws_reconnect_failed`）在停 Worker 时无条件清空了重连计数，导致「重连 N 次后停止」永远不触发、日志恒显示 `(1/3)`。现改为 `stopWorker` 仅在手动停止 / 踢下线 / 删除账号时清零计数，自动重连路径保留计数跨周期累积，达到上限后真正停止重连。
- 修复重连日志在面板「常驻最下方」：账号日志时间戳为 `YYYY-MM-DD HH:mm:ss` 空格格式，浏览器 `Date.parse` 解析为 `NaN` 后回退成 `Date.now()`，使旧日志被错误顶到列表底部、不随新日志上移。现统一转成 ISO（`T` 分隔）再解析，并给账号日志补充数字 `ts` 字段，排序归位正常。

## 2026-07-19（Aoluis1005 维护分支）

### Bug 修复

- 修复好友「经验满只帮护主犬」模式失效、无差别帮助所有人的问题（经验额度数据缺失时不再误重置）。
- 修复自动重连失控：移除 Worker 内自动重连（指数退避重试），仅保留主进程的应用宝离线重连；并重连计数不再被 worker 启动清零，达到上限后真正停止。
- 修复悬浮导航栏「自动避让弹窗检测」引发的 dock 永久消失 bug：移除基于几何判定的自动检测（误判常驻 fixed 元素为弹窗），dock 回归稳定长驻；保留手动收起（把手/小药丸）与「更多」面板打开时自动收起。

### 优化

- 应用宝接口配置：API Token 不再写死，改为用户自行输入；接口地址保留可更改的默认值；appId 不再写死。
- 好友交互效率提升：移除预检查、并行帮助、批量偷菜、巡查期好友列表缓存、巡逻时收集狗信息等。
- 悬浮导航栏：稳定长驻底部；支持手动收起/展开（把手 + 小药丸），打开「更多」面板时自动收起。

## 2026-07-12

### 新增功能

- 新增设置方案上传云端，新账号可直接导入设置方案。
- 新增多账号一键同步设置方案。
- 新增抓包登录。
- 新增黄金虫图标、投放与清除。

### 优化

- 活动抽奖完成通知不再挡住右上角账号切换。

## 2026-07-11

### 新增功能

- 活动中心支持一次兑换多个化肥或有机化肥。
- 登录页支持自定义图标、标题和提示语。
- 新增购买卡密、加入 QQ 群和更新日志入口。

### Bug 修复

- 修复 QQ 会员每日礼包领取。

### 优化

- 运行日志只保留最近三天，减少日志占用。

## 2026-07-06

### 新增功能

- 新增四格作物优先种植，会自动安排合适的土地。
- 自动捣蛋连续失败后会暂停到第二天，避免一直报错。
- 新账号默认优先使用背包种子，也可以调整种子顺序。

### Bug 修复

- 修复好友农场相关操作。

### 优化

- 优化商城移动端布局、账号切换和网络稳定性。
- 精简运行日志，果实出售结果显示更清楚。

## 2026-07-04

### 新增功能

- 新增最终阶段施肥策略。
- 购买种子和化肥时可以选择数量，也可以按余额自动计算最多可买多少。
- 放虫放草连续失败后会自动停止。

### 优化

- 金币、点券、金豆豆数量显示更简洁。

## 2026-07-03

### Bug 修复

- 修复管理员弹窗在小屏幕上显示不完整的问题。

### 优化

- 优化手机端页面滚动和顶部栏显示。

## 2026-07-02

### 新增功能

- 新增“青梅酿万金”活动及青梅酿酒功能。
- 账号切换支持显示账号名称和头像。

### Bug 修复

- 修复满级后好友帮助异常的问题。

### 优化

- 优化界面和头像显示。
- 优化活动页移动端显示。
