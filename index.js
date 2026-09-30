logger.info(logger.yellow("- 正在加载 DouYin 适配器插件"))

import makeConfig from "../../lib/plugins/config.js"
import QRCode from "qrcode"
import md5 from "md5"
import path from "node:path"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as douyin from "douyin.ts"
import { update } from "../other/update.js"

// SDK sendBody 支持 11 种类型（text/image/video/file/emoji/share/userCard/forward/card/location/groupCard）；
// audio/link/chains 无发送实现，raw 透传时降级为文本
const sdkSendable = new Set(["text", "image", "video", "file", "emoji", "share", "userCard", "forward", "card", "location", "groupCard"])

const { config, configSave } = await makeConfig(
  "DouYin",
  {
    tips: "",
    permission: "master",
    bot: {
      timeout: 30000,
      // 收到消息后自动标记已读（对方可见已读回执）
      autoRead: true,
      // 上报在线状态（对方可见在线）
      activeStatus: true,
    },
    token: [],
  },
  {
    tips: [
      "欢迎使用 TRSS-Yunzai DouYin Plugin ! SDK：dmmdekkd",
      "参考：https://github.com/dmmdekkd/douyin.ts",
    ],
  },
)

const adapter = new (class DouYinAdapter {
  constructor() {
    this.id = "DouYin"
    this.name = "DouYin"
    this.path = "data/DouYin/"
    // SDK 名称与版本号（exports 不含 package.json，通过入口文件路径定位读取）
    const { name, version } = JSON.parse(
      readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve("douyin.ts"))), "../package.json"), "utf8"),
    )
    this.version = `${name} ${version}`
    this.logining = false
    // 登录二次验证等待：{ kind: "sms"|"password", resolve, reject }，由验证码/密码指令消费
    this.mfaWait = null
    // 断线重连状态：各账号已重试次数 / 主动登出标记
    this.reconnects = {}
    this.noReconnect = new Set()
    // 群成员增减去重：notice 与 status 补漏双路径
    this.memberSeen = new Map()
    this.refreshes = {}
  }

  makeSDKLog(id) {
    return {
      info: msg => Bot.makeLog("debug", msg, id),
      warn: msg => Bot.makeLog("warn", msg, id),
      error: msg => Bot.makeLog("error", msg, id),
    }
  }

  makeMessageSegs(msg) {
    const message = []
    for (const i of msg.ats || []) message.push({ type: "at", qq: i.uid })

    switch (msg.type) {
      case "text":
        message.push({ type: "text", text: msg.text })
        break
      case "image": {
        const url =
          msg.image.thumbUrls?.[0] || msg.image.mediumUrls?.[0] || msg.image.largeUrls?.[0] || msg.image.originUrls?.[0]
        if (url) message.push({ type: "image", file: url })
        if (msg.text) message.push({ type: "text", text: msg.text })
        break
      }
      case "video": {
        // 封面图 + 播放地址（签名 URL 有时效，过期可 media.videoUrl 重取）
        const cover = msg.video?.poster
        const coverUrl = cover?.mediumUrls?.[0] || cover?.thumbUrls?.[0] || cover?.largeUrls?.[0] || cover?.originUrls?.[0]
        if (coverUrl) message.push({ type: "image", file: coverUrl })
        else if (msg.video?.inlinePic) message.push({ type: "image", file: `base64://${msg.video.inlinePic}` })
        const videoUrl = msg.video?.url?.mainUrl
        message.push({ type: "text", text: videoUrl ? `[视频] ${videoUrl}` : "[视频]" })
        if (msg.text) message.push({ type: "text", text: msg.text })
        break
      }
      case "file":
        message.push({ type: "text", text: `[文件] ${msg.file?.name || msg.file?.md5 || ""}` })
        if (msg.text) message.push({ type: "text", text: msg.text })
        break
      case "audio":
        message.push({ type: "record", file: msg.audio?.urls?.[0] })
        if (msg.text) message.push({ type: "text", text: msg.text })
        break
      case "emoji":
        if (msg.emoji) message.push({ type: "image", file: msg.emoji })
        if (msg.text) message.push({ type: "text", text: msg.text })
        break
      case "location":
        if (msg.location) message.push({ type: "location", ...msg.location })
        if (msg.text) message.push({ type: "text", text: msg.text })
        break
      default:
        // 卡片等未支持类型透传原始消息体
        message.push({ type: "raw", data: msg })
        if (msg.text) message.push({ type: "text", text: msg.text })
    }
    return message
  }

  async makeMsg(data, msg, nested) {
    const msgs = []
    let text = "",
      ats = [],
      atAll = false,
      image,
      // 5 分钟内自动引用触发消息
      reply = !nested && data.time && Date.now() / 1000 - data.time < 300 ? data.bot.replys[data.message_id] : undefined

    const flush = () => {
      if (image) {
        msgs.push({ type: "image", body: { type: "image", image, text }, reply })
        text = ""
        ats = []
        image = undefined
        reply = undefined
      } else if (text || ats.length || atAll) {
        // loader 的 at 选项会插入 "\n" 分隔段，SDK 提及追加在末尾，去掉多余换行
        msgs.push({
          type: "text",
          body: {
            type: "text",
            text: ats.length || atAll ? text.replace(/^\n+/, "") : text,
            ...(ats.length ? { ats } : {}),
            ...(atAll ? { atAll: true } : {}),
          },
          reply,
        })
        text = ""
        ats = []
        atAll = false
        reply = undefined
      }
    }

    for (const i of Array.isArray(msg) ? msg : [msg]) {
      switch (i.type) {
        case "text":
          if (!i.text?.trim()) continue
          if (image) flush()
          text += i.text
          break
        case "at": {
          const uid = String(i.qq)
          if (uid === "all") {
            atAll = true
            continue
          }
          if (image) flush()
          ats.push({
            uid,
            nickname: data.bot.gml.get(data.group_id)?.get(uid)?.nickname || data.bot.fl.get(uid)?.nickname || uid,
          })
          break
        }
        case "image":
          flush()
          image = await Bot.Buffer(i.file, { http: true })
          break
        case "record":
        case "file":
          flush()
          msgs.push({ type: i.type, body: { type: "file", file: { source: await Bot.Buffer(i.file, { http: true }) } } })
          break
        case "video":
          flush()
          msgs.push({ type: "video", body: { type: "video", video: { source: await Bot.Buffer(i.file, { http: true }) } } })
          break
        case "raw": {
          flush()
          // SDK 不支持的类型（link/chains/audio/emoji/unknown）降级为文本发送
          let body = i.data
          if (!sdkSendable.has(body.type)) {
            const link = body.link
            const text = link
              ? [link.title, link.url].filter(Boolean).join("\n")
              : body.chains
                ? [body.chains.description, ...(body.chains.entries || []).map(i => i.text)].filter(Boolean).join("\n")
                : body.audio?.urls?.[0] || body.text || body.emoji || ""
            body = { type: "text", text }
          }
          if (body.type !== "text" || body.text?.trim()) msgs.push({ type: "raw", body })
          break
        }
        case "location":
          flush()
          // 兼容 icqq 命名（lat/lng/title）与 SDK 命名（latitude/longitude/name）
          msgs.push({
            type: "location",
            body: {
              type: "location",
              location: {
                name: i.name || i.title,
                address: i.address,
                latitude: i.latitude ?? i.lat,
                longitude: i.longitude ?? i.lng,
                ...(i.poiId ? { poiId: i.poiId } : {}),
              },
            },
          })
          break
        case "face":
          // QQ 数字表情 id 无抖音对应，仅透传抖音小表情 id（如 weixiao）
          if (i.id && !/^\d+$/.test(String(i.id))) {
            flush()
            msgs.push({ type: "raw", body: { type: "emoji", emoji: String(i.id) } })
          }
          continue
        case "button":
        case "markdown":
          continue
        case "node": {
          // 合并转发：收集节点消息体，sendMsg 阶段先真实发送再引用构建 forward 卡片
          const bodies = []
          for (const { message } of i.data)
            for (const seg of await this.makeMsg(data, message, true))
              if (seg.type === "forward") bodies.push(...seg.bodies)
              else bodies.push(seg)
          if (bodies.length) msgs.push({ type: "forward", bodies })
          continue
        }
        case "reply":
          reply = data.bot.replys[i.id]
          continue
        default:
          if (image) flush()
          text += Bot.String(i)
      }
    }
    flush()
    return msgs
  }

  makeBrief({ type, body, reply }) {
    let brief = reply ? `[回复:${reply.serverMessageId}]` : ""
    switch (type) {
      case "text":
        for (const i of body.ats || []) brief += `@[${i.uid}]`
        if (body.atAll) brief += "@[所有人]"
        return brief + body.text
      case "image":
        return `${brief}[图片:${md5(body.image)}]${body.text || ""}`
      case "record":
        return `${brief}[语音:${md5(body.file.source)}]`
      case "video":
        return `${brief}[视频:${md5(body.video.source)}]`
      case "file":
        return `${brief}[文件:${md5(body.file.source)}]`
      case "raw":
        return (
          brief +
          (body.text ||
            body.groupCard?.groupName ||
            body.user?.name ||
            body.share?.title ||
            body.card?.title ||
            body.chains?.description ||
            (body.emoji ? `[表情:${body.emoji}]` : undefined) ||
            `[${body.type}]`)
        )
      case "location":
        return `${brief}[位置:${body.location.name}]${body.text || ""}`
      default:
        return brief + JSON.stringify(body)
    }
  }

  // 发送单条消息体（reply 优先走引用回复），statusCode 非 0 抛错由调用方统一处理
  async sendBody(data, { reply, body }) {
    const ret = reply
      ? await data.bot.sdk.msg.reply(data.chatId, reply, body.text, {
          ...(body.atAll ? { atAll: true } : {}),
          ...(body.ats?.length ? { ats: body.ats } : {}),
        })
      : await data.bot.sdk.msg.send(data.chatId, body)
    Bot.makeLog("debug", ["发送消息返回", ret], data.self_id)
    if (ret.statusCode) throw new Error(`发送被拒：statusCode=${ret.statusCode} ${ret.statusMsg || ""}`)
    return ret
  }

  // 合并转发：协议要求引用会话内已发送消息，先逐条真实发送节点收集 msgId，
  // 再组装 forward 卡片，最后撤回节点原消息（群聊无撤回权限会留痕，协议限制）
  async sendForward(data, { bodies }, rets) {
    // 节点消息类型映射（7 文本 / 27 图片 / 30 视频 / 136 转发 / 152 接龙，未知给 0）
    const fwdType = { text: [7, 700], image: [27, 2702], video: [30, 0], forward: [136, 0], chains: [152, 0] }
    const nodes = [],
      sent = []
    try {
      for (const seg of bodies) {
        const ret = await this.sendBody(data, seg)
        rets.data.push(ret)
        if (!ret.serverMessageId) throw new Error("节点消息发送失败，无法构建合并转发")
        sent.push(String(ret.serverMessageId))
        nodes.push({
          uid: String(data.self_id),
          nickname: data.bot.nickname,
          text: this.makeBrief(seg),
          msgType: fwdType[seg.type]?.[0] ?? 0,
          aweType: fwdType[seg.type]?.[1] ?? 0,
          msgId: String(ret.serverMessageId),
        })
      }
      Bot.makeLog("info", `send to ${data.group_id ? `Group(${data.group_id})` : `User(${data.user_id})`}: [合并转发:${nodes.length}条]`, data.self_id)
      const ret = await data.bot.sdk.msg.send(data.chatId, { type: "forward", nodes })
      rets.data.push(ret)
      if (ret.statusCode) rets.error.push(new Error(`发送被拒：statusCode=${ret.statusCode} ${ret.statusMsg || ""}`))
      else if (ret.serverMessageId) rets.message_id.push(ret.serverMessageId)
    } catch (err) {
      Bot.makeLog("error", ["发送合并转发错误", err], data.self_id)
      if (/HTTP 401|login|auth|登录|expire/i.test(String(err.message || err)))
        Bot.makeLog("error", `${data.self_id} 登录状态已失效，请使用 #抖音bot登录 重新扫码`, data.self_id)
      rets.error.push(err)
    }
    for (const msgId of sent)
      data.bot.sdk.msg.recall(data.chatId, msgId).catch(err => Bot.makeLog("debug", ["合并转发节点撤回失败", msgId, err], data.self_id))
  }

  async sendMsg(data, msg) {
    const rets = { message_id: [], data: [], error: [] }
    data.bot.stat.sent_msg_cnt++
    for (const i of await this.makeMsg(data, msg)) {
      if (i.type === "forward") {
        await this.sendForward(data, i, rets)
        continue
      }
      try {
        Bot.makeLog(
          "info",
          `send to ${data.group_id ? `Group(${data.group_id})` : `User(${data.user_id})`}: ${this.makeBrief(i)}`,
          data.self_id,
        )
        const ret = await this.sendBody(data, i)
        rets.data.push(ret)
        if (ret.serverMessageId) rets.message_id.push(ret.serverMessageId)
      } catch (err) {
        Bot.makeLog("error", ["发送消息错误", i.body, err], data.self_id)
        if (/HTTP 401|login|auth|登录|expire/i.test(String(err.message || err)))
          Bot.makeLog("error", `${data.self_id} 登录状态已失效，请使用 #抖音bot登录 重新扫码`, data.self_id)
        rets.error.push(err)
      }
    }
    return rets
  }

  async sendFriendMsg(data, msg) {
    if (!data.chatId) {
      await this.loadFriend(data.self_id)
      Object.assign(data, Bot[data.self_id].fl.get(data.user_id) || {})
      if (!data.chatId) {
        Bot.makeLog("error", [`发送好友消息失败：[${data.user_id}] 不存在会话信息`, msg], data.self_id)
        return false
      }
    }
    return this.sendMsg(data, msg)
  }

  async sendGroupMsg(data, msg) {
    if (!data.chatId) {
      await this.loadGroup(data.self_id)
      Object.assign(data, Bot[data.self_id].gl.get(data.group_id) || {})
      if (!data.chatId) {
        Bot.makeLog("error", [`发送群消息失败：[${data.group_id}] 不存在会话信息`, msg], data.self_id)
        return false
      }
    }
    return this.sendMsg(data, msg)
  }

  async recallMsg(data, message_id) {
    if (!Array.isArray(message_id)) message_id = [message_id]
    const msgs = []
    for (const i of message_id) {
      Bot.makeLog(
        "info",
        `${data.group_id ? `撤回群消息：[${data.group_id}]` : `撤回好友消息：[${data.user_id}]`} ${i}`,
        data.self_id,
      )
      let ret
      try {
        ret = await data.bot.sdk.msg.recall(data.chatId, i)
        // SDK 失败不抛异常，返回 recalled:false（如群聊无撤回权限 statusCode=11 USER_FORBIDDEN）
        if (ret?.recalled === false) {
          Bot.makeLog("warn", ["撤回消息失败", i, `${ret.statusCode} ${ret.statusMsg}`], data.self_id)
          ret = false
        }
      } catch (err) {
        Bot.makeLog("info", ["撤回消息错误", i, err], data.self_id)
        ret = false
      }
      msgs.push(ret || false)
    }
    return msgs
  }

  getFriendMap(id) {
    return Bot.getMap(`${this.path}${id}/Friend`)
  }

  getGroupMap(id) {
    return Bot.getMap(`${this.path}${id}/Group`)
  }

  getMemberMap(id) {
    return Bot.getMap(`${this.path}${id}/Member`)
  }

  async getChatHistory(data, cnt = 20) {
    const history = await data.bot.sdk.chat.history(data.chatId, { count: cnt })
    return history.map(msg => ({
      message_id: msg.serverMessageId,
      user_id: msg.senderUid,
      time: msg.createTime ? +msg.createTime / 1e6 : undefined,
      message: this.makeMessageSegs(msg),
      raw_message: msg.text || "",
      raw: msg,
    }))
  }

  pickFriend(id, user_id) {
    if (typeof user_id !== "string") user_id = String(user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id,
    }
    return {
      ...i,
      get name() {
        return this.nickname
      },
      sendMsg: msg => this.sendFriendMsg(i, msg),
      recallMsg: message_id => this.recallMsg(i, message_id),
      getAvatarUrl: async () => {
        if (i.avatar) return i.avatar
        if (!i.secUid) return i.avatar
        // 好友列表无头像，通过资料接口查询并缓存
        const profile = await i.bot.sdk.user.profileScene(i.secUid).catch(() => undefined)
        if (profile?.avatar) {
          i.avatar = profile.avatar
          await i.bot.fl.set(user_id, {
            ...i.bot.fl.get(user_id),
            user_id,
            nickname: i.nickname,
            secUid: i.secUid,
            chatId: i.chatId,
            avatar: i.avatar,
          })
        }
        return profile?.avatar || i.avatar
      },
      getInfo: async () => {
        if (!i.secUid) return i
        const profile = await i.bot.sdk.user.profileScene(i.secUid).catch(() => undefined)
        if (profile?.avatar) {
          i.avatar = profile.avatar
          await i.bot.fl.set(user_id, {
            ...i.bot.fl.get(user_id),
            user_id,
            nickname: profile.nickname || i.nickname,
            secUid: i.secUid,
            chatId: i.chatId,
            avatar: i.avatar,
          })
        }
        return { ...i, ...profile, user_id }
      },
      getChatHistory: (cnt = 20) => this.getChatHistory(i, cnt),
    }
  }

  pickMember(id, group_id, user_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    if (typeof user_id !== "string") user_id = String(user_id)
    const i = {
      ...Bot[id].fl.get(user_id),
      ...Bot[id].gml.get(group_id)?.get(user_id),
      self_id: id,
      bot: Bot[id],
      user_id,
      group_id,
    }
    return {
      ...this.pickFriend(id, user_id),
      ...i,
      get card() {
        return this.nickname
      },
      get is_friend() {
        return i.bot.fl.has(user_id)
      },
      // role 来自群成员列表（1 群主），或与群主 uid 比对
      get is_owner() {
        return i.role === 1 || i.bot.gl.get(group_id)?.ownerUid === user_id
      },
      get is_admin() {
        return this.is_owner || i.role === 2 || i.role === 3
      },
      getInfo: async () => {
        const chatId = i.bot.gl.get(group_id)?.chatId
        if (!chatId) return i
        const members = await i.bot.sdk.grp.members(chatId)
        return members.find(member => member.uid === user_id) || i
      },
      kickOut: async () => {
        const chatId = i.bot.gl.get(group_id)?.chatId
        if (!chatId) return false
        return i.bot.sdk.grp.removeMembers(chatId, [user_id])
      },
      kick() {
        return this.kickOut()
      },
    }
  }

  pickGroup(id, group_id) {
    if (typeof group_id !== "string") group_id = String(group_id)
    const i = {
      ...Bot[id].gl.get(group_id),
      self_id: id,
      bot: Bot[id],
      group_id,
    }
    return {
      ...i,
      get name() {
        return this.group_name
      },
      get is_owner() {
        return i.ownerUid === id
      },
      sendMsg: msg => this.sendGroupMsg(i, msg),
      recallMsg: message_id => this.recallMsg(i, message_id),
      pickMember: user_id => this.pickMember(id, group_id, user_id),
      getMemberMap() {
        return i.bot.gml.get(group_id)
      },
      getMemberList() {
        return [...(i.bot.gml.get(group_id)?.keys() || [])]
      },
      getMemberArray() {
        return [...(i.bot.gml.get(group_id)?.values() || [])]
      },
      getAvatarUrl: () => i.avatar,
      getInfo: async () => {
        if (!i.chatId) return i
        const info = (await i.bot.sdk.chat.info(i.chatId))[0]
        if (!info) return i
        const owner = info.members?.find(m => m.uid === info.ownerUid || m.role === 1)
        Object.assign(i, {
          group_name: info.name,
          avatar: info.avatar?.replace(/`/g, ""),
          member_count: info.members?.length,
          ownerUid: info.ownerUid,
          ownerSecUid: owner?.secUid,
        })
        // 只存纯数据字段，避免 bot 实例循环引用无法序列化
        await i.bot.gl.set(group_id, {
          ...i.bot.gl.get(group_id),
          group_id,
          chatId: i.chatId,
          group_name: i.group_name,
          avatar: i.avatar,
          member_count: i.member_count,
          ownerUid: i.ownerUid,
          ownerSecUid: i.ownerSecUid,
        })
        return { ...i }
      },
      getChatHistory: (cnt = 20) => this.getChatHistory(i, cnt),
      setGroupName: async group_name => {
        const ret = await i.bot.sdk.grp.rename(i.chatId, group_name)
        if (ret?.statusCode === 0) {
          i.group_name = group_name
          // 只存纯数据字段，避免 bot 实例循环引用无法序列化
          await i.bot.gl.set(group_id, {
            ...i.bot.gl.get(group_id),
            group_id,
            chatId: i.chatId,
            group_name,
          })
        }
        return ret
      },
      setName(group_name) {
        return this.setGroupName(group_name)
      },
      kickOut: async user_id => i.bot.sdk.grp.removeMembers(i.chatId, [String(user_id)]),
      kickMember(user_id) {
        return this.kickOut(user_id)
      },
      quit: () => i.bot.sdk.grp.leave(i.chatId),
    }
  }

  async loadFriend(id) {
    try {
      for (const i of await Bot[id].sdk.frd.list())
        Bot[id].fl.set(i.uid, {
          ...Bot[id].fl.get(i.uid),
          user_id: i.uid,
          nickname: i.nickname,
          secUid: i.secUid,
          chatId: i.chatId,
        })
    } catch (err) {
      Bot.makeLog("error", ["好友列表获取错误", err], id)
    }
  }

  async loadGroup(id) {
    try {
      for (const i of await Bot[id].sdk.grp.list())
        if (i.isGroup)
          Bot[id].gl.set(i.conversationShortId, {
            ...Bot[id].gl.get(i.conversationShortId),
            group_id: i.conversationShortId,
            group_name: i.name,
            avatar: i.avatar?.replace(/`/g, ""),
            chatId: i.chatId,
          })
    } catch (err) {
      Bot.makeLog("error", ["群列表获取错误", err], id)
    }
  }

  async setFriendMap(data) {
    await data.bot.fl.set(data.user_id, {
      ...data.bot.fl.get(data.user_id),
      user_id: data.user_id,
      nickname: data.sender.nickname,
      chatId: data.chatId,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async setGroupMap(data) {
    await data.bot.gl.set(data.group_id, {
      ...data.bot.gl.get(data.group_id),
      group_id: data.group_id,
      chatId: data.chatId,
      time: data.time,
      message_id: data.message_id,
    })
    let gml = data.bot.gml.get(data.group_id)
    if (!gml) {
      gml = new Map()
      await data.bot.gml.set(data.group_id, gml)
    }
    await gml.set(data.user_id, {
      ...gml.get(data.user_id),
      user_id: data.user_id,
      nickname: data.sender.nickname,
      time: data.time,
      message_id: data.message_id,
    })
  }

  async makeMessage(id, msg) {
    if (!msg.serverMessageId || (msg.conversationType !== 1 && msg.conversationType !== 2)) {
      Bot.makeLog("warn", ["未知消息", msg], id)
      return
    }
    Bot[id].stat.recv_msg_cnt++

    const data = {
      raw: msg,
      bot: Bot[id],
      self_id: id,
      post_type: "message",
      message_type: msg.conversationType === 2 ? "group" : "private",
      sub_type: "normal",
      message_id: msg.serverMessageId,
      user_id: msg.senderUid,
      time: msg.createTime ? +msg.createTime / 1e6 : Date.now() / 1000,
      sender: {
        user_id: msg.senderUid,
        nickname: msg.senderNickname || msg.senderUid,
      },
      chatId: msg.chatId,
      // 抖音特有字段：盖楼 / 会话内游标 / 上下文扩展
      thread_id: msg.threadId,
      is_thread_root: msg.isThreadRoot,
      index_in_conversation: msg.indexInConversation,
      ext: msg.ext,
      message: this.makeMessageSegs(msg),
      raw_message: msg.text || "",
    }

    if (data.message_type === "group") {
      data.group_id = msg.conversationShortId
      Bot.makeLog("info", `群消息：[${data.group_id}, ${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, id)
      await this.setGroupMap(data)
    } else {
      Bot.makeLog("info", `好友消息：[${data.sender.nickname}(${data.user_id})] ${data.raw_message}`, id)
      await this.setFriendMap(data)
    }

    Bot[id].replys[data.message_id] = msg
    setTimeout(() => delete Bot[id].replys[data.message_id], 300000)

    // 自动标记已读：readSwitch 清列表红点（50013 依据），markRead 会话内已读（对方可见）
    if (config.bot.autoRead)
      Promise.all([
        data.bot.sdk.chat.readSwitch(data.chatId, [msg]),
        data.bot.sdk.msg.read(data.chatId, msg),
      ])
        .then(() => Bot.makeLog("debug", `已读回执：[${data.message_id}]`, id))
        .catch(err => Bot.makeLog("debug", ["自动已读失败", err], id))

    Bot.em(`${data.post_type}.${data.message_type}.${data.sub_type}`, data)
  }

  // 由会话 id 反查群/好友 id（事件部分类型仅携带长会话 id）
  chatIdToTarget(id, chatId) {
    for (const [gid, g] of Bot[id].gl) if (g.chatId === chatId) return { type: "group", id: gid }
    for (const [uid, f] of Bot[id].fl) if (f.chatId === chatId) return { type: "friend", id: uid }
    return { type: chatId.startsWith("2:") ? "group" : "friend", id: chatId }
  }

  // 会话状态变更（messageType=50001，高频且自发也下发）
  makeStatus(id, event) {
    // 3/4/8 为自身客户端的会话状态同步（游标更新/属性设置/信息回显），高频无业务价值
    if (event.commandType === 3 || event.commandType === 4 || event.commandType === 8) return
    const label = { 1: "红点更新", 14: "已读同步", 2: "消息删除", 6: "群属性变更", 7: "群成员变更" }[event.commandType] || `commandType=${event.commandType}`
    const detail =
      event.commandType === 2 ? `删除 ${event.messageId}`
      : event.commandType === 6 ? event.nameChange?.name || event.avatarChange?.icon || Bot.String(event.extData || [])
      : event.commandType === 7 ? Bot.String(event.memberChange || {})
      : event.unread != null ? `unread=${event.unread} readIndex=${event.readIndex}` : "未知状态"
    Bot.makeLog("debug", `会话状态 ${label}：[${event.conversationId}] ${detail}`, id)
    // 退群等场景服务端不下发 1001 系统消息，仅 status 有 removed 明细，需补漏派发
    if (event.commandType === 7) this.memberChangeNotice(id, event)
  }

  // bot 自身 uid 判定：数组内大数无保精度处理，尾部可能被截 0（7669111753674851387 → ...4851000），前 15 位比对兜底
  isSelfUid(id, uid) {
    uid = String(uid)
    return uid === id || (uid.length === id.length && uid.slice(0, 15) === id.slice(0, 15))
  }

  // 群成员增减补漏派发：notice（1001 系统消息）已派发过的（2 分钟内）跳过，避免重复
  memberChangeNotice(id, event) {
    const mc = event.memberChange
    if (!mc) return
    // status 的 conversationId 可能是群短 id，与 gl 的 key 或 chatId 匹配（兜底区分群/好友不可靠）
    const conv = event.conversationId
    let gid
    for (const [k, g] of Bot[id].gl) if (g.chatId === conv || k === conv) { gid = k; break }
    if (!gid) return
    const gml = Bot[id].gml.get(gid)
    const emit = (sub_type, uids) => {
      for (const uid of uids) {
        if (this.isSelfUid(id, uid)) { // bot 自身进/退群不派发事件
          Bot.makeLog("info", `机器人${sub_type === "increase" ? "加入" : "退出"}群聊：[${gid}]`, id)
          continue
        }
        const key = `${gid}:${uid}:${sub_type}`
        const seen = this.memberSeen.get(key)
        if (seen && Date.now() - seen < 120000) continue
        this.memberSeen.set(key, Date.now())
        if (this.memberSeen.size > 500) this.memberSeen.clear()
        const nickname = gml?.get(uid)?.nickname || uid
        Bot.makeLog("info", `群成员${sub_type === "increase" ? "加入" : "离开"}：[${gid}] ${nickname}(${uid})`, id)
        Bot.em(`notice.group.${sub_type}`, {
          raw: event,
          bot: Bot[id],
          self_id: id,
          post_type: "notice",
          notice_type: "group",
          sub_type,
          group_id: gid,
          user_id: uid,
          nickname,
          time: Date.now() / 1000,
        })
      }
    }
    emit("increase", mc.added || [])
    emit("decrease", mc.removed || [])
  }

  async makeNotice(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "notice",
      time: Date.now() / 1000,
    }

    switch (event.type) {
      case "message.reaction": {
        const target = this.chatIdToTarget(id, event.conversationId)
        data.notice_type = target.type
        data.sub_type = "reaction"
        if (target.type === "group") data.group_id = target.id
        else data.user_id = target.id
        data.operator_id = event.operatorUid
        data.message_id = event.serverMessageId
        data.emoji = event.emoji
        data.isSet = event.isSet
        Bot.makeLog("info", `消息${event.isSet ? "添加" : "取消"}回应：[${data.group_id || data.user_id}] ${event.operatorUid} ${event.emoji}`, id)
        break
      }
      case "conversation.read": {
        const target = this.chatIdToTarget(id, event.conversationId)
        data.notice_type = target.type
        data.sub_type = "read"
        if (target.type === "group") data.group_id = target.id
        else data.user_id = target.id
        data.read_index = event.readMessageIndexV2 || event.readMessageIndex
        Bot.makeLog("debug", `已读回执：[${data.group_id || data.user_id}] ${data.read_index}`, id)
        break
      }
      case "conversation.typing": {
        data.notice_type = "friend"
        data.sub_type = "typing"
        data.user_id = event.peerUid
        data.operator_id = event.senderUid
        data.typing = event.typing
        Bot.makeLog("debug", `输入状态：${event.senderUid} ${event.typing ? "正在输入" : "停止输入"}`, id)
        break
      }
      case "conversation.update":
        Bot.makeLog("debug", ["会话更新", event.conversationId], id)
        return
      case "conversation.delete":
        Bot.makeLog("debug", ["会话删除", event.conversationId], id)
        return
      case "friend.increase":
      case "friend.decrease": {
        data.notice_type = "friend"
        data.sub_type = event.type === "friend.increase" ? "increase" : "decrease"
        data.user_id = event.peerUid
        data.content = event.content
        Bot.makeLog("info", `好友${data.sub_type === "increase" ? "添加" : "删除"}：${event.peerUid}${event.content ? ` ${event.content}` : ""}`, id)
        break
      }
      case "message.recall": {
        const target = this.chatIdToTarget(id, event.conversationId)
        data.notice_type = target.type
        data.sub_type = "recall"
        if (target.type === "group") data.group_id = target.id
        else data.user_id = target.id
        data.message_id = event.serverMessageId
        data.client_id = event.targetClientMessageId
        data.operator_id = event.recallUid
        Bot.makeLog("info", `撤回消息：[${data.group_id || data.user_id}] ${event.serverMessageId}`, id)
        break
      }
      case "group.member-increase":
      case "group.member-decrease": {
        data.notice_type = "group"
        data.sub_type = event.type === "group.member-increase" ? "increase" : "decrease"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.source = event.source
        for (const i of event.members) {
          // bot 自身进/退群不派发事件（退群后回复必被拒），仅记日志
          if (this.isSelfUid(id, i.uid)) {
            Bot.makeLog("info", `机器人${data.sub_type === "increase" ? "加入" : "退出"}群聊：[${data.group_id}]`, id)
            continue
          }
          this.memberSeen.set(`${data.group_id}:${i.uid}:${data.sub_type}`, Date.now())
          data.user_id = i.uid
          data.nickname = i.nickname
          Bot.makeLog("info", `群成员${data.sub_type === "increase" ? "加入" : "离开"}：[${data.group_id}] ${i.nickname}(${i.uid})`, id)
          Bot.em(`notice.${data.notice_type}.${data.sub_type}`, { ...data })
        }
        return
      }
      case "group.dismiss": {
        data.notice_type = "group"
        data.sub_type = "dismiss"
        data.group_id = event.conversationShortId
        data.operator_id = event.operatorUid
        // 群已解散，清理本地缓存
        Bot[id].gl.delete(data.group_id)
        Bot[id].gml.delete(data.group_id)
        Bot.makeLog("info", `群解散：[${data.group_id}] 操作者：${event.operatorUid || "未知"}`, id)
        break
      }
      case "group.admin": {
        data.notice_type = "group"
        data.sub_type = "admin"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.enabled = event.enabled
        for (const i of event.members) {
          data.user_id = i.uid
          data.nickname = i.nickname
          Bot.makeLog("info", `设为管理员：[${data.group_id}] ${i.nickname}(${i.uid})`, id)
          Bot.em(`notice.${data.notice_type}.${data.sub_type}`, { ...data })
        }
        return
      }
      case "group.name-change": {
        data.notice_type = "group"
        data.sub_type = "name-change"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.name = event.name
        const g = Bot[id].gl.get(event.conversationShortId)
        if (g && event.name) await Bot[id].gl.set(event.conversationShortId, { ...g, group_name: event.name })
        Bot.makeLog("info", `群名变更：[${data.group_id}] ${event.name || ""}`, id)
        break
      }
      case "group.avatar-change": {
        data.notice_type = "group"
        data.sub_type = "avatar-change"
        data.group_id = event.conversationShortId
        data.operator_id = event.operators?.[0]?.uid
        data.avatar = event.avatar
        const g = Bot[id].gl.get(event.conversationShortId)
        if (g && event.avatar) await Bot[id].gl.set(event.conversationShortId, { ...g, avatar: event.avatar.replace(/`/g, "") })
        Bot.makeLog("info", `群头像变更：[${data.group_id}]`, id)
        break
      }
      case "im.command":
        Bot.makeLog("debug", ["IM 命令", event], id)
        return
      default:
        Bot.makeLog("debug", ["未知通知", event], id)
        return
    }
    Bot.em(`notice.${data.notice_type}.${data.sub_type}`, data)
  }

  // 消息编辑（编辑重推全文，对自身编辑也触发）：Yunzai 无标准事件，记日志并同步引用缓存
  makeEdited(id, msg) {
    Bot.makeLog("info", `消息编辑：[${msg.senderNickname}(${msg.senderUid})] ${msg.text}`, id)
    if (msg.serverMessageId && Bot[id].replys[msg.serverMessageId]) Bot[id].replys[msg.serverMessageId] = msg
  }

  // 语音/视频来电（仅感知，出站未支持）：Yunzai 无标准事件，仅记日志
  makeVoip(id, event) {
    Bot.makeLog("info", `${event.cameraOff === 1 ? "语音" : "视频"}来电：${event.callerUid} room=${event.roomId}`, id)
  }

  async makeRequest(id, event) {
    const data = {
      raw: event,
      bot: Bot[id],
      self_id: id,
      post_type: "request",
      sub_type: "add",
      comment: event.content || "",
      time: Date.now() / 1000,
    }

    if (event.type === "friend.request") {
      data.request_type = "friend"
      data.user_id = event.applicantUid
      data.nickname = event.applicantUid
      data.approve = () => data.bot.sdk.frd.approve(event.applicantUid)
      data.reject = () => data.bot.sdk.frd.reject(event.applicantUid)
      Bot.makeLog("info", `好友申请：${data.user_id} ${data.comment}`, id)
    } else if (event.type === "group.join-request") {
      data.request_type = "group"
      data.group_id = event.conversationShortId
      // 事件仅携带群信息，需查询申请列表获取申请人及 requestId
      const request = (await data.bot.sdk.grp.requests(event.conversationShortId).catch(() => []))?.find(
        i => i.status === 1 && (i.requestId === event.requestId || !event.requestId),
      )
      data.user_id = request?.applicantUid
      data.nickname = request?.applicantNickname || data.user_id
      data.approve = () => data.bot.sdk.grp.approve(request?.requestId || event.requestId)
      data.reject = () => data.bot.sdk.grp.reject(request?.requestId || event.requestId)
      Bot.makeLog("info", `入群申请：[${data.group_id}] ${data.nickname || ""} ${data.comment}`, id)
    } else {
      return
    }
    Bot[id].request_list.push(data)
    Bot.em(`request.${data.request_type}`, data)
  }

  // 断开并移除账号：清刷新定时器、登出、删 Bot、清 Bot.uin 残留（防核心遍历无效 id 抛错）
  removeBot(id) {
    clearInterval(this.refreshes[id])
    delete this.refreshes[id]
    Bot[id]?.logout()
    delete Bot[id]
    const idx = Bot.uin.indexOf(id)
    if (idx !== -1) Bot.uin.splice(idx, 1)
  }

  // 断线自动重连：延迟 5 秒，最多 5 次，登录成功后重置计数
  async reconnect(id, event) {
    const count = (this.reconnects[id] || 0) + 1
    if (this.noReconnect.has(id) || count > 5) {
      delete this.reconnects[id]
      if (!this.noReconnect.has(id))
        Bot.makeLog("error", `${this.name}(${id}) 断线重连超过 5 次，放弃重连，请重启或重新登录`, this.id)
      return
    }
    this.reconnects[id] = count
    Bot.makeLog("warn", [`${this.name}(${id}) 连接断开，5 秒后第 ${count} 次重连`, event], this.id)
    await Bot.sleep(5000)
    const token = config.token.find(i => i.startsWith(`${id}:`))
    if (!token) {
      delete this.reconnects[id]
      return Bot.makeLog("error", `${this.name}(${id}) 不在账号列表，无法重连`, this.id)
    }
    if (await this.connect(token)) delete this.reconnects[id]
    else this.reconnect(id)
  }

  async connect(token) {
    const [id, cookie] = token.split(/:(.+)/s)
    if (!id || !cookie) {
      Bot.makeLog("error", "账号格式错误，应为 uid:cookie", this.id)
      return false
    }
    Bot.makeLog("debug", `开始连接账号 ${id}`, this.id)

    // 重复登录时先断开旧连接，避免双连接
    if (Bot[id]?.sdk) {
      Bot.makeLog("warn", `账号 ${id} 已连接，正在断开旧连接`, this.id)
      this.removeBot(id)
    }

    const opts = {
      ...config.bot,
      cookie,
      userId: id,
      log: this.makeSDKLog(id),
    }

    Bot[id] = {
      adapter: this,
      sdk: new douyin.Bot(opts),
      login() {
        return this.sdk.start()
      },
      logout() {
        // 主动登出标记，避免 close 事件触发自动重连
        this.adapter.noReconnect.add(id)
        this.sdk.stop()
      },

      uin: id,
      info: {
        id,
        ...opts,
      },
      get nickname() {
        return this.info.nickname || this.uin
      },
      get avatar() {
        return this.info.avatar
      },

      version: {
        id: this.id,
        name: this.name,
        version: this.version,
      },
      stat: {
        start_time: Date.now() / 1000,
        recv_msg_cnt: 0,
        sent_msg_cnt: 0,
      },

      pickFriend: user_id => this.pickFriend(id, user_id),
      get pickUser() {
        return this.pickFriend
      },
      getFriendMap() {
        return this.fl
      },
      getFriendArray() {
        return [...this.fl.values()]
      },
      getFriendList() {
        return [...this.fl.keys()]
      },
      fl: await this.getFriendMap(id),

      pickMember: (group_id, user_id) => this.pickMember(id, group_id, user_id),
      pickGroup: group_id => this.pickGroup(id, group_id),
      getGroupMap() {
        return this.gl
      },
      getGroupArray() {
        return [...this.gl.values()]
      },
      getGroupList() {
        return [...this.gl.keys()]
      },
      gl: await this.getGroupMap(id),
      gml: await this.getMemberMap(id),
      getGroupMemberMap(group_id) {
        return this.gml.get(String(group_id))
      },
      getGroupMemberArray(group_id) {
        return [...(this.gml.get(String(group_id))?.values() || [])]
      },
      getGroupMemberList(group_id) {
        return [...(this.gml.get(String(group_id))?.keys() || [])]
      },

      // 好友/群申请列表（makeRequest 时存入），供插件查询与标准接口处理
      request_list: [],
      getSystemMsg() {
        return this.request_list
      },
      // flag 为好友 uid / 群申请 requestId
      setFriendAddRequest: (flag, approve) => (approve ? sdk.frd.approve(flag) : sdk.frd.reject(flag)),
      setGroupAddRequest: (flag, approve) => (approve ? sdk.grp.approve(flag) : sdk.grp.reject(flag)),
      getCookies() {
        return this.info.cookie
      },
      getCsrfToken: () => "",

      replys: {},
    }

    // 注册到核心账号列表（Bot.uin.toString 随机取号、Bot.xxx 重定向依赖）
    if (!Bot.uin.includes(id)) Bot.uin.push(id)

    try {
      await Bot[id].login()
      Object.assign(Bot[id].info, await Bot[id].sdk.user.self())
    } catch (err) {
      Bot.makeLog("error", [`${this.name}(${this.id}) ${this.version} 连接失败`, err], id)
      this.removeBot(id)
      this.noReconnect.delete(id)
      return false
    }
    this.noReconnect.delete(id)

    // 在线状态开关 + im 活跃心跳（登录后打一次）
    if (config.bot.activeStatus)
      Bot[id].sdk.user.activeSwitch().catch(err => Bot.makeLog("warn", ["在线状态上报失败", err], id))
    Bot[id].sdk.user.heartbeat().catch(err => Bot.makeLog("debug", ["心跳上报失败", err], id))

    // 将 SDK 中 Yunzai 未覆盖的 API 挂到 bot 上，插件可通过 e.bot.xxx 直接调用
    const sdk = Bot[id].sdk
    Object.assign(Bot[id], {
      // msg：输入状态/语音通话/表情回应/已读/编辑
      sendTyping: (chatId, typing) => sdk.msg.sendTyping(chatId, typing),
      callVoice: (chatId, uid) => sdk.msg.call(chatId, uid),
      reactMsg: (chatId, msgId, emoji, isSet = true) => sdk.msg.react(chatId, msgId, emoji, isSet),
      readMsg: (chatId, msg) => sdk.msg.read(chatId, msg),
      editMsg: (chatId, clientMessageId, body) => sdk.msg.edit(chatId, clientMessageId, body),
      // media：上传/视频地址/作品详情/表情资源
      uploadImage: input => sdk.media.image(input),
      uploadVideo: input => sdk.media.video(input),
      uploadFile: (input, name) => sdk.media.file(input, name),
      getVideoUrl: tkey => sdk.media.videoUrl(tkey),
      getAwemeDetail: (ids, opts) => sdk.media.awemeDetail(ids, opts),
      getPeer: req => sdk.media.getPeer(req),
      getEmojiList: () => sdk.media.emojiList(),
      // frd：好友申请
      getFriendRequests: status => sdk.frd.requests(status),
      approveFriend: uid => sdk.frd.approve(uid),
      rejectFriend: uid => sdk.frd.reject(uid),
      // grp：入群申请/拉人/建群（改名/踢人/退群在 pickGroup 上）
      getGroupRequests: chatId => sdk.grp.requests(chatId),
      approveGroup: requestId => sdk.grp.approve(requestId),
      rejectGroup: requestId => sdk.grp.reject(requestId),
      addGroupMembers: (chatId, uids) => sdk.grp.addMembers(chatId, uids),
      createGroup: opts => sdk.grp.create(opts),
      // chat：会话管理与游标
      getChatInfo: chatId => sdk.chat.info(chatId),
      getStrangers: () => sdk.chat.strangers(),
      getStrangerConversations: () => sdk.chat.strangerConversations(),
      getReadIndex: chatId => sdk.chat.readIndex(chatId),
      getMinIndex: chatId => sdk.chat.minIndex(chatId),
      getUserMessageStat: req => sdk.chat.userMessageStat(req),
      ackMsg: (chatId, msgId) => sdk.chat.ack(chatId, msgId),
      readSwitch: (chatId, msgs) => sdk.chat.readSwitch(chatId, msgs),
      deleteChat: chatId => sdk.chat.delete(chatId),
      setChatSetting: (chatId, input) => sdk.chat.setting(chatId, input),
      batchReadIndex: chatId => sdk.chat.batchReadIndex(chatId),
      // user：资料/在线状态
      getUserProfile: secUid => sdk.user.profileScene(secUid),
      getUserProfileOther: secUid => sdk.user.profileOther(secUid),
      getOnlineStatus: (ids, source) => sdk.user.onlineStatus(ids, source),
      heartbeat: () => sdk.user.heartbeat(),
      activeSwitch: () => sdk.user.activeSwitch(),
      // sticker：表情面板
      getStickerList: opts => sdk.sticker.list(opts),
      getStickerFavs: () => sdk.sticker.favs(),
      getStickerGifs: () => sdk.sticker.gifs(),
      collectSticker: (ids, opts) => sdk.sticker.collect(ids, opts),
      getTrendingSticker: opts => sdk.sticker.trending(opts),
      getStickerStrategy: scenes => sdk.sticker.strategy(scenes),
    })

    // 事件监听须在 loadFriend/loadGroup 之前注册，否则启动窗口期内推送的消息会被静默丢弃
    Bot[id].sdk.on("message", msg => this.makeMessage(id, msg))
    Bot[id].sdk.on("message:edited", msg => this.makeEdited(id, msg))
    Bot[id].sdk.on("notice", event => this.makeNotice(id, event))
    Bot[id].sdk.on("voip", event => this.makeVoip(id, event))
    Bot[id].sdk.on("status", event => this.makeStatus(id, event))
    Bot[id].sdk.on("request", event => this.makeRequest(id, event))
    Bot[id].sdk.on("read", event => Bot.makeLog("debug", ["单聊已读回执", event], id))
    Bot[id].sdk.on("reconnecting", event => Bot.makeLog("debug", ["连接重连中", event], id))
    Bot[id].sdk.on("close", event => this.reconnect(id, event))

    Bot.makeLog(
      "debug",
      ["自动已读", config.bot.autoRead, "在线状态", config.bot.activeStatus],
      id,
    )

    await this.loadFriend(id)
    await this.loadGroup(id)

    // 每 30 分钟全量刷新好友/群列表，防止缓存漂移（先清理旧定时器，避免重连后累积）
    clearInterval(this.refreshes[id])
    const refresh = setInterval(() => {
      if (!Bot[id]) return clearInterval(refresh)
      this.loadFriend(id)
      this.loadGroup(id)
    }, 30 * 60000)
    refresh.unref?.()
    this.refreshes[id] = refresh

    Bot.makeLog("mark", `${this.name}(${this.id}) ${this.version} ${Bot[id].nickname} 已连接`, id)
    Bot.em(`connect.${id}`, { self_id: id })
    return true
  }

  async load() {
    // 账号已在插件加载阶段开始连接，这里等待连接完成
    Bot.makeLog("debug", "适配器加载阶段，等待账号连接完成", this.id)
    await connecting
  }
})()

Bot.adapter.push(adapter)

// 插件加载即开始并行连接所有账号，核心在适配器加载阶段调用 load 时才等待，缩短启动耗时
Bot.makeLog("debug", `插件加载阶段开始连接 ${config.token.length} 个账号`, "DouYin")
const connecting = Promise.allSettled(config.token.map(token => adapter.connect(token)))

// config 热重载感知：定时对比 token 列表，新增/变更的账号自动重连，删除的账号自动断开
let oldTokens = new Map(config.token.map(i => [i.split(/:(.+)/s)[0], i]))
setInterval(() => {
  const cur = new Map(config.token.map(i => [i.split(/:(.+)/s)[0], i]))
  for (const [id, token] of cur)
    if (oldTokens.get(id) !== token) adapter.connect(token)
  for (const id of oldTokens.keys())
    if (!cur.has(id)) adapter.removeBot(id)
  oldTokens = cur
}, 30000).unref?.()

export class DouYinAdapter extends plugin {
  constructor() {
    super({
      name: "DouYinAdapter",
      dsc: "DouYin 适配器设置",
      event: "message",
      rule: [
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot账号$|^#抖音bot账号$",
          fnc: "List",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot登录$|^#抖音bot登录$",
          fnc: "Login",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot更新$|^#抖音bot更新$",
          fnc: "Update",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot更新日志$|^#抖音bot更新日志$",
          fnc: "UpdateLog",
          permission: config.permission,
        },
        {
          reg: "^#[Dd]ou[Yy]in[Bb]ot删除[0-9]+$|^#抖音bot删除[0-9]+$",
          fnc: "Del",
          permission: config.permission,
        },
      ],
    })
  }

  List() {
    this.reply(
      `共${config.token.length}个账号：\n${config.token.map(i => i.split(/:(.+)/s)[0]).join("\n")}`,
      true,
    )
  }

  async Login() {
    if (adapter.logining) return this.reply("已有登录流程进行中", true)
    adapter.logining = true

    try {
      const session = await douyin.login({
        onQr: async qr => {
          if (this.e.adapter_id === "stdin") {
            logger.info(`请使用抖音 App 扫码登录\n${await QRCode.toString(qr.url, { type: "terminal", small: true })}`)
            return
          }
          const base64 = (qr.base64 || (await QRCode.toBuffer(qr.url)).toString("base64")).replace(
            /^data:image\/\w+;base64,/,
            "",
          )
          this.reply(["请使用抖音 App 扫码登录", segment.image(`base64://${base64}`)])
        },
        onStatus: s => {
          if (s && s !== "verified") this.reply(s, true)
        },
        // 触发短信/密码二次验证：交互式等待用户直接回复验证码/密码，5 分钟超时
        onMfa: info =>
          new Promise((resolve, reject) => {
            const wait = { kind: info.kind, resolve, reject, userId: this.e.user_id }
            if (info.kind === "password")
              this.reply("登录触发密码二次验证，请直接回复账号密码完成验证", true)
            else
              this.reply(
                `登录触发短信二次验证，验证码已发送${info.maskedMobile ? `（尾号 ${info.maskedMobile.slice(-4)}）` : ""}，请直接回复 6 位验证码`,
                true,
              )
            adapter.mfaWait = wait
            setTimeout(() => {
              if (adapter.mfaWait !== wait) return
              adapter.mfaWait = null
              reject(new Error("二次验证等待超时"))
            }, 5 * 60000)
          }),
      })

      const token = `${session.userId}:${session.cookie}`
      if (await adapter.connect(token)) {
        config.token = config.token.filter(i => !i.startsWith(`${session.userId}:`))
        config.token.push(token)
        this.reply(`账号 ${session.userId} 连接成功`, true)
        return configSave()
      }
      this.reply("账号连接失败", true)
      return false
    } catch (err) {
      this.reply(`登录失败：${err.message || err}`, true)
      return false
    } finally {
      adapter.logining = false
    }
  }

  /** 登录二次验证交互：等待期间直接回复验证码/密码即可，无需额外命令 */
  async accept(e) {
    const wait = adapter.mfaWait
    if (!wait) return
    // 仅拦截登录发起者本人的消息；无法确认发起者（如终端登录）时不限制
    if (wait.userId && e.user_id && String(e.user_id) !== String(wait.userId)) return
    const msg = e.msg?.trim()
    if (!msg || msg.startsWith("#")) return
    // 短信验证码要求纯数字（4-6 位），密码等其他验证接受任意非指令文本
    if (wait.kind === "sms" && !/^\d{4,6}$/.test(msg)) return
    adapter.mfaWait = null
    wait.resolve(msg)
    // 拦截该消息，避免验证码被其他插件当作普通消息处理
    return "return"
  }

  async Update() {
    // 复用核心更新插件（#更新DouYin），支持更新日志、依赖更新与更新后自动重启
    // 核心 update 类构造不接收参数，this.e 需按加载器 Object.assign(new ..., { e }) 方式手动绑定
    this.e.msg = "#更新DouYin"
    return Object.assign(new update(), { e: this.e }).update()
  }

  async UpdateLog() {
    this.e.msg = "#更新日志DouYin"
    return Object.assign(new update(), { e: this.e }).updateLog()
  }

  async Del() {
    const id = this.e.msg.replace(/^#[Dd]ou[Yy]in[Bb]ot删除|^#抖音bot删除/, "").trim()
    const token = config.token.find(i => i.startsWith(`${id}:`))
    if (!token) return this.reply("账号不存在", true)

    config.token = config.token.filter(i => i !== token)
    this.removeBot(id)
    this.reply(`账号已删除，共${config.token.length}个账号`, true)
    return configSave()
  }
}

logger.info(logger.green("- DouYin 适配器插件 加载完成"))
