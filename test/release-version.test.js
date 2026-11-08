import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  currentProjectVersion,
  nextPatchVersion,
  parsePatchVersion,
  setProjectVersion,
  verifyProjectVersion,
} from '../scripts/release-version.js';

const temporaryRoots = [];

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'tarteel-release-version-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tarteel', version: '0.7.8' }, null, 2));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'tarteel',
    version: '0.7.8',
    lockfileVersion: 3,
    packages: { '': { name: 'tarteel', version: '0.7.8' } },
  }, null, 2));
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "tarteel"\nversion = "0.7.8"\nedition = "2021"\n\n[dependencies]\ntauri = "2"\n');
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ productName: 'Tarteel', version: '0.7.8' }, null, 2));
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe('ترقيم الإصدار patch-only', () => {
  it('يزيد أعلى patch موجود من إصدار المشروع والوسوم 0.7.x فقط', () => {
    expect(nextPatchVersion('0.7.8', [
      'tarteel-v0.7.7',
      'tarteel-v0.7.8',
      'tarteel-v0.8.0',
      'tarteel-v0.8.1',
      'not-a-release-tag',
    ])).toBe('0.7.9');
  });

  it('لا يعيد استخدام رقم patch إذا سبقته علامة إصدار أعلى من ملفات المشروع', () => {
    expect(nextPatchVersion('0.7.8', ['tarteel-v0.7.10'])).toBe('0.7.11');
  });

  it('يرفض سلسلة خارج 0.7.x بدل إنشاء إصدار خاطئ بصمت', () => {
    expect(() => parsePatchVersion('0.8.1')).toThrow('0.7.x');
    expect(() => nextPatchVersion('0.8.1', [])).toThrow('0.7.x');
  });
});

describe('مزامنة ملفات الإصدار', () => {
  it('يقرأ ويؤكد تطابق ملفات التطبيق الخمسة', () => {
    const root = makeProject();
    expect(currentProjectVersion(root)).toBe('0.7.8');
    expect(verifyProjectVersion(root, '0.7.8')).toBe('0.7.8');
  });

  it('يحدّث package وlockfile وCargo وTauri معًا دون تغيير إصدار dependency', () => {
    const root = makeProject();
    expect(setProjectVersion(root, '0.7.9')).toBe('0.7.9');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('0.7.9');
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    expect(lock.version).toBe('0.7.9');
    expect(lock.packages[''].version).toBe('0.7.9');
    const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
    expect(cargo).toContain('version = "0.7.9"');
    expect(cargo).toContain('tauri = "2"');
    expect(JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version).toBe('0.7.9');
  });

  it('يفشل إذا كانت الملفات غير متطابقة أو إذا طُلب إصدار خارج السلسلة', () => {
    const root = makeProject();
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    pkg.version = '0.7.9';
    writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2));
    expect(() => currentProjectVersion(root)).toThrow('out of sync');
    expect(() => setProjectVersion(root, '0.8.0')).toThrow('0.7.x');
  });
});
