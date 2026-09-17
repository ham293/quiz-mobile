/**
 * 知识点自动出题（web/js/generator.js）单元测试。
 *   node --test tests/generator.test.mjs
 * 全部为纯逻辑测试：generator.js 不碰 DOM，可在 Node 下直接跑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GEN_CHOICE,
  GEN_FILL,
  GEN_JUDGE,
  GEN_TYPES,
  GEN_TYPE_LABELS,
  extractKeyTerms,
  generateQuestions,
  splitSentences,
  summarizeGenerated,
  textToLines,
} from '../web/js/generator.js';
import { QT_JUDGE, QT_SINGLE, checkAnswer } from '../web/js/models.js';

/* --------------------------------------------------------------- 夹具 */

/** 一行一句话的近代史知识点 */
const DOC = textToLines(`1911 年，辛亥革命推翻了清王朝的统治，结束了两千多年的君主专制制度。
1919 年，五四运动标志着中国新民主主义革命的开端。
1949 年，中华人民共和国成立，中国人民从此站起来了。
光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。
鲁迅在《狂人日记》中描写了封建礼教的吃人本质。`);

/** 术语池：3 个同类干扰项 + 1 个不同 kind 的词 */
const KIND_DOC = textToLines(`辛亥革命推翻了清王朝的统治，具有深远的历史意义。
中国人应当记住五四运动的历史意义与时代价值。
太平天国运动沉重打击了清王朝统治，也改变了社会结构。
光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。`);

/** 取题干的集合形式，便于断言「干扰项不在题干里」 */
function compact(text) {
  return String(text || '').replace(/\s+/g, '');
}

/* ------------------------------------------------------------- 题型常量 */

test('题型常量与中文名', () => {
  assert.deepEqual(GEN_TYPES, ['fill', 'choice', 'judge']);
  assert.equal(GEN_FILL, 'fill');
  assert.equal(GEN_CHOICE, 'choice');
  assert.equal(GEN_JUDGE, 'judge');
  assert.equal(GEN_TYPE_LABELS.fill, '填空');
  assert.equal(GEN_TYPE_LABELS.judge, '判断');
});

/* --------------------------------------------------------------- 切句 */

test('splitSentences：按句末标点切分、保留标点、继承来源行', () => {
  const lines = [
    { page: 2, line: 5, para: 0, text: '第一章 绪论' },
    { page: 2, line: 6, para: 0, text: '五四运动是中国新民主主义革命的开端；它标志着新文化运动的高潮。' },
  ];
  const out = splitSentences(lines);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, '第一章 绪论');
  assert.equal(out[1].text, '五四运动是中国新民主主义革命的开端；');
  assert.ok(out[1].text.endsWith('；'), '分号要保留在句子里');
  assert.equal(out[2].text, '它标志着新文化运动的高潮。');
  assert.equal(out[1].page, 2);
  assert.equal(out[1].line, 6);
  assert.equal(out[1].para, 0);
  assert.equal(out[2].line, 6, '同一行切出的句子共享来源行');
});

test('splitSentences：字符串行没有来源信息（位置全为 0）', () => {
  const out = splitSentences(['光合作用是绿色植物利用光能合成有机物的过程。']);
  assert.equal(out.length, 1);
  assert.equal(out[0].page, 0);
  assert.equal(out[0].line, 0);
  assert.equal(out[0].para, 0);
});

test('splitSentences：去页码、去行首编号与项目符号', () => {
  const out = splitSentences([
    '- 3 -',
    '1. 五四运动是中国新民主主义革命的开端。',
    '· 辛亥革命推翻了清王朝的统治。',
  ]);
  assert.equal(out.length, 2, '页脚「- 3 -」要被丢掉');
  assert.equal(out[0].text, '五四运动是中国新民主主义革命的开端。');
  assert.equal(out[1].text, '辛亥革命推翻了清王朝的统治。');
});

test('splitSentences：重复 3 次的短行按页眉页脚丢弃', () => {
  const out = splitSentences([
    { page: 1, line: 1, para: 0, text: '内部资料 请勿外传' },
    { page: 2, line: 1, para: 0, text: '内部资料 请勿外传' },
    { page: 3, line: 1, para: 0, text: '内部资料 请勿外传' },
    { page: 3, line: 2, para: 0, text: '光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].page, 3);
  assert.equal(out[0].line, 2);
});

test('splitSentences：空输入不报错', () => {
  assert.deepEqual(splitSentences([]), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences([null, '', '   ', {}]), []);
});

test('textToLines：按真实行号切行、丢空行', () => {
  const lines = textToLines('第一行知识点。\n\n  第二行知识点。  \r\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].line, 1);
  assert.equal(lines[1].line, 3, '空行也占行号，和记事本一致');
  assert.equal(lines[1].text, '第二行知识点。');
  assert.equal(lines[0].page, 0);
  assert.equal(lines[0].para, 0);
});

/* ----------------------------------------------------------- 知识点提取 */

test('extractKeyTerms：书名号与引号 → quote', () => {
  const hits = extractKeyTerms('鲁迅在《狂人日记》中描写了封建礼教的吃人本质。');
  const quote = hits.find((h) => h.kind === 'quote');
  assert.ok(quote, '应识别出书名号里的知识点');
  assert.equal(quote.term, '狂人日记');
  assert.equal(quote.index, 4, 'index 指向「狂」字（不含书名号）');
  assert.ok(quote.reason.includes('书名号'));
  assert.equal(extractKeyTerms('他被称为“人民艺术家”。')[0].kind, 'quote');
  assert.equal(extractKeyTerms('他被称为“人民艺术家”。')[0].term, '人民艺术家');
});

test('extractKeyTerms：年份 / 日期 / 百分比 / 比例 / 数量 → number', () => {
  const year = extractKeyTerms('1851 年，中国爆发了太平天国运动。');
  assert.equal(year[0].kind, 'number');
  assert.equal(year[0].term, '1851 年');
  assert.equal(year[0].index, 0);

  const hits = extractKeyTerms('中国于 2001 年加入 WTO，关税水平下降到 9.8%。');
  assert.ok(hits.some((h) => h.term === '2001 年' && h.kind === 'number'));
  assert.ok(hits.some((h) => h.term === '9.8%' && h.kind === 'number'));
  assert.ok(hits.some((h) => h.term === 'WTO' && h.kind === 'en'));

  assert.equal(extractKeyTerms('这个比例大约是 3:1，符合质量标准。')[0].term, '3:1');
  assert.ok(extractKeyTerms('1949 年 10 月 1 日，中华人民共和国成立。')[0].term.includes('1949'));
  assert.ok(extractKeyTerms('该国人口约为 13 亿。').some((h) => h.term === '13 亿'));
});

test('extractKeyTerms：术语 → term（词典与后缀规则，且不跨词误切）', () => {
  const hits = extractKeyTerms('1851 年，中国爆发了太平天国运动。');
  const term = hits.find((h) => h.kind === 'term');
  assert.equal(term.term, '太平天国运动');
  assert.equal(term.index, 12);

  assert.ok(extractKeyTerms('五四运动标志着中国新民主主义革命的开端。').some((h) => h.term === '新民主主义革命'));
  assert.ok(extractKeyTerms('这个比例大约是 3:1，符合质量标准。').some((h) => h.term === '质量标准'));
  assert.ok(extractKeyTerms('辛亥革命是一次伟大革命。').some((h) => h.term === '伟大革命'));

  // 「1895 年签订的条约」不能截出「年签订的条约」这种半截话
  const junk = extractKeyTerms('1895 年，清政府签订了《马关条约》。');
  assert.ok(junk.every((h) => h.term !== '年签订的条约'), '不该跨词截取术语');
  assert.ok(junk.some((h) => h.term === '马关条约' && h.kind === 'quote'));
});

test('extractKeyTerms：人名 / 地名 / 机构 → name', () => {
  const hits = extractKeyTerms('孙中山领导的辛亥革命推翻了清王朝的统治。');
  assert.ok(hits.some((h) => h.term === '孙中山' && h.kind === 'name'));

  const org = extractKeyTerms('1949 年，中华人民共和国成立，中国人民从此站起来了。');
  assert.ok(org.some((h) => h.term === '中华人民共和国' && h.kind === 'name'));
  assert.ok(extractKeyTerms('1894 年，清政府战败后签订了条约。').some((h) => h.term === '清政府'));

  // 「标志着中国」不能截出「志着中国」
  const cross = extractKeyTerms('1919 年，五四运动标志着中国新民主主义革命的开端。');
  assert.ok(cross.every((h) => h.term !== '志着中国'), '不该跨词截取机构名');
  assert.ok(cross.some((h) => h.term === '新民主主义革命'));
});

test('extractKeyTerms：英文缩写 → en，且没有知识点时返回空数组', () => {
  assert.equal(extractKeyTerms('中国在 2001 年加入 WTO。').find((h) => h.kind === 'en').term, 'WTO');
  assert.deepEqual(extractKeyTerms('他每天坚持体育锻炼。'), []);
  assert.deepEqual(extractKeyTerms(''), []);
  assert.deepEqual(extractKeyTerms(null), []);
});

test('extractKeyTerms：重叠时按 quote > term > name > number 取优先级', () => {
  const hits = extractKeyTerms('《马关条约》是 1895 年签订的不平等条约。');
  const book = hits.find((h) => h.term === '马关条约');
  assert.equal(book.kind, 'quote');
  assert.ok(hits.every((h) => h.kind !== 'term' || h.term !== '条约'), '书名号内的词不会再按后缀重复命中');

  const year = extractKeyTerms('1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。');
  assert.deepEqual(year.map((h) => h.kind), ['number', 'name', 'term']);
  assert.deepEqual(year.map((h) => h.term), ['1851 年', '中国', '太平天国运动']);
});

/* --------------------------------------------------------------- 填空题 */

test('填空题：挖空位置、答案、选项与出处', () => {
  const doc = textToLines('1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。');
  const r = generateQuestions(doc, { types: [GEN_FILL], seed: 1 });
  assert.equal(r.questions.length, 1);
  const q = r.questions[0];
  assert.equal(q.stem, '1851 年，中国爆发了 ____ 运动，沉重打击了清王朝统治。');
  assert.equal(q.qtype, QT_SINGLE, '填空用单选承载，练习页才能正常判对错');
  assert.equal(q.qtype, '单选');
  assert.deepEqual(Object.keys(q.options), ['A'], '填空题只有正确项一个选项');
  assert.equal(q.options.A, '太平天国', '术语后缀「运动」留在题干里');
  assert.equal(q.answer, 'A');
  assert.equal(q.explanation, '出自原文：1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。');
  assert.equal(q.raw, '1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。');
  assert.equal(q.page, 0);
  assert.equal(q.line, 1);
  // models.extractYear 只认 19xx/20xx，1851 这类年份按约定保持 null
  assert.equal(q.year, null);
  assert.equal(generateQuestions(textToLines('1911 年，辛亥革命推翻了清王朝的统治，具有深远意义。'), {
    types: [GEN_FILL],
    seed: 1,
  }).questions[0].year, 1911);
  assert.equal(q.source, 'auto');
  assert.equal(q.qid.length, 16);
});

test('填空题：练习页判定链路可用（答 A 判对、答错判错）', () => {
  const r = generateQuestions(textToLines('1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。'), {
    types: [GEN_FILL],
    seed: 1,
  });
  const q = r.questions[0];
  assert.equal(checkAnswer(q, q.answer), true);
  assert.equal(checkAnswer(q, 'B'), false);
  assert.equal(checkAnswer(q, ''), false);
});

test('挖空门槛：被挖词占整句比例过高 → 不生成', () => {
  const r = generateQuestions(textToLines('中国特色社会主义的根本方向。'), { types: [GEN_FILL] });
  assert.equal(r.questions.length, 0);
  assert.equal(r.total, 1);
  assert.equal(r.skipped, 1);
});

test('挖空门槛：挖空后仍剩 ≥8 字、太短句直接跳过', () => {
  const ok = generateQuestions(textToLines('辛亥革命是一次伟大革命。'), { types: [GEN_FILL], seed: 1 });
  assert.equal(ok.questions.length, 1);
  assert.equal(ok.questions[0].options.A, '辛亥');
  assert.equal(ok.questions[0].stem, '____ 革命是一次伟大革命。');

  const tooShort = generateQuestions(textToLines('辛亥革命爆发。'), { types: [GEN_FILL] });
  assert.equal(tooShort.questions.length, 0);
  assert.equal(tooShort.sentences, 0);
});

/* --------------------------------------------------------------- 选择题 */

test('选择题：4 个选项、答案字母指向正确项、干扰项同 kind 优先', () => {
  const r = generateQuestions(KIND_DOC, { types: [GEN_CHOICE], seed: 1 });
  assert.equal(r.questions.length, 4);
  const q = r.questions[0];
  assert.deepEqual(Object.keys(q.options).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(q.options[q.answer], '辛亥', '答案字母必须指向正确项');
  assert.ok(['A', 'B', 'C', 'D'].includes(q.answer));
  const values = Object.values(q.options);
  assert.deepEqual([...values].sort(), ['五四', '光合作用', '太平天国', '辛亥']);
  assert.equal(values.filter((v) => v === '辛亥').length, 1, '正确项只出现一次');
  assert.equal(q.qtype, QT_SINGLE);
  assert.equal(q.explanation, '出自原文：辛亥革命推翻了清王朝的统治，具有深远的历史意义。');
});

test('选择题：干扰项不会出现在题干里（避免送分）', () => {
  const r = generateQuestions(KIND_DOC, { types: [GEN_CHOICE], seed: 3 });
  assert.ok(r.questions.length >= 2);
  for (const q of r.questions) {
    const stem = compact(q.stem);
    for (const [letter, text] of Object.entries(q.options)) {
      if (letter === q.answer) continue;
      assert.ok(!stem.includes(compact(text)), `干扰项「${text}」不该出现在题干里`);
    }
  }
});

test('选择题：找不到干扰项就不生成（宁缺毋滥）', () => {
  const lonely = textToLines('光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。');
  const r = generateQuestions(lonely, { types: [GEN_CHOICE] });
  assert.equal(r.questions.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('干扰项')), '要给出「干扰项不足」的中文提示');
});

/* --------------------------------------------------------------- 判断题 */

test('判断题：原句照抄 → 正确，题型为判断', () => {
  const r = generateQuestions(DOC, { types: [GEN_JUDGE], seed: 1 });
  const q = r.questions[0];
  assert.equal(q.qtype, QT_JUDGE);
  assert.equal(q.answer, '正确');
  assert.equal(q.stem, '1911 年，辛亥革命推翻了清王朝的统治，结束了两千多年的君主专制制度。');
  assert.deepEqual(q.options, {}, '判断题不需要选项');
  assert.equal(checkAnswer(q, '正确'), true);
  assert.equal(checkAnswer(q, '错误'), false);
  assert.equal(q.explanation, `出自原文：${q.raw}`);
});

test('判断题：改数字 → 错误，且解析注明改动', () => {
  const doc = textToLines(`1840 年，英国发动了鸦片战争，中国开始沦为半殖民地半封建社会。
1919 年，五四运动标志着中国新民主主义革命的开端。`);
  const r = generateQuestions(doc, { types: [GEN_JUDGE], seed: 3 });
  assert.equal(r.questions.length, 2);
  assert.equal(r.questions[0].answer, '正确');
  const wrong = r.questions[1];
  assert.equal(wrong.answer, '错误');
  assert.notEqual(wrong.stem, wrong.raw);
  assert.ok(/19\d{2} 年/.test(wrong.stem), '年份被改掉');
  assert.ok(wrong.explanation.includes('出自原文：'));
  assert.ok(wrong.explanation.includes('改成了'), '解析要写清改了什么');
});

test('判断题：百分比 ±10 → 错误', () => {
  const doc = textToLines(`1840 年，英国发动了鸦片战争，中国开始沦为半殖民地半封建社会。
我国的贫困发生率下降到 0.6%，取得了显著的成效。`);
  const r = generateQuestions(doc, { types: [GEN_JUDGE], seed: 9 });
  const wrong = r.questions[1];
  assert.equal(wrong.answer, '错误');
  assert.ok(wrong.stem.includes('10.6%'), `百分比应 +10：${wrong.stem}`);
  assert.equal(checkAnswer(wrong, '错误'), true);
});

test('判断题：删否定词 → 错误', () => {
  const doc = textToLines(`实践是检验真理的唯一标准，这是马克思主义的基本原则。
五四运动不是一场单纯的文化运动。`);
  const r = generateQuestions(doc, { types: [GEN_JUDGE], seed: 3 });
  assert.equal(r.questions.length, 2);
  const wrong = r.questions[1];
  assert.equal(wrong.answer, '错误');
  assert.equal(wrong.stem, '五四运动是一场单纯的文化运动。');
  assert.equal(wrong.raw, '五四运动不是一场单纯的文化运动。');
  assert.ok(wrong.explanation.includes('删去'), '解析要说明删掉了否定词');
});

test('判断题：加否定词（是 → 不是）→ 错误', () => {
  const doc = textToLines(`1840 年，英国发动了鸦片战争，中国开始沦为半殖民地半封建社会。
中国的革命道路具有自身的特点。`);
  const doc2 = textToLines(`中国的革命道路具有自身的特点。
实践是检验真理的唯一标准，这是马克思主义的基本原则。`);
  // 第二句含「是」但第一句不含数字 → 第一句出「正确」，第二句改写
  const r = generateQuestions(doc2, { types: [GEN_JUDGE], seed: 2 });
  assert.ok(r.questions.length >= 2);
  assert.equal(r.questions[0].answer, '正确');
  const wrong = r.questions[1];
  assert.equal(wrong.answer, '错误');
  assert.ok(wrong.stem.includes('不是'), `应插入否定词：${wrong.stem}`);
  assert.equal(generateQuestions(doc, { types: [GEN_JUDGE] }).questions.length >= 1, true);
});

test('判断题：只对含数字或判断词的句子出题', () => {
  const pure = textToLines('他每天坚持体育锻炼身体非常健康。');
  const r = generateQuestions(pure, { types: [GEN_JUDGE] });
  assert.equal(r.questions.length, 0);
  assert.equal(r.sentences, 1, '句子是有效句子，只是不适合出判断题');
});

test('判断题：同一句不会生成只差一个字的重复题', () => {
  const doc = textToLines('五四运动是中国新民主主义革命的开端。');
  const r = generateQuestions(doc, { types: [GEN_JUDGE], seed: 4, maxPerSentence: 3 });
  assert.equal(r.questions.length, 1, '一句最多一道判断题，避免「X 是 Y / X 不是 Y」成对出现');
  assert.equal(new Set(r.questions.map((q) => q.qid)).size, r.questions.length);
  assert.deepEqual(r.byType, { fill: 0, choice: 0, judge: 1 });
});

/* ------------------------------------------------------------- 综合行为 */

test('三种题型混合：题型均衡、题干互不重复、答案为客观题可判定的答案', () => {
  const r = generateQuestions(DOC, { seed: 1, count: 50 });
  assert.ok(r.questions.length >= 4);
  assert.equal(new Set(r.questions.map((q) => q.qid)).size, r.questions.length, 'qid 必须唯一');
  assert.ok(r.byType.fill >= 1 && r.byType.choice >= 1 && r.byType.judge >= 1, '三种题型都应出现');
  for (const q of r.questions) {
    assert.ok(q.qtype === QT_SINGLE || q.qtype === QT_JUDGE);
    assert.ok(q.answer, '每题都要有参考答案');
    assert.ok(q.explanation.startsWith('出自原文：'), '每题都要带出处原句');
    assert.equal(q.source, 'auto');
    assert.ok(q.raw.length > 0);
  }
});

test('题数上限与每句上限生效', () => {
  const capped = generateQuestions(DOC, { count: 2 });
  assert.equal(capped.questions.length, 2);
  assert.ok(capped.warnings.some((w) => w.includes('上限')));
  assert.ok(capped.skipped >= capped.total - capped.sentences, '噪声句都要计入 skipped');

  const perSentence = generateQuestions(DOC, { types: [GEN_FILL], count: 20, maxPerSentence: 2, seed: 5 });
  assert.ok(perSentence.questions.length >= 2);
  const firstLineCount = perSentence.questions.filter((q) => q.line === 1 && q.stem.includes('____')).length;
  assert.ok(firstLineCount <= 2, '同一句最多出 maxPerSentence 题');
});

test('噪声句被跳过：标题、目录、推广语、答案行、页码、短句', () => {
  const noise = textToLines(`第一章 总论
目录
关注公众号领取完整复习资料
答案：A
解析：本题考查了五四运动的历史意义
- 7 -
短句。`);
  const r = generateQuestions(noise, {});
  assert.equal(r.questions.length, 0);
  assert.equal(r.sentences, 0, '噪声句不算参与出题的句子');
  assert.equal(r.skipped, r.total);
  assert.ok(r.total >= 5);
  assert.ok(r.warnings.some((w) => w.includes('没有提取到')), '空结果要给出引导提示');
});

test('空输入 / 非法输入不崩', () => {
  for (const input of [[], null, undefined, '', 42, [{ text: '' }]]) {
    const r = generateQuestions(input, {});
    assert.deepEqual(r.questions, []);
    assert.equal(r.total, 0);
    assert.equal(r.sentences, 0);
    assert.ok(Array.isArray(r.warnings));
  }
  const noOpts = generateQuestions(DOC);
  assert.ok(noOpts.questions.length > 0, '不传 opts 也能工作');
});

test('参数兜底：非法 types/count/maxPerSentence 不影响运行', () => {
  assert.ok(generateQuestions(DOC, { types: [] }).questions.length > 0, '空数组视为全都要');
  assert.ok(generateQuestions(DOC, { types: ['nope'] }).questions.length > 0);
  assert.equal(generateQuestions(DOC, { types: [GEN_FILL], count: 0 }).questions.length, 1, 'count 最小为 1');
  assert.equal(generateQuestions(DOC, { types: [GEN_FILL], count: 9999 }).questions.length <= 500, true);
  assert.ok(generateQuestions(DOC, { types: [GEN_FILL], count: 'abc' }).questions.length > 0);
  const onlyJudge = generateQuestions(DOC, { types: [GEN_JUDGE] });
  assert.ok(onlyJudge.questions.every((q) => q.qtype === QT_JUDGE), 'types 过滤生效');
});

test('seed 可复现：同 seed 完全一致，不同 seed 会打乱选项', () => {
  const a = generateQuestions(KIND_DOC, { types: [GEN_CHOICE], seed: 7 });
  const b = generateQuestions(KIND_DOC, { types: [GEN_CHOICE], seed: 7 });
  const c = generateQuestions(KIND_DOC, { types: [GEN_CHOICE], seed: 8 });
  assert.equal(JSON.stringify(a.questions), JSON.stringify(b.questions));
  assert.notEqual(
    a.questions.map((q) => q.answer).join(''),
    c.questions.map((q) => q.answer).join(''),
    '换 seed 后正确项位置应该变化',
  );
  const d = generateQuestions(KIND_DOC, { types: [GEN_CHOICE] });
  const e = generateQuestions(KIND_DOC, { types: [GEN_CHOICE] });
  assert.equal(JSON.stringify(d.questions), JSON.stringify(e.questions), '默认 seed 固定 → 默认也可复现');
});

test('summarizeGenerated 输出中文摘要', () => {
  const r = generateQuestions(DOC, { seed: 1 });
  const text = summarizeGenerated(r);
  assert.ok(text.includes('生成'));
  assert.ok(text.includes(`填空 ${r.byType.fill}`));
  assert.ok(text.includes(`选择 ${r.byType.choice}`));
  assert.ok(text.includes(`判断 ${r.byType.judge}`));
  assert.ok(summarizeGenerated({}).includes('0 题'));
});
