/**
 * Deterministic bundler for the Lambda entry points and the Author_Console bundle.
 *
 * Design: "Determinism (Req 12.8)", "Repository layout". Requirements: 12.1, 12.8.
 *
 * The contract this script upholds is narrow and mechanical: the same source tree, built twice with
 * the same pinned esbuild version, produces byte-identical output. That is what lets `cdk synth`
 * hash assets to the same digest on every run, which is the half of Req 12.8 the template alone
 * cannot deliver. Concretely, nothing here may put a clock, a random value, a machine name, or an
 * absolute path into an artifact:
 *
 *   - `banner` and `footer` are explicitly empty, so there is no preamble and no build-timestamp
 *     footer. The deployed version identifier is the git short SHA, supplied at synth time as CDK
 *     context, never a build timestamp baked in here.
 *   - `sourcemap` is off. Source maps carry `sourceRoot` and per-file paths.
 *   - `absWorkingDir` is the repository root, so the relative source-path comments esbuild writes
 *     between bundled modules do not depend on where the repository is checked out or on the shell's
 *     working directory.
 *   - `define` is unused. There is no injected build metadata.
 *   - Targets are built in a fixed order and output paths are fixed strings.
 *
 * Usage:
 *   npm run build                      bundle everything into dist/
 *   npm run build -- --outdir=build/x  bundle into another directory
 *   npm run build -- --verify          build twice into separate directories and compare digests
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Lambda bundles run on Node.js 22 (arm64); the console bundle runs in a browser. */
type BundleKind = 'lambda' | 'browser';

interface BundleTarget {
  /** Stable name used in log lines and as the CDK asset directory for Lambda targets. */
  readonly name: string;
  readonly kind: BundleKind;
  /** Repository-relative entry module. */
  readonly entry: string;
  /** Output path relative to the output directory. */
  readonly outfile: string;
}

/**
 * The three Lambda entry points of the design plus the availability probe (design "Availability
 * probing without Synthetics") and the Author_Console browser bundle. Lambda bundles land one per
 * directory as `index.mjs`, so a function's `code` asset is its directory and its handler is
 * `index.handler`.
 */
const TARGETS: readonly BundleTarget[] = [
  { name: 'api', kind: 'lambda', entry: 'src/api/handler.ts', outfile: 'lambda/api/index.mjs' },
  { name: 'site', kind: 'lambda', entry: 'src/site/handler.ts', outfile: 'lambda/site/index.mjs' },
  {
    name: 'generator',
    kind: 'lambda',
    entry: 'src/generator/handler.ts',
    outfile: 'lambda/generator/index.mjs',
  },
  {
    name: 'probe',
    kind: 'lambda',
    entry: 'src/probe/handler.ts',
    outfile: 'lambda/probe/index.mjs',
  },
  {
    name: 'console',
    kind: 'browser',
    entry: 'src/console/main.ts',
    outfile: 'console/console.js',
  },
];

/** Directories used by `--verify`; both sit under the git-ignored `build/` tree. */
const VERIFY_DIRS = ['build/determinism-a', 'build/determinism-b'] as const;

function optionsFor(target: BundleTarget, outDir: string): BuildOptions {
  const shared: BuildOptions = {
    absWorkingDir: repoRoot,
    entryPoints: [target.entry],
    outfile: join(outDir, target.outfile),
    bundle: true,
    format: 'esm',
    // Determinism (Req 12.8): no banner, no footer, therefore no build timestamp and no preamble
    // that could vary between runs.
    banner: { js: '' },
    footer: { js: '' },
    sourcemap: false,
    treeShaking: true,
    charset: 'utf8',
    // Licence comments stay with the code they belong to; attribution also lives in THIRD-PARTY.md.
    legalComments: 'inline',
    metafile: false,
    write: true,
    logLevel: 'warning',
  };

  if (target.kind === 'lambda') {
    return {
      ...shared,
      platform: 'node',
      target: ['node22'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      // Dependencies are bundled rather than taken from the runtime image, so an artifact's bytes
      // are fixed by this repository's pinned versions and not by the runtime's own SDK revision.
      external: [],
      // Readable stack traces matter more than bytes in a Lambda log group.
      minify: false,
    };
  }

  return {
    ...shared,
    platform: 'browser',
    format: 'iife',
    globalName: 'DevlogConsole',
    target: ['es2022'],
    // esbuild's minifier is a pure function of input and version, so this stays deterministic.
    minify: true,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(root: string, current: string = root): Promise<string[]> {
  const found: string[] = [];
  for (const dirent of await readdir(current, { withFileTypes: true })) {
    const full = join(current, dirent.name);
    if (dirent.isDirectory()) {
      found.push(...(await collectFiles(root, full)));
    } else {
      found.push(relative(root, full).split(sep).join('/'));
    }
  }
  // Code-unit order, not locale order, so the digest does not depend on the shell's locale.
  return found.sort();
}

interface TreeDigest {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  /** SHA-256 over the sorted `<sha256>  <path>` lines, so names and contents both count. */
  readonly digest: string;
}

async function digestTree(absOutDir: string): Promise<TreeDigest> {
  const files: { path: string; sha256: string }[] = [];
  for (const path of await collectFiles(absOutDir)) {
    const bytes = await readFile(join(absOutDir, path));
    files.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const aggregate = createHash('sha256');
  for (const file of files) {
    aggregate.update(`${file.sha256}  ${file.path}\n`);
  }
  return { files, digest: aggregate.digest('hex') };
}

async function buildAll(outDir: string): Promise<TreeDigest> {
  const absOutDir = resolve(repoRoot, outDir);
  await rm(absOutDir, { recursive: true, force: true });
  await mkdir(absOutDir, { recursive: true });

  for (const target of TARGETS) {
    if (!(await fileExists(resolve(repoRoot, target.entry)))) {
      // Entry points are written by later tasks. A missing one is reported and skipped rather than
      // failing the build, so the toolchain stays usable while the tree is incomplete.
      console.log(`skipped ${target.name}: entry point ${target.entry} does not exist yet`);
      continue;
    }
    await build(optionsFor(target, outDir));
    console.log(`bundled ${target.name} -> ${outDir}/${target.outfile}`);
  }

  const consoleHtmlSrc = resolve(repoRoot, 'src/console/index.html');
  if (await fileExists(consoleHtmlSrc)) {
    await copyFile(consoleHtmlSrc, join(absOutDir, 'console/index.html'));
    console.log(`copied console/index.html -> ${outDir}/console/index.html`);
  }

  return digestTree(absOutDir);
}

function report(label: string, tree: TreeDigest): void {
  console.log(`\n${label}`);
  for (const file of tree.files) {
    console.log(`  ${file.sha256}  ${file.path}`);
  }
  console.log(`  tree digest: ${tree.digest}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outDirFlag = '--outdir=';
  const outDir = args.find((arg) => arg.startsWith(outDirFlag))?.slice(outDirFlag.length) ?? 'dist';

  if (!args.includes('--verify')) {
    report(`build ${outDir}`, await buildAll(outDir));
    return;
  }

  const [dirA, dirB] = VERIFY_DIRS;
  const first = await buildAll(dirA);
  const second = await buildAll(dirB);
  report(`build 1 ${dirA}`, first);
  report(`build 2 ${dirB}`, second);

  if (first.digest !== second.digest) {
    console.error(
      `\ndeterminism check FAILED: ${dirA} digest ${first.digest} != ${dirB} digest ${second.digest}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\ndeterminism check passed: both builds hash to ${first.digest}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
