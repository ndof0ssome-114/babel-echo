// Only explicitly selected Markdown and contained raster images can be read.
const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp' };
async function readMarkdownFile(filePath) {
  if (typeof filePath !== 'string' || !/\.(md|markdown|txt)$/i.test(filePath)) throw new Error('请选择 Markdown 或 TXT 文件');
  const file = await fs.realpath(filePath);
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件不能超过 2 MB');
  const data = await fs.readFile(file);
  if (data.length > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件不能超过 2 MB');
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
    : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(data);
  if (text.includes('\0')) throw new Error('文件包含二进制内容，请使用 UTF-8 或带 BOM 的 UTF-16 文本');
  return { text, title: path.basename(file), filePath: file, baseDir: path.dirname(file) };
}
async function readRelativeImage(baseDir, reference) {
  if (!baseDir || typeof reference !== 'string' || reference.length > 4096) throw new Error('此文档没有本地图片目录');
  const decoded = decodeURIComponent(reference.split(/[?#]/)[0]);
  if (!decoded || decoded.includes('\0') || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(decoded)) throw new Error('仅允许文档目录内的相对图片');
  const base = await fs.realpath(baseDir);
  const target = await fs.realpath(path.resolve(base, decoded));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('图片必须位于文档目录内');
  const mime = imageTypes[path.extname(target).toLowerCase()];
  if (!mime) throw new Error('仅支持 PNG/JPEG/GIF/WebP/AVIF/BMP 本地图片');
  const info = await fs.stat(target);
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 8 MB');
  const data = await fs.readFile(target);
  if (data.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 8 MB');
  return { mime, base64: data.toString('base64') };
}
function isExternalLink(value) {
  try { return ['https:', 'http:', 'mailto:'].includes(new URL(value).protocol); }
  catch { return false; }
}
/**
 * Markdown files the operating system asked us to open: double-clicking a .md file passes its
 * path as an argument (Windows, Linux; macOS uses the open-file event instead). Switches and
 * the executable is skipped; only .md/.markdown paths are returned.
 */
function markdownPathsFromArgv(argv) {
  if (!Array.isArray(argv)) return [];
  // Only the executable is skipped by position: Chromium moves its own switches in front of
  // positional arguments, so the script path ('.') is not always argv[1]. It is not a .md file
  // and falls out of the filter anyway.
  return argv.slice(1)
    .filter((arg) => typeof arg === 'string' && !arg.startsWith('-') && /\.(md|markdown)$/i.test(arg));
}

/** The Uniform Type Identifier macOS uses for Markdown (declared in the app's Info.plist). */
const MARKDOWN_UTI = 'net.daringfireball.markdown';

/**
 * A JavaScript-for-Automation script that makes the app with `bundleId` the default handler for
 * Markdown. macOS may ask the user to confirm. Prints the OSStatus (0 = success).
 */
function macDefaultHandlerScript(bundleId) {
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('invalid bundle id');
  return [
    "ObjC.import('CoreServices');",
    `const status = $.LSSetDefaultRoleHandlerForContentType($('${MARKDOWN_UTI}'), $.kLSRolesAll, $('${bundleId}'));`,
    'status;',
  ].join('\n');
}

module.exports = { readMarkdownFile, readRelativeImage, isExternalLink, MAX_MARKDOWN_BYTES,
  markdownPathsFromArgv, macDefaultHandlerScript, MARKDOWN_UTI };
