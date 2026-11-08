import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCH_VERSION = /^0\.7\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^tarteel-v(0\.7\.(?:0|[1-9]\d*))$/;

export function parsePatchVersion(version) {
  const match = PATCH_VERSION.exec(String(version));
  if (!match) {
    throw new Error(`Expected a stable 0.7.x patch version, received: ${version}`);
  }
  return Number(match[1]);
}

export function nextPatchVersion(currentVersion, tags = []) {
  let highestPatch = parsePatchVersion(currentVersion);
  for (const tag of tags) {
    const match = RELEASE_TAG.exec(String(tag));
    if (!match) continue;
    highestPatch = Math.max(highestPatch, parsePatchVersion(match[1]));
  }
  return `0.7.${highestPatch + 1}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readCargoPackageVersion(source) {
  const lines = source.split(/\r?\n/);
  let inPackage = false;
  for (const line of lines) {
    if (line.trim() === '[package]') {
      inPackage = true;
      continue;
    }
    if (inPackage && /^\s*\[/.test(line)) break;
    if (inPackage) {
      const match = /^\s*version\s*=\s*"([^"]+)"\s*$/.exec(line);
      if (match) return match[1];
    }
  }
  throw new Error('Could not read the [package] version from src-tauri/Cargo.toml');
}

function writeCargoPackageVersion(source, version) {
  const lines = source.split(/\r?\n/);
  let inPackage = false;
  let changes = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '[package]') {
      inPackage = true;
      continue;
    }
    if (inPackage && /^\s*\[/.test(line)) break;
    if (inPackage && /^\s*version\s*=/.test(line)) {
      lines[index] = line.replace(/=\s*"[^"]+"/, `= "${version}"`);
      changes += 1;
      break;
    }
  }
  if (changes !== 1) {
    throw new Error('Could not update exactly one [package] version in src-tauri/Cargo.toml');
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  return lines.join(newline);
}

export function currentProjectVersion(root = process.cwd()) {
  const base = resolve(root);
  const packageJson = readJson(resolve(base, 'package.json'));
  const packageLock = readJson(resolve(base, 'package-lock.json'));
  const cargo = readFileSync(resolve(base, 'src-tauri/Cargo.toml'), 'utf8');
  const tauri = readJson(resolve(base, 'src-tauri/tauri.conf.json'));
  const values = [
    packageJson.version,
    packageLock.version,
    packageLock.packages?.['']?.version,
    readCargoPackageVersion(cargo),
    tauri.version,
  ];
  for (const value of values) parsePatchVersion(value);
  if (new Set(values).size !== 1) {
    throw new Error(`Version files are out of sync: ${values.join(', ')}`);
  }
  return values[0];
}

export function verifyProjectVersion(root = process.cwd(), expectedVersion) {
  const actual = currentProjectVersion(root);
  if (expectedVersion !== undefined && actual !== expectedVersion) {
    throw new Error(`Expected all app version files to be ${expectedVersion}, found ${actual}`);
  }
  return actual;
}

export function setProjectVersion(root, version) {
  parsePatchVersion(version);
  const base = resolve(root);
  const packagePath = resolve(base, 'package.json');
  const lockPath = resolve(base, 'package-lock.json');
  const cargoPath = resolve(base, 'src-tauri/Cargo.toml');
  const tauriPath = resolve(base, 'src-tauri/tauri.conf.json');

  const packageJson = readJson(packagePath);
  const packageLock = readJson(lockPath);
  const cargoSource = readFileSync(cargoPath, 'utf8');
  const tauri = readJson(tauriPath);
  if (!packageLock.packages || !packageLock.packages['']) {
    throw new Error('package-lock.json is missing the root package entry');
  }

  // Validate every input and compute every replacement before writing anything.
  const cargoUpdated = writeCargoPackageVersion(cargoSource, version);
  packageJson.version = version;
  packageLock.version = version;
  packageLock.packages[''].version = version;
  tauri.version = version;

  writeJson(packagePath, packageJson);
  writeJson(lockPath, packageLock);
  writeFileSync(cargoPath, cargoUpdated, 'utf8');
  writeJson(tauriPath, tauri);
  return verifyProjectVersion(base, version);
}

function gitTags() {
  return execFileSync('git', ['tag', '--list', 'tarteel-v0.7.*'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

function main() {
  const [command, value] = process.argv.slice(2);
  switch (command) {
    case 'current':
      console.log(currentProjectVersion());
      break;
    case 'next':
      console.log(nextPatchVersion(currentProjectVersion(), gitTags()));
      break;
    case 'set':
      console.log(setProjectVersion(process.cwd(), value));
      break;
    case 'verify':
      console.log(verifyProjectVersion(process.cwd(), value));
      break;
    default:
      throw new Error('Usage: node scripts/release-version.js <current|next|set VERSION|verify [VERSION]>');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
