const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 幂等初始化：写入 8 个知识分类 + 5 篇官方示例文章（scope=official）。
// 通过 key / link_hash 去重，可反复运行；仅由运维在云函数控制台手动触发一次。
//
// 注意与小程序端查询口径对齐：
//   - 文章必须带 status:'published'（knowledge/index.js 按此过滤）
//   - 文章必须带 category_id（= 分类文档 _id），而非 category_key（分类筛选 .eq('category_id', cat.id)）
const CATEGORIES = [
  { key: 'hydropower', name: '水电隐蔽工程', sort_order: 1 },
  { key: 'masonry', name: '泥瓦与防水', sort_order: 2 },
  { key: 'carpentry', name: '木作与吊顶', sort_order: 3 },
  { key: 'paint', name: '油漆与墙面', sort_order: 4 },
  { key: 'material', name: '主材选购', sort_order: 5 },
  { key: 'soft', name: '软装与收纳', sort_order: 6 },
  { key: 'acceptance', name: '验收与避坑', sort_order: 7 },
  { key: 'wholehouse', name: '全屋定制', sort_order: 8 },
]

const ARTICLES = [
  {
    scope: 'official',
    category_key: 'hydropower',
    title: '水电改造：横平竖直还是点对点',
    summary: '走顶便于检修，走地省料；厨卫必须走顶，线管间距留足。',
    content: '水电是隐蔽工程里最贵的返工项。原则：厨卫水路走顶，漏水能第一时间发现；强电弱电分管分槽，间距≥30cm 避免干扰。验收时务必拍照存档管线走向，贴砖后无从查证。',
    tags: ['水电', '避坑'],
    image_paths: [],
    link_hash: 'seed-official-hydropower-1',
    view_count: 0,
  },
  {
    scope: 'official',
    category_key: 'masonry',
    title: '防水做几遍？闭水试验多久',
    summary: '卫生间墙面刷到 1.8m，地面两遍，闭水试验不少于 48 小时。',
    content: '防水涂料薄刷多遍，单遍不超 1mm；门槛石处重点处理。闭水试验蓄水深 2-3cm，楼下/top 邻户观察 48h 无渗漏再贴砖。地漏、管根做圆弧倒角再刷防水。',
    tags: ['防水', '验收'],
    image_paths: [],
    link_hash: 'seed-official-masonry-1',
    view_count: 0,
  },
  {
    scope: 'official',
    category_key: 'material',
    title: '瓷砖选购：吸水率与背胶',
    summary: '地砖看耐磨，墙砖看吸水率；低吸水率砖必须背胶铺贴。',
    content: '瓷质砖吸水率<0.5%，上墙需背胶+瓷砖胶，水泥砂浆易空鼓脱落。哑光砖显脏但耐看，亮光砖显干净但有水渍印。买砖多备 5% 损耗，同批次色号一致。',
    tags: ['主材', '瓷砖'],
    image_paths: [],
    link_hash: 'seed-official-material-1',
    view_count: 0,
  },
  {
    scope: 'official',
    category_key: 'acceptance',
    title: '竣工验收清单（家庭版）',
    summary: '门缝、地漏坡度、插座相位、空鼓，四项逐一过。',
    content: '空鼓锤敲瓷砖，单砖空鼓率<5%；地漏倒水看回水坡度；插座用相位仪查零火地；门窗缝隙均匀、开合顺。所有问题拍照留证，尾款留 5-10% 质保金。',
    tags: ['验收', '清单'],
    image_paths: [],
    link_hash: 'seed-official-acceptance-1',
    view_count: 0,
  },
  {
    scope: 'official',
    category_key: 'wholehouse',
    title: '全屋定制怎么用：贯穿全程的并行环节',
    summary: '橱柜衣柜不是一步工序，而是从水电前初测到硬装尾声安装的并行环节。讲清在 App 里怎么建阶段、看进度、管材料。',
    content: '全屋定制（橱柜/衣柜/木门等）是贯穿装修全程的并行环节，与油漆工程等没有绝对先后：水电前初测 → 泥木后复尺下单 → 工厂生产 30–45 天 → 硬装尾声集中安装。因此在 App 里它不占线性工序的固定槽位，由你按需建立。\n\n三步上手：\n1. 在施工看板建阶段：进「施工看板」，点「＋添加施工阶段」，输入"全屋定制"（或"全屋定制（橱柜）"等带全名的），确认后即归入全屋定制环节，位置排在列表末尾，放哪都行。\n2. 推进状态：在看板里点「全屋定制」那一行，状态循环 未开始 → 进行中 → 已完成，点成"进行中"即视为已启动。\n3. 在花费页看进度、管材料：回到「花费」页，中段「全屋定制」卡会自动认出该阶段并显示进度，点卡片可跳回看板；要采购的板材、五金、嵌入电器等，在花费页顶部「材料清单」逐件添加，按 待购买 → 已购买 → 已进场 推进，单独计"材料合计"，不混入预算花费。\n\n注意：阶段名要带"全屋定制"四个字，卡片才认得出（写"定制柜"不会匹配）；旧项目若标准阶段未同步可用 syncStages 补，但全屋定制本就是手建，不用等它。',
    tags: ['全屋定制', '使用说明'],
    image_paths: [],
    link_hash: 'seed-official-wholehouse-1',
    view_count: 0,
  },
]

exports.main = async () => {
  const db = cloud.database()
  // 诊断返回：真实插入数 + 错误列表，避免「函数没抛错就返回 ok」掩盖静默写入失败
  const result = { ok: true, categories: CATEGORIES.length, articles: ARTICLES.length, catInserted: 0, artInserted: 0, errors: [] }

  // 先写分类并记住 key -> _id 映射，供文章填 category_id
  const catMap = {}
  for (const c of CATEGORIES) {
    try {
      const ex = await db.collection('knowledge_categories').where({ key: c.key }).get()
      if (!ex.data.length) {
        const r = await db.collection('knowledge_categories').add({ data: c })
        catMap[c.key] = r._id
        result.catInserted++
      } else {
        catMap[c.key] = ex.data[0]._id
      }
    } catch (e) {
      result.errors.push({ step: 'category', key: c.key, message: e.message || String(e) })
    }
  }

  for (const a of ARTICLES) {
    try {
      const ex = await db.collection('knowledge_articles').where({ link_hash: a.link_hash }).get()
      if (!ex.data.length) {
        const doc = { ...a, status: 'published', category_id: catMap[a.category_key] }
        delete doc.category_key
        const r = await db.collection('knowledge_articles').add({ data: doc })
        result.artInserted++
        // 若 add 返回无 _id，说明可能静默未写入，显式记录便于排查
        if (!r || !r._id) {
          result.errors.push({ step: 'article-add', title: a.title, message: 'add 返回无 _id（疑似静默未写入）' })
        }
      }
    } catch (e) {
      result.errors.push({ step: 'article', title: a.title, link_hash: a.link_hash, message: e.message || String(e) })
    }
  }

  if (result.errors.length) result.ok = false
  return result
}
