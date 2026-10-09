#!/usr/bin/env node
// 一次性把 output/ima-import-pilot.json 的条目写入 CloudBase knowledge_articles。
// 凭证只从环境变量读取，绝不写死在文件里。
//   TCB_ENV        CloudBase 环境 ID（如 cloudbase-d0gcanr6v1194af27）
//   TCB_SECRET_ID  / TCB_SECRET_KEY  腾讯云 CAM 密钥（需该环境的数据库写权限）
//
// 用法：TCB_ENV=xxx TCB_SECRET_ID=xxx TCB_SECRET_KEY=xxx node import_ima_pilot.cjs
//
// 行为：按 link_hash 幂等（已存在则跳过）；category_key 自动解析为 category_id；
// 写入 status:'published'（知识库列表按此过滤）。可选把 image_paths 的 ima 签名 URL
// 转存到云存储后再回填（当前版本先原样写入，过期问题后续处理）。

const fs = require('fs')
const path = require('path')

async function main() {
  const env = process.env.TCB_ENV
  const secretId = process.env.TCB_SECRET_ID
  const secretKey = process.env.TCB_SECRET_KEY
  if (!env || !secretId || !secretKey) {
    console.error('缺少环境变量 TCB_ENV / TCB_SECRET_ID / TCB_SECRET_KEY')
    process.exit(2)
  }

  const cloud = require('@cloudbase/node-sdk')
  const app = cloud.init({ env, secretId, secretKey })
  const db = app.database()

  const payloadPath = path.join(__dirname, 'ima-import-pilot.json')
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'))
  const articles = payload.articles || []

  // 解析 category_key -> _id
  const catMap = {}
  const cats = (await db.collection('knowledge_categories').limit(100).get()).data || []
  for (const c of cats) if (c.key) catMap[c.key] = c._id

  let inserted = 0
  let skipped = 0
  const errors = []
  for (const a of articles) {
    try {
      const ex = await db.collection('knowledge_articles').where({ link_hash: a.link_hash }).get()
      if (ex.data && ex.data.length) {
        skipped++
        continue
      }
      const doc = { ...a }
      if (doc.category_key) {
        doc.category_id = catMap[doc.category_key]
        delete doc.category_key
      }
      doc.status = 'published'
      const r = await db.collection('knowledge_articles').add({ data: doc })
      if (r && r._id) inserted++
      else errors.push({ title: a.title, message: 'add 返回无 _id（疑似静默未写入）' })
    } catch (e) {
      errors.push({ title: a.title, message: e.message || String(e) })
    }
  }

  console.log(JSON.stringify({ ok: errors.length === 0, inserted, skipped, errors }, null, 2))
  if (errors.length) process.exit(1)
}

main().catch((e) => {
  console.error('FATAL', e.message || e)
  process.exit(1)
})
