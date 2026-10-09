const cloud = require('wx-server-sdk')
const https = require('https')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 把 ima 共享库导入的图片（ima 签名 URL，会过期）转存到小程序云存储，
// 并把 knowledge_articles.image_paths 回填为 cloud:// fileID。
// 详情页 detail.js 用 cloud.storage.createSignedUrls(image_paths) 即 wx.cloud.getTempFileURL 解析图片，
// 只认 cloud:// fileID，所以这一步是「详情页能出图」的必要条件。
//
// 幂等：image_paths 已是 cloud:// 开头的会跳过，重复触发不会重复转存。
// 触发（开发者工具）：云函数 transferImaImages → 测试 → 事件可填 {} 或 {"link_hashes":["ima-import-xxx"]}

function fetchBuffer(url, headers, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000, headers: headers || {} }, (res) => {
      const code = res.statusCode
      // 跟随重定向（ima 偶有 301/302）
      if ((code === 301 || code === 302 || code === 307 || code === 308) && redirects > 0) {
        const loc = res.headers.location
        res.resume()
        if (!loc) return reject(new Error('redirect 无 location'))
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href
        return resolve(fetchBuffer(next, redirects - 1))
      }
      if (code < 200 || code >= 300) {
        res.resume()
        return reject(new Error('HTTP ' + code))
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('下载超时')))
  })
}

function extOf(url) {
  const path = url.split('?')[0]
  const m = path.match(/\.(jpg|jpeg|png|gif|webp|bmp)(?:$|[#?])/i)
  return m ? m[1].toLowerCase() : 'jpg'
}

function sanitize(s) {
  return String(s || 'shared').replace(/[^\w.-]/g, '_')
}

exports.main = async (event) => {
  const db = cloud.database()
  const linkHashes = (event && event.link_hashes) || null
  const onlyMissing = !(event && event.only_missing === false)
  // overrides: { "<link_hash>": { url, headers } } —— 用 ima get_media_info 换来的新鲜地址+请求头覆盖过期/缺头的旧 URL
  const overrides = (event && event.overrides) || null

  const q = db.collection('knowledge_articles').where({ source: 'ima' })
  const { data: articles } = await q.limit(100).get()
  if (!articles || !articles.length) {
    return { ok: true, message: '没有 source=ima 的文章', processed: 0, transferred: 0, skipped: 0, errors: [] }
  }

  let processed = 0
  let transferred = 0
  let skipped = 0
  const errors = []

  for (const a of articles) {
    if (linkHashes && linkHashes.length && (!a.link_hash || !linkHashes.includes(a.link_hash))) continue
    const paths = (a.image_paths || []).filter(Boolean)
    if (!paths.length) { skipped++; continue }
    if (onlyMissing && paths.every((p) => p.startsWith('cloud://'))) { skipped++; continue }

    // 该文章的新鲜地址覆盖（支持单条 {url,headers} 或按索引数组）
    const ov = overrides && a.link_hash ? overrides[a.link_hash] : null

    const newPaths = []
    let anyCloud = false
    for (let i = 0; i < paths.length; i++) {
      const url = paths[i]
      if (url.startsWith('cloud://')) { newPaths.push(url); anyCloud = true; continue }
      const useOv = ov ? (Array.isArray(ov) ? ov[i] : ov) : null
      const dlUrl = useOv && useOv.url ? useOv.url : url
      const dlHeaders = useOv && useOv.headers ? useOv.headers : null
      try {
        const buf = await fetchBuffer(dlUrl, dlHeaders)
        const ext = extOf(url)
        const cloudPath = `knowledge/${sanitize(a.project_id)}/${sanitize(a.link_hash || a._id)}_${i}.${ext}`
        const up = await cloud.uploadFile({ cloudPath, fileContent: buf })
        if (up && up.fileID) {
          newPaths.push(up.fileID)
          anyCloud = true
          transferred++
        } else {
          newPaths.push(url)
          errors.push({ title: a.title, message: 'uploadFile 返回无 fileID' })
        }
      } catch (e) {
        newPaths.push(url) // 保留原 URL，待重试（多为签名过期）
        errors.push({ title: a.title, url, message: e.message || String(e) })
      }
    }

    // 只要有一张成功转存就回填，避免把已成功的也覆盖回原 URL
    if (anyCloud) {
      try {
        await db.collection('knowledge_articles').doc(a._id).update({ data: { image_paths: newPaths } })
        processed++
      } catch (e) {
        errors.push({ title: a.title, message: 'update image_paths 失败：' + (e.message || e) })
      }
    }
  }

  return { ok: errors.length === 0, processed, transferred, skipped, errors }
}
