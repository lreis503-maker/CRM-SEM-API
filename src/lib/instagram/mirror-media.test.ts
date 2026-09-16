import { describe, expect, it, vi } from 'vitest';
import { mirrorInstagramMedia } from './mirror-media';

function fakeStorage(uploadError: { message: string } | null = null) {
  return {
    from: () => ({
      upload: vi.fn().mockResolvedValue({ error: uploadError }),
      getPublicUrl: () => ({ data: { publicUrl: 'https://example.com/mirrored.jpg' } }),
    }),
  };
}

describe('mirrorInstagramMedia', () => {
  it('downloads and uploads the file, returning the public URL', async () => {
    const download = vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake-bytes'),
      contentType: 'image/jpeg',
    });
    const url = await mirrorInstagramMedia({
      storage: fakeStorage(),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.jpg',
      stableId: 'mid-1-image',
      fallbackExtension: 'jpg',
      downloadFn: download,
    });
    expect(url).toBe('https://example.com/mirrored.jpg');
    expect(download).toHaveBeenCalledWith('https://cdn.example/original.jpg');
  });

  it('returns null when the download throws', async () => {
    const download = vi.fn().mockRejectedValue(new Error('network error'));
    const url = await mirrorInstagramMedia({
      storage: fakeStorage(),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.jpg',
      stableId: 'mid-1-image',
      fallbackExtension: 'jpg',
      downloadFn: download,
    });
    expect(url).toBeNull();
  });

  it('returns null when the storage upload fails', async () => {
    const download = vi.fn().mockResolvedValue({
      buffer: Buffer.from('fake-bytes'),
      contentType: 'image/jpeg',
    });
    const url = await mirrorInstagramMedia({
      storage: fakeStorage({ message: 'mime rejected' }),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.jpg',
      stableId: 'mid-1-image',
      fallbackExtension: 'jpg',
      downloadFn: download,
    });
    expect(url).toBeNull();
  });

  it('returns null for a file over the size limit', async () => {
    const oversized = Buffer.alloc(17 * 1024 * 1024);
    const download = vi.fn().mockResolvedValue({ buffer: oversized, contentType: 'video/mp4' });
    const url = await mirrorInstagramMedia({
      storage: fakeStorage(),
      accountId: 'acc-1',
      sourceUrl: 'https://cdn.example/original.mp4',
      stableId: 'mid-1-video',
      fallbackExtension: 'mp4',
      downloadFn: download,
    });
    expect(url).toBeNull();
  });
});
