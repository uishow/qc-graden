// 费用数据导出：把当前项目的花费 / 材料汇总为 UTF-8 BOM CSV（Excel 中文不乱码）。
// 通过 wx.shareFileMessage 分享文件出去（微信聊天/文件），失败兜底复制到剪贴板。
// 被「我的」页（全量导出）与「花费」页各 Tab（只导出当前页）共用。
//
// 导出范围 scope：
//   'all'        → 花费 + 材料（我的页「导出全部费用数据」）
//   'expenses'   → 仅花费（花费清单 Tab）
//   'materials'  → 仅材料（材料清单 Tab）
//   'wholehouse' → 仅归入全屋定制的材料/花费（全屋定制 Tab）

const { today, shortDate } = require('./format')
const { BELONG_WHOLEHOUSE } = require('./wholehouse')

const EXPENSE_TYPE_NAMES = { material: '材料', labor: '人工', design: '设计', deposit: '订金/定金', other: '其他' }
const MAT_STATUS_NAME = { to_buy: '待购买', bought: '已购买', on_site: '已进场' }

// 文件名前缀 + 空数据提示，按 scope 区分，让导出内容一目了然对应当前页
const SCOPE_NAMES = {
  all: '费用数据',
  expenses: '花费清单',
  materials: '材料清单',
  wholehouse: '全屋定制',
}
const SCOPE_EMPTY = {
  all: '本项目还没有费用数据',
  expenses: '本项目还没有花费记录',
  materials: '本项目还没有材料',
  wholehouse: '还没有归入全屋定制的材料/花费',
}

function csvCell(v) {
  const s = String(v == null ? '' : v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

// 金额单位为分，转元保留两位小数；非数字（花费行无计划/偏差）留空
function fmtFen(v) {
  return typeof v === 'number' ? (v / 100).toFixed(2) : ''
}
// 偏差：正=超支，负=结余，0/非数字留空（与页面「超支/结余」文案一致）
function fmtDev(v) {
  if (typeof v !== 'number' || v === 0) return ''
  return (v > 0 ? '超支 ' : '结余 ') + (Math.abs(v) / 100).toFixed(2)
}

function buildCsv(rows) {
  const header = ['类别', '名称/备注', '金额(元)', '类目', '状态', '计划价(元)', '偏差(元)', '归属', '所属阶段', '日期', '规格']
  const lines = [header.map(csvCell).join(',')]
  rows.forEach((r) => {
    lines.push([
      r.kind,
      r.name,
      fmtFen(r.amount),
      r.category,
      r.status,
      fmtFen(r.planned),
      fmtDev(r.deviation),
      r.belong,
      r.stage,
      r.date,
      r.spec,
    ].map(csvCell).join(','))
  })
  return lines.join('\r\n')
}

function copyCsv(csv) {
  wx.setClipboardData({
    data: csv,
    success: () => wx.showToast({ title: '已复制，可粘贴到 Excel', icon: 'none' }),
    fail: () => wx.showToast({ title: '导出失败', icon: 'none' }),
  })
}

// 路径②：CSV 上传云存储 → 临时下载链接复制到剪贴板，手机浏览器粘贴打开即下载为本地文件
// （小程序没有写手机存储盘的 API，浏览器下载是拿到真正本地文件的唯一途径）
async function copyDownloadLink(filePath, fileName) {
  wx.showLoading({ title: '生成链接…', mask: true })
  try {
    const safe = String(fileName).replace(/[\\/:*?"<>|#]/g, '_')
    const up = await wx.cloud.uploadFile({
      cloudPath: `exports/${Date.now()}-${safe}`,
      filePath,
    })
    const res = await wx.cloud.getTempFileURL({ fileList: [up.fileID] })
    const url = res.fileList && res.fileList[0] && res.fileList[0].tempFileURL
    if (!url) throw new Error('取不到下载链接')
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.hideLoading()
        wx.showModal({
          title: '下载链接已复制',
          content: '打开手机浏览器，在地址栏粘贴并打开，即可把 CSV 文件下载到手机存储。',
          showCancel: false,
          confirmText: '知道了',
        })
      },
      fail: () => wx.showToast({ title: '复制失败', icon: 'none' }),
    })
  } catch (e) {
    wx.hideLoading()
    wx.showToast({ title: (e && e.message) || '生成链接失败', icon: 'none' })
  }
}

// 拼好 CSV 后写本地文件 → 让用户选「发微信」或「复制下载链接」
function shareCsv(filePath, fileName, csv) {
  const fs = wx.getFileSystemManager()
  fs.writeFile({
    filePath,
    data: '﻿' + csv,
    encoding: 'utf8',
    success: () => {
      wx.hideLoading()
      wx.showActionSheet({
        itemList: ['发送到微信（发文件传输助手后可存手机）', '复制下载链接（浏览器打开存到手机）'],
        success: (r) => {
          if (r.tapIndex === 0) {
            wx.shareFileMessage({
              filePath,
              fileName,
              success: () => {},
              fail: () => copyCsv(csv),
            })
          } else {
            copyDownloadLink(filePath, fileName)
          }
        },
      })
    },
    fail: () => {
      wx.hideLoading()
      copyCsv(csv)
    },
  })
}

// 主入口：按 scope 过滤，只导当前页数据
async function runExport(cloud, projectId, scope) {
  if (!projectId) {
    wx.showToast({ title: '请先在首页选择项目', icon: 'none' })
    return
  }
  wx.showLoading({ title: '正在汇总…' })
  try {
    const [{ data: project }, { data: stages }, { data: expenses }, { data: materials }] = await Promise.all([
      cloud.database.from('projects').select('name').eq('id', projectId).limit(1),
      cloud.database.from('stages').select('id,name').eq('project_id', projectId),
      cloud.database.from('expenses').select('*').eq('project_id', projectId).neq('deleted', true),
      cloud.database.from('materials').select('*').eq('project_id', projectId),
    ])
    const stageMap = {}
    ;(stages || []).forEach((s) => { stageMap[s.id] = s.name })

    let rows = []
    // 花费清单 / 全量 / 全屋定制 都含花费（全屋定制只留 belong=全屋定制的）
    if (scope !== 'materials') {
      ;(expenses || []).forEach((e) => {
        rows.push({
          kind: '花费',
          name: e.remark || EXPENSE_TYPE_NAMES[e.type] || '其他',
          amount: Number(e.amount || 0),
          category: EXPENSE_TYPE_NAMES[e.type] || '其他',
          status: '',
          planned: '',
          deviation: '',
          belong: e.belong === BELONG_WHOLEHOUSE ? '全屋定制' : '',
          stage: e.stage_id ? (stageMap[e.stage_id] || '通用') : '通用',
          date: e.pay_date || '',
          spec: '',
        })
      })
    }
    // 材料清单 / 全量 / 全屋定制 都含材料（材料清单含全部材料，含归属全屋定制的）
    if (scope !== 'expenses') {
      ;(materials || []).forEach((m) => {
        const spec = [m.brand || '', `${m.quantity || ''}${m.unit || ''}`].join(' ').trim()
        const total = Number(m.total_price || 0)
        // 计划价：有 planned_price 用计划价（已定格），无则回退 total_price（老数据）
        const planPrice = Number(m.planned_price != null ? m.planned_price : total)
        const dev = total - planPrice // 实际-计划，正=超支
        rows.push({
          kind: '材料',
          name: m.name || '',
          amount: total,
          category: m.category || '其他',
          status: MAT_STATUS_NAME[m.status] || m.status || '',
          planned: planPrice,
          deviation: dev,
          belong: m.belong === BELONG_WHOLEHOUSE ? '全屋定制' : '',
          stage: m.stage_id ? (stageMap[m.stage_id] || '通用') : '通用',
          date: shortDate(m.created_at),
          spec,
        })
      })
    }
    // 全屋定制 Tab：只保留归入全屋定制的材料/花费
    if (scope === 'wholehouse') {
      rows = rows.filter((r) => r.belong === '全屋定制')
    }

    if (rows.length === 0) {
      wx.hideLoading()
      wx.showToast({ title: SCOPE_EMPTY[scope] || '没有可导出的数据', icon: 'none' })
      return
    }
    const csv = buildCsv(rows)
    const name = (project && project[0] && project[0].name) || '项目'
    const dateStr = today().replace(/-/g, '')
    const fileName = `${SCOPE_NAMES[scope]}_${name}_${dateStr}.csv`
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`
    shareCsv(filePath, fileName, csv)
  } catch (err) {
    wx.hideLoading()
    wx.showToast({ title: '导出失败，请重试', icon: 'none' })
  }
}

// 对外导出：我的页仍用「全量」导出（花费+材料）
async function exportExpensesCsv(cloud, projectId) {
  return runExport(cloud, projectId, 'all')
}
// 花费页三个 Tab 各自只导当前页
async function exportExpensesTabCsv(cloud, projectId) {
  return runExport(cloud, projectId, 'expenses')
}
async function exportMaterialsTabCsv(cloud, projectId) {
  return runExport(cloud, projectId, 'materials')
}
async function exportWholeHouseTabCsv(cloud, projectId) {
  return runExport(cloud, projectId, 'wholehouse')
}

module.exports = {
  exportExpensesCsv,
  exportExpensesTabCsv,
  exportMaterialsTabCsv,
  exportWholeHouseTabCsv,
}
