import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { createImageAssetFromClipboardData } from './clipboardUtils';

const fileSystemMocks = vi.hoisted(() => {
  const createDirectory = vi.fn();
  const writeFile = vi.fn();

  const joinUri = (parts: (string | { uri: string })[]) =>
    parts
      .map((part) => (typeof part === 'string' ? part : part.uri))
      .map((part) => part.replace(/\/+$/, ''))
      .join('/');

  class MockDirectory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = `${joinUri(parts)}/`;
    }
    create(options?: object) {
      createDirectory(this.uri, options);
    }
  }

  class MockFile {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = joinUri(parts);
    }
    write(content: string, options?: object) {
      writeFile(this.uri, content, options);
    }
  }

  return {
    createDirectory,
    writeFile,
    Directory: MockDirectory,
    File: MockFile,
    Paths: { cache: { uri: 'file:///cache/' } },
  };
});

const imageMocks = vi.hoisted(() => ({
  imageSize: vi.fn(),
}));

const fileMocks = vi.hoisted(() => ({
  getFileSize: vi.fn(),
}));

vi.mock('expo-file-system', () => ({
  Directory: fileSystemMocks.Directory,
  File: fileSystemMocks.File,
  Paths: fileSystemMocks.Paths,
}));
vi.mock('../../utils/images', () => imageMocks);
vi.mock('../../utils/files', () => fileMocks);
vi.mock('expo-clipboard', () => ({}));
vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}));

beforeEach(() => {
  fileSystemMocks.createDirectory.mockReset();
  fileSystemMocks.writeFile.mockReset();
  imageMocks.imageSize.mockReset();
  imageMocks.imageSize.mockResolvedValue([640, 480]);
  fileMocks.getFileSize.mockReset();
  fileMocks.getFileSize.mockReturnValue(3);
  vi.spyOn(Date, 'now').mockReturnValue(123);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('writes base64 clipboard images to a cache file', async () => {
  const asset = await createImageAssetFromClipboardData({
    data: 'AAAA',
    mimeType: 'image/png',
  });

  expect(fileSystemMocks.createDirectory).toHaveBeenCalledWith(
    'file:///cache/clipboard-images/',
    { intermediates: true, idempotent: true }
  );
  expect(fileSystemMocks.writeFile).toHaveBeenCalledWith(
    'file:///cache/clipboard-images/clipboard-123.png',
    'AAAA',
    { encoding: 'base64' }
  );
  expect(imageMocks.imageSize).toHaveBeenCalledWith(
    'file:///cache/clipboard-images/clipboard-123.png'
  );
  expect(asset).toMatchObject({
    assetId: 'clipboard-123',
    uri: 'file:///cache/clipboard-images/clipboard-123.png',
    width: 640,
    height: 480,
    fileName: 'clipboard-image.png',
    fileSize: 3,
    mimeType: 'image/png',
    type: 'image',
  });
});

test('uses the mime type embedded in data uris', async () => {
  const asset = await createImageAssetFromClipboardData({
    data: 'data:image/jpeg;base64,AAAA',
    mimeType: 'image/png',
  });

  expect(fileSystemMocks.writeFile).toHaveBeenCalledWith(
    'file:///cache/clipboard-images/clipboard-123.jpg',
    'AAAA',
    { encoding: 'base64' }
  );
  expect(asset).toMatchObject({
    uri: 'file:///cache/clipboard-images/clipboard-123.jpg',
    fileName: 'clipboard-image.jpg',
    mimeType: 'image/jpeg',
  });
});
