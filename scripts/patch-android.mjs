/**
 * 给 `npx cap add android` 生成的安卓工程注入「稳定签名」配置。
 *
 * 为什么需要：CI 每次运行都是全新的 runner，Android 默认的 debug 签名每个 runner 都不同，
 * 会导致新 APK 无法覆盖安装（签名不一致必须卸载重装，本地数据会丢）。
 * 仓库里自带一个自签名 PKCS12 密钥库（keystore/quiz-release.p12），
 * 用它签名后每次构建签名一致，可以直接覆盖升级。
 *
 * 用法：
 *   node scripts/patch-android.mjs            # 注入
 *   node scripts/patch-android.mjs --revert   # 移除注入内容（回退到默认 debug 签名）
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ANDROID = resolve(ROOT, 'android');
const GRADLE = resolve(ANDROID, 'app/build.gradle');
const KEYSTORE = resolve(ROOT, 'keystore/quiz-release.p12');
const RES_SRC = resolve(ROOT, 'resources/android');
const RES_DST = resolve(ANDROID, 'app/src/main/res');

const MARK_BEGIN = '// === 刷题助手：稳定签名配置（scripts/patch-android.mjs 自动注入，勿手动修改） ===';
const MARK_END = '// === 刷题助手：稳定签名配置结束 ===';

const BLOCK = `
${MARK_BEGIN}
android {
    signingConfigs {
        quiz {
            // 仓库自带的侧载自签名密钥库（PKCS12），保证每次 CI 构建签名一致
            storeFile file("../../keystore/quiz-release.p12")
            storePassword "quizmobile2026"
            keyAlias "quizmobile"
            keyPassword "quizmobile2026"
            storeType "PKCS12"
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.quiz
        }
        release {
            signingConfig signingConfigs.quiz
            minifyEnabled false
        }
    }
}
${MARK_END}
`;

function stripBlock(text) {
  const start = text.indexOf(MARK_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(MARK_END);
  if (end < 0) return text.slice(0, start);
  return text.slice(0, start) + text.slice(end + MARK_END.length);
}

function applyIcons() {
  if (!existsSync(RES_SRC) || !existsSync(RES_DST)) {
    console.warn(`跳过图标替换（缺少 ${RES_SRC} 或 ${RES_DST}）`);
    return;
  }
  let count = 0;
  for (const density of readdirSyncSafe(RES_SRC)) {
    const src = join(RES_SRC, density);
    const dst = join(RES_DST, density);
    if (!existsSync(dst)) continue;
    mkdirSync(dst, { recursive: true });
    for (const file of readdirSyncSafe(src)) {
      cpSync(join(src, file), join(dst, file));
      count += 1;
    }
  }
  // 自适应图标背景色
  const colorFile = join(RES_DST, 'values/ic_launcher_background.xml');
  if (existsSync(colorFile)) {
    writeFileSync(colorFile, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#2563EB</color>
</resources>
`, 'utf8');
    count += 1;
  }
  console.log(`已替换安卓启动图标：${count} 个文件`);
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function main() {
  const revert = process.argv.includes('--revert');
  if (!existsSync(GRADLE)) {
    console.error(`找不到安卓工程文件：${GRADLE}`);
    console.error('请先执行：npx cap add android');
    process.exit(1);
  }
  let text = readFileSync(GRADLE, 'utf8');
  text = stripBlock(text).replace(/\s*$/, '\n');

  if (!revert) {
    applyIcons();
    if (!existsSync(KEYSTORE)) {
      console.error(`找不到密钥库：${KEYSTORE}`);
      console.error('可执行 python tools/make_keystore.py 生成，或改用默认 debug 签名（加 --revert）。');
      process.exit(1);
    }
    text += BLOCK;
    console.log(`已注入稳定签名配置：${GRADLE}`);
    console.log(`  密钥库：${KEYSTORE}`);
  } else {
    console.log(`已移除稳定签名配置（将使用默认 debug 签名）：${GRADLE}`);
  }
  writeFileSync(GRADLE, text, 'utf8');
}

main();
