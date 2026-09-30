# 更新日志

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
