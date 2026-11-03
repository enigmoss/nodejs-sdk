import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const sources = readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => [file, read(`src/${file}`)] as const);

describe('package', () => {
  it('VERSION equals package.json', () => {
    expect(VERSION).toBe(JSON.parse(read('package.json')).version);
  });

  it('has no runtime dependencies', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('sources use web APIs only', () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/from ['"]node:|\brequire\(|\bprocess\.|\bBuffer\b/);
    }
  });

  it('the README example is the typechecked one', () => {
    const readme = /## Usage\n\n```ts\n([\s\S]*?)```/.exec(read('README.md'))?.[1];
    const example = /\/\/ README example start\n([\s\S]*?)\/\/ README example end/.exec(
      read('test/readme-example.ts'),
    )?.[1];
    expect(readme).toBeDefined();
    expect(example).toBe(readme);
  });
});
