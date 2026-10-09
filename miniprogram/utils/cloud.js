// 数据层适配：把原 supabase 风格链式 API 映射到微信云开发（CloudBase 文档型数据库）。
// 设计目标：13 个页面数据逻辑零改动或最小改动；本文件是唯一的云厂商边界。
//
// 语义约定（与旧 WorkBuddy SDK 保持一致）：
//   from(table).select(fields).eq(k,v).in(k,arr).order(f,{ascending}).limit(n) -> { data, error }
//   from(table).insert(obj|arr)                        -> { data: [{ id }], error }
//   from(table).update(o).eq(k,v)...(.select())        -> { data, error }（stats.updated===0 视为冲突 error）
//   * 自增主键统一用 _id；eq('id', x) 自动映射为 _id，结果行补 .id = _id，页面无需区分
//   auth.getSession() -> { user: { id: openid } } | null
//   storage.createSignedUrls(paths) -> { data: [{ signedUrl }] }

const ENV_ID = 'cloudbase-d0gcanr6v1194af27'

function db() {
  return wx.cloud.database()
}
function command() {
  return db().command
}

// 'a,b,c' / '*' / undefined -> 云开发 field 对象（null 表示全字段）
// 'id' 投影视为文档主键 _id，确保结果含 _id（run() 会规整回 .id）
function parseFields(s) {
  if (!s || s === '*') return null
  const obj = {}
  String(s).split(',').forEach((f) => {
    let key = f.trim()
    if (key === 'id') key = '_id'
    if (key) obj[key] = true
  })
  return obj
}

// 'id' 视为文档主键；其余字段原样（含 project_id/room_id/stage_id 等外键，值即 _id 字符串）
function mapKey(k) {
  return k === 'id' ? '_id' : k
}

function build(table) {
  let w = {}
  let fields = null
  let orders = []
  let lim = 20
  let pendingUpdate = undefined

  // 读取：执行 get，并规范化 _id -> id；任何云错误都包装成 { data:null, error } 而非抛出，
  // 否则异常会冒泡到页面 onLoad 导致白屏（页面已有 if(error) 兜底）
  async function run() {
    try {
      let c = db().collection(table)
      if (Object.keys(w).length) c = c.where(w)
      if (fields) c = c.field(fields)
      for (const [f, dir] of orders) c = c.orderBy(f, dir)
      if (lim) c = c.limit(lim)
      const res = await c.get()
      const data = (res.data || []).map((row) => {
        if (row._id != null && row.id == null) row.id = row._id
        return row
      })
      return { data, error: null }
    } catch (e) {
      console.error('[cloud] query failed', table, w, e)
      return { data: null, error: { code: 'query_failed', message: (e && e.message) || '查询失败' } }
    }
  }

  // 写入：执行 update/remove，冲突以 error 返回；云错误同样包装而非抛出
  async function execWrite() {
    try {
      let c = db().collection(table)
      if (Object.keys(w).length) c = c.where(w)
      let res
      if (pendingUpdate === '__remove__') {
        res = await c.remove()
      } else {
        // 客户端 SDK 的 update 签名是 update({ data: ... })，需包一层 data
        res = await c.update({ data: pendingUpdate })
      }
      if (res.stats && res.stats.updated === 0) {
        return { data: null, error: { code: 'conflict', message: '数据已被其他人修改，请刷新后重试' } }
      }
      return { data: res, error: null }
    } catch (e) {
      console.error('[cloud] write failed', table, w, e)
      return { data: null, error: { code: 'write_failed', message: (e && e.message) || '写入失败' } }
    }
  }

  const api = {
    select(s) {
      if (s === undefined || typeof s === 'object') {
        // 无参 select() / .select({...})：update 链的末端执行符
        return execWrite()
      }
      fields = parseFields(s)
      return api
    },
    field(s) {
      fields = parseFields(s)
      return api
    },
    eq(k, v) {
      w[mapKey(k)] = v
      return api
    },
    neq(k, v) {
      w[mapKey(k)] = command().neq(v)
      return api
    },
    in(k, arr) {
      w[mapKey(k)] = command().in(arr)
      return api
    },
    // 模糊搜索：把 supabase 的 ilike('%kw%') 映射到云开发正则（大小写不敏感）。
    // 仅作用于字符串字段；pattern 中的 % 视为 .* 通配，其余正则特殊字符转义。
    ilike(k, pattern) {
      const p = String(pattern == null ? '' : pattern)
      const esc = p
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
      w[k] = db().RegExp({ regexp: esc, options: 'i' })
      return api
    },
    // 未显式传 ascending 时默认升序；需要降序的调用方都显式传了 { ascending: false }
    // （修复：stages / rooms / knowledge_categories 等按 sort_order 排序被默认降序，导致顺序反了）
    order(f, opt) {
      const dir = opt === undefined ? 'asc' : (opt.ascending ? 'asc' : 'desc')
      orders.push([f, dir])
      return api
    },
    limit(n) {
      lim = n
      return api
    },
    get() {
      return run()
    },
    // insert 必须是同步函数：立即返回带 .select 的 thenable，
    // 否则 .insert(o).select() 会在 async 外层 Promise 上找不到 select（报 not a function）
    insert(o) {
      const run = async () => {
        try {
          const col = db().collection(table)
          let data
          // 注意：客户端 SDK 的 add 签名是 add({ data: doc })，与云函数端 add(doc) 不同
          if (Array.isArray(o)) {
            const rows = await Promise.all(o.map((row) => col.add({ data: row })))
            data = rows.map((r) => {
              const rid = r && (r._id || (r.data && r.data._id))
              return { id: rid, _id: rid }
            })
          } else {
            const r = await col.add({ data: o })
            const rid = r && (r._id || (r.data && r.data._id))
            data = [{ id: rid, _id: rid }]
          }
          return { data, error: null }
        } catch (e) {
          console.error('[cloud] insert failed', table, e)
          return { data: null, error: { code: 'insert_failed', message: (e && e.message) || '新增失败' } }
        }
      }
      const p = run()
      p.select = () => p
      return p
    },
    update(o) {
      pendingUpdate = o
      return api
    },
    remove() {
      pendingUpdate = '__remove__'
      return api
    },
    // await 末端：写入链(pendingUpdate 已设)走 execWrite，读取链走 run
    then(resolve, reject) {
      return (pendingUpdate ? execWrite() : run()).then(resolve, reject)
    },
  }
  return api
}

const cloud = {
  ENV_ID,
  db,
  command,
  database: { from: build },
  // 登录：调用 login 云函数拿 OPENID，结果存 app.globalData.user
  auth: {
    async getSession() {
      const u = (getApp() && getApp().globalData && getApp().globalData.user) || null
      return u ? { user: u } : { user: null }
    },
    async login() {
      const app = getApp()
      if (app && app.globalData && app.globalData.user) return app.globalData.user
      const r = await app.ensureLogin()
      return r
    },
  },
  storage: {
    // 由 fileID 列表换临时访问 URL（替代原 createSignedUrls）；失败返回空而非抛出
    async createSignedUrls(paths) {
      if (!paths || !paths.length) return { data: [], error: null }
      try {
        const res = await wx.cloud.getTempFileURL({ fileList: paths })
        const data = (res.fileList || []).map((f) => ({ signedUrl: f.tempFileURL }))
        return { data, error: null }
      } catch (e) {
        console.error('[cloud] getTempFileURL failed', paths, e)
        return { data: [], error: { code: 'storage_failed', message: (e && e.message) || '图片链接获取失败' } }
      }
    },
  },
}

module.exports = { cloud, db, command }
