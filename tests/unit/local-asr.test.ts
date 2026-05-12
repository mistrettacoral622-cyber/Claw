import { describe, expect, it, vi } from 'vitest';

vi.mock('@electron/utils/paths', () => ({
  ensureDir: vi.fn(),
  getDataDir: () => 'C:/tmp/ktclaw-data',
  getResourcesDir: () => 'C:/tmp/ktclaw-resources',
}));

describe('local ASR service', () => {
  it('rejects invalid WAV payloads before loading the bundled model', async () => {
    const { transcribeLocalSpeech } = await import('@electron/services/asr/local-asr');

    await expect(transcribeLocalSpeech({ wavBase64: Buffer.from('not wav').toString('base64') }))
      .rejects
      .toThrow('Invalid WAV audio payload');
  });
});
