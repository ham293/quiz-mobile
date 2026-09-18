/**
 * tests/ai.test.mjs —— AI 识别模块（web/js/ai.js）单元测试。
 *
 * 覆盖：设置读写/打码、切块边界与重叠、提示词内容、模型返回的容错解析、
 * 以及通过注入的假 requestFn 跑通「多块识别 / 单块失败不影响其它块 / 重试 /
 * 401 / 429 / 超时 / 取消」等路径；另外用假 fetch 验证默认网络层的真实行为。
 *
 * 全程不发任何真实网络请求。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_PROVIDERS,
  AI_SETTINGS_KEY,
  AiError,
  DEFAULT_CHUNK_CHARS,
  aiErrorFromHttp,
  buildMessages,
  buildRequest,
  buildSystemPrompt,
  chunkLines,
  clearAiSettings,
  defaultRequest,
  extractJsonText,
  extractMessageContent,
  findProvider,
  isAiConfigured,
  loadAiSettings,
  maskKey,
  normalizeAiType,
  normalizeOptions,
  parseAiQuestions,
  recognizeQuestions,
  saveAiSettings,
  testAiConnection,
  usageOf,
} from '../web/js/ai.js';
// 命名空间导入：追加的 AI 讲解用例里用 ai.xxx 调用（与上面的具名导入是同一个模块）
import * as ai from '../web/js/ai.js';

/* ------------------------------------------------------------------ *
 * 测试用工具
 * ------------------------------------------------------------------ */

/** 一份可用的假设置（不落盘，直接传给各函数） */
function fakeSettings(patch = {}) {
  return {
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    apiKey: 'sk-test-1234',
    enabled: true,
    chunkChars: DEFAULT_CHUNK_CHARS,
    ...patch,
  };
}

/** 造 n 行假题目文本（每行长度固定，便于推算切块结果） */
function makeLines(count, lineLength = 30) {
  return Array.from({ length: count }, (_, i) => {
    const head = `${i + 1}. 第${i + 1}题 `;
    const body = '测'.repeat(Math.max(1, lineLength - head.length));
    return { page: 1, line: i + 1, para: 0, text: head + body };
  });
}

/** 组装一个 OpenAI 风格的假响应 */
function chatResponse(content, usage = { prompt_tokens: 0, completion_tokens: 0 }) {
  return { choices: [{ message: { content } }], usage };
}

/** 用假的 fetch 执行一次，结束后恢复全局 fetch */
async function withFakeFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------------------ *
 * 预设与设置
 * ------------------------------------------------------------------ */

test('AI_PROVIDERS：内置 6 个预设，字段齐全且申请地址是 https', () => {
  assert.equal(AI_PROVIDERS.length, 6);
  const ids = AI_PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids, ['zhipu', 'moonshot', 'doubao', 'deepseek', 'siliconflow', 'custom']);
  for (const p of AI_PROVIDERS) {
    assert.ok(p.name, `${p.id} 缺少 name`);
    assert.ok(typeof p.baseUrl === 'string');
    assert.ok(typeof p.model === 'string');
    if (p.id !== 'custom') {
      assert.match(p.baseUrl, /^https:\/\//);
      assert.match(p.keyUrl, /^https:\/\//);
    }
  }
  assert.equal(findProvider('zhipu').free, true);
  assert.equal(findProvider('deepseek').model, 'deepseek-chat');
  assert.equal(findProvider('siliconflow').free, true);
  assert.equal(findProvider('not-exist'), null);
});

test('loadAiSettings：默认值直接给出第一个免费服务商的地址与模型，但没有 Key', () => {
  clearAiSettings();
  const s = loadAiSettings();
  assert.equal(s.provider, 'zhipu');
  assert.equal(s.baseUrl, AI_PROVIDERS[0].baseUrl);
  assert.equal(s.model, AI_PROVIDERS[0].model);
  assert.equal(s.apiKey, '');
  assert.equal(s.enabled, true);
  assert.equal(s.chunkChars, DEFAULT_CHUNK_CHARS);
  assert.equal(isAiConfigured(s), false);
});

test('saveAiSettings / loadAiSettings：合并保存并能读回，换服务商自动带出预设', () => {
  clearAiSettings();
  const saved = saveAiSettings({ apiKey: 'sk-abcdefghijklmn', chunkChars: 3000 });
  assert.equal(saved.apiKey, 'sk-abcdefghijklmn');
  assert.equal(saved.chunkChars, 3000);

  const back = loadAiSettings();
  assert.equal(back.apiKey, 'sk-abcdefghijklmn');
  assert.equal(back.chunkChars, 3000);

  // 换服务商：不传 baseUrl/model 时自动带出该预设的默认值
  const switched = saveAiSettings({ provider: 'deepseek' });
  assert.equal(switched.provider, 'deepseek');
  assert.equal(switched.baseUrl, 'https://api.deepseek.com');
  assert.equal(switched.model, 'deepseek-chat');
  assert.equal(switched.apiKey, 'sk-abcdefghijklmn'); // Key 不会被换服务商清掉

  // 传了 baseUrl/model 就按传的来（自定义服务商）
  const custom = saveAiSettings({ provider: 'custom', baseUrl: ' https://example.com/v1 ', model: 'my-model' });
  assert.equal(custom.baseUrl, 'https://example.com/v1');
  assert.equal(custom.model, 'my-model');

  // chunkChars 越界会被收敛回合法范围（下限 500：免费模型排队时小块更稳）
  assert.equal(saveAiSettings({ chunkChars: 5 }).chunkChars, 500);
  assert.equal(saveAiSettings({ chunkChars: 999999 }).chunkChars, 20000);
  assert.equal(saveAiSettings({ chunkChars: 'abc' }).chunkChars, DEFAULT_CHUNK_CHARS);

  assert.equal(isAiConfigured(), true);
  assert.equal(loadAiSettings().provider, 'custom');
});

test('clearAiSettings：清掉 Key 与自定义地址，回到默认', () => {
  saveAiSettings({ provider: 'custom', baseUrl: 'https://example.com/v1', model: 'x', apiKey: 'sk-1' });
  const after = clearAiSettings();
  assert.equal(after.apiKey, '');
  assert.equal(after.provider, 'zhipu');
  assert.equal(loadAiSettings().apiKey, '');
  assert.equal(isAiConfigured(), false);
  assert.equal(typeof AI_SETTINGS_KEY, 'string');
});

test('isAiConfigured：三个字段缺一不可', () => {
  assert.equal(isAiConfigured(fakeSettings()), true);
  assert.equal(isAiConfigured(fakeSettings({ apiKey: '' })), false);
  assert.equal(isAiConfigured(fakeSettings({ apiKey: '   ' })), false);
  assert.equal(isAiConfigured(fakeSettings({ baseUrl: '' })), false);
  assert.equal(isAiConfigured(fakeSettings({ model: '' })), false);
  assert.equal(isAiConfigured(null), false);
});

test('maskKey：前后各留 4 位，中间打码；短 Key 整体打码', () => {
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-1********cdef');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('   '), '');
  assert.equal(maskKey('12345678'), '********');
  assert.equal(maskKey('123456789'), '1234********6789');
  assert.ok(!maskKey('sk-1234567890abcdef').includes('567890ab'));
});

/* ------------------------------------------------------------------ *
 * 切块 chunkLines
 * ------------------------------------------------------------------ */

test('chunkLines：空输入、单块、字符串行数组都支持', () => {
  assert.deepEqual(chunkLines([]), []);
  assert.deepEqual(chunkLines(null), []);

  const one = chunkLines(['第一行', '第二行']);
  assert.equal(one.length, 1);
  assert.deepEqual([one[0].from, one[0].to], [0, 1]);
  assert.equal(one[0].text, '第一行\n第二行');

  const obj = chunkLines([{ text: '甲' }, { text: '乙' }], { maxChars: 200 });
  assert.equal(obj[0].text, '甲\n乙');
});

test('chunkLines：按字符数切块，每块的 text 与 from/to 完全对应', () => {
  const lines = makeLines(12);
  assert.equal(lines[0].text.length, 30); // 每行长度一致，便于推算
  const chunks = chunkLines(lines, { maxChars: 200, overlapLines: 2 });

  assert.ok(chunks.length > 1, '应当切成多块');
  for (const c of chunks) {
    assert.ok(c.from <= c.to, 'from 必须不大于 to');
    assert.equal(c.text, lines.slice(c.from, c.to + 1).map((l) => l.text).join('\n'));
    // 除单行超长的情况外，块内字符数不应超过预算
    assert.ok(c.text.length <= 200 || c.to === c.from);
  }
  assert.equal(chunks[0].from, 0);
  assert.equal(chunks[chunks.length - 1].to, lines.length - 1);
  assert.deepEqual([chunks[0].from, chunks[0].to], [0, 4]);
  assert.equal(chunks.length, 3); // 最后一块直接吃掉剩余内容，不再为对齐边界多切一刀
  assert.deepEqual([chunks[2].from, chunks[2].to], [6, 11]);
});

test('chunkLines：相邻块保留 overlapLines 行重叠，且下标严格前进（不会死循环）', () => {
  const lines = makeLines(30);
  const chunks = chunkLines(lines, { maxChars: 200, overlapLines: 2 });
  assert.ok(chunks.length > 2);
  for (let i = 1; i < chunks.length; i += 1) {
    assert.ok(chunks[i].from >= chunks[i - 1].from, '起始下标必须前进');
    assert.ok(chunks[i].from <= chunks[i - 1].to, '相邻块应当重叠');
    assert.ok(chunks[i - 1].to - chunks[i].from + 1 <= 2, '重叠不超过 overlapLines 行');
  }

  const noOverlap = chunkLines(lines, { maxChars: 200, overlapLines: 0 });
  for (let i = 1; i < noOverlap.length; i += 1) {
    assert.equal(noOverlap[i].from, noOverlap[i - 1].to + 1);
  }
});

test('chunkLines：超长单行不会被截断，独占一块', () => {
  const long = 'x'.repeat(1000);
  const chunks = chunkLines([{ text: '1. 短题' }, { text: long }, { text: '2. 短题二' }], { maxChars: 200 });
  const hit = chunks.find((c) => c.text.includes(long));
  assert.ok(hit, '超长行必须被完整保留');
  assert.equal(hit.from, 1);
  assert.equal(hit.to, 1);
  assert.equal(chunks[chunks.length - 1].to, 2);
});

test('chunkLines：优先在题目边界切开（选项行不是边界）', () => {
  // 全是题号开头的行：没有到 60% 预算就不会被切碎
  const lines = makeLines(8, 12);
  const chunks = chunkLines(lines, { maxChars: 500, overlapLines: 1 });
  assert.equal(chunks.length, 1, '预算还很小的时候不该提前切');

  // 每题 1 行题干 + 2 行选项：选项行（A. / B.）不是题目边界
  const blocks = [];
  for (let i = 0; i < 30; i += 1) {
    blocks.push({ text: `${i + 1}. 第${i + 1}题的题干内容，长度凑到三十个字符左右看看` });
    blocks.push({ text: `A. 选项甲${i}，长度也凑到三十个字符左右` });
    blocks.push({ text: `B. 选项乙${i}，长度也凑到三十个字符左右` });
  }
  const many = chunkLines(blocks, { maxChars: 300, overlapLines: 0 });
  assert.ok(many.length > 3);
  for (let i = 1; i < many.length; i += 1) {
    assert.match(blocks[many[i].from].text, /^\d+\. /, '每块都应当从题号行开始');
    assert.equal(many[i].from, many[i - 1].to + 1);
  }
  assert.equal(many[0].from, 0);
  assert.equal(many[many.length - 1].to, blocks.length - 1);
  // 每一块的开头都不带别的题的半截内容
  for (const c of many) {
    assert.ok(c.text.length <= 300);
  }
});

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

test('buildSystemPrompt：包含严格 JSON 结构与关键约束', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /严格 JSON/);
  assert.match(prompt, /"questions"/);
  assert.match(prompt, /"stem"/);
  assert.match(prompt, /"qtype"/);
  assert.match(prompt, /"options"/);
  assert.match(prompt, /单选/);
  assert.match(prompt, /多选/);
  assert.match(prompt, /判断/);
  assert.match(prompt, /分值标注/);
  assert.match(prompt, /页眉页脚/);
  assert.match(prompt, /不要编造/);
  assert.match(prompt, /没有给出答案的就留空/);
  assert.match(prompt, /只输出 JSON/);
});

test('buildMessages：两条消息，system 是提示词，user 带上片段原文', () => {
  const chunk = '1. 下列哪项正确？\nA. 甲\nB. 乙';
  const messages = buildMessages(chunk);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, buildSystemPrompt());
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /以下是某份题库文件的文本片段，请识别其中的题目/);
  assert.ok(messages[1].content.includes(chunk));
  assert.match(messages[1].content, /文本片段开始/);
  assert.doesNotMatch(messages[1].content, /补充要求/);

  const withHint = buildMessages(chunk, { typeHint: '全部按单选题处理' });
  assert.match(withHint[1].content, /补充要求：全部按单选题处理/);
});

/* ------------------------------------------------------------------ *
 * 返回解析 parseAiQuestions
 * ------------------------------------------------------------------ */

test('parseAiQuestions：标准结构、qid 规范化与字段补全', () => {
  const raw = JSON.stringify({
    questions: [
      { stem: '中国的首都是（　）', qtype: '单选', options: { A: '上海', B: '北京' }, answer: 'b', explanation: '常识题' },
    ],
  });
  const { questions, errors } = parseAiQuestions(raw);
  assert.equal(errors.length, 0);
  assert.equal(questions.length, 1);
  const q = questions[0];
  assert.equal(q.stem, '中国的首都是（　）');
  assert.equal(q.qtype, '单选');
  assert.deepEqual(q.options, { A: '上海', B: '北京' });
  assert.equal(q.answer, 'B');
  assert.equal(q.explanation, '常识题');
  assert.equal(q.source, 'auto');
  assert.match(q.qid, /^[0-9a-f]{16}$/);
});

test('parseAiQuestions：容忍 ```json 围栏与前后废话', () => {
  const body = JSON.stringify({ questions: [{ stem: '围栏题', qtype: '判断', answer: '正确' }] });
  const raw = `好的，以下是识别结果：\n\`\`\`json\n${body}\n\`\`\`\n希望有帮助！`;
  const { questions, errors } = parseAiQuestions(raw);
  assert.equal(errors.length, 0);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].stem, '围栏题');
  assert.equal(extractJsonText(raw), body);
  assert.equal(extractJsonText('前后都是废话 {"a":1} 尾巴'), '{"a":1}');
});

test('parseAiQuestions：顶层数组、data.questions、对象映射、单题对象都能吃下', () => {
  const asArray = parseAiQuestions(JSON.stringify([{ stem: '顶层数组题', qtype: '简答', answer: '略' }]));
  assert.equal(asArray.errors.length, 0);
  assert.equal(asArray.questions[0].qtype, '简答');

  const nested = parseAiQuestions(JSON.stringify({ data: { questions: [{ stem: '嵌套题', qtype: '判断', answer: '错误' }] } }));
  assert.equal(nested.questions.length, 1);
  assert.equal(nested.questions[0].answer, '错误');

  const mapped = parseAiQuestions(JSON.stringify({
    questions: {
      1: { stem: '映射题一', qtype: '判断', answer: '正确' },
      2: { stem: '映射题二', qtype: '判断', answer: '错误' },
    },
  }));
  assert.equal(mapped.questions.length, 2);

  const single = parseAiQuestions(JSON.stringify({ stem: '单题对象', qtype: '判断', answer: '错误' }));
  assert.equal(single.questions.length, 1);
  assert.equal(single.questions[0].stem, '单题对象');
});

test('parseAiQuestions：非法 JSON / 空内容 / 没有题目数组 → 记 errors 不抛异常', () => {
  const bad = parseAiQuestions('抱歉，我无法完成这个请求。');
  assert.equal(bad.questions.length, 0);
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /不是合法 JSON/);
  assert.match(bad.errors[0], /抱歉/);

  const empty = parseAiQuestions('   ');
  assert.deepEqual(empty.questions, []);
  assert.deepEqual(empty.errors, ['模型返回内容为空']);

  const noList = parseAiQuestions('{"result":"ok"}');
  assert.equal(noList.questions.length, 0);
  assert.match(noList.errors[0], /没有找到题目数组/);
});

test('parseAiQuestions：单题字段缺失只跳过该条，不整体失败', () => {
  const raw = JSON.stringify({
    questions: [
      { stem: '   ' },
      { options: { A: '甲' } },
      null,
      '不是对象',
      { stem: '正常题目', qtype: '判断', answer: '正确' },
    ],
  });
  const { questions, errors } = parseAiQuestions(raw);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].stem, '正常题目');
  assert.equal(errors.length, 4);
  assert.match(errors[0], /第 1 条缺少题干/);
  assert.match(errors[1], /第 2 条缺少题干/);
  assert.match(errors[2], /第 3 条不是题目对象/);
  assert.match(errors[3], /第 4 条不是题目对象/);
});

test('parseAiQuestions：选项小写键、数组、字符串、乱序键都归一成 A~H', () => {
  const lower = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '小写选项', options: { a: '甲', b: '乙' }, answer: 'a' }],
  }));
  assert.deepEqual(lower.questions[0].options, { A: '甲', B: '乙' });
  assert.equal(lower.questions[0].answer, 'A');

  const array = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '数组选项', options: ['甲', '乙', '丙'], answer: 'B' }],
  }));
  assert.deepEqual(array.questions[0].options, { A: '甲', B: '乙', C: '丙' });

  const text = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '字符串选项', options: 'A. 甲 B. 乙 C. 丙', answer: 'C' }],
  }));
  assert.deepEqual(text.questions[0].options, { A: '甲', B: '乙', C: '丙' });

  const chineseKey = normalizeOptions({ 选项A: '甲', 选项B: '乙' });
  assert.deepEqual(chineseKey, { A: '甲', B: '乙' });
  assert.deepEqual(normalizeOptions({ '1': '甲', '2': '乙' }), { A: '甲', B: '乙' });
  assert.deepEqual(normalizeOptions({ A: '带前缀', B: 'B. 去前缀' }), { A: '带前缀', B: '去前缀' });
  assert.deepEqual(normalizeOptions({}), {});
  assert.deepEqual(normalizeOptions(null), {});
});

test('parseAiQuestions：答案前缀清理、字母排序、判断题归一', () => {
  const multi = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '多选题目', qtype: '多选', options: { A: '甲', B: '乙', C: '丙' }, answer: '答案：b,a' }],
  }));
  assert.equal(multi.questions[0].qtype, '多选');
  assert.equal(multi.questions[0].answer, 'AB');

  const single = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '单选题目', options: { A: '甲', B: '乙' }, answer: '正确答案是 B' }],
  }));
  assert.equal(single.questions[0].answer, 'B');

  const judgeYes = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '地球是圆的', qtype: '判断', answer: '√' }],
  }));
  assert.equal(judgeYes.questions[0].qtype, '判断');
  assert.equal(judgeYes.questions[0].answer, '正确');

  const judgeChinese = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '太阳从西边升起', qtype: '判断题', answer: '错的' }],
  }));
  assert.equal(judgeChinese.questions[0].answer, '错误');

  // 判断题给了 A/B 选项、答案给字母：按选项文本映射
  const judgeByLetter = parseAiQuestions(JSON.stringify({
    questions: [{ stem: '1+1=2', qtype: '判断', options: { A: '正确', B: '错误' }, answer: 'A' }],
  }));
  assert.equal(judgeByLetter.questions[0].answer, '正确');
});

test('parseAiQuestions：题型中英文别名与缺失时按结构推断', () => {
  assert.equal(normalizeAiType('单项选择', {}, 'A'), '单选');
  assert.equal(normalizeAiType('多项选择题', {}, 'AB'), '多选');
  assert.equal(normalizeAiType('true_false', {}, '正确'), '判断');
  assert.equal(normalizeAiType('short answer', {}, ''), '简答');
  assert.equal(normalizeAiType('论述题', {}, ''), '论述');
  assert.equal(normalizeAiType('', { A: '甲', B: '乙' }, 'A'), '单选');
  assert.equal(normalizeAiType('', { A: '甲', B: '乙' }, 'AB'), '多选');
  assert.equal(normalizeAiType('', {}, '正确'), '判断');
  assert.equal(normalizeAiType('', {}, '一段参考答案'), '简答');

  const inferred = parseAiQuestions(JSON.stringify({
    questions: [
      { stem: '没写题型的单选', options: { A: '甲', B: '乙' }, answer: 'B' },
      { stem: '没写题型的判断', answer: '错误' },
      { stem: '写成单选但其实没选项', qtype: '单选', answer: '正确' },
    ],
  }));
  assert.equal(inferred.questions[0].qtype, '单选');
  assert.equal(inferred.questions[1].qtype, '判断');
  assert.equal(inferred.questions[2].qtype, '判断');
  assert.equal(inferred.questions[2].answer, '正确');
});

test('parseAiQuestions：全角标点与尾逗号也能解析', () => {
  const fullWidth = parseAiQuestions('{"questions"：［{"stem"："全角标点测试"，"qtype"："判断"，"answer"："对的"}］}');
  assert.equal(fullWidth.errors.length, 0);
  assert.equal(fullWidth.questions.length, 1);
  assert.equal(fullWidth.questions[0].answer, '正确');

  const trailing = parseAiQuestions('{"questions":[{"stem":"尾逗号题","qtype":"简答","answer":"略",},]}');
  assert.equal(trailing.errors.length, 0);
  assert.equal(trailing.questions[0].stem, '尾逗号题');
});

test('parseAiQuestions：同批内按 qid 去重', () => {
  const raw = JSON.stringify({
    questions: [
      { stem: '重复题干（　）', qtype: '判断', answer: '正确' },
      { stem: '重复 题干。', qtype: '判断', answer: '错误' },
      { stem: '另一道题', qtype: '判断', answer: '正确' },
    ],
  });
  const { questions, errors } = parseAiQuestions(raw);
  assert.equal(questions.length, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /重复/);
});

/* ------------------------------------------------------------------ *
 * 请求组装与默认网络层
 * ------------------------------------------------------------------ */

test('buildRequest：URL、请求头、请求体符合 OpenAI 兼容规范', () => {
  const payload = buildRequest({ settings: fakeSettings(), messages: buildMessages('题目文本') });
  assert.equal(payload.url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(payload.headers.Authorization, 'Bearer sk-test-1234');
  assert.equal(payload.headers['Content-Type'], 'application/json');
  assert.equal(payload.body.model, 'test-model');
  assert.equal(payload.body.temperature, 0.1);
  assert.deepEqual(payload.body.response_format, { type: 'json_object' });
  assert.equal(payload.body.messages.length, 2);
  assert.equal(payload.model, 'test-model');

  // 已经是 /chat/completions 结尾的不再重复拼接
  const full = buildRequest({ settings: fakeSettings({ baseUrl: 'https://a.com/v1/chat/completions/' }), messages: [] });
  assert.equal(full.url, 'https://a.com/v1/chat/completions');

  assert.throws(() => buildRequest({ settings: fakeSettings({ baseUrl: '' }), messages: [] }), /接口地址/);
  assert.throws(() => buildRequest({ settings: fakeSettings({ model: '' }), messages: [] }), /模型名/);
});

test('extractMessageContent：兼容标准结构、CapacitorHttp 包装与多模态分段', () => {
  assert.equal(extractMessageContent(chatResponse('你好')), '你好');
  assert.equal(extractMessageContent({ status: 200, data: chatResponse('包装内容') }), '包装内容');
  assert.equal(extractMessageContent({ status: 200, data: JSON.stringify(chatResponse('字符串包裹')) }), '字符串包裹');
  assert.equal(extractMessageContent({ choices: [{ text: '纯文本字段' }] }), '纯文本字段');
  assert.equal(extractMessageContent({ choices: [{ message: { content: [{ text: '分' }, { text: '段' }] } }] }), '分段');
  assert.equal(extractMessageContent('直接是字符串'), '直接是字符串');
  assert.equal(extractMessageContent(null), '');
  assert.equal(extractMessageContent({ choices: [] }), '');
});

test('usageOf：读出 token 用量，缺失时返回 0', () => {
  assert.deepEqual(usageOf(chatResponse('x', { prompt_tokens: 12, completion_tokens: 34 })), { prompt: 12, completion: 34 });
  assert.deepEqual(usageOf({ status: 200, data: { usage: { prompt_tokens: 5 } } }), { prompt: 5, completion: 0 });
  assert.deepEqual(usageOf(null), { prompt: 0, completion: 0 });
  assert.deepEqual(usageOf({ choices: [] }), { prompt: 0, completion: 0 });
});

test('错误映射：401/403 → Key 无效，429 → 限流，408/504 → 超时，5xx → 服务端错误', () => {
  const auth = aiErrorFromHttp(401, { error: { message: 'invalid api key' } });
  assert.ok(auth instanceof AiError);
  assert.equal(auth.code, 'auth');
  assert.match(auth.message, /API Key 无效或没有权限/);
  assert.match(auth.message, /invalid api key/);
  assert.equal(aiErrorFromHttp(403, '').code, 'auth');
  assert.match(aiErrorFromHttp(403, '').message, /API Key 无效或没有权限/);

  const rate = aiErrorFromHttp(429, 'rate limit exceeded');
  assert.equal(rate.code, 'rate');
  assert.match(rate.message, /请求太频繁\/额度用尽/);

  const timeout = aiErrorFromHttp(504, '');
  assert.equal(timeout.code, 'timeout');
  assert.match(timeout.message, /请求超时/);
  assert.match(timeout.message, /更小的分块/);

  assert.equal(aiErrorFromHttp(500, 'boom').code, 'server');
  assert.match(aiErrorFromHttp(400, 'bad param').message, /HTTP 400/);
  assert.equal(aiErrorFromHttp(400, 'bad').code, 'bad_request');
});

test('defaultRequest（浏览器路径）：正常返回、非 JSON、401、超时、response_format 重试', async () => {
  // 1) 正常返回
  let captured = null;
  await withFakeFetch(async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify(chatResponse('{"questions":[]}', { prompt_tokens: 7, completion_tokens: 2 })) };
  }, async () => {
    const payload = buildRequest({ settings: fakeSettings(), messages: buildMessages('文本') });
    const body = await defaultRequest(payload);
    assert.equal(extractMessageContent(body), '{"questions":[]}');
    assert.equal(usageOf(body).prompt, 7);
  });
  assert.equal(captured.url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test-1234');
  assert.match(captured.init.body, /"response_format":\{"type":"json_object"\}/);

  // 2) 返回体不是 JSON → 提示原文前 200 字
  await withFakeFetch(async () => ({ ok: true, status: 200, text: async () => '<html>502 Bad Gateway</html>' }), async () => {
    await assert.rejects(
      () => defaultRequest(buildRequest({ settings: fakeSettings(), messages: [] })),
      (err) => {
        assert.equal(err.code, 'bad_response');
        assert.match(err.message, /不是 JSON/);
        assert.match(err.message, /html/);
        return true;
      },
    );
  });

  // 3) 401 → Key 无效
  await withFakeFetch(async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"unauthorized"}}' }), async () => {
    await assert.rejects(
      () => defaultRequest(buildRequest({ settings: fakeSettings(), messages: [] })),
      (err) => {
        assert.equal(err.code, 'auth');
        assert.match(err.message, /API Key 无效或没有权限/);
        return true;
      },
    );
  });

  // 4) 超时（timeoutMs 40 毫秒）
  await withFakeFetch(() => new Promise(() => {}), async () => {
    await assert.rejects(
      () => defaultRequest(buildRequest({ settings: fakeSettings(), messages: [], timeoutMs: 40 })),
      (err) => {
        assert.equal(err.code, 'timeout');
        assert.match(err.message, /请求超时/);
        assert.match(err.message, /检查网络/);
        return true;
      },
    );
  });

  // 5) 服务商不支持 response_format：第一次 400，去掉该参数后成功
  const bodies = [];
  await withFakeFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) {
      return { ok: false, status: 400, text: async () => '{"error":{"message":"response_format is not supported"}}' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(chatResponse('{"questions":[]}')) };
  }, async () => {
    const body = await defaultRequest(buildRequest({ settings: fakeSettings(), messages: [] }));
    assert.equal(extractMessageContent(body), '{"questions":[]}');
  });
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(bodies[1].model, 'test-model');
});

/* ------------------------------------------------------------------ *
 * 识别主流程（注入假 requestFn）
 * ------------------------------------------------------------------ */

test('recognizeQuestions：多块串行识别 + 跨块去重 + 进度与用量统计', async () => {
  const calls = [];
  const requestFn = async (payload) => {
    calls.push(payload);
    const user = payload.messages[1].content;
    const firstLine = (user.split('\n').find((l) => /^\d+\. /.test(l)) || '无题干').trim();
    return chatResponse(
      '```json\n' + JSON.stringify({
        questions: [
          { stem: `${firstLine}｜第 ${calls.length} 块`, qtype: '单选', options: { a: '甲', b: '乙', c: '丙' }, answer: 'b', explanation: '解析' },
          { stem: '固定重复题：中国的首都是北京', qtype: '判断', answer: '正确' },
        ],
      }) + '\n```',
      { prompt_tokens: 100, completion_tokens: 20 },
    );
  };

  const stages = [];
  const result = await recognizeQuestions(makeLines(40), {
    settings: fakeSettings(),
    requestFn,
    retries: 0,
    chunkChars: 300,
    onProgress: (info) => stages.push(info.stage),
  });

  assert.ok(result.chunks.total > 1, '应当切成多块');
  assert.equal(result.chunks.done, result.chunks.total);
  assert.equal(result.chunks.failed, 0);
  assert.equal(calls.length, result.chunks.total);
  // 每块 1 道独有题 + 1 道跨块重复题（重复题只留 1 道）
  assert.equal(result.questions.length, result.chunks.total + 1);
  assert.equal(result.questions.filter((q) => q.stem.includes('固定重复题')).length, 1);
  assert.equal(result.usage.prompt, 100 * result.chunks.total);
  assert.equal(result.usage.completion, 20 * result.chunks.total);
  assert.equal(result.errors.length, 0);

  // 每道题都被规范化过
  for (const q of result.questions) {
    assert.match(q.qid, /^[0-9a-f]{16}$/);
    assert.ok(['单选', '多选', '判断', '简答', '论述'].includes(q.qtype));
    assert.ok(q.stem.length > 0);
  }
  // 小写选项键在流水线里也归一了
  const first = result.questions.find((q) => q.stem.includes('第 1 块'));
  assert.deepEqual(Object.keys(first.options), ['A', 'B', 'C']);
  assert.equal(first.answer, 'B');

  // 进度：每块一次 start + 一次 ok，最后 done
  assert.equal(stages.filter((s) => s === 'start').length, result.chunks.total);
  assert.equal(stages.filter((s) => s === 'ok').length, result.chunks.total);
  assert.equal(stages.filter((s) => s === 'done').length, 1);

  // 请求体里带着 system/user 两条消息
  assert.equal(calls[0].body.messages.length, 2);
  assert.match(calls[0].body.messages[0].content, /严格 JSON/);
  assert.match(calls[0].body.messages[1].content, /以下是某份题库文件的文本片段/);
});

test('recognizeQuestions：单块失败不影响其它块，错误里写清是第几块', async () => {
  let n = 0;
  const requestFn = async () => {
    n += 1;
    if (n === 2) throw new Error('模拟网络中断');
    return chatResponse(JSON.stringify({ questions: [{ stem: `成功题 ${n}`, qtype: '判断', answer: '正确' }] }));
  };
  const result = await recognizeQuestions(makeLines(40), {
    settings: fakeSettings(),
    requestFn,
    retries: 0,
    chunkChars: 300,
  });
  assert.ok(result.chunks.total >= 3);
  assert.equal(result.chunks.done, result.chunks.total - 1);
  assert.equal(result.chunks.failed, 1);
  assert.equal(result.questions.length, result.chunks.total - 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], new RegExp(`第 2/${result.chunks.total} 块识别失败`));
  assert.match(result.errors[0], /模拟网络中断/);
  assert.ok(result.questions.every((q) => q.qid));
});

test('recognizeQuestions：失败后按 retries 重试，重试成功照常收下题目', async () => {
  let n = 0;
  const requestFn = async () => {
    n += 1;
    if (n === 1) throw new Error('第一次抽风');
    return chatResponse(JSON.stringify({ questions: [{ stem: '重试后成功', qtype: '判断', answer: '正确' }] }));
  };
  const stages = [];
  const result = await recognizeQuestions(makeLines(4), {
    settings: fakeSettings(),
    requestFn,
    retries: 2,
    retryDelayMs: 0,
    onProgress: (info) => stages.push(info.stage),
  });
  assert.equal(n, 2);
  assert.equal(result.chunks.total, 1);
  assert.equal(result.chunks.done, 1);
  assert.equal(result.chunks.failed, 0);
  assert.equal(result.questions.length, 1);
  assert.ok(stages.includes('retry'));
});

test('recognizeQuestions：401 不重试、直接停下并给出可读中文提示', async () => {
  let calls = 0;
  const requestFn = async () => {
    calls += 1;
    throw aiErrorFromHttp(401, { error: { message: 'invalid api key' } });
  };
  const result = await recognizeQuestions(makeLines(40), {
    settings: fakeSettings(),
    requestFn,
    retries: 2,
    retryDelayMs: 0,
    chunkChars: 300,
  });
  assert.equal(calls, 1, '权限错误不应当重试，也不应当继续后面的块');
  assert.equal(result.questions.length, 0);
  assert.equal(result.chunks.done, 0);
  assert.equal(result.chunks.failed, result.chunks.total);
  assert.match(result.errors[0], /API Key 无效或没有权限/);
  assert.ok(result.errors.some((e) => /已停止后续/.test(e)));
});

test('recognizeQuestions：429 会重试到用尽次数，最终报「请求太频繁/额度用尽」', async () => {
  let calls = 0;
  const requestFn = async () => {
    calls += 1;
    throw aiErrorFromHttp(429, 'rate limit');
  };
  const result = await recognizeQuestions(makeLines(4), {
    settings: fakeSettings(),
    requestFn,
    retries: 1,
    retryDelayMs: 0,
  });
  assert.equal(calls, 2);
  assert.equal(result.chunks.failed, 1);
  assert.match(result.errors[0], /请求太频繁\/额度用尽/);
});

test('recognizeQuestions：模型返回空内容或坏 JSON 会被当成失败并重试', async () => {
  let n = 0;
  const requestFn = async () => {
    n += 1;
    return chatResponse(n === 1 ? '' : '这不是 JSON');
  };
  const result = await recognizeQuestions(makeLines(4), {
    settings: fakeSettings(),
    requestFn,
    retries: 1,
    retryDelayMs: 0,
  });
  assert.equal(n, 2);
  assert.equal(result.chunks.failed, 1);
  assert.match(result.errors[0], /不是合法 JSON/);
});

test('recognizeQuestions：未配置 Key 时直接给出中文指引，不发请求', async () => {
  let calls = 0;
  const result = await recognizeQuestions(makeLines(4), {
    settings: fakeSettings({ apiKey: '' }),
    requestFn: async () => {
      calls += 1;
      return chatResponse('{}');
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.questions.length, 0);
  assert.equal(result.chunks.done, 0);
  assert.match(result.errors[0], /还没有配置 AI/);
});

test('recognizeQuestions：空行输入、取消信号、可选 typeHint', async () => {
  const empty = await recognizeQuestions([], { settings: fakeSettings(), requestFn: async () => chatResponse('{}') });
  assert.equal(empty.chunks.total, 0);
  assert.deepEqual(empty.questions, []);

  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const aborted = await recognizeQuestions(makeLines(10), {
    settings: fakeSettings(),
    signal: controller.signal,
    requestFn: async () => {
      calls += 1;
      return chatResponse('{}');
    },
  });
  assert.equal(calls, 0);
  assert.match(aborted.errors[0], /已取消/);

  const payloads = [];
  await recognizeQuestions(makeLines(4), {
    settings: fakeSettings(),
    typeHint: '只要是单选题就标成单选',
    requestFn: async (payload) => {
      payloads.push(payload);
      return chatResponse('{"questions":[]}');
    },
  });
  assert.match(payloads[0].body.messages[1].content, /只要是单选题就标成单选/);
});

/* ------------------------------------------------------------------ *
 * 测试连接
 * ------------------------------------------------------------------ */

test('testAiConnection：成功与各类失败都返回结果对象而不抛异常', async () => {
  const ok = await testAiConnection(fakeSettings(), {
    requestFn: async (payload) => {
      assert.equal(payload.body.max_tokens, 32);
      assert.equal(payload.body.temperature, 0);
      return chatResponse('{"ok":true}');
    },
  });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /连接成功/);
  assert.equal(ok.model, 'test-model');
  assert.ok(ok.elapsedMs >= 0);

  const noKey = await testAiConnection(fakeSettings({ apiKey: '' }), { requestFn: async () => chatResponse('{}') });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, 'nokey');
  assert.match(noKey.message, /API Key/);

  const noModel = await testAiConnection(fakeSettings({ model: '' }), { requestFn: async () => chatResponse('{}') });
  assert.equal(noModel.ok, false);
  assert.match(noModel.message, /模型名/);

  const authFail = await testAiConnection(fakeSettings(), {
    requestFn: async () => {
      throw aiErrorFromHttp(401, 'bad key');
    },
  });
  assert.equal(authFail.ok, false);
  assert.equal(authFail.code, 'auth');
  assert.match(authFail.message, /API Key 无效或没有权限/);
});

/* ------------------------------------------------------------------ *
 * AI 讲解（explainQuestion）
 * ------------------------------------------------------------------ */

test('explainQuestion：已有解析时不发请求，直接返回', async () => {
  let called = 0;
  const r = await ai.explainQuestion(
    { stem: '题干', explanation: '  已有解析  ' },
    { requestFn: async () => { called += 1; return {}; } },
  );
  assert.equal(r.ok, true);
  assert.equal(r.cached, true);
  assert.equal(r.explanation, '已有解析');
  assert.equal(called, 0, '已有解析不应发请求');
});

test('explainQuestion：没配 Key / 缺题干时给出中文原因且不发请求', async () => {
  let called = 0;
  const noKey = await ai.explainQuestion(
    { stem: '题干' },
    { settings: { apiKey: '', baseUrl: 'https://x/v1', model: 'm' }, requestFn: async () => { called += 1; } },
  );
  assert.equal(noKey.ok, false);
  assert.match(noKey.message, /API Key/);

  const noStem = await ai.explainQuestion(
    { stem: '   ' },
    { settings: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' }, requestFn: async () => { called += 1; } },
  );
  assert.equal(noStem.ok, false);
  assert.match(noStem.message, /题干/);
  assert.equal(called, 0);
});

test('explainQuestion：解析 JSON 回复并去掉“解析：”前缀', async () => {
  const r = await ai.explainQuestion(
    { stem: '近代中国半殖民地半封建社会的起点是', qtype: '单选', options: { A: '1840年' }, answer: 'A' },
    {
      settings: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      requestFn: async (payload) => {
        // 请求体里必须带上题干与答案，模型才知道讲哪道题
        const body = JSON.stringify(payload.body || payload);
        assert.ok(body.includes('近代中国半殖民地半封建社会的起点是'), '请求应包含题干');
        assert.ok(body.includes('正确答案'), '请求应包含答案');
        return { choices: [{ message: { content: '```json\n{"explanation":"解析：鸦片战争后签订《南京条约》。"}\n```' } }] };
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.explanation, '鸦片战争后签订《南京条约》。');
  assert.equal(r.cached, false);
});

test('explainQuestion：模型返回纯文本也能用；返回空则报错', async () => {
  const plain = await ai.explainQuestion(
    { stem: '题干', qtype: '判断', answer: '正确' },
    {
      settings: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      requestFn: async () => ({ choices: [{ message: { content: '这句话是对的，因为……' } }] }),
    },
  );
  assert.equal(plain.ok, true);
  assert.match(plain.explanation, /这句话是对的/);

  const empty = await ai.explainQuestion(
    { stem: '题干' },
    {
      settings: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      requestFn: async () => ({ choices: [{ message: { content: '   ' } }] }),
    },
  );
  assert.equal(empty.ok, false);
  assert.match(empty.message, /没有返回/);
});

test('explainQuestion：网络错误映射成中文原因（401 / 超时）', async () => {
  const auth = await ai.explainQuestion(
    { stem: '题干' },
    {
      settings: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      requestFn: async () => { throw new AiError('API Key 无效或没有权限。', 'auth'); },
    },
  );
  assert.equal(auth.ok, false);
  assert.match(auth.message, /API Key 无效/);

  const timeout = await ai.explainQuestion(
    { stem: '题干' },
    {
      settings: { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      requestFn: async () => { throw new AiError('请求超时，请检查网络或用更小的分块', 'timeout'); },
    },
  );
  assert.equal(timeout.ok, false);
  assert.match(timeout.message, /超时/);
});

test('设置：autoExplain 默认为 false，可保存/读回', async () => {
  ai.clearAiSettings();
  assert.equal(ai.loadAiSettings().autoExplain, false, '默认关闭自动讲解');
  const saved = ai.saveAiSettings({ autoExplain: true });
  assert.equal(saved.autoExplain, true);
  assert.equal(ai.loadAiSettings().autoExplain, true);
  ai.clearAiSettings();
  assert.equal(ai.loadAiSettings().autoExplain, false);
});
