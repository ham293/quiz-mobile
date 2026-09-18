"""生成「双栏排版」PDF 测试样本（考试卷常见的左右两栏）。

用途：验证 extract.js 的分栏检测 —— 不分栏时左右两栏同一横线上的文字会被
拼成一行，题干串行；分栏后应当各栏独立、读起来通顺。

用法：python tools/make_two_column_fixture.py
产物：tests/fixtures/two-column.pdf
"""
from __future__ import annotations

from pathlib import Path

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "fixtures" / "two-column.pdf"

FONT = "STSong-Light"
LEFT_X = 36
RIGHT_X = 306
TOP_Y = 780
LINE_H = 16

LEFT_COLUMN = [
    "一、单选题（共计280分）",
    "1、[2分] 1943年1月，美英分别与中国",
    "签订新约，废除在华领事裁判权，这说明（ ）",
    "A. 购买救国公债",
    "B. 华侨义捐",
    "C. 抵制日货",
    "D. 国民外交活动",
    "2、[2分] 1842年《南京条约》签订后，",
    "中国开始沦为（ ）",
    "A. 封建社会",
    "B. 半殖民地半封建社会",
    "C. 资本主义社会",
    "D. 社会主义社会",
    "3、[2分] 1919年五四运动爆发的",
    "直接原因是（ ）",
    "A. 巴黎和会上中国外交失败",
    "B. 新文化运动的推动",
    "C. 俄国十月革命的影响",
    "D. 民族资本主义的发展",
]

RIGHT_COLUMN = [
    "二、多选题（共计120分）",
    "4、[3分] 下列属于洋务运动内容的有（ ）",
    "A. 创办军事工业",
    "B. 创办民用工业",
    "C. 建立新式海军",
    "D. 废除科举制度",
    "5、[3分] 抗日战争时期，中国共产党",
    "领导的抗日根据地实行的政策包括（ ）",
    "A. 三三制原则",
    "B. 减租减息",
    "C. 大生产运动",
    "D. 精兵简政",
    "6、[3分] 下列属于戊戌变法内容的有（ ）",
    "A. 改革政府机构",
    "B. 鼓励私人兴办工矿企业",
    "C. 开办新式学堂",
    "D. 建立君主立宪制",
]


def main() -> None:
    pdfmetrics.registerFont(UnicodeCIDFont(FONT))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUT), pagesize=A4)
    c.setFont(FONT, 10.5)

    for i, text in enumerate(LEFT_COLUMN):
        c.drawString(LEFT_X, TOP_Y - i * LINE_H, text)
    # 右栏与左栏使用完全相同的 y 坐标 —— 不分栏就会串行
    for i, text in enumerate(RIGHT_COLUMN):
        c.drawString(RIGHT_X, TOP_Y - i * LINE_H, text)

    c.showPage()
    c.save()
    print(f"已生成：{OUT}")
    print(f"  左栏 {len(LEFT_COLUMN)} 行 / 右栏 {len(RIGHT_COLUMN)} 行，两栏行 y 坐标完全相同")


if __name__ == "__main__":
    main()
