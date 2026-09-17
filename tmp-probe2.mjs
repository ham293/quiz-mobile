import { generateQuestions, textToLines, extractKeyTerms, splitSentences } from './web/js/generator.js';

const KIND_DOC = textToLines(`辛亥革命推翻了清王朝的统治，具有深远的历史意义。
中国人应当记住五四运动的历史意义与时代价值。
太平天国运动沉重打击了清王朝统治，也改变了社会结构。
光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。`);
console.log('KIND pool:');
for (const s of KIND_DOC) console.log('  ', s.text, '→', extractKeyTerms(s.text).map((h) => `${h.kind}:${h.term}`).join(' | '));
const kr = generateQuestions(KIND_DOC, { types: ['choice'], seed: 1 });
kr.questions.forEach((q) => console.log('  choice:', q.stem, '|', JSON.stringify(q.options), '| ans', q.answer));

const LONELY = textToLines('光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。');
const lr = generateQuestions(LONELY, { types: ['choice'] });
console.log('LONELY choice count', lr.questions.length, 'warnings', JSON.stringify(lr.warnings));

const PCT = textToLines(`1840 年，英国发动了鸦片战争，中国开始沦为半殖民地半封建社会。
2019 年，我国的贫困发生率下降到 0.6%，取得显著成效。`);
const pr = generateQuestions(PCT, { types: ['judge'], seed: 3 });
pr.questions.forEach((q) => console.log('  pct judge:', q.stem, '|', q.answer, '|', q.explanation.replace(/\n/g, ' / ')));

const NEG = textToLines(`实践是检验真理的唯一标准，这是马克思主义的基本原则。
五四运动不是一场单纯的文化运动。`);
const nr = generateQuestions(NEG, { types: ['judge'], seed: 3 });
nr.questions.forEach((q) => console.log('  neg judge:', q.stem, '|', q.answer, '|', q.explanation.replace(/\n/g, ' / ')));

console.log('40% 规则:', generateQuestions(textToLines('中国特色社会主义的根本方向。'), { types: ['fill'] }).questions.length);
console.log('12字句:', JSON.stringify(generateQuestions(textToLines('辛亥革命是一次伟大革命。'), { types: ['fill'], seed: 1 }).questions.map((q) => [q.stem, q.options])));
console.log('抽词:', JSON.stringify(extractKeyTerms('辛亥革命是一次伟大革命。')));
console.log('重复页眉:', JSON.stringify(splitSentences([
  { page: 1, line: 1, para: 0, text: '内部资料 请勿外传' },
  { page: 2, line: 1, para: 0, text: '内部资料 请勿外传' },
  { page: 3, line: 1, para: 0, text: '内部资料 请勿外传' },
  { page: 3, line: 2, para: 0, text: '光合作用是绿色植物利用光能把二氧化碳和水合成有机物的过程。' },
])));
console.log('maxPerSentence 3:', generateQuestions(KIND_DOC, { seed: 2, maxPerSentence: 3, count: 20 }).questions.length);
const dedupe = generateQuestions(KIND_DOC, { seed: 2, maxPerSentence: 3, count: 20 });
console.log('qid 唯一:', new Set(dedupe.questions.map((q) => q.qid)).size === dedupe.questions.length);
console.log('warnings 超限:', JSON.stringify(generateQuestions(KIND_DOC, { count: 1 }).warnings));
