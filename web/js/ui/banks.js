/** 题库首页：题库列表、导入、选择 */

import { importFile, loadBank, navigate, state } from '../app.js';
import * as repo from '../bank.js';
import * as eb from '../ebbinghaus.js';
import { el, emptyState, confirmDialog, mount, toast } from './common.js';
import { setAction } from '../app.js';

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
    el('div.row.mt12', {}, [
      el('button.btn.grow', { type: 'button', text: '导入新题库', onclick: () => onImport(root) }),
    ]),
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
