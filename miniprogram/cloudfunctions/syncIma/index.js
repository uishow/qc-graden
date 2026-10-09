const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 自动同步 ima 共享知识库 → 写 knowledge_articles（status='pending' 待人工确认）。
//
// 为什么是云函数 + 环境变量存 ima key：
//   ima OpenAPI 的 clientid/apikey 绝不能进前端（反编译/抓包会泄露），只能放云函数环境变量。
//   客户端只读 knowledge_articles；同步/确认都走云函数（管理员上下文，绕过 knowledge_articles 的写安全规则）。
//
// 去重：按 ima_media_id 比对已存在记录——已导入的（含此前 importImaKb 试点导入的 2 条）跳过，不重复。
//
// 人工确认门禁：新条目一律先写 status='pending'（不在知识库正常列表显示）；
//   用户在知识库页「待确认导入」里点「确认导入」→ confirmImaImport 云函数翻成 published 才进入。
//
// 触发（开发者工具）：云函数 syncIma → 测试 → 事件可选：
//   { "project_id": "<项目id>", "kbId": "<共享库id，缺省用装修小常识>", "categoryKey": "material" }
//
// ima 关键参数（踩坑记录）：
//   - get_knowledge_list 必传 cursor(首传"") + limit(1-50)；folder_id 进子文件夹，根目录省略 folder_id。
//   - 文件夹 media_type=99，递归时 folder_id = 文件夹的 media_id（folder_... 前缀）。
//   - 图片 media_type=9：get_media_info 拿 url+headers，下载转存云存储得稳定 fileID（ima 签名 URL 会过期）。

const DEFAULT_KB_ID = 'IOG192gnLHFssO7bJpBdF3804CH1QoimpI4EBxC92WY='
const https = require('https')
const { URL } = require('url')

function imaRequest(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        hostname: 'ima.qq.com',
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'ima-openapi-clientid': process.env.IMA_CLIENT_ID || '',
          'ima-openapi-apikey': process.env.IMA_API_KEY || '',
        },
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf) })
          } catch (e) {
            reject(new Error('ima 响应解析失败: ' + buf.slice(0, 200)))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  }).then((r) => r.body)
}

// 下载图片字节（带 X-IMA-* 等请求头；跟随 3xx 重定向）
function fetchBuffer(url, headers) {
  return new Promise((resolve, reject) => {
    const doReq = (u, hdrs, redirects) => {
      if (redirects > 5) return reject(new Error('重定向过多'))
      const parsed = new URL(u)
      const req = https.request(
        {
          hostname: parsed.hostname,
          port: 443,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: hdrs || {},
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return doReq(res.headers.location, hdrs, redirects + 1)
          }
          if (res.statusCode !== 200) return reject(new Error('下载图片 HTTP ' + res.statusCode))
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks)))
        }
      )
      req.on('error', reject)
      req.end()
    }
    doReq(url, headers, 0)
  })
}

// 递归列出某文件夹下所有「媒体」条目（文件夹 media_type=99 继续下钻；其余作为可导入条目）
async function listFolder(kbId, folderId, out) {
  let cursor = ''
  do {
    const body = { knowledge_base_id: kbId, cursor, limit: 50 }
    if (folderId) body.folder_id = folderId
    const j = await imaRequest('/openapi/wiki/v1/get_knowledge_list', body)
    if (j.code !== 0) throw new Error('get_knowledge_list ' + j.code + ' ' + (j.msg || ''))
    const items = (j.data && j.data.knowledge_list) || []
    for (const it of items) {
      if (it.media_type === 99) {
        await listFolder(kbId, it.media_id, out) // 进子文件夹
      } else {
        out.push(it)
      }
    }
    cursor = j.data && j.data.is_end ? '' : (j.data && j.data.next_cursor) || ''
  } while (cursor)
}

exports.main = async (event) => {
  const clientId = process.env.IMA_CLIENT_ID
  const apiKey = process.env.IMA_API_KEY
  // 诊断回显：不泄露密钥值，只回显「是否存在」，方便定位是没配还是配错了函数
  if (!clientId || !apiKey) {
    return {
      ok: false,
      hasClientId: !!clientId,
      hasApiKey: !!apiKey,
      message: '请先在 syncIma 云函数环境变量配置 IMA_CLIENT_ID / IMA_API_KEY',
    }
  }
  const db = cloud.database()
  const kbId = (event && event.kbId) || DEFAULT_KB_ID
  const projectId = (event && event.project_id) || null
  const categoryKey = (event && event.categoryKey) || 'material'

  // 拉全量媒体条目（递归进文件夹）
  let media = []
  try {
    await listFolder(kbId, '', media)
  } catch (e) {
    return { ok: false, message: '拉取 ima 失败：' + e.message }
  }

  // 解析分类 key -> _id
  const catMap = {}
  const cats = (await db.collection('knowledge_categories').limit(100).get()).data || []
  for (const c of cats) if (c.key) catMap[c.key] = c._id

  let pending = 0
  let skipped = 0
  const errors = []
  for (const m of media) {
    try {
      // 去重：已导入（含 pilot）跳过
      const ex = await db.collection('knowledge_articles').where({ ima_media_id: m.media_id }).get()
      if (ex.data && ex.data.length) {
        // 回填：早期同步版本未存 url/source_link，导致链接类条目"看不到相关信息"。
        // 这里对已存在的网页类记录补拉一次并回填，再同步一次即可修好历史条目。
        const existing = ex.data[0]
        if (m.media_type !== 9 && !existing.url) {
          try {
            const info2 = await imaRequest('/openapi/wiki/v1/get_media_info', { media_id: m.media_id })
            const d2 = (info2 && info2.data) || {}
            const linkUrl2 =
              (d2.web_info && d2.web_info.content_id) ||
              (d2.url_info && d2.url_info.url) ||
              (d2.note_info && d2.note_info.content_id) ||
              ''
            if (linkUrl2) {
              await db.collection('knowledge_articles').doc(existing._id)
                .update({ data: { url: linkUrl2, source_link: linkUrl2 } })
            }
          } catch (e) {
            // 回填失败不影响主流程
          }
        }
        skipped++
        continue
      }
      const doc = {
        scope: 'member',
        category_key: categoryKey,
        // 网页/链接类(media_type!=9)标题加 [链接] 前缀，避免被误当成装修内容；图片保持原名
        title:
          m.media_type === 9
            ? m.title || 'ima 图片'
            : m.title && m.title.startsWith('[链接]')
              ? m.title
              : '[链接] ' + (m.title || '未命名链接'),
        summary: '',
        content: '',
        tags: m.tags || [],
        link_hash: 'ima-' + m.media_id,
        view_count: 0,
        status: 'pending', // 人工确认门禁：先 pending，不进正常列表
        source: 'ima',
        ima_kb_id: kbId,
        ima_media_id: m.media_id,
        project_id: projectId,
        created_at: new Date().toISOString(),
      }
      if (doc.category_key) {
        doc.category_id = catMap[doc.category_key]
        delete doc.category_key
      }
      // 取媒体访问信息：图片拿下载 URL+header；网页/链接拿真实 URL 供人工核对
      const info = await imaRequest('/openapi/wiki/v1/get_media_info', { media_id: m.media_id })
      const infoData = (info && info.data) || {}
      if (m.media_type === 9) {
        // 图片：转存云存储拿稳定 fileID（ima 签名 URL 会过期，pending 期间也先落盘）
        const urlInfo = infoData.url_info || {}
        if (!urlInfo.url) {
          errors.push({ title: doc.title, message: 'get_media_info 无可访问 url' })
          continue
        }
        const buf = await fetchBuffer(urlInfo.url, urlInfo.headers || {})
        const fileID = (await cloud.uploadFile({
          cloudPath: `knowledge/${Date.now()}_${m.media_id}.jpg`,
          fileContent: buf,
        })).fileID
        doc.image_paths = [fileID]
      } else {
        // 网页/链接类：存真实 URL 供待确认页展示/复制核对；图片留空、确认后详情页再补
        const linkUrl =
          (infoData.web_info && infoData.web_info.content_id) ||
          (infoData.url_info && infoData.url_info.url) ||
          (infoData.note_info && infoData.note_info.content_id) ||
          ''
        doc.url = linkUrl
        doc.source_link = linkUrl // 详情页「原文链接」按钮读这个字段
        doc.image_paths = []
        doc.note = '网页/链接类（确认后可在详情补充）'
      }
      const r = await db.collection('knowledge_articles').add({ data: doc })
      if (r && r._id) pending++
      else errors.push({ title: doc.title, message: 'add 返回无 _id（疑似静默未写入）' })
    } catch (e) {
      errors.push({ title: m.title, message: e.message || String(e) })
    }
  }

  return { ok: errors.length === 0, fetched: media.length, pending, skipped, errors }
}
