import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { buildExtension } from '../scripts/build-extension.script';
import {
  computeCrc32,
  createDeterministicZipArchive,
  packageExtension,
} from '../scripts/package-extension.script';

/**
 * Minimal PKZIP reader in pure Node.js to verify local headers, central directory,
 * EOCD record, CRC32 checksums, and deflated payloads independently.
 */
function parseAndInflateZip(zipBuf: Buffer): Map<string, Buffer> {
  // Locate EOCD at the end of the buffer (22 bytes with 0-length comment)
  const eocdOffset = zipBuf.length - 22;
  expect(zipBuf.readUInt32LE(eocdOffset)).toBe(0x06054b50);

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuf.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  expect(centralDirOffset + centralDirSize).toBe(eocdOffset);

  const extracted = new Map<string, Buffer>();
  let cdCursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i++) {
    expect(zipBuf.readUInt32LE(cdCursor)).toBe(0x02014b50);
    const method = zipBuf.readUInt16LE(cdCursor + 10);
    const expectedCrc = zipBuf.readUInt32LE(cdCursor + 16);
    const compressedSize = zipBuf.readUInt32LE(cdCursor + 20);
    const uncompressedSize = zipBuf.readUInt32LE(cdCursor + 24);
    const fileNameLen = zipBuf.readUInt16LE(cdCursor + 28);
    const extraLen = zipBuf.readUInt16LE(cdCursor + 30);
    const commentLen = zipBuf.readUInt16LE(cdCursor + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(cdCursor + 42);

    const fileName = zipBuf
      .subarray(cdCursor + 46, cdCursor + 46 + fileNameLen)
      .toString('utf8');
    cdCursor += 46 + fileNameLen + extraLen + commentLen;

    // Verify matching Local File Header
    expect(zipBuf.readUInt32LE(localHeaderOffset)).toBe(0x04034b50);
    expect(zipBuf.readUInt16LE(localHeaderOffset + 8)).toBe(method);
    expect(zipBuf.readUInt32LE(localHeaderOffset + 14)).toBe(expectedCrc);
    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedSlice = zipBuf.subarray(dataStart, dataStart + compressedSize);

    const inflated =
      method === 8 ? zlib.inflateRawSync(compressedSlice) : Buffer.from(compressedSlice);
    expect(inflated.length).toBe(uncompressedSize);
    expect(computeCrc32(inflated)).toBe(expectedCrc);

    extracted.set(fileName, inflated);
  }

  return extracted;
}

describe('packageExtension & createDeterministicZipArchive', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-pkg-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('builds and packages a deterministic, Chrome Web Store-ready Manifest V3 ZIP archive', () => {
    const distDir = path.join(tmpRoot, 'dist');
    const releaseDir = path.join(tmpRoot, 'release');

    buildExtension({ outDir: distDir, skipTypecheck: true });
    const result = packageExtension({
      distDir,
      releaseDir,
      skipBuild: true,
    });

    expect(result.version).toBe('1.0.1');
    expect(fs.existsSync(result.zipPath)).toBe(true);
    expect(fs.existsSync(result.versionedZipPath)).toBe(true);
    expect(result.entries).toEqual([
      'content.js',
      'icons/icon-128.png',
      'icons/icon-16.png',
      'icons/icon-32.png',
      'icons/icon-48.png',
      'manifest.json',
      'popup.html',
      'popup.js',
    ]);

    const zipBytes = fs.readFileSync(result.zipPath);
    const extracted = parseAndInflateZip(zipBytes);
    expect(Array.from(extracted.keys()).sort()).toEqual([...result.entries].sort());

    const packagedManifest = JSON.parse(
      extracted.get('manifest.json')!.toString('utf8')
    ) as Record<string, unknown>;
    expect(packagedManifest['manifest_version']).toBe(3);
    expect(packagedManifest['name']).toBe('Gmail @tention');
    expect(packagedManifest['key']).toBeUndefined();
    expect(packagedManifest['action']).toEqual({
      default_title: 'Gmail @tention',
      default_popup: 'popup.html',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
    });
    expect(packagedManifest['host_permissions']).toEqual(['https://mail.google.com/*']);
  });

  it('refuses to package a dist directory whose manifest.json contains a local developer "key"', () => {
    const distDir = path.join(tmpRoot, 'dist-with-key');
    const releaseDir = path.join(tmpRoot, 'release');
    const keyFile = path.join(tmpRoot, 'dev.pub.pem');
    fs.writeFileSync(
      keyFile,
      '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtestkey\n-----END PUBLIC KEY-----\n',
      'utf8'
    );

    buildExtension({
      outDir: distDir,
      devKeyFilePath: keyFile,
      skipTypecheck: true,
    });

    expect(() =>
      packageExtension({
        distDir,
        releaseDir,
        skipBuild: true,
      })
    ).toThrow(/local "key" field/);
  });

  it('rejects disallowed secret files (.pem / .key) and path-traversal ZIP entries', () => {
    expect(() =>
      createDeterministicZipArchive([
        { relativePosixPath: '../escape.txt', data: Buffer.from('nope') },
      ])
    ).toThrow(/Unsafe ZIP entry path/);

    const distDir = path.join(tmpRoot, 'dist-dirty');
    const releaseDir = path.join(tmpRoot, 'release');
    buildExtension({ outDir: distDir, skipTypecheck: true });
    fs.writeFileSync(path.join(distDir, 'private.pem'), 'secret', 'utf8');

    expect(() =>
      packageExtension({
        distDir,
        releaseDir,
        skipBuild: true,
      })
    ).toThrow(/Disallowed secret or debug file/);
  });
});
