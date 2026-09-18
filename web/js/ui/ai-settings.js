/**
 * web/js/ui/ai-settings.js —— 「AI 识别设置」（可选功能）。
 *
 * 四张卡片：
 *   ① 状态：是否已配置、当前服务商/模型、Key 打码显示；
 *   ② 选择服务商：内置预设（chip 选择，自动带出接口地址与模型名）+ 申请 Key 链接 + 是否免费；
 *   ③ 参数：API Key（可显示/隐藏）、Base URL、模型名、分块字符数、测试连接；
 *   ④ 说明：会联网上传文本、免费额度、失败可回退本地规则解析。
 *
 * 约定：Key 只存 localStorage，程序里永远只展示打码版本；本页不联网，
 * 只有用户主动点「测试连接」或「用 AI 识别题库」时才会发请求。
 */

import {
  AI_PROVIDERS,
  clearAiSettings,
  findProvider,
  isAiConfigured,
  loadAiSettings,
  maskKey,
  saveAiSettings,
  testAiConnection,
} from '../ai.js';
import { navigate, setAction, setBackVisible } from '../app.js';
import { confirmDialog, el, kv, loading, mount, toast } from './common.js';

/** 表单草稿（模块级：切到别的页面再回来，没保存的输入还在） */
let draft = null;

/**
 * 渲染 AI 识别设置页。
 * @param {HTMLElement} root 挂载点
 * @param {{reload?:boolean}} [params] reload=true 时强制从本地设置重新读取
 */
export async function renderAiSettings(root, params = {}) {
  setBackVisible(true);
  setAction(null);
  if (!draft || params.reload) draft = loadAiSettings();
  render(root);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 按当前 draft 重绘整页 */
function render(root) {
  mount(root, statusCard(), providerCard(root), paramCard(root), noticeCard());
}

/** ① 状态卡片 */
function statusCard() {
  const configured = isAiConfigured(draft);
  const preset = findProvider(draft.provider);
  return el('div.card', {}, [
    el('h3.card-title', { text: '🤖 AI 识别（可选）' }),
    el('p.card-sub', {
      text: '排版特殊的 PDF / Word 用本地规则识别不准时，可以让大模型帮你把题目抽出来。完全可选，不配置也不影响其它功能。',
    }),
    el('div.row.wrap.mt12', {}, [
      el(`span.pill${configured ? '.ok' : '.gray'}`, { text: configured ? '已配置' : '未配置' }),
      el('span.pill', { text: preset ? preset.name : draft.provider }),
      el('span.pill.gray', { text: `${draft.chunkChars} 字/块` }),
    ]),
    el('div.mt12', {}, [
      kv('服务商', preset ? preset.name : draft.provider || '未选择'),
      kv('模型', draft.model || '（未填写）'),
      kv('接口地址', draft.baseUrl || '（未填写）'),
      kv('API Key', maskKey(draft.apiKey) || '（未填写）'),
    ]),
    configured
      ? el('p.tiny.muted.mt8', { text: '已配置。去「题库」页点「🤖 用 AI 识别题库」即可开始识别。' })
      : el('p.tiny.muted.mt8', { text: '还差 API Key（或接口地址/模型名），填好并保存后才能识别。' }),
  ]);
}

/** ② 服务商选择卡片 */
function providerCard(root) {
  const rows = AI_PROVIDERS.map((p) => {
    const active = draft.provider === p.id;
    const chip = el(`button.chip${active ? '.active' : ''}`, {
      type: 'button',
      text: p.name,
      onclick: () => {
        draft.provider = p.id;
        // 预设直接带出接口地址与模型名；自定义则是空值，由用户自己填
        draft.baseUrl = p.baseUrl || '';
        draft.model = p.model || '';
        render(root);
      },
    });
    return el('div.row.mt8', {}, [
      el('div.grow', {}, [chip]),
      p.free ? el('span.pill.ok', { text: '免费额度' }) : null,
      p.keyUrl
        ? el('a.tiny', {
            href: p.keyUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: '申请 Key ↗',
          })
        : null,
    ]);
  });

  const preset = findProvider(draft.provider);
  return el('div.card', {}, [
    el('h3.card-title', { text: '选择服务商' }),
    el('p.card-sub', {
      text: '都是 OpenAI 兼容接口，选一个填上 Key 即可。「智谱 GLM-4-Flash」「硅基流动」有免费模型，可以先拿它们试。',
    }),
    ...rows,
    el('p.tiny.muted.mt12', {
      text: preset && preset.id === 'custom'
        ? '自定义：请把完整的 Base URL（例如 https://api.example.com/v1）与模型名填到下面。'
        : '选中后会自动填好接口地址与模型名；也可以在下面对它们做微调。',
    }),
  ]);
}

/** 单行输入框字段 */
function field(labelText, input, hint) {
  return el('div.field', {}, [
    el('label', { text: labelText }),
    input,
    hint ? el('p.tiny.muted', { text: hint }) : null,
  ]);
}

/** ③ 参数卡片（填写 + 测试连接 + 保存/清除） */
function paramCard(root) {
  /* --- API Key（可显示/隐藏） --- */
  const keyInput = el('input', {
    type: 'password',
    value: draft.apiKey,
    placeholder: '粘贴服务商给你的 Key（只保存在本机）',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => {
      draft.apiKey = e.target.value;
    },
  });
  const toggleBtn = el('button.btn.sm', {
    type: 'button',
    text: '显示',
    onclick: () => {
      const show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      toggleBtn.textContent = show ? '隐藏' : '显示';
    },
  });

  /* --- Base URL / 模型名 --- */
  const baseUrlInput = el('input', {
    type: 'text',
    value: draft.baseUrl,
    placeholder: '例如 https://open.bigmodel.cn/api/paas/v4',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => {
      draft.baseUrl = e.target.value;
    },
  });
  const modelInput = el('input', {
    type: 'text',
    value: draft.model,
    placeholder: '例如 glm-4-flash',
    autocomplete: 'off',
    spellcheck: 'false',
    oninput: (e) => {
      draft.model = e.target.value;
    },
  });

  /* --- 分块字符数 --- */
  const chunkInput = el('input', {
    type: 'text',
    inputmode: 'numeric',
    value: String(draft.chunkChars),
    placeholder: '6000',
    oninput: (e) => {
      draft.chunkChars = Number(String(e.target.value).replace(/[^\d]/g, '')) || draft.chunkChars;
    },
  });

  /* --- 测试连接 --- */
  const resultNode = el('p.tiny.pre-wrap.mt8.hidden');
  const testBtn = el('button.btn.block.mt8', {
    type: 'button',
    text: '🔌 测试连接',
    onclick: async () => {
      testBtn.disabled = true;
      resultNode.classList.add('hidden');
      loading('正在测试连接…');
      try {
        const res = await testAiConnection(draft);
        resultNode.textContent = `${res.ok ? '✅' : '❌'} ${res.message}（模型：${res.model || '未填写'}，耗时 ${res.elapsedMs} ms）`;
        resultNode.classList.remove('hidden');
        if (res.ok) toast('连接成功', 2400);
        else toast(`连接失败：${res.message}`, 4200);
      } catch (err) {
        // testAiConnection 本身不抛异常，这里只是兜底
        console.warn('AI 设置页：测试连接异常', err);
        resultNode.textContent = `❌ ${err && err.message ? err.message : err}`;
        resultNode.classList.remove('hidden');
        toast('测试连接失败', 3600);
      } finally {
        loading(false);
        testBtn.disabled = false;
      }
    },
  });

  /* --- 保存 / 清除 --- */
  const saveBtn = el('button.btn.primary.block.mt12', {
    type: 'button',
    text: '保存',
    onclick: () => {
      const saved = saveAiSettings({
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model,
        apiKey: draft.apiKey,
        chunkChars: draft.chunkChars,
        enabled: true,
      });
      draft = saved;
      toast(isAiConfigured(saved) ? '已保存 AI 配置' : '已保存（还差 API Key 才能真正识别）', 3200);
      render(root);
    },
  });

  const clearBtn = el('button.btn.bad.block.mt8', {
    type: 'button',
    text: '清除配置',
    onclick: async () => {
      const ok = await confirmDialog({
        title: '清除 AI 配置？',
        message: 'API Key、接口地址与模型名都会从本机删除。清除后无法再用 AI 识别，其它功能不受影响。',
        okText: '清除',
        danger: true,
      });
      if (!ok) return;
      draft = clearAiSettings();
      toast('已清除 AI 配置');
      render(root);
    },
  });

  return el('div.card', {}, [
    el('h3.card-title', { text: '参数' }),
    field('API Key', el('div.row', {}, [el('div.grow', {}, [keyInput]), toggleBtn]), '只保存在本机浏览器（localStorage），不会写进题库，也不会出现在日志里。'),
    field('Base URL（接口地址）', baseUrlInput, '末尾不要加 /chat/completions，程序会自己拼接。'),
    field('模型名', modelInput),
    field('分块字符数', chunkInput, '默认 6000。太大容易超时/超出上下文，太小会多花请求次数与额度。'),
    testBtn,
    resultNode,
    el('div.divider'),
    saveBtn,
    clearBtn,
  ]);
}

/** ④ 说明卡片 */
function noticeCard() {
  return el('div.card', {}, [
    el('h3.card-title', { text: '使用须知（请先读一下）' }),
    el('p.card-sub.pre-wrap', {
      text:
        '1. 用 AI 识别时，**会把你在这一步选中的题库文件文本上传到你选择的服务商服务器**（题目里如果含个人信息请注意）；\n' +
        '   本程序本体是离线优先的：不点「用 AI 识别题库」就完全不会联网。\n' +
        '2. API Key 由你自己去服务商官网申请，本程序不提供、不代付，也不会把 Key 发给除该服务商以外的任何地方。\n' +
        '3. 有免费额度的服务商：智谱 GLM-4-Flash、硅基流动的部分小模型；其余服务商按量计费，请注意额度。\n' +
        '4. AI 识别结果可能出错（漏题、题型判错、答案错位），导入前请先看预览，把明显不对的题删掉。\n' +
        '5. 不想用或识别失败也没关系：用「导入题库」的本地规则解析即可，功能完全一样。',
    }),
    el('div.mt12', {}, [
      el('button.btn.block', {
        type: 'button',
        text: '← 回题库页试试导入',
        onclick: () => navigate('banks', {}, { push: false }),
      }),
    ]),
  ]);
}
