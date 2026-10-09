// 全屋定制「归属」约定
// materials.belong / expenses.belong 取 'wholehouse' 表示属于全屋定制；空串表示无归属。
// 这样材料/花费用一个显式字段就能被「花费-全屋定制」模块稳定归集，避免歧义。

const BELONG_WHOLEHOUSE = 'wholehouse'

// 全屋定制的常见子类（可选，用于细化展示；仅当 belong='wholehouse' 时有意义）
const WHOLEHOUSE_SUBS = ['橱柜', '衣柜', '木门', '榻榻米', '五金', '台面', '其他']

// 关键词兜底：名称/备注命中则「疑似」属于全屋定制。
// 不自动归入，只用于提示用户「一键归集」，避免误标。
// 含「定制」二字即命中（定制柜/定制橱柜/整体定制…均算全屋定制范畴）。
const WHOLEHOUSE_KEYWORDS = [
  '全屋定制', '定制', '定制柜', '橱柜', '衣柜', '木门', '榻榻米', '台面',
  '酒柜', '鞋柜', '书柜', '餐边柜', '电视柜', '阳台柜', '浴室柜', '护墙板',
]

function isWholeHouseLike(text) {
  const s = String(text || '')
  if (!s) return false
  return WHOLEHOUSE_KEYWORDS.some((k) => s.indexOf(k) !== -1)
}

// 阶段是否属于全屋定制：key 命中，或名称含「全屋定制」/「定制」二字。
// 与 board.js 的 resolveStageKey 保持一致（含「定制」的名称落 key='customhome'）。
function isWholeHouseStage(stage) {
  if (!stage) return false
  if (stage.key === 'customhome') return true
  const name = stage.name || ''
  return name.indexOf('全屋定制') !== -1 || name.indexOf('定制') !== -1
}

module.exports = { BELONG_WHOLEHOUSE, WHOLEHOUSE_SUBS, WHOLEHOUSE_KEYWORDS, isWholeHouseLike, isWholeHouseStage }
