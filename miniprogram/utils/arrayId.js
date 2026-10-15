// 共用 UI / 数据辅助函数（小工具集）

/**
 * 把 id 数组映射成中文名数组，拼成最多展示 3 项（剩余用「等 X 项」）。
 * 用于多选下拉/标签等多值展示，避免一行过宽。
 * @param {string[]} arr 选中的 id 列表
 * @param {{id:string,name:string}[]} items 候选清单（按 id 索引）
 * @returns {string} 「主卧、次卧、书房」或「主卧、次卧、书房 等 5 项」
 */
function joinNames(arr, items) {
  const map = {}
  ;(items || []).forEach((x) => { if (x && x.id != null) map[String(x.id)] = x.name })
  const names = (arr || []).map((id) => map[String(id)] || '?')
  if (names.length === 0) return ''
  if (names.length <= 3) return names.join('、')
  return names.slice(0, 3).join('、') + ' 等 ' + names.length + ' 项'
}

/**
 * 把「_ids[] + 单 _id」字段归一为多值数组（读取端向后兼容）。
 * - 优先用 *_ids 数组（去空、去重、字符串化）
 * - 没有 *_ids 时回退单字段（包装成单元素数组）
 * - 都没有 → 空数组
 * @param {string|string[]} idsArr
 * @param {string} single
 * @returns {string[]}
 */
function normalizeIds(idsArr, single) {
  if (Array.isArray(idsArr) && idsArr.length) {
    const seen = {}
    const out = []
    idsArr.forEach((x) => {
      const s = String(x || '').trim()
      if (s && !seen[s]) { seen[s] = true; out.push(s) }
    })
    return out
  }
  if (single) return [String(single)]
  return []
}

/**
 * 单字段归一：从 { stage_ids?, stage_id? } 提取多值数组（用于聚合/汇总处兼容新旧数据）。
 * @param {{stage_ids?:string[],stage_id?:string}} d
 * @returns {string[]}
 */
function tagsOf(d) {
  return normalizeIds(d && d.stage_ids, d && d.stage_id)
}

module.exports = { joinNames, normalizeIds, tagsOf }
