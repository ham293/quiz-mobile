/**
 * exporter.test.mjs —— 导出模块的纯逻辑单测（node:test + node:assert/strict）
 *
 * 只测 `buildExportHtml` 这类不依赖 DOM 的部分：
 * 浏览器里的 html2canvas / jsPDF 渲染路径无法在 Node 中执行，
 * 但「依赖缺失时必须抛 ExportError」这类环境分支可以在这里验证。
 *
 * 运行：cd "D:\ds haness\quiz-mobile" && node --test tests/exporter.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ExportError,
  buildExportHtml,
  buildFileName,
  downloadBlob,
  exportHtml,
  exportPdf,
  renderPdf,
} from '../web/js/exporter.js';

/** 全角空格（错题信息行的分隔符） */
const IDEO_SPACE = '\u3000';

/** 一份典型错题本数据：3 道题，覆盖单选/多选/判断 + 乱序选项 + 缺解析 */
function sampleItems() {
  return [
    {
      qid: 'q1',
      stem: '下列哪个是中国的首都？',
      qtype: '单选',
      options: { D: '上海', A: '北京', C: '广州', B: '天津' },
      answer: 'A',
      explanation: '北京是中华人民共和国的首都。',
      wrong_count: 3,
      correct_streak: 2,
      stage: 4,
      next_review: '2026-09-20',
    },
    {
      qid: 'q2',
      stem: '以下哪些是编程语言？\n（可多选）',
      qtype: '多选',
      options: { B: 'JavaScript', A: 'Python' },
      answer: 'AB',
      explanation: '',
      wrong_count: 1,
      correct_streak: 0,
      stage: 1,
      next_review: '2026-09-18',
    },
    {
      qid: 'q3',
      stem: '地球是球体。',
      qtype: '判断',
      options: {},
      answer: '正确',
      explanation: '常识题。',
    },
  ];
}

const OPTS = {
  title: '《示例题库》错题本',
  subtitle: '共 3 题',
  exportedAt: '2026-09-17 20:10:00',
  wrongInfo: true,
};

test('导出接口齐全，ExportError 是 Error 的子类', () => {
  assert.equal(typeof buildExportHtml, 'function');
  assert.equal(typeof exportHtml, 'function');
  assert.equal(typeof renderPdf, 'function');
  assert.equal(typeof exportPdf, 'function');
  assert.equal(typeof downloadBlob, 'function');
  assert.equal(typeof buildFileName, 'function');
  assert.ok(new ExportError('x') instanceof Error);
  assert.equal(new ExportError('x').name, 'ExportError');
});

test('纯字符串生成：Node 环境（无 DOM）下可直接调用', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const html = buildExportHtml(sampleItems(), OPTS);
  assert.equal(typeof html, 'string');
  assert.ok(html.length > 500);
});

test('页头包含标题、副标题、导出时间与总题数', () => {
  const html = buildExportHtml(sampleItems(), OPTS);
  assert.ok(html.includes('《示例题库》错题本'));
  assert.ok(html.includes('共 3 题'));
  assert.ok(html.includes('导出时间：2026-09-17 20:10:00'));
  assert.ok(html.includes('总题数：3 题'));
});

test('按题型统计只列数量大于 0 的题型，并按约定顺序排列', () => {
  const html = buildExportHtml(
    [
      { stem: 'a', qtype: '单选' },
      { stem: 'b', qtype: '单选' },
      { stem: 'c', qtype: '判断' },
    ],
    OPTS,
  );
  assert.ok(html.includes('单选题 2 题'));
  assert.ok(html.includes('判断题 1 题'));
  assert.ok(!html.includes('多选题'));
  assert.ok(!html.includes('论述题'));
  assert.ok(html.indexOf('单选题 2 题') < html.indexOf('判断题 1 题'));

  const mixed = buildExportHtml(sampleItems(), OPTS);
  assert.ok(mixed.indexOf('单选题') < mixed.indexOf('多选题'));
  assert.ok(mixed.indexOf('多选题') < mixed.indexOf('判断题'));
});

test('逐题输出题型标签、题干、答案与解析', () => {
  const html = buildExportHtml(sampleItems(), OPTS);
  assert.ok(html.includes('1.【单选题】下列哪个是中国的首都？'));
  assert.ok(html.includes('2.【多选题】以下哪些是编程语言？'));
  assert.ok(html.includes('3.【判断题】地球是球体。'));
  assert.ok(html.includes('<p class="quiz-exp-answer">答案：A</p>'));
  assert.ok(html.includes('<p class="quiz-exp-answer">答案：AB</p>'));
  assert.ok(html.includes('<p class="quiz-exp-answer">答案：正确</p>'));
  assert.ok(html.includes('解析：北京是中华人民共和国的首都。'));
  assert.ok(html.includes('解析：常识题。'));
  // 解析为空 → 输出「（无）」
  assert.ok(html.includes('<p class="quiz-exp-expl">解析：（无）</p>'));
});

test('乱序输入的选项按字母升序输出', () => {
  const html = buildExportHtml(sampleItems(), OPTS);
  const a = html.indexOf('A. 北京');
  const b = html.indexOf('B. 天津');
  const c = html.indexOf('C. 广州');
  const d = html.indexOf('D. 上海');
  assert.ok(a > -1 && b > -1 && c > -1 && d > -1);
  assert.ok(a < b && b < c && c < d);
  assert.ok(html.includes('<p class="quiz-exp-opt">A. 北京</p>'));
  // 数组形式选项也会补齐字母
  const arr = buildExportHtml([{ stem: 's', qtype: '单选', options: ['甲', '乙'] }], OPTS);
  assert.ok(arr.includes('<p class="quiz-exp-opt">A. 甲</p>'));
  assert.ok(arr.includes('<p class="quiz-exp-opt">B. 乙</p>'));
});

test('判断题没有选项时不输出选项行', () => {
  const html = buildExportHtml([{ stem: '地球是球体。', qtype: '判断', options: {} }], OPTS);
  assert.ok(!html.includes('class="quiz-exp-opt">'));
  assert.ok(html.includes('【判断题】'));
});

test('题干与解析里的换行转成 <br>', () => {
  const html = buildExportHtml(
    [{ stem: '第一行\n第二行', qtype: '简答', answer: '', explanation: '解析一\r\n解析二' }],
    { title: 'T', wrongInfo: false, exportedAt: '2026-01-01 00:00:00' },
  );
  assert.ok(html.includes('第一行<br>第二行'));
  assert.ok(!html.includes('第一行\n第二行'));
  assert.ok(html.includes('解析一<br>解析二'));
});

test('wrongInfo 为 true 时输出错题复习信息', () => {
  const html = buildExportHtml(sampleItems(), { ...OPTS, wrongInfo: true });
  assert.ok(html.includes('错误次数：3'));
  assert.ok(html.includes('连续答对：2'));
  assert.ok(html.includes('复习阶段：4'));
  assert.ok(html.includes('下次复习：2026-09-20'));
  assert.ok(
    html.includes(
      `<p class="quiz-exp-wrong">错误次数：3${IDEO_SPACE}连续答对：2${IDEO_SPACE}复习阶段：4${IDEO_SPACE}下次复习：2026-09-20</p>`,
    ),
  );
  // 缺字段的错题记录用默认值 0 / —
  assert.ok(html.includes(`错误次数：0${IDEO_SPACE}连续答对：0${IDEO_SPACE}复习阶段：0${IDEO_SPACE}下次复习：—`));
});

test('wrongInfo 为 false 时不输出错题复习信息', () => {
  const html = buildExportHtml(sampleItems(), { ...OPTS, wrongInfo: false });
  assert.ok(!html.includes('错误次数'));
  assert.ok(!html.includes('class="quiz-exp-wrong"')); // 样式表里的类名不算，只看是否有该元素
  assert.ok(!html.includes('下次复习'));
});

test('文本一律 HTML 转义（& < > "）', () => {
  const html = buildExportHtml(
    [
      {
        stem: 'A <script>alert("x")</script> & B',
        qtype: '单选',
        options: { A: '5 < 6 & 7 > 6' },
        answer: '"A"',
        explanation: '包含 <b> 标签 & 引号 " 的解析',
      },
    ],
    OPTS,
  );
  assert.ok(html.includes('A &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; B'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('alert("x")'));
  assert.ok(html.includes('5 &lt; 6 &amp; 7 &gt; 6'));
  assert.ok(html.includes('答案：&quot;A&quot;'));
  assert.ok(html.includes('包含 &lt;b&gt; 标签 &amp; 引号 &quot; 的解析'));
  // 标题同样要转义
  const titleHtml = buildExportHtml([], { title: '<b>标题</b>', exportedAt: '2026-01-01 00:00:00' });
  assert.ok(titleHtml.includes('&lt;b&gt;标题&lt;/b&gt;'));
  assert.ok(!titleHtml.includes('<h1 class="quiz-exp-title"><b>'));
});

test('空列表不崩，显示「（暂无题目）」', () => {
  const html = buildExportHtml([], OPTS);
  assert.ok(html.includes('（暂无题目）'));
  assert.ok(html.includes('总题数：0 题'));
  assert.ok(!html.includes('class="quiz-exp-item"'));
});

test('items 不是数组（null/undefined/字符串/对象）时不崩', () => {
  for (const bad of [null, undefined, 'not-an-array', 42, { length: 1 }]) {
    const html = buildExportHtml(bad, OPTS);
    assert.ok(html.includes('总题数：0 题'));
    assert.ok(html.includes('（暂无题目）'));
  }
  // opts 缺失或非法时用默认值
  const noOpts = buildExportHtml(sampleItems());
  assert.ok(noOpts.includes('题目导出'));
  assert.ok(noOpts.includes('导出时间：'));
  assert.ok(!noOpts.includes('错误次数'));
  const badOpts = buildExportHtml(sampleItems(), null);
  assert.ok(badOpts.includes('题目导出'));
});

test('缺字段的记录（只有 stem/qtype）不崩，缺解析显示「解析：（无）」', () => {
  const html = buildExportHtml([{ stem: '只有题干', qtype: '简答' }], OPTS);
  assert.ok(html.includes('1.【简答题】只有题干'));
  assert.ok(html.includes('答案：—'));
  assert.ok(html.includes('解析：（无）'));
  // qtype 缺失 → 占位符
  const noType = buildExportHtml([{ stem: '没有题型' }], OPTS);
  assert.ok(noType.includes('1.【—】没有题型'));
  // 连题干都没有也不崩
  const empty = buildExportHtml([{}], OPTS);
  assert.ok(empty.includes('1.【—】—'));
});

test('输出是完整 HTML 文档，含 DOCTYPE / style / 固定宽度与中文字体栈', () => {
  const html = buildExportHtml(sampleItems(), OPTS);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<html lang="zh-CN"'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('</style>'));
  assert.ok(html.includes('</body>'));
  assert.ok(html.trimEnd().endsWith('</html>'));
  assert.ok(html.includes('width: 794px'));
  assert.ok(html.includes('-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif'));
  assert.ok(html.includes('font-size: 15px'));
  assert.ok(html.includes('line-height: 1.6'));
  assert.ok(html.includes('background: #ffffff'));
  assert.ok(html.includes('<title>《示例题库》错题本</title>'));
});

test('题目之间有分隔线，且首题不带分隔线', () => {
  const html = buildExportHtml(sampleItems(), OPTS);
  assert.ok(html.includes('<li class="quiz-exp-item"><p class="quiz-exp-stem">1.【单选题】'));
  assert.ok(html.includes('<li class="quiz-exp-item"><div class="quiz-exp-sep"></div>'));
  const sepCount = html.split('quiz-exp-sep"></div>').length - 1;
  assert.equal(sepCount, 2); // 3 道题 → 2 条分隔线
});

test('exportHtml 与 buildExportHtml 输出一致', async () => {
  const items = sampleItems();
  const direct = buildExportHtml(items, OPTS);
  const viaExport = await exportHtml(items, OPTS);
  assert.equal(viaExport, direct);
});

test('缺 vendor 依赖时 renderPdf/exportPdf 抛 ExportError（含指引文案）', async () => {
  await assert.rejects(
    () => renderPdf(sampleItems(), OPTS),
    (err) => {
      assert.ok(err instanceof ExportError);
      assert.ok(err.message.includes('web/vendor'));
      assert.notEqual(err.name, 'Error');
      return true;
    },
  );
  await assert.rejects(() => exportPdf(sampleItems(), OPTS), (err) => {
    assert.ok(err instanceof ExportError);
    assert.ok(err.message.includes('导出组件未加载'));
    return true;
  });
});

test('Node 环境调用 downloadBlob 抛 ExportError 而不是裸异常', () => {
  assert.throws(
    () => downloadBlob(new Blob(['demo'], { type: 'application/pdf' }), 'demo.pdf'),
    (err) => {
      assert.ok(err instanceof ExportError);
      assert.ok(err.message.includes('不支持浏览器下载'));
      return true;
    },
  );
  assert.throws(() => downloadBlob(null, 'demo.pdf'), (err) => {
    assert.ok(err instanceof ExportError);
    assert.ok(err.message.includes('文件内容为空'));
    return true;
  });
});

test('buildFileName 生成安全的 .pdf 文件名', () => {
  const name = buildFileName('《示例题库》错题本 / 2026');
  assert.ok(name.endsWith('.pdf'));
  assert.ok(!/[\\/:*?"<>|]/.test(name));
  assert.ok(name.includes('示例题库'));
  assert.ok(buildFileName('').startsWith('题目导出'));
  assert.ok(buildFileName().endsWith('.pdf'));
});
