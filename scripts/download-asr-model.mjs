#!/usr/bin/env node
/**
 * Download the local ASR model files for bundling into the Electron app.
 * Places files at resources/asr-models/Xenova/whisper-tiny/
 *
 * Usage: node scripts/download-asr-model.mjs
 *
 * Environment variables:
 *   HF_MIRROR - Override HuggingFace base URL (e.g. https://hf-mirror.com)
 */
import { mkdirSync, existsSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODEL_ID = 'Xenova/whisper-tiny';
const REQUIRED_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt',
  'normalizer.json',
  'added_tokens.json',
  'special_tokens_map.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

const OUTPUT_DIR = join(
  __dirname,
  '..',
  'resources',
  'asr-models',
  ...MODEL_ID.split('/'),
);

const BASE_URL = process.env.HF_MIRROR?.replace(/\/+$/, '')
  || 'https://huggingface.co';

function fileUrl(file) {
  return `${BASE_URL}/${MODEL_ID}/resolve/main/${file}`;
}

async function downloadFile(file) {
  const dest = join(OUTPUT_DIR, file);
  if (existsSync(dest)) {
    console.log(`  OK ${file} (cached)`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const url = fileUrl(file);
  console.log(`  GET ${file}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`Empty response body for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  console.log(`Downloading local ASR model to ${OUTPUT_DIR}`);
  console.log(`Source: ${BASE_URL}/${MODEL_ID}`);
  console.log('');

  for (const file of REQUIRED_FILES) {
    await downloadFile(file);
  }

  console.log('');
  console.log('Done. Local ASR model ready for bundling.');
}

main().catch((err) => {
  console.error('Failed to download ASR model:', err.message);
  process.exitCode = 1;
});

