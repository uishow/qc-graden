const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const https = require('https')
const { URL } = require('url')

// 确认导入后自动：① 抓网页正文(含内联图片)存入 content ② 生成「摘要 + 标签」③ 完成才发布。
// status: pending -> processing -> published；已发布但缺摘要/正文的老文章可"补充"（不改变已发布状态）。
//
// 大模型：OpenAI 兼容 HTTP 接口，走环境变量（与 ima 同思路，密钥绝不进代码库/前端）：
//   LLM_BASE_URL  完整 chat/completions 地址，如 https://api.deepseek.com/v1/chat/completions
//   LLM_API_KEY   模型服务密钥
//   LLM_MODEL     模型名，如 deepseek-chat / hunyuan-t1
// 未配置 LLM_API_KEY 时降级为「网页 meta 描述 + keywords」轻量抽取，功能仍可用。
//
// 微信文章(mp.weixin.qq.com)图片：HTML 里是 data-src 懒加载 + mmbiz.qpic.cn 防盗链，
//   需带 Referer/微信 UA 下载，再转存云存储得 fileID，正文里以 ![img](fileID) 内联。

const UA_MP =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30'
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 2 * 1024 * 1024

function httpJson({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = body ? JSON.stringify(body) : null
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          ...headers,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpJson({ method, url: new URL(res.headers.location, url).toString(), headers, body }))
        }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          if (res.statusCode >= 400) {
            // 把厂商返回的 JSON 错误信息带出来，便于定位（401 密钥错 / 402 余额不足 / 429 限流…）
            let msg = buf.slice(0, 300)
            try { msg = (JSON.parse(buf).error || {}).message || msg } catch (e) {}
            return reject(new Error(`HTTP ${res.statusCode} ${msg}`))
          }
          try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 160))) }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('大模型请求超时')))
    if (data) req.write(data)
    req.end()
  })
}

// 容错：允许只填域名或 .../v1，自动补全成 chat/completions 完整地址
function normalizeBase(raw) {
  let s = String(raw || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) {
    if (!/chat\/completions$/i.test(s)) s += '/chat/completions'
    return s
  }
  return 'https://' + s + '/chat/completions'
}

// GET 取文本（带微信 UA，利于抓公众号正文）
function httpText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': UA_MP, Accept: 'text/html,application/xhtml+xml' },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpText(new URL(res.headers.location, url).toString(), redirects + 1))
        }
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve(buf))
      }
    )
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('页面抓取超时')))
    req.end()
  })
}

// GET 取二进制（图片转存用；带 Referer 过防盗链）
function httpBuffer(url, referer, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const u = new URL(url)
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'GET',
        headers: { 'User-Agent': UA_MP, Referer: referer || u.origin, Accept: 'image/*,*/*' },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpBuffer(new URL(res.headers.location, url).toString(), referer, redirects + 1))
        }
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
        const chunks = []
        let size = 0
        res.on('data', (c) => {
          size += c.length
          if (size > MAX_IMAGE_BYTES) { req.destroy(); return reject(new Error('too large')) }
          chunks.push(c)
        })
        res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || '' }))
      }
    )
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('图片下载超时')))
    req.end()
  })
}

function extFromType(type, url) {
  const t = String(type).toLowerCase()
  if (t.includes('png')) return 'png'
  if (t.includes('gif')) return 'gif'
  if (t.includes('webp')) return 'webp'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  const m = String(url).match(/\.(png|jpg|jpeg|gif|webp)(\?|$)/i)
  return m ? m[1].toLowerCase() : 'jpg'
}

// HTML → 保留段落与语义格式：标题→"## "、列表→"- "/有序"n. "、引用→"> "、加粗→**…**、
// 图片→![img](src) 占位（优先 data-src 懒加载真实地址）。花式内联样式（颜色/字号/字体）无法承载，丢弃。
function htmlToText(html) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/data-src=["']([^"']+)["']/i) || tag.match(/src=["']([^"']+)["']/i)
    const u = m && m[1]
    return u ? `\n![img](${u})\n` : ' '
  })
  // 标题 / 引用
  s = s
    .replace(/<h[1-6]\b[^>]*>/gi, '\n## ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<\/blockquote>/gi, '\n')
  // 列表：单趟解析保持文档顺序（栈区分 ul/ol；有序输出 "n. "，无序输出 "- "）
  const stack = []
  let olCount = 0
  s = s
    .replace(/<(ul|ol)\b[^>]*>|<\/(ul|ol)\s*>|<li\b[^>]*>/gi, (tag) => {
      const t = tag.toLowerCase()
      if (t.startsWith('</')) { stack.pop(); return '\n' }
      if (t.startsWith('<li')) return stack[stack.length - 1] === 'ol' ? `\n${++olCount}. ` : '\n- '
      const isOl = t.startsWith('<ol')
      stack.push(isOl ? 'ol' : 'ul')
      if (isOl) olCount = 0
      return '\n'
    })
    .replace(/<\/li\s*>/gi, '\n')
  // 加粗 → **…**（em/斜体等内联标签丢弃）
  s = s
    .replace(/<(strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/(strong|b)>/gi, '**')
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|figure|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\*\*\s+\*\*/g, '') // 空加粗清理
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    // 结构行（列表/引用/标题/图片）前的空行收成单换行，避免列表项之间出现大间隔
    .replace(/\n{2,}(?=(- |\d+\. |> |## |!\[img\]))/g, '\n')
  return s
    .split('\n')
    .map((l) => {
      let t = l.trim()
      // 一行内 ** 数量为奇数说明加粗跨行断裂，整行去掉 ** 防止渲染错乱
      if (t && (t.match(/\*\*/g) || []).length % 2 === 1) t = t.replace(/\*\*/g, '')
      return t
    })
    .filter((l, i, arr) => l || (i > 0 && arr[i - 1]))
    .join('\n')
    .trim()
}

function pickMeta(html, names) {
  for (const n of names) {
    let m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${n}["'][^>]*content=["']([^"']*)["']`, 'i'))
    if (m && m[1]) return m[1].trim()
    m = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${n}["']`, 'i'))
    if (m && m[1]) return m[1].trim()
  }
  return ''
}

// 取原文素材：链接抓网页（标题/描述/正文含图片占位），否则用文章自带内容
async function buildSource(a) {
  const url = a.source_link || a.url
  if (url) {
    try {
      const html = await httpText(url)
      const title = pickMeta(html, ['og:title', 'twitter:title']) ||
        (String(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() || a.title
      const desc = pickMeta(html, ['og:description', 'description', 'twitter:description'])
      const keywords = pickMeta(html, ['keywords'])
      const body = htmlToText(html).slice(0, 60000)
      return { title, desc, keywords, text: body.slice(0, 3000), body, url }
    } catch (e) {
      // 抓取失败（需登录/反爬/网络）→ 用标题兜底，不阻断
    }
  }
  return {
    title: a.title,
    desc: a.summary || '',
    keywords: '',
    text: String(a.content || '').slice(0, 3000),
    body: String(a.content || '').slice(0, 60000),
    url: '',
  }
}

// 把正文里的 ![img](http...) 图片下载并转存云存储，替换成 fileID；失败的直接丢弃该行
// deadline：时间预算（毫秒时间戳），预算用尽即停止抓图，避免整体超时卡在 processing
async function inlineImages(body, referer, deadline) {
  const urls = []
  let m
  const re = /!\[img\]\((https?:\/\/[^)\s]+)\)/g
  while ((m = re.exec(body)) !== null) {
    if (!urls.includes(m[1])) urls.push(m[1])
    if (urls.length >= MAX_IMAGES) break
  }
  if (!urls.length) return { body, count: 0 }
  let count = 0
  for (const u of urls) {
    if (Date.now() > deadline) break // 预算用尽，剩余图片保留原占位由详情页忽略
    try {
      const { buf, type } = await httpBuffer(u, referer)
      const fileID = (
        await cloud.uploadFile({
          cloudPath: `knowledge/rich/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extFromType(type, u)}`,
          fileContent: buf,
        })
      ).fileID
      body = body.split(`![img](${u})`).join(`![img](${fileID})`)
      count++
    } catch (e) {
      body = body.split(`![img](${u})`).join('') // 下载失败的移除该图片行
    }
  }
  // 清理因删图产生的多余空行
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), count }
}

// 调大模型生成 {summary, tags}；未配置或失败返回 null（由调用方降级）
async function callLLM(source, fallbackTitle) {
  const base = normalizeBase(process.env.LLM_BASE_URL)
  const key = String(process.env.LLM_API_KEY || '').trim()
  const model = String(process.env.LLM_MODEL || 'deepseek-chat').trim()
  if (!base || !key) return null
  const prompt = [
    '请为下面这条装修知识库内容写一段中文摘要（2-3句，概括核心信息），并给出 3-6 个中文标签。',
    '只输出 JSON，格式：{"summary":"...","tags":["标签1","标签2"]}',
    '',
    `标题：${source.title || fallbackTitle}`,
    source.url ? `链接：${source.url}` : '',
    source.desc ? `网页描述：${source.desc}` : '',
    `内容片段：${source.text}`,
  ].filter(Boolean).join('\n')
  const j = await httpJson({
    method: 'POST',
    url: base,
    headers: { Authorization: 'Bearer ' + key },
    body: {
      model,
      messages: [
        { role: 'system', content: '你是装修知识库助手。只输出 JSON，不要解释。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      stream: false,
    },
  })
  const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content
  if (!txt) return null
  const mm = txt.match(/\{[\s\S]*\}/)
  const o = JSON.parse(mm ? mm[0] : txt)
  const summary = String(o.summary || '').trim()
  let tags = Array.isArray(o.tags)
    ? o.tags.map((t) => String(t).trim()).filter(Boolean)
    : String(o.tags || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean)
  tags = [...new Set(tags)].slice(0, 8)
  if (!summary && !tags.length) return null
  return { summary, tags }
}

// 降级：网页 meta 描述/正文首句做摘要，meta keywords / 已有标签做标签
function heuristic(source, fallbackTags) {
  const summary = source.desc || String(source.text || '').slice(0, 120) || source.title || ''
  let tags = String(source.keywords || '').split(/[,，;；]/).map((t) => t.trim()).filter(Boolean)
  if (!tags.length) tags = (fallbackTags || []).slice()
  return { summary, tags: [...new Set(tags)].slice(0, 8) }
}

exports.main = async (event) => {
  const { id, force } = event || {} // force=true：重新抓取，覆盖已有正文/摘要（配合"重新抓取正文"按钮）
  if (!id) return { ok: false, message: '缺少 id' }
  const db = cloud.database()
  const col = db.collection('knowledge_articles')

  let a = null
  try { a = (await col.doc(id).get()).data } catch (e) { a = null }
  if (!a) return { ok: false, message: '文章不存在' }
  if (a.status === 'rejected') return { ok: false, message: '文章已被拒绝，无法导入' }

  const hasLink = !!(a.source_link || a.url)
  const hasContent = !!(a.content && a.content.trim())
  const needsEnrich = !a.summary || !(a.tags && a.tags.length) || (hasLink && !hasContent)
  if (a.status === 'published' && !needsEnrich && !force) {
    return { ok: true, skipped: true, message: '已有摘要与内容' }
  }

  const wasPublished = a.status === 'published'
  const now = new Date().toISOString()
  if (!wasPublished) await col.doc(id).update({ data: { status: 'processing', updated_at: now } })

  try {
    const source = await buildSource(a)
    let gen = null
    let usedAI = false
    let aiError = ''
    try {
      gen = await callLLM(source, a.title)
      usedAI = !!gen
    } catch (e) {
      gen = null
      aiError = String((e && e.message) || e)
    }
    if (!gen) gen = heuristic(source, a.tags)

    const update = { summary: gen.summary || a.summary || '', tags: gen.tags || [], updated_at: now }
    if (!wasPublished) update.status = 'published'

    // 仅在文章原本没有正文（或 force 重新抓取）且抓到正文时写入；内联图片转存云存储
    let filledContent = false
    let imgCount = 0
    if ((!hasContent || force) && source.body && source.body.length > 40) {
      let body = source.body
      if (source.url) {
        // 图片抓取预算 20s：宁可少抓几张图，也必须保证函数在超时前把文章发布出去
        const r = await inlineImages(body, source.url, Date.now() + 20000)
        body = r.body
        imgCount = r.count
      }
      update.content = body
      filledContent = true
    }
    await col.doc(id).update({ data: update })
    return {
      ok: true,
      ai: usedAI,
      aiError, // 大模型调用失败原因（未配置/密钥错/余额不足/超时），便于排查；不影响发布
      filledContent,
      images: imgCount,
      summary: update.summary,
      tags: update.tags,
    }
  } catch (e) {
    if (!wasPublished) {
      await col.doc(id).update({
        data: { status: 'pending', error_note: '生成失败：' + (e.message || e), updated_at: new Date().toISOString() },
      }).catch(() => {})
    }
    return { ok: false, message: '生成摘要标签失败：' + (e.message || e) }
  }
}