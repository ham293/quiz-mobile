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

const MANIFEST = resolve(ANDROID, 'app/src/main/AndroidManifest.xml');

/**
 * 可选：去掉 INTERNET 权限（本应用完全离线，不需要联网）。
 * 默认**不**去掉 —— Capacitor 的 WebView 默认从 https://localhost 加载本地资源，
 * 保留该权限最保险；确认自己的设备上没问题后，可以用 `--strip-internet` 生成无网络权限的包。
 */
function stripInternetPermission() {
  if (!existsSync(MANIFEST)) {
    console.warn(`跳过权限处理（找不到 ${MANIFEST}）`);
    return;
  }
  let xml = readFileSync(MANIFEST, 'utf8');
  const before = xml;
  xml = xml.replace(/\s*<uses-permission[^>]*android\.permission\.INTERNET[^>]*\/>/g, '');
  if (xml === before) {
    console.log('未找到 INTERNET 权限（可能已移除）');
    return;
  }
  writeFileSync(MANIFEST, xml, 'utf8');
  console.log('已移除 INTERNET 权限（应用完全离线）');
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
    text = syncVersion(text); // 注意要接住返回值，否则改动会丢掉
    if (process.argv.includes('--strip-internet')) stripInternetPermission();
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

/**
 * 把 package.json 里的版本号同步进安卓工程：
 *   versionName = 1.0.1，versionCode = 主*10000 + 次*100 + 修订（1.0.1 → 10001）。
 * 这样每次发新版，系统看到的版本号是递增的。
 */
function syncVersion(gradleText) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const [maj = 1, min = 0, rev = 0] = String(pkg.version || '1.0.0').split('.').map((n) => Number(n) || 0);
    const versionCode = maj * 10000 + min * 100 + rev;
    const before = gradleText;
    const next = gradleText
      .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
      .replace(/versionName\s+"[^"]*"/, `versionName "${pkg.version}"`);
    if (next !== before) {
      console.log(`已同步版本号：versionName=${pkg.version} versionCode=${versionCode}`);
    }
    return next;
  } catch (err) {
    console.warn('同步版本号失败（忽略）:', err && err.message);
    return gradleText;
  }
}

main();
