<div align="center">

# TRSS-Yunzai DouYin Plugin

TRSS-Yunzai 抖音适配器插件

基于 [douyin.ts](https://github.com/dmmdekkd/douyin.ts) SDK，支持抖音私聊 / 群聊消息收发与事件处理

</div>

## 🐬 安装教程

需要先准备 [TRSS-Yunzai](../../../Yunzai)

<details>
  <summary>展开/收起</summary>

#### 🔧 Yunzai 根目录执行命令安装

推荐使用 git 进行安装，以方便后续使用 `#抖音bot更新` 升级：

```bash
git clone --depth=1 https://github.com/dmmdekkd/DouYin-Plugin.git ./plugins/DouYin-Plugin
```

> [!NOTE]
> 如果你的网络环境较差，无法连接到 Github，可以使用代理加速下载服务
>
> ```bash
> git clone --depth=1 https://ghproxy.521002.xyz/https://github.com/dmmdekkd/DouYin-Plugin.git ./plugins/DouYin-Plugin
> ```

#### 🔧 安装依赖

```bash
pnpm install
```

</details>

## 使用教程

- `#抖音bot账号` 查看已登录账号
- `#抖音bot登录` 扫码登录新账号
- `#抖音bot删除uid` 删除账号并断开连接
- `#抖音bot更新` 更新插件（更新成功自动重启）
- `#抖音bot更新日志` 查看插件更新日志

## 配置说明

配置文件 `config/DouYin.yaml`：

- `permission` 指令权限，默认 `master`
- `bot.timeout` 请求超时时间（ms，默认 30000）
- `bot.autoRead` 收到消息后自动标记已读（对方可见已读回执）
- `bot.activeStatus` 上报在线状态（对方可见在线）
- `token` 账号列表，格式 `uid:cookie`

令牌变更后无需重启，适配器会定时检测配置变化自动连接新账号、断开删除的账号

## 账号安全与风控

### 登录双重验证（建议关闭）

抖音 App「设置 → 账号与安全 → 登录双重验证」开启后，新设备登录或异常登录会要求二次验证。机器人通过 Cookie 模拟登录，开启双重验证时容易触发风控拦截、登录后强制二次验证，导致掉线或消息收发异常。

**建议关闭双重验证**，保持 Cookie 登录稳定：

![抖音账号与安全-双重验证](docs/account-security.jpg)


### 抖音风控限制

可能出现消息仅回显到自身、对方看不到：

## 消息支持

- 收：文本、@、图片（原样透传）、视频（原样透传）、语音（降级文本提示）、文件（原样透传）、表情包、位置、链接/接龙/用户/群邀请等卡片（raw 透传）
- 发：文本、@、@全体成员、图片、视频、文件、表情、位置、raw 卡片透传；不支持的类型自动降级文本（如语音）
- 引用回复：5 分钟内触发消息自动引用；node 合并转发映射 SDK forward 卡片

> 协议限制：发送位置消息仅自身可见；群聊撤回无权限；合并转发节点消息需先真实发送收集消息 id

## 事件支持

- message：私聊 / 群聊消息、消息编辑
- notice：消息撤回、表情回应、已读回执、输入状态、好友增减、群成员增减、群名/头像变更、群解散
- request：好友申请、入群申请（approve / reject）
- voip：语音 / 视频来电感知

## 相关链接

- 许可证：MIT（[LICENSE](LICENSE)）
- SDK：https://github.com/dmmdekkd/douyin.ts
- TRSS-Yunzai：https://github.com/TimeRainStarSky/Yunzai
