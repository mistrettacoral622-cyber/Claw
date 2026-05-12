import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, getDataDir, getResourcesDir } from '../../utils/paths';

export const LOCAL_ASR_MODEL_ID = 'Xenova/whisper-tiny';
const LOCAL_ASR_MODEL_ROOT = 'asr-models';

type TransformersModule = typeof import('@xenova/transformers');
type AsrPipeline = Awaited<ReturnType<TransformersModule['pipeline']>>;
type AsrOutput = {
  text?: string;
};

type TranscribeLocalInput = {
  wavBase64: string;
  language?: string;
};

let pipelinePromise: Promise<AsrPipeline> | null = null;

export function getLocalAsrModelCacheDir(): string {
  const configured = process.env.KTCLAW_ASR_MODEL_CACHE?.trim();
  if (configured) return configured;
  return join(getDataDir(), LOCAL_ASR_MODEL_ROOT);
}

export function getLocalAsrBundledModelPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.KTCLAW_ASR_LOCAL_MODEL_PATH?.trim();
  if (configured && hasLocalAsrModelFiles(configured)) return configured;

  const candidates = [
    join(getResourcesDir(), LOCAL_ASR_MODEL_ROOT),
    join(process.cwd(), 'resources', LOCAL_ASR_MODEL_ROOT),
  ];

  for (const candidate of candidates) {
    if (hasLocalAsrModelFiles(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function hasBundledLocalAsrModel(): boolean {
  const modelRoot = getLocalAsrBundledModelPath();
  return modelRoot ? hasLocalAsrModelFiles(modelRoot) : false;
}

function hasLocalAsrModelFiles(modelRoot: string): boolean {
  const resolvedModelRoot = join(modelRoot, ...LOCAL_ASR_MODEL_ID.split('/'));
  return [
    'config.json',
    'generation_config.json',
    'preprocessor_config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'vocab.json',
    'merges.txt',
    'normalizer.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
  ].every((relativePath) => existsSync(join(resolvedModelRoot, relativePath)));
}

export async function transcribeLocalSpeech(input: TranscribeLocalInput): Promise<{ text: string }> {
  if (!input.wavBase64?.trim()) {
    throw new Error('No audio data was provided');
  }

  const buffer = Buffer.from(input.wavBase64, 'base64');
  const samples = bufferToFloat32Pcm(buffer);
  const transcriber = await getLocalAsrPipeline();
  const result = await transcriber(samples, {
    language: normalizeWhisperLanguage(input.language),
    task: 'transcribe',
  }) as AsrOutput;

  return { text: result.text?.trim() ?? '' };
}

async function getLocalAsrPipeline(): Promise<AsrPipeline> {
  pipelinePromise ??= loadLocalAsrPipeline().catch((error) => {
    pipelinePromise = null;
    throw error;
  });
  return pipelinePromise;
}

async function loadLocalAsrPipeline(): Promise<AsrPipeline> {
  const transformers = await import('@xenova/transformers');
  const cacheDir = getLocalAsrModelCacheDir();
  ensureDir(cacheDir);
  transformers.env.cacheDir = cacheDir;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;

  const localModelPath = getLocalAsrBundledModelPath();
  if (!localModelPath || !hasBundledLocalAsrModel()) {
    throw new Error('Local ASR model is not bundled. Run pnpm run asr:model:download before packaging.');
  }
  transformers.env.localModelPath = localModelPath;

  return await transformers.pipeline('automatic-speech-recognition', LOCAL_ASR_MODEL_ID, {
    quantized: true,
    local_files_only: true,
  });
}

function normalizeWhisperLanguage(language?: string): string {
  const normalized = language?.toLowerCase() ?? '';
  if (normalized.startsWith('zh') || normalized.includes('cn')) {
    return 'chinese';
  }
  if (normalized.startsWith('en')) {
    return 'english';
  }
  return 'chinese';
}

function bufferToFloat32Pcm(buffer: Buffer): Float32Array {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV audio payload');
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkId === 'fmt ') {
      audioFormat = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
      break;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (audioFormat !== 1 || channels < 1 || bitsPerSample !== 16 || dataOffset < 0) {
    throw new Error('Unsupported WAV format for local ASR');
  }

  const frameCount = Math.floor(dataSize / (channels * 2));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = dataOffset + (frame * channels + channel) * 2;
      sum += buffer.readInt16LE(sampleOffset) / 32768;
    }
    samples[frame] = sum / channels;
  }
  return samples;
}
