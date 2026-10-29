import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.resolve(PROJECT_ROOT, 'src');
const SRC_ICONS_DIR = path.resolve(SRC_DIR, 'icons');
const DIST_DIR = path.resolve(PROJECT_ROOT, 'dist');

const ICON_SIZES = [16, 32, 48, 128] as const;

export interface ChromeManifestShape {
  manifest_version: number;
  name: string;
  version: string;
  description: string;
  key?: string;
  icons?: Record<string, string>;
  content_scripts?: Array<{ js?: string[]; matches?: string[] }>;
}

export interface BuildExtensionOptionsInterface {
  readonly devKeyFilePath?: string;
  readonly skipTypecheck?: boolean;
  readonly outDir?: string;
}

/**
 * Ensures `targetPath` resolves strictly inside `allowedBaseDir` to prevent
 * path traversal or partial-prefix directory escapes.
 */
export function assertPathWithinDirectory(targetPath: string, allowedBaseDir: string): string {
  const resolvedBase = path.resolve(allowedBaseDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error(`Security violation: path escapes allowed boundary: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

/**
 * Recursively collects `.ts` files under `dirPath` (excluding `.d.ts`).
 */
function collectTypeScriptFiles(dirPath: string): string[] {
  const safeDir = assertPathWithinDirectory(dirPath, SRC_DIR);
  const entries = fs.readdirSync(safeDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = assertPathWithinDirectory(path.join(safeDir, entry.name), SRC_DIR);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

/**
 * Runs full strict TypeScript type-checking across the project `tsconfig.json`.
 */
export function typecheckProject(): void {
  const configPath = assertPathWithinDirectory(
    path.join(PROJECT_ROOT, 'tsconfig.json'),
    PROJECT_ROOT
  );
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    PROJECT_ROOT
  );

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: {
      ...parsed.options,
      noEmit: true,
    },
  });

  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => PROJECT_ROOT,
      getNewLine: () => '\n',
    });
    throw new Error(`TypeScript typecheck failed:\n${formatted}`);
  }
}

/**
 * Normalizes a source file path under `src/` to a canonical module ID (e.g. `core/gmail-mention.monitor`).
 */
function toModuleId(absFilePath: string): string {
  const rel = path.relative(SRC_DIR, absFilePath).split(path.sep).join('/');
  return rel.replace(/\.ts$/, '');
}

/**
 * Compiles all TypeScript modules under `src/` into a single zero-dependency IIFE content script bundle.
 */
export function bundleContentScript(): string {
  const sourceFiles = collectTypeScriptFiles(SRC_DIR);
  const moduleEntries: string[] = [];

  for (const filePath of sourceFiles) {
    const moduleId = toModuleId(filePath);
    const sourceText = fs.readFileSync(filePath, 'utf8');
    const transpiled = ts.transpileModule(sourceText, {
      fileName: filePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
        esModuleInterop: true,
        removeComments: false,
      },
    });

    const dirId = path.posix.dirname(moduleId);
    moduleEntries.push(
      `  ${JSON.stringify(moduleId)}: function(require, module, exports) {\n` +
        `    const __localRequire = function(specifier) {\n` +
        `      if (specifier.startsWith('.')) {\n` +
        `        const joined = (${JSON.stringify(dirId)} === '.' ? specifier : ${JSON.stringify(dirId)} + '/' + specifier);\n` +
        `        return require(normalizeModulePath(joined));\n` +
        `      }\n` +
        `      return require(specifier);\n` +
        `    };\n` +
        transpiled.outputText
          .replace(/\brequire\s*\(/g, '__localRequire(')
          .split('\n')
          .map((line) => (line.length > 0 ? `    ${line}` : ''))
          .join('\n') +
        `\n  }`
    );
  }

  return (
    `(() => {\n` +
    `  "use strict";\n` +
    `  function normalizeModulePath(rawPath) {\n` +
    `    const segments = rawPath.replace(/\\.ts$|\\.js$/, "").split("/");\n` +
    `    const stack = [];\n` +
    `    for (const seg of segments) {\n` +
    `      if (!seg || seg === ".") continue;\n` +
    `      if (seg === "..") stack.pop();\n` +
    `      else stack.push(seg);\n` +
    `    }\n` +
    `    return stack.join("/");\n` +
    `  }\n` +
    `  const modules = {\n` +
    moduleEntries.join(',\n') +
    `\n  };\n` +
    `  const cache = Object.create(null);\n` +
    `  function requireModule(id) {\n` +
    `    if (cache[id]) return cache[id].exports;\n` +
    `    const factory = modules[id];\n` +
    `    if (!factory) throw new Error("Module not found in extension bundle: " + id);\n` +
    `    const mod = { exports: {} };\n` +
    `    cache[id] = mod;\n` +
    `    factory(requireModule, mod, mod.exports);\n` +
    `    return mod.exports;\n` +
    `  }\n` +
    `  requireModule("content.entry");\n` +
    `})();\n`
  );
}

/**
 * Reads an optional local unpacked extension public key file (PEM, JSON `"key"`, or raw base64)
 * for local enterprise-managed Chrome profiles without committing keys to source control.
 */
function readDeveloperPublicKeyFile(keyFilePath: string): string {
  const resolvedPath = path.resolve(keyFilePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Developer public key file not found at: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8').trim().replace(/,$/, '');
  if (raw.startsWith('{')) {
    const parsed = JSON.parse(raw) as { key?: string };
    if (!parsed.key || typeof parsed.key !== 'string') {
      throw new Error('JSON developer key file does not contain a valid "key" string property.');
    }
    return parsed.key.trim();
  }
  if (raw.startsWith('"key"')) {
    const parsed = JSON.parse(`{${raw}}`) as { key?: string };
    if (!parsed.key || typeof parsed.key !== 'string') {
      throw new Error('Failed to parse "key" snippet from developer key file.');
    }
    return parsed.key.trim();
  }

  const normalized = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('-----'))
    .join('');

  if (normalized.length === 0) {
    throw new Error('Developer public key file is empty.');
  }
  return normalized;
}

export function verifyPngDimensions(filePath: string, expectedSize: number): void {
  const buf = fs.readFileSync(filePath);
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(pngSig)) {
    throw new Error(`Invalid PNG header in ${filePath}`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `Icon dimension mismatch in ${filePath}: expected ${expectedSize}x${expectedSize}, got ${width}x${height}`
    );
  }
}

function parseCliDevKeyFile(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dev-key-file') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing path argument after --dev-key-file');
      }
      return next;
    }
    if (arg.startsWith('--dev-key-file=')) {
      return arg.slice('--dev-key-file='.length);
    }
  }
  return process.env['CHROME_EXTENSION_DEV_KEY_FILE']?.trim() || undefined;
}

/**
 * Builds the unpacked Manifest V3 Chrome extension into `dist/` (or `options.outDir`).
 */
export function buildExtension(options: BuildExtensionOptionsInterface = {}): string {
  if (!options.skipTypecheck) {
    typecheckProject();
  }

  const targetOutDir = options.outDir ? path.resolve(options.outDir) : DIST_DIR;
  const safeIconsOutDir = assertPathWithinDirectory(
    path.join(targetOutDir, 'icons'),
    targetOutDir
  );
  fs.rmSync(targetOutDir, { recursive: true, force: true });
  fs.mkdirSync(safeIconsOutDir, { recursive: true });

  // 1. Bundle content.js
  const bundleCode = bundleContentScript();
  const contentOutPath = assertPathWithinDirectory(
    path.join(targetOutDir, 'content.js'),
    targetOutDir
  );
  fs.writeFileSync(contentOutPath, bundleCode, 'utf8');

  // 2. Copy and verify committed PNG icons from src/icons/
  for (const size of ICON_SIZES) {
    const srcIconPath = assertPathWithinDirectory(
      path.join(SRC_ICONS_DIR, `icon-${size}.png`),
      SRC_ICONS_DIR
    );
    if (!fs.existsSync(srcIconPath)) {
      throw new Error(
        `Missing source icon ${srcIconPath}. Run 'npm run assets' to regenerate icons from assets/icon.svg.`
      );
    }
    verifyPngDimensions(srcIconPath, size);

    const outIconPath = assertPathWithinDirectory(
      path.join(safeIconsOutDir, `icon-${size}.png`),
      targetOutDir
    );
    fs.copyFileSync(srcIconPath, outIconPath);
    verifyPngDimensions(outIconPath, size);
  }

  // 3. Validate and write manifest.json
  const manifestSrcPath = assertPathWithinDirectory(
    path.join(SRC_DIR, 'manifest.json'),
    SRC_DIR
  );
  const manifest = JSON.parse(
    fs.readFileSync(manifestSrcPath, 'utf8')
  ) as ChromeManifestShape;

  if (manifest.manifest_version !== 3) {
    throw new Error('manifest_version must be 3.');
  }
  if (!manifest.description || manifest.description.length > 132) {
    throw new Error(
      `manifest.json description must be <= 132 chars (got ${manifest.description?.length ?? 0}).`
    );
  }
  if (manifest.key) {
    throw new Error(
      'src/manifest.json must not contain a committed "key" field. Pass --dev-key-file for local testing.'
    );
  }

  if (options.devKeyFilePath) {
    manifest.key = readDeveloperPublicKeyFile(options.devKeyFilePath);
  }

  // Verify every referenced file in manifest.json exists in dist/
  for (const [sizeKey, relIconPath] of Object.entries(manifest.icons ?? {})) {
    const absIcon = assertPathWithinDirectory(path.join(targetOutDir, relIconPath), targetOutDir);
    if (!fs.existsSync(absIcon)) {
      throw new Error(`Missing icon referenced in manifest.json: ${relIconPath}`);
    }
    verifyPngDimensions(absIcon, Number(sizeKey));
  }

  for (const cs of manifest.content_scripts ?? []) {
    for (const jsRel of cs.js ?? []) {
      const absJs = assertPathWithinDirectory(path.join(targetOutDir, jsRel), targetOutDir);
      if (!fs.existsSync(absJs)) {
        throw new Error(`Missing content script referenced in manifest.json: ${jsRel}`);
      }
    }
  }

  const manifestOutPath = assertPathWithinDirectory(
    path.join(targetOutDir, 'manifest.json'),
    targetOutDir
  );
  fs.writeFileSync(manifestOutPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  return targetOutDir;
}

function main(): void {
  const devKeyFilePath = parseCliDevKeyFile(process.argv.slice(2));
  const outDir = buildExtension({ devKeyFilePath });
  process.stdout.write(
    `Built Gmail @tention to ${outDir}` +
      (devKeyFilePath ? ' (with local unpacked developer key)\n' : '\n')
  );
}

if (require.main === module) {
  main();
}
