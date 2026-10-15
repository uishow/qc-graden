// aiFeedback 云函数回归：重点验证「项目级隔离」门禁（谁能看、能改哪些反馈）。
// 用法：node tests/ai-feedback.harness.js
// 背景：反馈里存的是用户原话 + AI 回答，属隐私；不隔离则 A 项目管理员能看到 B 项目成员说了什么。
const Module = require('module')
const path = require('path')

const FILE = path.join(__dirname, '..', 'miniprogram', 'cloudfunctions', 'aiFeedback', 'index.js')

// —— 内存版 CloudBase：够用即可（where/order/skip/limit/get/update/add + command.in）——
function makeDb(state) {
  const command = { in: (arr) => ({ __in: arr }) }
  const match = (doc, cond) => Object.keys(cond || {}).every((k) => {
    const v = cond[k]
    if (v && typeof v === 'object' && Array.isArray(v.__in)) return v.__in.indexOf(doc[k]) !== -1
    return doc[k] === v
  })
  function collection(name) {
    const rows = () => (state[name] || [])
    function where(cond) {
      const api = {
        where: (c2) => where(Object.assign({}, cond, c2)),
        order: () => api,
        skip: () => api,
        limit: () => api,
        get: async () => ({ data: rows().filter((d) => match(d, cond)) }),
        update: async ({ data }) => {
          let n = 0
          rows().forEach((d) => { if (match(d, cond)) { Object.assign(d, data); n++ } })
          return { stats: { updated: n } }
        },
      }
      return api
    }
    return {
      where,
      add: async ({ data }) => { rows().push(Object.assign({}, data)); return { _id: 'new' } },
      get: async () => ({ data: rows() }),
    }
  }
  return { collection, command }
}

// 三个用户：u1 = p1 的 owner（active）；u2 = p2 的 member（无权限）；u3 = p2 的 owner 但已退出
function seedState() {
  return {
    members: [
      { user_id: 'u1', project_id: 'p1', role: 'owner', status: 'active' },
      { user_id: 'u1', project_id: 'p9', role: 'member', status: 'active' }, // 别的协作身份不影响判定
      { user_id: 'u2', project_id: 'p2', role: 'member', status: 'active' },
      { user_id: 'u3', project_id: 'p2', role: 'owner', status: 'left' },    // 已退出
    ],
    ai_feedback: [
      { signal: 'unparsed', intent: 'material', norm: '录入材料', question: 'p1的原话', project_id: 'p1', status: 'pending', created_at: '2026-10-15T01:00:00.000Z' },
      { signal: 'unparsed', intent: 'material', norm: '录入材料', question: 'p1的原话2', project_id: 'p1', status: 'pending', created_at: '2026-10-15T02:00:00.000Z' },
      { signal: 'unparsed', intent: 'material', norm: '录入材料', question: 'p2的原话（别人项目的隐私）', project_id: 'p2', status: 'pending', created_at: '2026-10-15T03:00:00.000Z' },
      { signal: 'degraded', intent: '', norm: '', question: '未选项目时的降级', project_id: '', status: 'pending', created_at: '2026-10-15T04:00:00.000Z' },
    ],
  }
}

let currentState = seedState()
let currentOpenid = 'u1'

const stubSdk = {
  init() {},
  DYNAMIC_CURRENT_ENV: 'test-env',
  getWXContext: () => ({ OPENID: currentOpenid }),
  database: () => makeDb(currentState),
}

const origLoad = Module._load
Module._load = function (request) {
  if (request === 'wx-server-sdk') return stubSdk
  return origLoad.apply(this, arguments)
}

const main = require(FILE).main

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')) }
}

async function run() {
  console.log('\n=== A. 项目级门禁：谁能看 ===')
  currentOpenid = 'u1'
  currentState = seedState()
  let r = await main({ op: 'list' })
  check('owner(active) 可看', r.ok === true, JSON.stringify(r.message || ''))
  check('只能看到自己项目的反馈（p2 的原话不可见）',
    r.ok && r.groups.length === 2 && !JSON.stringify(r.groups).includes('p2的原话'),
    JSON.stringify(r.groups.map((g) => g.count)))
  check('p1 的两条聚合为 1 组 count=2',
    r.ok && r.groups.some((g) => g.norm === '录入材料' && g.count === 2), JSON.stringify(r.groups.map((g) => [g.norm, g.count])))
  check('未选项目(project_id 空)的信号仍可见，不沉底',
    r.ok && r.groups.some((g) => g.signal === 'degraded'), JSON.stringify(r.groups.map((g) => g.signal)))

  currentOpenid = 'u2'
  r = await main({ op: 'list' })
  check('协作成员 member 被拒', r.ok === false && String(r.message).includes('管理员'), JSON.stringify(r))
  r = await main({ op: 'summary' })
  check('协作成员 summary 也被拒', r.ok === false, JSON.stringify(r))

  currentOpenid = 'u3' // owner 但 status=left
  r = await main({ op: 'list' })
  check('已退出成员(status=left) 被拒', r.ok === false, JSON.stringify(r))

  console.log('\n=== B. 项目级门禁：能改哪些 ===')
  currentOpenid = 'u1'
  currentState = seedState()
  r = await main({ op: 'setStatus', signal: 'unparsed', intent: 'material', norm: '录入材料', status: 'fixed', note: '已加规则' })
  check('标记成功', r.ok === true, JSON.stringify(r))
  const p1Rows = currentState.ai_feedback.filter((x) => x.project_id === 'p1')
  const p2Rows = currentState.ai_feedback.filter((x) => x.project_id === 'p2')
  check('自己项目的行被标记 fixed', p1Rows.every((x) => x.status === 'fixed'), JSON.stringify(p1Rows.map((x) => x.status)))
  check('**别的项目同 key 的行不受影响**（越权写入已堵）', p2Rows.every((x) => x.status === 'pending'), JSON.stringify(p2Rows.map((x) => x.status)))
  check('备注写入', p1Rows.every((x) => x.note === '已加规则'), JSON.stringify(p1Rows.map((x) => x.note)))

  console.log('\n=== C. summary 角标 ===')
  currentOpenid = 'u1'
  currentState = seedState()
  r = await main({ op: 'summary' })
  check('只统计自己项目的待处理：2 类 / 3 条',
    r.ok && r.pendingGroups === 2 && r.pendingRows === 3, JSON.stringify(r))

  console.log('\n=== D. 埋点写入 ===')
  currentOpenid = 'u1'
  currentState = seedState()
  r = await main({ op: 'log', signal: 'thumb_down', question: '本月花费多少', projectId: 'p1' })
  check('log 成功', r.ok === true, JSON.stringify(r))
  const added = currentState.ai_feedback[currentState.ai_feedback.length - 1]
  check('落库带 project_id', added.project_id === 'p1', JSON.stringify(added.project_id))
  check('落库带归一化 norm', added.norm === '本月花费多少', added.norm)
  check('初始状态 pending', added.status === 'pending')
  r = await main({ op: 'log', question: 'x' })
  check('缺 signal → 拒绝', r.ok === false, JSON.stringify(r))

  console.log('\n=== E. 未登录 / 未知 op ===')
  currentOpenid = ''
  r = await main({ op: 'list' })
  check('未登录 → 拒绝', r.ok === false && String(r.message).includes('未登录'), JSON.stringify(r))
  currentOpenid = 'u1'
  r = await main({ op: 'nope' })
  check('未知 op → 拒绝', r.ok === false, JSON.stringify(r))

  console.log('\n=== 结果 ===')
  console.log('PASS: ' + pass + '   FAIL: ' + fail)
  if (fail) process.exitCode = 1
}

run()
