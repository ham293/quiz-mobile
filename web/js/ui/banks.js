/** 题库首页：题库列表、导入、选择 */

import { APP_VERSION } from '../config.js';
import { importFile, importSamples, loadBank, navigate, pickFile, showErrorDetail, state } from '../app.js';
import { isAiConfigured, loadAiSettings, recognizeQuestions } from '../ai.js';
import * as repo from '../bank.js';
import { nowStr } from '../dates.js';
import * as eb from '../ebbinghaus.js';
import { extractLines } from '../extract.js';
import { el, emptyState, confirmDialog, closeSheet, loading, mount, openSheet, toast } from './common.js';

/** 截断长文本，避免把整条错误塞进加载提示里 */
function shortText(text, limit = 40) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
import { setAction } from '../app.js';

/** AI 识别结果的预览上限（保存时会把全部题目写进题库） */
const AI_PREVIEW_LIMIT = 20;

/**
 * 渲染题库列表。
 * @param {HTMLElement} root
 */
export async function renderBanks(root) {
  setAction({ label: '＋', onClick: () => onImport(root) });

  const banks = await repo.listBanks();
  const children = [];

  if (!banks.length) {
    children.push(emptyState('📚', '还没有题库\n点右上角「＋」导入 .docx / .pdf 文件', {
      label: '导入题库',
      onClick: () => onImport(root),
    }));
    // 首次使用 / 导入失败时，用它快速判断是文件问题还是程序问题
    children.push(
      el('div.card', {}, [
        el('h3.card-title', { text: '先试试示例题库？' }),
        el('p.card-sub', {
          text: '点下面按钮导入内置的示例题库（含一份 docx、一份 PDF）。' +
            '如果示例能导入成功、而你的文件不行，就是文件格式的问题；如果示例也失败，把报错发我。',
        }),
        el('button.btn.block.mt12', {
          type: 'button',
          text: '导入示例题库',
          onclick: async () => {
            await importSamples();
            await renderBanks(root);
          },
        }),
      ]),
    );
  }

  for (const b of banks) {
    const wrongRecords = await repo.loadWrong(b.name);
    const due = eb.dueCount(wrongRecords);
    const isCurrent = state.bankName === b.name;
    children.push(
      el('div.card.tappable', {
        onclick: () => selectBank(b.name),
      }, [
        el('div.row.between', {}, [
          el('h3.card-title', { text: (isCurrent ? '📖 ' : '') + b.name }),
          el('span.tiny.muted', { text: (b.fileType || '').toUpperCase() }),
        ]),
        el('div.row.wrap.mt8', {}, [
          el('span.pill', { text: `${b.questionCount} 题` }),
          b.wrongCount ? el('span.pill.bad', { text: `错题 ${b.wrongCount}` }) : el('span.pill.gray', { text: '错题 0' }),
          b.favoriteCount ? el('span.pill.warn', { text: `收藏 ${b.favoriteCount}` }) : null,
          due ? el('span.pill.ok', { text: `今日到期 ${due}` }) : null,
          b.manualCount ? el('span.pill.gray', { text: `补录 ${b.manualCount}` }) : null,
        ]),
        el('p.card-sub.mt8', { text: `最近使用：${(b.lastUsed || '').slice(0, 16)}${b.fileName ? ' · ' + b.fileName : ''}` }),
      ]),
    );
  }

  children.push(
    el('button.btn.block.mb8', {
      type: 'button',
      text: '🧩 知识点自动出题',
      onclick: () => navigate('generate'),
    }),
  );

  children.push(
    el('div.row.mt12', {}, [
      el('button.btn.grow', { type: 'button', text: '导入新题库', onclick: () => onImport(root) }),
      el('button.btn', {
        type: 'button',
        text: '示例题库',
        onclick: async () => {
          await importSamples();
          await renderBanks(root);
        },
      }),
    ]),
  );

  // 排版特殊的 PDF / 扫描件用本地规则识别不准时，可以改用大模型识别（可选功能，需要自备 API Key）
  children.push(
    el('button.btn.block.mt8', {
      type: 'button',
      text: '🤖 用 AI 识别题库',
      onclick: () => onAiImport(root),
    }),
  );

  // 版本号常驻显示：出问题时截图就能看出装的是哪一版
  children.push(
    el('div.center.tiny.muted.mt12', {
      text: `刷题助手 v${APP_VERSION} · 完全离线`,
      onclick: () => navigate('selftest'),
    }),
  );

  mount(root, ...children);
}

/** 选择题库并进入练习页 */
async function selectBank(name) {
  await loadBank(name);
  toast(`已选择「${name}」`);
  navigate('practice');
}

/** 导入流程 */
async function onImport(root) {
  const { pickFile } = await import('../app.js');
  const file = await pickFile();
  if (!file) return;
  const bank = await importFile(file);
  if (bank) {
    await renderBanks(root);
    navigate('practice');
  }
}

/* ------------------------------------------------------------------ *
 * AI 识别导入（可选功能）
 * ------------------------------------------------------------------ */

/**
 * AI 导入流程：选文件 → 读文本（复用 extract.js）→ AI 识别 → 预览可删 → 保存为题库。
 * 没有配置 Key 时先引导去设置页；任何失败都给出可复制的错误详情。
 * @param {HTMLElement} root 题库页挂载点
 */
async function onAiImport(root) {
  if (!isAiConfigured()) {
    const go = await confirmDialog({
      title: '还没有配置 AI',
      message:
        '用 AI 识别题库需要先填一个 API Key（智谱 GLM-4-Flash、硅基流动有免费额度）。\n' +
        '不配置也没关系：直接用「导入新题库」走本地规则解析即可。',
      okText: '去设置',
    });
    if (go) navigate('ai');
    return;
  }

  const file = await pickFile();
  if (!file) return;

  const baseName = file.name.replace(/\.[^.]+$/, '') || '未命名题库';
  const defaultName = `${baseName}_AI`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let cancelled = false;
  const showProgress = (text) => loading(text, {
    showCancelAfter: 10000,
    onCancel: () => {
      cancelled = true;
      if (controller) controller.abort();
      loading('正在停止识别…');
    },
  });

  showProgress(`正在读取「${file.name}」…`);
  try {
    const { lines, warnings } = await extractLines(file, {
      onProgress: (info) => {
        if (cancelled) return;
        if (info && info.page && info.pages) showProgress(`正在读取「${file.name}」…　第 ${info.page}/${info.pages} 页`);
        else if (info && info.stage) showProgress(`${info.stage}：${file.name}`);
      },
    });
    if (cancelled) {
      loading(false);
      toast('已取消 AI 识别');
      return;
    }

    const settings = loadAiSettings();
    showProgress('AI 识别中…');
    const result = await recognizeQuestions(lines, {
      settings,
      signal: controller ? controller.signal : null,
      onProgress: (info) => {
        if (cancelled) return;
        if (info.stage === 'preflight') {
          showProgress('正在检查网络与 API Key（约几秒）…');
        } else if (info.stage === 'start') {
          showProgress(`AI 识别中 第 ${info.index}/${info.total} 块…`);
        } else if (info.stage === 'retry') {
          // 把失败原因直接写出来：否则用户只看到「失败重试中」，不知道是 Key 错还是网络不通
          const why = info.message ? `：${shortText(info.message, 40)}` : '';
          showProgress(`AI 识别中 第 ${info.index}/${info.total} 块（第 ${info.attempt} 次重试${why}）`);
        } else if (info.stage === 'ok') {
          showProgress(`AI 识别中 第 ${info.index}/${info.total} 块（已识别 ${info.questions} 题）`);
        } else if (info.stage === 'fail') {
          showProgress(`第 ${info.index}/${info.total} 块失败${info.message ? `：${shortText(info.message, 40)}` : ''}`);
        }
      },
    });
    loading(false);

    if (cancelled) {
      toast('已取消 AI 识别');
      return;
    }

    if (!result.questions.length) {
      // 全部/部分分块失败 ≠ 模型没认出题目：报错文案要说清是哪一种，别让用户去猜
      const allFailed = result.chunks.total > 0 && result.chunks.failed === result.chunks.total;
      const tips = allFailed
        ? [
            '· 先到「AI 识别设置」点「测试连接」，确认 Key、接口地址与模型名是否正确；',
            '· 免费额度用完 / 被限流也会失败，可以等一会儿或换一个服务商；',
            '· 确认手机能访问该服务商的接口地址（个别服务商需要开代理）。',
          ]
        : [
            '· 换一个更强的模型（例如把 glm-4-flash 换成更大的模型）；',
            '· 到「AI 识别设置」把分块字符数改小一些（例如 3000）；',
            '· 或者直接用「导入新题库」走本地规则解析。',
          ];
      showErrorDetail(
        allFailed ? 'AI 识别失败（所有分块都没成功）' : 'AI 没有识别出题目',
        [
          `「${file.name}」读到 ${lines.length} 行文本，切成 ${result.chunks.total} 块，` +
            (allFailed ? `其中 ${result.chunks.failed} 块全部失败。` : '但一道题也没识别出来。'),
          ...result.errors.map((e) => `· ${e}`),
          ...(warnings || []).map((w) => `· ${w}`),
          '',
          '可以试试：',
          ...tips,
        ].join('\n'),
      );
      return;
    }

    showAiPreview(root, {
      file,
      lines,
      warnings: warnings || [],
      result,
      questions: result.questions.slice(),
      name: defaultName,
    });
  } catch (err) {
    console.warn('[banks] AI 识别失败：', err);
    loading(false);
    // 详细错误用可复制的弹窗展示（toast 一闪而过，用户来不及截图）
    showErrorDetail('AI 识别失败', err && err.message ? err.message : String(err));
  } finally {
    loading(false);
  }
}

/**
 * AI 识别结果预览（底部弹层）：前 20 条可逐条删除，改题库名后保存。
 * @param {HTMLElement} root 题库页挂载点（保存成功后用来刷新列表）
 * @param {{file:File, lines:object[], warnings:string[], result:object, questions:object[], name:string}} ctx
 */
function showAiPreview(root, ctx) {
  const paint = () => {
    const total = ctx.questions.length;
    const shown = Math.min(total, AI_PREVIEW_LIMIT);
    const children = [
      el('h3.card-title', { text: `AI 识别结果（${total} 题）` }),
      el('p.card-sub', {
        text:
          `「${ctx.file.name}」读到 ${ctx.lines.length} 行，切成 ${ctx.result.chunks.total} 块，` +
          `成功 ${ctx.result.chunks.done} 块、失败 ${ctx.result.chunks.failed} 块。`,
      }),
      el('div.row.wrap.mt8', {}, [
        el('span.pill.ok', { text: `${total} 题` }),
        ctx.result.chunks.failed ? el('span.pill.bad', { text: `失败 ${ctx.result.chunks.failed} 块` }) : null,
        ctx.result.errors.length ? el('span.pill.warn', { text: `异常 ${ctx.result.errors.length} 条` }) : null,
        el('span.pill.gray', { text: `用量 ${ctx.result.usage.prompt + ctx.result.usage.completion} tokens` }),
      ]),
      el('p.tiny.muted.mt8', {
        text: total > shown
          ? `下面只预览前 ${shown} 条（可逐条删除），保存时会把剩下的 ${total} 题全部写入题库。`
          : 'AI 识别可能出错，请核对后再保存；每条都可以单独删除。',
      }),
    ];

    ctx.questions.slice(0, shown).forEach((q, index) => {
      const optionText = Object.entries(q.options || {})
        .map(([letter, text]) => `${letter}．${text}`)
        .join('　');
      children.push(
        el('div.list-item', {}, [
          el('span.idx', { text: String(index + 1) }),
          el('div.grow', {}, [
            el('div.row.between', {}, [
              el('span.pill', { text: q.qtype }),
              el('span.tiny.muted', { text: `答案 ${q.answer || '—'}` }),
            ]),
            el('div.small.mt8.pre-wrap', { text: q.stem }),
            optionText ? el('p.tiny.muted.mt8.pre-wrap', { text: optionText }) : null,
          ]),
          el('button.btn.sm.bad', {
            type: 'button',
            text: '删除',
            onclick: () => {
              ctx.questions.splice(index, 1);
              toast(`已删除第 ${index + 1} 题，剩 ${ctx.questions.length} 题`);
              paint();
            },
          }),
        ]),
      );
    });

    if (ctx.result.errors.length) {
      children.push(
        el('button.btn.sm.block.mt8', {
          type: 'button',
          text: `查看识别异常（${ctx.result.errors.length} 条）`,
          onclick: () => showErrorDetail('AI 识别异常明细', ctx.result.errors.join('\n')),
        }),
      );
    }
    if (ctx.warnings.length) {
      children.push(el('p.tiny.muted.mt8', { text: `读取提示：${ctx.warnings.slice(0, 3).join('；')}` }));
    }

    const nameInput = el('input', {
      type: 'text',
      value: ctx.name,
      placeholder: '题库名',
      oninput: (e) => {
        ctx.name = e.target.value;
      },
    });
    children.push(el('div.field.mt12', {}, [el('label', { text: '保存为题库' }), nameInput]));
    children.push(
      el('div.grid2.mt12', {}, [
        el('button.btn', { type: 'button', text: '取消', onclick: () => closeSheet() }),
        el('button.btn.primary', {
          type: 'button',
          text: `保存（${ctx.questions.length} 题）`,
          onclick: () => saveAiBank(root, ctx, paint),
        }),
      ]),
    );

    openSheet(el('div', {}, children));
  };

  paint();
}

/**
 * 保存 AI 识别的结果为新题库（题库已存在时先确认覆盖），成功后跳到练习页。
 * @param {HTMLElement} root 题库页挂载点
 * @param {object} ctx showAiPreview 的上下文
 * @param {Function} repaint 取消覆盖后重新展示预览
 */
async function saveAiBank(root, ctx, repaint) {
  if (!ctx.questions.length) {
    toast('没有可保存的题目');
    return;
  }
  const name = String(ctx.name || '').trim() || `${ctx.file.name.replace(/\.[^.]+$/, '') || '未命名题库'}_AI`;
  ctx.name = name;

  const exist = await repo.getBank(name);
  if (exist) {
    const ok = await confirmDialog({
      title: `题库「${name}」已存在`,
      message: `已有 ${(exist.questions || []).length} 道题。覆盖后题目会更新，错题本与收藏本按题干保留。`,
      okText: '覆盖导入',
      danger: true,
    });
    if (!ok) {
      repaint(); // 确认框会关掉预览层，这里把它放回来，用户可以改个名字再存
      return;
    }
  }

  loading('正在保存题库…');
  try {
    await repo.importParsed(
      name,
      {
        questions: ctx.questions,
        // AI 的失败/异常也写进解析日志，和本地解析一样可查
        errors: ctx.result.errors.map((reason) => ({ time: nowStr(), page: 0, line: 0, reason, raw: '' })),
        warnings: [`题库「${name}」由 AI 识别生成，请核对准确性。`],
      },
      { fileName: ctx.file.name, fileType: (ctx.file.name.split('.').pop() || '').toLowerCase() },
    );
    await loadBank(name);
    closeSheet();
    toast(`已保存题库「${name}」，共 ${ctx.questions.length} 题`, 3200);
    await renderBanks(root);
    navigate('practice');
  } catch (err) {
    console.warn('[banks] 保存 AI 题库失败：', err);
    showErrorDetail('保存题库失败', err && err.message ? err.message : String(err));
  } finally {
    loading(false);
  }
}
