import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  assertPathWithinDirectory,
  buildExtension,
  ChromeManifestShape,
  verifyPngDimensions,
} from './build-extension.script';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DIST_DIR = path.resolve(PROJECT_ROOT, 'dist');
const DEFAULT_RELEASE_DIR = path.resolve(PROJECT_ROOT, 'release');

const DISALLOWED_ARCHIVE_EXTENSIONS = ['.pem', '.key', '.crx', '.map'];

// Deterministic MS-DOS timestamp (2026-01-01 00:00:00) for reproducible ZIP builds.
const DETERMINISTIC_DOS_TIME = 0x0000;
const DETERMINISTIC_DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const UNIX_REGULAR_FILE_ATTR = (0o100644 << 16) >>> 0;

export interface ZipEntryInputInterface {
  readonly relativePosixPath: string;
  readonly data: Buffer;
}

export interface PackageExtensionOptionsInterface {
  readonly distDir?: string;
  readonly releaseDir?: string;
  readonly skipBuild?: boolean;
}

export interface PackageExtensionResultInterface {
  readonly zipPath: string;
  readonly versionedZipPath: string;
  readonly version: string;
  readonly entries: readonly string[];
  readonly sizeBytes: number;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function computeCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encodes a standards-compliant PKZIP (v2.0 DEFLATE, UTF-8 POSIX paths) archive in pure Node.js.
 */
export function createDeterministicZipArchive(entries: readonly ZipEntryInputInterface[]): Buffer {
  if (entries.length === 0) {
    throw new Error('Cannot create an empty Chrome Web Store ZIP archive.');
  }

  const sortedEntries = [...entries].sort((a, b) =>
    a.relativePosixPath.localeCompare(b.relativePosixPath)
  );

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of sortedEntries) {
    if (
      entry.relativePosixPath.startsWith('/') ||
      entry.relativePosixPath.includes('\\') ||
      entry.relativePosixPath.split('/').includes('..')
    ) {
      throw new Error(`Unsafe ZIP entry path rejected: ${entry.relativePosixPath}`);
    }

    const fileNameBuf = Buffer.from(entry.relativePosixPath, 'utf8');
    const uncompressedBuf = entry.data;
    const compressedBuf = zlib.deflateRawSync(uncompressedBuf, { level: 9 });
    const crc = computeCrc32(uncompressedBuf);

    // Local File Header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + fileNameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(8, 8); // Compression method: DEFLATE
    localHeader.writeUInt16LE(DETERMINISTIC_DOS_TIME, 10);
    localHeader.writeUInt16LE(DETERMINISTIC_DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(uncompressedBuf.length, 22);
    localHeader.writeUInt16LE(fileNameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    fileNameBuf.copy(localHeader, 30);

    localChunks.push(localHeader, compressedBuf);

    // Central Directory File Header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + fileNameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(0x0314, 4); // Version made by: Unix (3) + PKZIP 2.0 (20)
    centralHeader.writeUInt16LE(20, 6); // Version needed to extract (2.0)
    centralHeader.writeUInt16LE(0x0800, 8); // General purpose bit flag (UTF-8)
    centralHeader.writeUInt16LE(8, 10); // Compression method: DEFLATE
    centralHeader.writeUInt16LE(DETERMINISTIC_DOS_TIME, 12);
    centralHeader.writeUInt16LE(DETERMINISTIC_DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(uncompressedBuf.length, 24);
    centralHeader.writeUInt16LE(fileNameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE(UNIX_REGULAR_FILE_ATTR, 38); // External file attributes
    centralHeader.writeUInt32LE(localOffset, 42); // Relative offset of local header
    fileNameBuf.copy(centralHeader, 46);

    centralChunks.push(centralHeader);
    localOffset += localHeader.length + compressedBuf.length;
  }

  const centralDirectoryBuf = Buffer.concat(centralChunks);

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(sortedEntries.length, 8);
  eocd.writeUInt16LE(sortedEntries.length, 10);
  eocd.writeUInt32LE(centralDirectoryBuf.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localChunks, centralDirectoryBuf, eocd]);
}

function collectExtensionFiles(
  currentDir: string,
  baseDistDir: string
): ZipEntryInputInterface[] {
  const safeCurrent = assertPathWithinDirectory(currentDir, baseDistDir);
  const dirents = fs.readdirSync(safeCurrent, { withFileTypes: true });
  const results: ZipEntryInputInterface[] = [];

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.')) {
      continue;
    }
    const fullPath = assertPathWithinDirectory(
      path.join(safeCurrent, dirent.name),
      baseDistDir
    );
    if (dirent.isDirectory()) {
      results.push(...collectExtensionFiles(fullPath, baseDistDir));
    } else if (dirent.isFile()) {
      const ext = path.extname(dirent.name).toLowerCase();
      if (DISALLOWED_ARCHIVE_EXTENSIONS.includes(ext)) {
        throw new Error(
          `Disallowed secret or debug file found in extension dist directory: ${dirent.name}`
        );
      }
      const relativePosixPath = path
        .relative(baseDistDir, fullPath)
        .split(path.sep)
        .join('/');
      results.push({
        relativePosixPath,
        data: fs.readFileSync(fullPath),
      });
    }
  }

  return results;
}

function validateStoreReadyDist(distDir: string): ChromeManifestShape {
  const manifestPath = assertPathWithinDirectory(
    path.join(distDir, 'manifest.json'),
    distDir
  );
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing manifest.json in ${distDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ChromeManifestShape;

  if (manifest.manifest_version !== 3) {
    throw new Error('Chrome Web Store package requires manifest_version 3.');
  }
  if (!manifest.version || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error(`Invalid Chrome extension version "${manifest.version ?? ''}".`);
  }
  if (!manifest.description || manifest.description.length > 132) {
    throw new Error(
      `Chrome Web Store manifest description must be <= 132 characters (got ${manifest.description?.length ?? 0}).`
    );
  }
  if ('key' in manifest && manifest.key !== undefined) {
    throw new Error(
      'Refusing to package dist/manifest.json containing a local "key" field for Chrome Web Store upload.'
    );
  }

  for (const [sizeKey, relIconPath] of Object.entries(manifest.icons ?? {})) {
    const absIcon = assertPathWithinDirectory(path.join(distDir, relIconPath), distDir);
    if (!fs.existsSync(absIcon)) {
      throw new Error(`Missing icon referenced in manifest.json: ${relIconPath}`);
    }
    verifyPngDimensions(absIcon, Number(sizeKey));
  }

  for (const cs of manifest.content_scripts ?? []) {
    for (const jsRel of cs.js ?? []) {
      const absJs = assertPathWithinDirectory(path.join(distDir, jsRel), distDir);
      if (!fs.existsSync(absJs)) {
        throw new Error(`Missing content script referenced in manifest.json: ${jsRel}`);
      }
    }
  }

  return manifest;
}

/**
 * Builds (unless `skipBuild: true`) and packages the Chrome Web Store submission `.zip`
 * into `release/gmail-attention.zip` and `release/gmail-attention-v<version>.zip`.
 */
export function packageExtension(
  options: PackageExtensionOptionsInterface = {}
): PackageExtensionResultInterface {
  const distDir = options.distDir ? path.resolve(options.distDir) : DEFAULT_DIST_DIR;
  const releaseDir = options.releaseDir
    ? path.resolve(options.releaseDir)
    : DEFAULT_RELEASE_DIR;

  if (!options.skipBuild) {
    buildExtension({ outDir: distDir });
  }

  const manifest = validateStoreReadyDist(distDir);
  const entries = collectExtensionFiles(distDir, distDir).sort((a, b) =>
    a.relativePosixPath.localeCompare(b.relativePosixPath)
  );
  const archiveBuffer = createDeterministicZipArchive(entries);

  fs.mkdirSync(releaseDir, { recursive: true });
  const zipPath = assertPathWithinDirectory(
    path.join(releaseDir, 'gmail-attention.zip'),
    releaseDir
  );
  const versionedZipPath = assertPathWithinDirectory(
    path.join(releaseDir, `gmail-attention-v${manifest.version}.zip`),
    releaseDir
  );

  fs.writeFileSync(zipPath, archiveBuffer);
  fs.writeFileSync(versionedZipPath, archiveBuffer);

  return {
    zipPath,
    versionedZipPath,
    version: manifest.version,
    entries: entries.map((e) => e.relativePosixPath),
    sizeBytes: archiveBuffer.length,
  };
}

function main(): void {
  const skipBuild = process.argv.includes('--skip-build');
  const result = packageExtension({ skipBuild });
  process.stdout.write(
    `Packaged Gmail @tention v${result.version} (${result.sizeBytes} bytes, ${result.entries.length} files)\n` +
      `  -> ${result.zipPath}\n` +
      `  -> ${result.versionedZipPath}\n`
  );
}

if (require.main === module) {
  main();
}
