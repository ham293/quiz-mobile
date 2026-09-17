/** 临时自测脚本：真实中文知识点 → 自动出题（跑完即删） */
import { generateQuestions, textToLines, summarizeGenerated, splitSentences, extractKeyTerms } from './web/js/generator.js';

const doc = `第一章 中国近代史纲要

1840 年，英国发动了鸦片战争，中国开始沦为半殖民地半封建社会。
1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。
1894 年，日本挑起甲午中日战争，清政府战败后被迫签订了《马关条约》。
1911 年，辛亥革命推翻了清王朝的统治，结束了两千多年的君主专制制度。
1919 年，五四运动标志着中国新民主主义革命的开端。
1921 年，中国共产党成立，中国革命的面貌从此焕然一新。
1937 年，抗日战争全面爆发，中国人民开始了长达八年的全国抗战。
1949 年，中华人民共和国成立，中国人民从此站起来了。
1978 年，十一届三中全会作出了改革开放的伟大决策。
邓小平提出了一国两制的伟大构想，为解决香港问题提供了方案。
中国共产党的领导是中国特色社会主义最本质的特征。
实践是检验真理的唯一标准，这是马克思主义的基本原则。
百分比考点：2019 年我国贫困发生率下降到 0.6%。
光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。
人体的免疫系统能够识别并清除入侵的病原体。
评论区留言可以领取资料，扫码关注公众号。`;

const lines = textToLines(doc);
console.log('=== 切句 ===');
const sentences = splitSentences(lines);
console.log('行数', lines.length, '句子数', sentences.length);
console.log('=== 知识点抽取样例 ===');
for (const s of sentences.slice(0, 6)) {
  console.log('·', s.text);
  console.log('   →', JSON.stringify(extractKeyTerms(s.text)));
}

const result = generateQuestions(lines, { count: 40, seed: 7 });
console.log('=== 统计 ===');
console.log(summarizeGenerated(result));
console.log('warnings:', result.warnings);
console.log('byType:', result.byType);
console.log('=== 前 8 题 ===');
result.questions.slice(0, 8).forEach((q, i) => {
  console.log(`--- ${i + 1}. [${q.qtype}] ${q.stem}`);
  console.log(`    答案：${q.answer}`);
  if (Object.keys(q.options).length) console.log(`    选项：${JSON.stringify(q.options)}`);
  console.log(`    解析：${q.explanation.replace(/\n/g, ' / ')}`);
  console.log(`    出处：line=${q.line} page=${q.page} para=${q.para} topic=${q.topic} qid=${q.qid}`);
});
console.log('=== seed 可复现 ===');
const a = generateQuestions(lines, { seed: 7, count: 40 });
const b = generateQuestions(lines, { seed: 7, count: 40 });
const c = generateQuestions(lines, { seed: 8, count: 40 });
console.log('同 seed 相同:', JSON.stringify(a.questions) === JSON.stringify(b.questions));
console.log('异 seed 相同:', JSON.stringify(a.questions) === JSON.stringify(c.questions));
