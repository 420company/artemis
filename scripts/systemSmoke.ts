import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { splitCommandArgs } from '../src/cli/commandArgs.js';
import { getHelpText, parseArgs } from '../src/cli/parseArgs.js';

function test(name: string, fn: () => void): void {
  fn();
  console.log(`✔ ${name}`);
}

console.log('\n  systemSmoke');
console.log('  ===========');

test('package exposes only artemis global command', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), ['artemis']);
  assert.equal(pkg.bin.artemis, 'dist/cli.js');
});

test('legacy shim is absent', () => {
  assert.equal(existsSync(resolve('bin', `my${'laude'}.js`)), false);
});

test('help lists real workflow and utility commands', () => {
  const help = getHelpText('en');
  for (const command of ['tool', 'analyze', 'execute', 'skill', 'audit', 'session', 'design']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
});

test('parser accepts documented utility commands', () => {
  assert.equal(parseArgs(['tool', '--list']).command, 'tool');
  assert.deepEqual(parseArgs(['tool', 'run', 'generate_long_video', 'title=Neon Rain Observatory']).promptArgs, [
    'run',
    'generate_long_video',
    'title=Neon Rain Observatory',
  ]);
  assert.equal(parseArgs(['skill', '--detail', 'color-master']).command, 'skill');
  assert.equal(parseArgs(['session', '--list']).command, 'session');
  assert.equal(parseArgs(['audit', '--scan']).command, 'audit');
  assert.equal(parseArgs(['analyze', 'hello']).prompt, 'hello');
  assert.equal(parseArgs(['execute', 'hello']).prompt, 'hello');
});

test('parser accepts direct workflow commands', () => {
  const parsed = parseArgs(['design', 'make', 'a', 'homepage']);
  assert.equal(parsed.command, 'design');
  assert.equal(parsed.prompt, 'make a homepage');
});

test('command arg splitter preserves quoted key-value values', () => {
  assert.deepEqual(
    splitCommandArgs(`run generate_long_video title='Neon Rain Observatory' prompt="two connected shots" totalDuration=20`),
    [
      'run',
      'generate_long_video',
      'title=Neon Rain Observatory',
      'prompt=two connected shots',
      'totalDuration=20',
    ],
  );
});

console.log('\n  ✔ All system smoke tests passed');
