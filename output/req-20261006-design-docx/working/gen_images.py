# -*- coding: utf-8 -*-
"""生成设计文档示意图：tabBar 结构图、双主题色板图、首页线框图"""
from PIL import Image, ImageDraw, ImageFont

OUT = "/Users/beryllewis/private/coding/qc-graden/output/req-20261006-design-docx/stage2/images"
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"

def f(size, bold=False):
    return ImageFont.truetype(FONT, size, index=2 if bold else 0)

THEME_A = {"primary": "#8C5A3B", "bg": "#FAF6EF", "secondary": "#3F5A4C",
           "accent": "#B08A47", "text": "#3A322B", "text2": "#8A7E72", "border": "#E8DFCF"}
THEME_B = {"primary": "#3E3E42", "bg": "#F7F7F5", "secondary": "#6E7F8D",
           "accent": "#C2A878", "text": "#232326", "text2": "#8B8B90", "border": "#E6E6E2"}

def rounded(d, box, r, **kw):
    d.rounded_rectangle(box, radius=r, **kw)

def center_text(d, cx, y, s, font, fill):
    w = d.textlength(s, font=font)
    d.text((cx - w / 2, y), s, font=font, fill=fill)

# ---------- 1. tabBar 结构图 ----------
def gen_tabbar():
    W, H = 1080, 340
    img = Image.new("RGB", (W, H), "#FFFFFF")
    d = ImageDraw.Draw(img)
    t = THEME_A
    d.text((40, 24), "tabBar 结构（5 个标签页）", font=f(30, True), fill=t["text"])
    # phone frame
    x0, y0, x1, y1 = 40, 80, W - 40, H - 40
    rounded(d, [x0, y0, x1, y1], 24, outline=t["border"], width=3, fill=t["bg"])
    bar_y = y1 - 110
    d.line([x0 + 2, bar_y, x1 - 2, bar_y], fill=t["border"], width=2)
    tabs = ["首页", "日记", "花费", "知识库", "我的"]
    tw = (x1 - x0) / 5
    for i, name in enumerate(tabs):
        cx = x0 + tw * i + tw / 2
        active = (i == 0)
        color = t["primary"] if active else t["text2"]
        # icon placeholder: rounded square
        rounded(d, [cx - 16, bar_y + 18, cx + 16, bar_y + 50], 6,
                fill=color if active else None, outline=color, width=2)
        center_text(d, cx, bar_y + 58, name, f(24, active), color)
        if i == 4:
            center_text(d, cx, y0 + 30, "", f(20), color)
    d.text((40, H - 28), "选中态 = 主色（方案A 胡桃棕）｜未选中 = 次要文字色", font=f(20), fill=t["text2"])
    img.save(f"{OUT}/tabbar.png")

# ---------- 2/3. 双主题色板 ----------
def gen_palette(theme, name, fname):
    W, H = 1080, 420
    img = Image.new("RGB", (W, H), "#FFFFFF")
    d = ImageDraw.Draw(img)
    d.text((40, 24), name, font=f(30, True), fill=theme["text"])
    items = [("主色 primary", "primary"), ("背景 bg", "bg"), ("辅助 secondary", "secondary"),
             ("强调 accent", "accent"), ("正文 text", "text")]
    bw, bh, gap, y = 190, 190, 12, 80
    x = 40
    for label, key in items:
        rounded(d, [x, y, x + bw, y + bh], 16, fill=theme[key], outline=theme["border"], width=2)
        d.text((x, y + bh + 10), label.split()[0], font=f(22, True), fill=theme["text"])
        d.text((x, y + bh + 44), theme[key], font=f(20), fill=theme["text2"])
        x += bw + gap
    d.text((40, H - 56), "标题用衬线体（杂志感）· 正文系统黑体 · 卡片 20rpx 圆角 + 0.5px 细边 · 金额一律强调色",
           font=f(22), fill=theme["text2"])
    img.save(f"{OUT}/{fname}")

# ---------- 4. 首页线框 ----------
def gen_home():
    W, H = 750, 1150
    t = THEME_A
    img = Image.new("RGB", (W, H), t["bg"])
    d = ImageDraw.Draw(img)
    m = 32
    def card(y0, y1):
        rounded(d, [m, y0, W - m, y1], 20, fill="#FFFFFF", outline=t["border"], width=2)
    d.text((m, 28), "首页（线框示意）", font=f(30, True), fill=t["text"])
    # 项目卡
    card(80, 260)
    d.text((m + 24, 104), "滨江府 89㎡", font=f(30, True), fill=t["text"])
    rounded(d, [W - m - 170, 106, W - m - 24, 152], 999, fill="#EDF3EF")
    center_text(d, W - m - 97, 112, "水电改造", f(22), t["secondary"])
    d.text((m + 24, 166), "三室两厅 · 89㎡", font=f(22), fill=t["text2"])
    d.text((m + 24, 206), "阶段进度 2/8", font=f(22), fill=t["text2"])
    # 预算卡
    card(280, 430)
    d.text((m + 24, 304), "已花费", font=f(22), fill=t["text2"])
    d.text((m + 24, 338), "¥36,800.00", font=f(34, True), fill=t["accent"])
    d.text((W - m - 220, 320), "预算 ¥200,000", font=f(22), fill=t["text2"])
    rounded(d, [m + 24, 392, W - m - 24, 406], 999, fill="#EDF3EF")
    rounded(d, [m + 24, 392, m + 24 + int((W - 2 * m - 48) * 0.18), 406], 999, fill=t["accent"])
    # 最新日记
    d.text((m, 460), "最新日记", font=f(26, True), fill=t["text"])
    y = 500
    for title, date in [("水电验收完成，打压测试通过", "10月6日 · 3 张图"),
                        ("瓷砖到场，核对色号", "10月4日 · 5 张图"),
                        ("开工大吉", "10月1日 · 2 张图")]:
        card(y, y + 100)
        d.text((m + 24, y + 18), title, font=f(24, True), fill=t["text"])
        d.text((m + 24, y + 58), date, font=f(20), fill=t["text2"])
        y += 120
    img.save(f"{OUT}/home-wireframe.png")

gen_tabbar()
gen_palette(THEME_A, "方案 A · 中古暖调（默认）", "theme-a.png")
gen_palette(THEME_B, "方案 B · 轻奢冷调", "theme-b.png")
gen_home()
print("done")
