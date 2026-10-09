# 更新日志

## 1.0.8 · 2026-10-09

### 依赖

- 升级 douyin.ts `0.6.6` → `0.6.7`（新增任意消息类型的引用回复）

### 新增

- 引用回复支持任意消息类型：5 分钟内自动引用改用 SDK `msg.reply(chatId, msg, body)`，透传完整消息体而非仅文本——引用后同样可发图片 / 视频 / 文件等，@提及 / @所有人随消息体一并生效
- 合并转发转图片开关：配置项 `bot.forwardToImage`（默认开启），开启时合并转发渲染成「聊天记录」卡片图片发送，关闭时走 SDK 原生 forward 卡片；渲染失败自动回退原生 forward 卡片，避免消息丢失
- 合并转发支持嵌套合并转发：内层 forward 不再被展平混入父节点，而是保留为单个节点——原生卡片下映射为 `msgType=136` 的「[聊天记录:N条]」节点，转图片时递归渲染为内嵌「聊天记录」小卡片（逐级紧凑，任意层级）
- 合并转发图片展示发送者真实头像：优先读好友/群成员缓存的 `avatar`，缺失时按 `secUid` 走 `user.info` 批量补全（50/批）；拿不到头像时退化为昵称首字彩底
- 资源代理：抖音私有富媒体（图片/视频）直链需带签名且校验 `Referer`/`Cookie`，外部直连会 403；消息中的私有图片、视频封面与播放地址改为本机代理地址（`Bot.url` + `/douyin-media/:uin`，附资源 `skey`），由代理按目标账号补全 `Referer`/UA/`Cookie` 拉取并解密（图片 64 hex，AES-256-GCM；CENC 视频 32 hex，AES-128），解密失败按原文回退。头像等公开资源保持直链，不做代理

### 优化

- 合并转发改走 SDK 原生 `sendMergeForward`：不再「先逐条真发节点 → 撤回节点」，消除由此造成的「先发送后撤回」闪屏与留痕；节点携带真实消息 id（转发真实聊天记录）时直接透传，纯生成内容用占位 id 按预览文本组卡，发送失败仅报错、不做降级
- 合并转发转图片的图片/视频节点由 `[图片:md5]` 文本改为真实缩略图与视频封面

### 修复

- 接收侧消息日志展示为空：媒体消息（图片/视频/文件等）正文 `text` 为空，日志直接打印 `raw_message` 会只剩发送者、不见内容；改为与 OPQBot/GSUIDCore 接收侧一致，组装 `message` 段时同步拼接 `raw_message`，且所有消息类型都带基本信息标记（`[提及:昵称]`、`[图片:url]`、`[视频:摘要]`、`[文件:名称]`、`[语音:摘要]`、`[表情]`、`[位置:名称]`、`[聊天记录:N条]`、`[链接/分享/名片/卡片/群邀请:标题]`、`[接龙:描述]`、`[未知消息]`），日志只打 `raw_message`，不再序列化带 `resource` 的消息段

## 1.0.6 · 2026-10-09

### 依赖

- 升级 douyin.ts `0.6.5` → `0.6.6`（新增设备身份持久化能力）

### 新增

- 设备身份持久化适配：连接时读取 `data/DouYin/<uid>/device.json` 注入 `BotOpts.device`，`start()` 后回写；`#抖音bot登录` 登录成功后落盘本次设备身份。复用同一设备身份后跳过设备注册，避免每次启动重新注册导致身份不稳定触发登录二次验证
- 用户资料批量接口：`e.bot.getUserInfo(secUids)` 暴露 SDK `user.info`（按 secUid 批量查昵称/头像/签名/抖音号/关系，50/批）；连接后与每 30 分钟刷新时后台批量补全好友缓存的 `uniqueId`（抖音号）、`shortId`、`signature`、`avatar`，插件可直接读 `e.bot.pickFriend(uid).uniqueId`
- 群成员资料补全：`pickMember.getInfo()` 由原 `grp.members` 单查改为按成员 `secUid` 走 `user.info` 补全真实昵称/头像/抖音号，并落库 `secUid`（此前群成员无 `secUid`，无法查资料）

### 优化

- 重写启动期 Cookie 校验：去除 `user.self()` + `frd.list()` + `grp.list()` 三连探针，改为仅以「群列表」（原生通道 `listNativeGroups`）单次校验——失效时首个请求即抛 `unexpected session length`（无重试），秒级失败；好友/群列表不再在校验与 `loadFriend`/`loadGroup` 中重复全量翻页，启动更快

## 1.0.5 · 2026-10-03

### 修复

- 登录 Cookie 校验：账号登录后、注册进在线账号列表前先拉取好友会话列表校验 Cookie，`get_by_user_init` 报 `unexpected session length` 即判定登录态失效，不再注册该账号，并提示 `请使用 #抖音bot登录 重新扫码`
- 运行期 Cookie 失效检测：好友 / 群列表刷新时同样判定 `session length` 失效，直接移除账号并禁止重连，避免 SDK 自动重连后仍持续拉取会话列表刷屏 `cmd=203 get_by_user_init 失败`
- 重连事件触发 Cookie 校验：SDK 自动重连（reconnecting）时同步校验登录态，失效即移除
- 日志降噪：Cookie 失效时仅打印「登录状态已失效」一条提示，不再输出 cmd=203 刷屏 WARN 与「连接失败」大堆栈；SDK 传输层请求失败日志降级为 debug 级
- 发送消息空引用防护：账号被移除后残留引用触发消息时不再抛 TypeError
- 打开数据库报错 `Database failed to open`（LEVEL_LOCKED）：移除账号时同步关闭好友 / 群 / 成员 leveldb 句柄，修复同一账号重复登录 / 断线重连时因 LOCK 文件占用导致的数据库打不开

## 1.0.4 · 2026-10-01

### 文档

- README 新增「使用其他框架」指引：本插件面向 TRSS-Yunzai 运行时，如需在其他框架中使用抖音相关能力，可参考 [zhin-adapter-douyin](https://github.com/zhinjs/zhin-adapter-douyin)（Zhin 框架）与 [karin-plugin-adapter-douyin](https://github.com/dmmdekkd/karin-plugin-adapter-douyin)（Karin 框架）

## 1.0.2 · 2026-09-29

### 新增

- `#抖音bot登录` 支持二次验证交互：扫码触发短信验证码 / 密码验证时提示对应输入项，直接回复验证码（纯数字）或密码即可完成登录（accept 拦截当前消息，无需任何命令前缀；5 分钟未回复自动超时）
  - 短信验证：`登录触发短信二次验证，验证码已发送（尾号 xxxx），请直接回复 6 位验证码`
  - 密码验证：`登录触发密码二次验证，请直接回复账号密码完成验证`

### 调整

- 移除登录流程 onStatus 状态消息推送（已扫描 / 正在验证等进度不再向会话发送通知）

## 1.0.1 · 2026-09-29

### 修复

- 修复 `#抖音bot更新` / `#抖音bot更新日志` 复用核心更新插件时报错 `Cannot read properties of undefined (reading 'isMaster')`（核心 update 类构造不接收事件参数，需按加载器 `Object.assign(new ..., { e })` 方式手动绑定）

### 许可与依赖

- 采用 MIT 许可证（LICENSE）
- package.json 声明 `license: MIT`
- douyin.ts 依赖锁定指定版本 `0.6.0`，避免 `*` 解析回退旧版 SDK

### 文档与工程

- README 安装教程改为 git 方式，新增网络较差时的代理加速下载说明
- 新增 `.gitignore`，忽略本地开发文件，避免更新拉取冲突

## 1.0.0 · 2026-09-29

首个公开版本。

### 基础功能

- 抖音私聊 / 群聊消息收发，登录态多账号管理（`uid:cookie` 令牌）
- 插件加载阶段并行连接账号，缩短启动耗时
- 事件监听先于好友 / 群列表加载注册，消除启动窗口期消息丢失
- 配置热重载：令牌增删变更后自动连接 / 断开，无需重启

### 消息收发

- 收：文本、@、图片、视频（封面 + 播放地址）、语音、文件、表情包、位置、卡片类（share / userCard / card / groupCard / link / chains / forward）raw 透传
- 发：文本、@、@全体成员、图片、视频、文件、表情、位置、raw 卡片透传；不支持的类型自动降级文本
- 引用回复：5 分钟内触发消息自动引用；node 合并转发映射 SDK forward 卡片（节点先真实发送收集消息 id）
- 发送结果校验：服务端拒绝（statusCode 非 0）推入 error，避免插件误判成功

### 事件

- message：私聊 / 群聊消息、消息编辑（同步更新引用缓存）
- notice：消息撤回、表情回应、已读回执、输入状态、会话更新/删除、好友增减、群成员增减、群管理员变更、群名/头像变更（回填 gl 缓存）、群解散、未分类指令兜底
- request：好友申请、入群申请（approve / reject，自动查询申请人信息）
- voip：语音 / 视频来电感知
- status：会话状态分流（红点、已读、消息删除、群属性、群成员变更），自身客户端同步帧（commandType 3/4/8）静默
- 群成员增减 notice 与 status 双路径派发 + 2 分钟去重；bot 自身进出群不派发（含大数精度丢失的前缀比对兜底）

### Bot 实例

- 标准 pick 对象：pickFriend / pickMember / pickGroup / makeRequest（approve / reject）
- 标准列表方法：getFriendArray / getFriendList、getGroupArray / getGroupList、getGroupMemberArray / getGroupMemberList / getGroupMemberMap
- getChatHistory（含 message_id）、getAvatarUrl、getCookies、getCsrfToken、getSystemMsg、setFriendAddRequest / setGroupAddRequest
- sdk 字段挂载 SDK 全量 API（38 个包装方法）
- 消息统计：stat.recv_msg_cnt / stat.sent_msg_cnt

### 稳定性

- 断线自动重连：5 秒延迟、最多 5 次，主动登出（删除账号 / 重复登录）不重连
- 重复登录检测：connect 前断开旧连接，杜绝双连接；刷新定时器随连接清理，不累积
- Cookie 失效检测：发送鉴权失败提示重新扫码
- 好友 / 群列表每 30 分钟全量刷新，合并写入保留头像等缓存字段

### 指令

- `#抖音bot账号` / `#抖音bot登录` / `#抖音bot删除<uid>`
- `#抖音bot更新`（代理核心更新，含依赖安装与自动重启）/ `#抖音bot更新日志`
