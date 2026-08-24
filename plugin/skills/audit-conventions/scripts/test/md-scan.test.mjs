import { test } from 'node:test';
import assert from 'node:assert/strict';

import { iterateUnfencedLines, maskInlineCode } from '../lib/md-scan.mjs';

// Convenience: these are pure string functions, so no temp-repo fixture is
// needed — collect the generator into an array and assert on it directly.
function scan(content) {
  return [...iterateUnfencedLines(content)];
}

// ---------------------------------------------------------------------------
// iterateUnfencedLines — no fences
// ---------------------------------------------------------------------------

test('iterateUnfencedLines: a plain file yields every line, 1-based', () => {
  assert.deepEqual(scan('alpha\nbeta\ngamma'), [
    { lineNumber: 1, text: 'alpha' },
    { lineNumber: 2, text: 'beta' },
    { lineNumber: 3, text: 'gamma' },
  ]);
});

test('iterateUnfencedLines: yielded text is raw, not trimmed', () => {
  assert.deepEqual(scan('  indented  \n\ttabbed'), [
    { lineNumber: 1, text: '  indented  ' },
    { lineNumber: 2, text: '\ttabbed' },
  ]);
});

test('iterateUnfencedLines: a trailing newline yields a final empty line', () => {
  // 'a\n'.split('\n') is ['a', ''] — mirrored, not special-cased.
  assert.deepEqual(scan('a\n'), [
    { lineNumber: 1, text: 'a' },
    { lineNumber: 2, text: '' },
  ]);
});

test('iterateUnfencedLines: empty content yields one empty line', () => {
  assert.deepEqual(scan(''), [{ lineNumber: 1, text: '' }]);
});

// ---------------------------------------------------------------------------
// iterateUnfencedLines — fences
// ---------------------------------------------------------------------------

test('iterateUnfencedLines: a ``` fence suppresses its delimiters and interior', () => {
  const content = ['before', '```js', 'const x = 1;', '```', 'after'].join('\n');
  assert.deepEqual(scan(content), [
    { lineNumber: 1, text: 'before' },
    { lineNumber: 5, text: 'after' },
  ]);
});

test('iterateUnfencedLines: a ~~~ fence suppresses its delimiters and interior', () => {
  const content = ['before', '~~~', 'hidden', '~~~', 'after'].join('\n');
  assert.deepEqual(scan(content), [
    { lineNumber: 1, text: 'before' },
    { lineNumber: 5, text: 'after' },
  ]);
});

test('iterateUnfencedLines: an indented fence delimiter still toggles (trimmed test)', () => {
  const content = ['before', '   ```', 'hidden', '   ```', 'after'].join('\n');
  assert.deepEqual(scan(content), [
    { lineNumber: 1, text: 'before' },
    { lineNumber: 5, text: 'after' },
  ]);
});

test('iterateUnfencedLines: content inside a fence is never yielded, however link-like', () => {
  // The reason this helper exists: a doc SHOWING Markdown must not be scanned
  // as though the example were real.
  const content = ['real [text](README.md)', '```', 'example [text](fake.md)', '```'].join('\n');
  assert.deepEqual(scan(content), [{ lineNumber: 1, text: 'real [text](README.md)' }]);
});

test('iterateUnfencedLines: the toggle is a flip — a ~~~ inside a ``` fence closes it', () => {
  // Documented, deliberate limitation: delimiter type and length are not
  // tracked, so a nested-looking fence terminates the outer one and the lines
  // after it become visible again.
  const content = ['before', '```', 'in fence', '~~~', 'now visible', '```', 'in fence again'].join(
    '\n',
  );
  assert.deepEqual(scan(content), [
    { lineNumber: 1, text: 'before' },
    { lineNumber: 5, text: 'now visible' },
  ]);
});

test('iterateUnfencedLines: an unterminated fence suppresses the rest of the file', () => {
  // No repair pass — the remaining lines simply stay suppressed at EOF.
  const content = ['visible', '```', 'swallowed', 'also swallowed'].join('\n');
  assert.deepEqual(scan(content), [{ lineNumber: 1, text: 'visible' }]);
});

test('iterateUnfencedLines: line numbers stay accurate across mid-file fenced regions', () => {
  const content = [
    'one', // 1
    '```', // 2
    'skip', // 3
    '```', // 4
    'five', // 5
    'six', // 6
    '~~~', // 7
    'skip', // 8
    'skip', // 9
    '~~~', // 10
    'eleven', // 11
  ].join('\n');
  assert.deepEqual(scan(content), [
    { lineNumber: 1, text: 'one' },
    { lineNumber: 5, text: 'five' },
    { lineNumber: 6, text: 'six' },
    { lineNumber: 11, text: 'eleven' },
  ]);
});

// ---------------------------------------------------------------------------
// maskInlineCode
// ---------------------------------------------------------------------------

test('maskInlineCode: blanks a backtick span, preserving line length', () => {
  const line = 'see `[text](fake.md)` here';
  const masked = maskInlineCode(line);
  assert.equal(masked, 'see                   here');
  assert.equal(masked.length, line.length);
});

test('maskInlineCode: blanks multiple spans on one line', () => {
  assert.equal(maskInlineCode('`a` and `b`'), '    and    ');
});

test('maskInlineCode: a double-backtick span is matched by its own run length', () => {
  assert.equal(maskInlineCode('x ``a`b`` y'), 'x         y');
});

test('maskInlineCode: an unmatched backtick run leaves the line unchanged', () => {
  // Per-line by design: no closing run on this line means nothing is masked,
  // so real content elsewhere on the line still scans.
  const line = 'an unclosed `span with [text](real.md) after it';
  assert.equal(maskInlineCode(line), line);
});

test('maskInlineCode: a line with no backticks is returned unchanged', () => {
  const line = 'plain [text](real.md) line';
  assert.equal(maskInlineCode(line), line);
});
