/**
 * 知识点自动出题页（web/js/ui/generate.js）。
 *
 * 单页四步（移动端友好，卡片分区）：
 *   ① 来源：选文件（.docx/.pdf/.txt，走 extract.js）或粘贴文本；
 *   ② 设置：题型多选 + 最多题数 + 题库名；
 *   ③ 生成与预览：统计信息 + 前 20 条预览（可逐条删除）；
 *   ④ 保存为题库：repo.importParsed → loadBank → 跳到练习页。
 *
 * 出题规则全部在 generator.js 里（纯规则、离线、无 AI 接口）。
 */

import { loadBank, navigate, pickFile } from '../app.js';
import * as repo from '../bank.js';
import { extractLines } from '../extract.js';
import {
  GEN_TYPES,
  GEN_TYPE_LABELS,
  generateQuestions,
  summarizeGenerated,
  textToLines,
} from '../generator.js';
import { confirmDialog, el, emptyState, kv, loading, mount, toast } from './common.js';

/** 预览最多列多少条（保存时全部保存） */
const PREVIEW_LIMIT = 20;
/** 默认最多生成题数 */
const DEFAULT_COUNT = 50;
/** 设置区的小提示 */
const TYPES_HINT =
  '填空题：把知识点挖成 ____，答案就是被挖掉的词；选择题：额外配 3 个干扰项（干扰项不足就不出这道题）；' +
  '判断题：原句照抄判「正确」，改掉数字或加删否定词判「错误」。三种题型都会带参考答案与出处原句。';

/**
 * 页面状态（模块级：从生成页跳去练习再返回时，输入与预览都还在）。
 * 所有字段都只是「表单值」，真正的题目在 questions / result 里。
 */
const view = {
  /** 来源方式：'file' 选文件 / 'paste' 粘贴文本 */
  mode: 'file',
  /** 已读取的文件名（用于默认题库名与来源标注） */
  fileName: '',
  /** 文件扩展名（docx/pdf/txt），粘贴文本时为空 */
  fileType: '',
  /** 已读取的文本行 */
  lines: [],
  /** 粘贴框里的文本（切换重渲染时不丢内容） */
  paste: '',
  /** 选中的题型 */
  types: [...GEN_TYPES],
  /** 最多生成多少题 */
  count: DEFAULT_COUNT,
  /** 题库名 */
  name: '',
  /** 生成结果（generateQuestions 的返回值） */
  result: null,
  /** 当前题目（预览里可以删，保存时用这份） */
  questions: [],
};

/**
 * 渲染知识点出题页。
 * @param {HTMLElement} root 挂载点
 * @param {{lines?:Array, name?:string, text?:string}} [params] 可选的预填参数
 */
export async function renderGenerate(root, params = {}) {
  if (params && Array.isArray(params.lines) && params.lines.length) {
    view.lines = params.lines;
    view.name = params.name || defaultBankName('');
  }
  render(root);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 按当前状态重绘整页 */
function render(root) {
  mount(root, sourceCard(root), settingCard(root), resultCard(root), bottomActions(root));
}

/** ① 来源卡片 */
function sourceCard(root) {
  const modeChip = (mode, label, icon) =>
    el('button.chip' + (view.mode === mode ? '.active' : ''), {
      type: 'button',
      text: `${icon} ${label}`,
      onclick: () => {
        view.mode = mode;
        render(root);
      },
    });

  const children = [
    el('h3.card-title', { text: '① 知识点来源' }),
    el('p.card-sub', {
      text: '上传或粘贴你的知识点 / 复习资料，程序用规则自动出题（完全离线，不会联网，也不会调用任何 AI 接口）。',
    }),
    el('div.chips.mt12', {}, [modeChip('file', '选文件', '📄'), modeChip('paste', '粘贴文本', '📋')]),
  ];

  if (view.mode === 'file') {
    children.push(
      el('button.btn.block.mt12', {
        type: 'button',
        text: '选择 .docx / .pdf / .txt 文件',
        onclick: () => chooseFile(root),
      }),
    );
    children.push(
      el('p.card-sub.mt8', {
        text: view.fileName
          ? `已读取：${view.fileName}（${view.lines.length} 行）`
          : '支持 Word（.docx）、文字版 PDF（.pdf）、纯文本（.txt）。扫描版 PDF 暂不支持。',
      }),
    );
    if (view.lines.length) {
      children.push(
        el('button.btn.sm.mt8', { type: 'button', text: '清空已读取内容', onclick: () => clearSource(root) }),
      );
    }
  } else {
    const area = el('textarea', {
      placeholder: '把知识点直接粘进来，每行一句效果最好。\n例如：\n1851 年，中国爆发了太平天国运动，沉重打击了清王朝统治。\n1919 年，五四运动标志着中国新民主主义革命的开端。',
      value: view.paste,
      oninput: (e) => {
        view.paste = e.target.value;
      },
    });
    children.push(el('div.field.mt12', {}, [area]));
    children.push(
      el('button.btn.block', {
        type: 'button',
        text: '使用这段文本',
        onclick: () => usePastedText(root),
      }),
    );
    children.push(
      el('p.card-sub.mt8', {
        text: view.lines.length && view.mode === 'paste'
          ? `已读取：粘贴文本（${view.lines.length} 行）`
          : '建议一行一句、句子完整（含年份、术语、书名号等），出题质量会明显更好。',
      }),
    );
  }

  return el('div.card', {}, children);
}

/** ② 设置卡片 */
function settingCard(root) {
  const chip = (type) => {
    const active = view.types.includes(type);
    return el('button.chip' + (active ? '.active' : ''), {
      type: 'button',
      text: GEN_TYPE_LABELS[type],
      onclick: () => {
        if (active && view.types.length === 1) {
          toast('至少要保留一种题型');
          return;
        }
        view.types = active ? view.types.filter((t) => t !== type) : [...view.types, type];
        render(root);
      },
    });
  };

  return el('div.card', {}, [
    el('h3.card-title', { text: '② 出题设置' }),
    el('div.field.mt8', {}, [
      el('label', { text: '题型（可多选）' }),
      el('div.chips', {}, GEN_TYPES.map(chip)),
    ]),
    el('div.grid2', {}, [
      el('div.field', {}, [
        el('label', { text: '最多生成题数' }),
        el('input', {
          type: 'text',
          inputmode: 'numeric',
          value: String(view.count),
          placeholder: String(DEFAULT_COUNT),
          oninput: (e) => {
            view.count = Number(String(e.target.value).replace(/[^\d]/g, '')) || DEFAULT_COUNT;
          },
        }),
      ]),
      el('div.field', {}, [
        el('label', { text: '题库名' }),
        el('input', {
          type: 'text',
          placeholder: '例如：近代史_自动出题',
          value: view.name,
          oninput: (e) => {
            view.name = e.target.value;
          },
        }),
      ]),
    ]),
    el('p.tiny.muted', { text: TYPES_HINT }),
  ]);
}

/** ③ 生成与预览卡片 */
function resultCard(root) {
  const children = [
    el('h3.card-title', { text: '③ 生成与预览' }),
    el('button.btn.primary.block.mt8', {
      type: 'button',
      text: view.questions.length ? '重新生成题目' : '生成题目',
      onclick: () => runGenerate(root),
    }),
  ];

  const result = view.result;
  if (!result) {
    children.push(
      el('p.card-sub.mt12', {
        text: view.lines.length
          ? `已准备好 ${view.lines.length} 行文本，点上面的按钮开始出题。`
          : '先在上面选一个文件或粘贴文本。',
      }),
    );
    return el('div.card', {}, children);
  }

  children.push(
    el('div.mt12', {}, [
      kv('句子数（可用）', result.sentences),
      kv('生成题目', `${view.questions.length} 题`),
      kv('跳过句子', result.skipped),
      kv('题型分布', `填空 ${countOf('fill')} · 选择 ${countOf('choice')} · 判断 ${countOf('judge')}`),
    ]),
  );

  for (const warning of result.warnings || []) {
    children.push(el('p.tiny.muted.mt8', { text: `· ${warning}` }));
  }

  if (!view.questions.length) {
    children.push(emptyState('🧩', '没有提取到知识点'));
    children.push(
      el('p.card-sub.mt8', {
        text:
          '可以试试更完整的知识点 / 复习资料：句子写完整、一行一句，' +
          '带上年份、术语（……主义/运动/条约）、书名号《》、人名地名，命中率会高很多。',
      }),
    );
    return el('div.card', {}, children);
  }

  children.push(
    el('p.card-sub.mt12', {
      text:
        view.questions.length > PREVIEW_LIMIT
          ? `下面只预览前 ${PREVIEW_LIMIT} 条，保存时会把 ${view.questions.length} 题全部写入题库。`
          : '每条都可以单独删除，剩下的才会保存进题库。',
    }),
  );

  view.questions.slice(0, PREVIEW_LIMIT).forEach((q, index) => {
    children.push(previewItem(q, index, root));
  });

  return el('div.card', {}, children);
}

/** 单条预览 */
function previewItem(q, index, root) {
  const isJudge = q.qtype === '判断';
  const rows = [
    el('div.row.between', {}, [
      el('span.pill', { text: isJudge ? '判断题' : '单选题' }),
      el('span.tiny.muted', { text: `第 ${index + 1} 题${q.line ? ` · 第 ${q.line} 行` : ''}` }),
    ]),
    el('div.small.mt8.pre-wrap', { text: q.stem }),
    el('div.tiny.muted.mt8', { text: `参考答案：${answerTextOf(q)}` }),
  ];

  if (!isJudge && Object.keys(q.options).length > 1) {
    rows.push(
      el('p.tiny.muted.mt8.pre-wrap', {
        text: `选项：${Object.entries(q.options).map(([k, v]) => `${k}．${v}`).join('　')}`,
      }),
    );
  }
  rows.push(el('p.tiny.muted.mt8.pre-wrap', { text: `出处：${q.explanation.replace(/\n/g, ' ')}` }));

  return el('div.list-item', {}, [
    el('div.grow', {}, rows),
    el('button.btn.sm', {
      type: 'button',
      text: '删除',
      onclick: () => {
        view.questions.splice(index, 1);
        toast(`已删除第 ${index + 1} 题，剩 ${view.questions.length} 题`);
        render(root);
      },
    }),
  ]);
}

/** ④ 保存动作条 */
function bottomActions(root) {
  return el('div.bottom-actions', {}, [
    el('button.btn.primary.grow', {
      type: 'button',
      text: view.questions.length ? `保存为题库（${view.questions.length} 题）` : '保存为题库',
      disabled: !view.questions.length,
      onclick: () => saveBank(root),
    }),
  ]);
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

/** 选题型分布计数 */
function countOf(type) {
  return (view.result && view.result.byType && view.result.byType[type]) || 0;
}

/** 参考答案展示文本 */
function answerTextOf(q) {
  if (q.qtype === '判断') return q.answer;
  const text = q.options[q.answer];
  return text ? `${q.answer}．${text}` : q.answer || '（无参考答案）';
}

/** 默认题库名 */
function defaultBankName(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  return `${base || '粘贴知识点'}_自动出题`;
}

/** 清空已读取的来源 */
function clearSource(root) {
  view.lines = [];
  view.fileName = '';
  view.fileType = '';
  view.result = null;
  view.questions = [];
  render(root);
  toast('已清空来源');
}

/** 选文件 → extractLines → 文本行 */
async function chooseFile(root) {
  const file = await pickFile();
  if (!file) return;
  loading(`正在读取「${file.name}」…`);
  try {
    const { lines, warnings } = await extractLines(file);
    if (!lines.length) {
      toast('这个文件里没有读到文字，换一个文件试试', 3000);
      return;
    }
    view.lines = lines;
    view.fileName = file.name;
    view.fileType = (file.name.split('.').pop() || '').toLowerCase();
    view.name = view.name && !view.name.endsWith('_自动出题') ? view.name : defaultBankName(file.name);
    view.result = null;
    view.questions = [];
    const tip = (warnings || [])[0];
    toast(`已读取 ${lines.length} 行${tip ? `（${tip}）` : ''}，点「生成题目」开始`, 3200);
    render(root);
  } catch (err) {
    // extractLines 抛的都是中文提示（ExtractError），原始异常只写控制台
    console.warn('[generate] 读取知识点文件失败：', err);
    toast(err && err.message ? err.message : '读取文件失败', 4000);
  } finally {
    loading(false);
  }
}

/** 使用粘贴框里的文本 */
function usePastedText(root) {
  const lines = textToLines(view.paste);
  if (!lines.length) {
    toast('粘贴框还是空的');
    return;
  }
  view.lines = lines;
  view.fileName = '';
  view.fileType = '';
  if (!view.name || view.name.endsWith('_自动出题')) view.name = defaultBankName('');
  view.result = null;
  view.questions = [];
  toast(`已读取 ${lines.length} 行，点「生成题目」开始`, 2600);
  render(root);
}

/** 生成题目 */
async function runGenerate(root) {
  if (!view.lines.length) {
    toast('请先选择文件或粘贴知识点文本');
    return;
  }
  if (!view.types.length) {
    toast('请至少选择一种题型');
    return;
  }
  loading('正在生成…');
  // 让加载遮罩先画出来，再做同步的出题计算
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    const result = generateQuestions(view.lines, {
      types: view.types,
      count: view.count,
      // 每次点「生成」换一个种子 → 选项顺序会重新打乱（同一次生成内仍完全可复现）
      seed: Date.now() % 1000000007,
    });
    view.result = result;
    view.questions = result.questions.slice();
    view.count = Number(view.count) || DEFAULT_COUNT;
    if (!view.name) view.name = defaultBankName(view.fileName);
    toast(
      result.questions.length
        ? `生成 ${result.questions.length} 题（${summarizeGenerated(result)}）`
        : '没有生成题目，看看下面的提示',
      3200,
    );
  } catch (err) {
    console.warn('[generate] 出题失败：', err);
    toast(`出题失败：${err && err.message ? err.message : err}`, 3600);
  } finally {
    loading(false);
    render(root);
  }
}

/** 保存为题库 → 载入 → 进入练习页 */
async function saveBank(root) {
  if (!view.questions.length) {
    toast('还没有可保存的题目');
    return;
  }
  const name = (view.name || '').trim() || defaultBankName(view.fileName);
  const exist = await repo.getBank(name);
  if (exist) {
    const ok = await confirmDialog({
      title: `题库「${name}」已存在`,
      message: `已有 ${(exist.questions || []).length} 道题。覆盖后题目会更新，错题本与收藏本按题干保留。`,
      okText: '覆盖保存',
      danger: true,
    });
    if (!ok) return;
  }

  loading('正在保存…');
  try {
    await repo.importParsed(
      name,
      { questions: view.questions },
      { fileName: view.fileName || '知识点自动出题', fileType: view.fileType || '' },
    );
    await loadBank(name);
    toast(`已生成题库「${name}」，共 ${view.questions.length} 题`, 3000);
    await navigate('practice');
  } catch (err) {
    console.warn('[generate] 保存题库失败：', err);
    toast(`保存失败：${err && err.message ? err.message : err}`, 3600);
  } finally {
    loading(false);
  }
}
