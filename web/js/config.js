/** 应用级常量 */

export const APP_NAME = '刷题助手';
export const APP_VERSION = '1.0.1';

/** 艾宾浩斯复习间隔（天） */
export const EBBINGHAUS_INTERVALS = [0, 1, 2, 4, 7, 15, 30];

/** 连续答对多少次后移出错题本 */
export const GRADUATE_STREAK = 7;

/** 支持导入的文件后缀 */
export const SUPPORTED_SUFFIXES = ['.docx', '.pdf', '.txt', '.md'];
export const LEGACY_SUFFIXES = ['.doc'];

/** 错题本/收藏本预览条数 */
export const PREVIEW_LIMIT = 20;

/** 每轮练习最多题目数（0 表示不限制） */
export const MAX_SESSION_SIZE = 0;
