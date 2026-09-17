import { generateQuestions, splitSentences, extractKeyTerms, textToLines, summarizeGenerated } from './web/js/generator.js';

const show = (label, v) => console.log(label, JSON.stringify(v, null, 0));

show('A1', extractKeyTerms('1851 年，中国爆发了太平天国运动。'));
show('A2', extractKeyTerms('鲁迅在《狂人日记》中描写了封建礼教的吃人本质。'));
show('A3', extractKeyTerms('五四运动标志着中国新民主主义革命的开端。'));
show('A4', extractKeyTerms('中国于 2001 年加入 WTO，关税水平下降到 9.8%。'));
show('A5', extractKeyTerms('孙中山领导的辛亥革命推翻了君主专制制度。'));
show('A6', extractKeyTerms('他每天坚持体育锻炼。'));
show('A7', extractKeyTerms('这个比例大约是 3:1，符合质量标准。'));

show('B1', splitSentences([{ page: 2, line: 5, para: 0, text: '第一章 绪论' }, { page: 2, line: 6, para: 0, text: '1. 五四运动是中国新民主主义革命的开端；它标志着新文化运动的高潮。' }]));
show('B2', splitSentences(['- 3 -', '第一章', '目录', 'abc', '光合作用是绿色植物利用光能合成有机物的过程。']));
show('B3', splitSentences('一段字符串'));

const doc = textToLines(`1911 年，辛亥革命推翻了清王朝的统治，结束了两千多年的君主专制制度。
1919 年，五四运动标志着中国新民主主义革命的开端。
1921 年，中国共产党成立，中国革命的面貌从此焕然一新。
1949 年，中华人民共和国成立，中国人民从此站起来了。
1978 年，十一届三中全会作出了改革开放的伟大决策。
光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。
人体的免疫系统能够识别并清除入侵的病原体。`);

const r = generateQuestions(doc, { seed: 1 });
console.log('C stats', summarizeGenerated(r), JSON.stringify(r.byType));
r.questions.forEach((q, i) => {
  console.log(`C${i + 1} [${q.qtype}] stem=${q.stem}`);
  console.log(`   ans=${q.answer} opts=${JSON.stringify(q.options)} qid=${q.qid} line=${q.line}`);
});

console.log('D judge-only');
const rj = generateQuestions(doc, { types: ['judge'], seed: 3, count: 10 });
rj.questions.forEach((q) => console.log(`   stem=${q.stem} ans=${q.answer} exp=${q.explanation.replace(/\n/g, ' / ')}`));

console.log('E fill-only maxPerSentence=2');
const rf = generateQuestions(doc, { types: ['fill'], seed: 5, maxPerSentence: 2, count: 4 });
rf.questions.forEach((q) => console.log(`   stem=${q.stem} ans=${q.options[q.answer]}`));

console.log('F 空输入', JSON.stringify(generateQuestions([], {})), JSON.stringify(generateQuestions(undefined, {})));
console.log('G 噪声', JSON.stringify(generateQuestions(textToLines(`1
目录
第一章 总论
关注公众号领取资料
答案：A
解析：本题考查基本概念
短句。`), {})));
show('H count 上限', generateQuestions(doc, { count: 2 }).questions.length);
show('I 类型过滤', generateQuestions(doc, { types: ['nope'] }).questions.length);
