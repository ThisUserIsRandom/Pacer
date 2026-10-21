#!/usr/bin/env node
'use strict';

/**
 * Fetch a GGUF model into ./models/model.gguf for the built-in provider.
 *
 *   npm run model:download                       # default Qwen3-0.6B (Q8_0, ~640 MB)
 *   npm run model:download -- --url <gguf-url>   # any reachable GGUF
 *   npm run model:download -- --force            # overwrite an existing file
 *   npm run model:link -- /path/to/model.gguf    # reuse a model you already have
 *
 * Nothing in the app scans for models: it looks only at models/model.gguf
 * (or LOCAL_MODEL_PATH if you set it). This script is how that file gets there.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_URL =
  'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf';

const MODELS_DIR = path.join(__dirname, '..', 'models');
const OUT_PATH = path.join(MODELS_DIR, 'model.gguf');

const GGUF_MAGIC = Buffer.from('GGUF', 'ascii');

function usage() {
  console.log(`
Usage:
  node scripts/download-model.js [options]

Options:
  --url <url>     GGUF file to download (default: Qwen3-0.6B Q8_0)
  --out <path>    destination (default: models/model.gguf)
  --force         overwrite if a model is already there
  --link <gguf>   symlink/copy an existing local GGUF instead of downloading
  --help          show this message

You can also just drop any .gguf into ./models/model.gguf yourself.
`);
}

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, out: OUT_PATH, force: false, link: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--help' || flag === '-h') args.help = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--url') args.url = argv[++i];
    else if (flag === '--out') args.out = path.resolve(argv[++i]);
    else if (flag === '--link') args.link = path.resolve(argv[++i]);
    else {
      console.error(`Unknown option: ${flag}`);
      args.help = true;
    }
  }
  return args;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function looksLikeGguf(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(4);
    await handle.read(buffer, 0, 4, 0);
    return buffer.equals(GGUF_MAGIC);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close();
  }
}

async function linkExisting(source, target) {
  if (!fs.existsSync(source)) throw new Error(`No such file: ${source}`);
  if (!(await looksLikeGguf(source))) {
    throw new Error(`${source} does not start with the GGUF magic bytes.`);
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rm(target, { force: true });

  try {
    await fsp.symlink(source, target);
    console.log(`  ✓ linked ${target} -> ${source}`);
  } catch {
    await fsp.copyFile(source, target);
    console.log(`  ✓ copied ${source} -> ${target}`);
  }
  const { size } = await fsp.stat(source);
  console.log(`  size: ${human(size)}`);
}

async function download(url, target, force) {
  if (!force && fs.existsSync(target)) {
    const { size } = await fsp.stat(target);
    if (await looksLikeGguf(target)) {
      console.log(`  ✓ ${target} already exists (${human(size)}) — use --force to replace it`);
      return;
    }
    console.log(`  ${target} exists but is not a GGUF; replacing it`);
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const partPath = `${target}.part`;

  console.log(`  downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const total = Number(response.headers.get('content-length')) || 0;
  if (total) console.log(`  size: ${human(total)}`);

  const file = await fsp.open(partPath, 'w');
  const startedAt = Date.now();
  let received = 0;
  let lastReport = 0;

  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      await file.write(value);
      received += value.length;

      const now = Date.now();
      if (now - lastReport > 1000) {
        lastReport = now;
        const elapsed = (now - startedAt) / 1000;
        const rate = received / elapsed;
        const percent = total ? ` (${((received / total) * 100).toFixed(1)}%)` : '';
        process.stdout.write(
          `\r  ${human(received)}${percent} at ${human(rate)}/s          `
        );
      }
    }
  } finally {
    await file.close();
  }

  process.stdout.write('\n');

  if (!(await looksLikeGguf(partPath))) {
    await fsp.rm(partPath, { force: true });
    throw new Error('Downloaded file is not a GGUF (bad magic bytes). Removed it.');
  }

  await fsp.rename(partPath, target);
  const { size } = await fsp.stat(target);
  console.log(`  ✓ saved ${target} (${human(size)})`);
  console.log(`\n  Pick "Built-in model" in Pacer's model popup, then generate.`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    usage();
    return;
  }

  try {
    if (args.link) {
      await linkExisting(args.link, args.out);
      return;
    }
    await download(args.url, args.out, args.force);
  } catch (error) {
    console.error(`\n  ✗ ${error.message}`);
    console.error('    You can also download a GGUF manually and save it as models/model.gguf\n');
    process.exitCode = 1;
  }
})();
