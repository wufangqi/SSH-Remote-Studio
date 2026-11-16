'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const md = require('../src/renderer/markdown');

describe('Markdown renderer', () => {
  it('renders headings, emphasis, lists, code and tables', () => {
    const html = md.render([
      '# Title',
      '',
      'A **bold** and *italic* paragraph with `code`.',
      '',
      '- one',
      '- two',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n'));
    assert.match(html, /<h1 id="title">Title<a class="md-anchor" href="#title"[^>]*>#<\/a><\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /<div class="md-table-wrap"><table class="md-table">/);
    assert.match(html, /<div class="md-code"><div class="md-code-head">/);
    assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
  });

  it('gives every heading a unique, escaped anchor id', () => {
    const html = md.render(['# Setup', '## Setup', '### Setup', '## C++ & "notes"', '## ***'].join('\n'));
    const ids = [...html.matchAll(/<h\d id="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(ids, ['setup', 'setup-1', 'setup-2', 'c--notes', 'section']);
    assert.match(html, /href="#setup-1"/);
    // Inline markup and punctuation never leak into the slug itself.
    assert.ok(ids.every((id) => !/[*_+&"']|%/.test(id)));
    // Every anchor href resolves to an id that exists in the same document.
    const hrefs = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(hrefs, ids);
  });

  it('never reuses an id when a suffix collides with an explicit heading', () => {
    const html = md.render(['# Setup', '## Setup 1', '# Setup', '# Setup 1'].join('\n'));
    const ids = [...html.matchAll(/<h\d id="([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(ids, ['setup', 'setup-1', 'setup-2', 'setup-1-1']);
    assert.strictEqual(new Set(ids).size, ids.length);
    const hrefs = [...html.matchAll(/href="#([^"]*)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(hrefs, ids);
  });

  it('keeps CJK and accented headings as usable anchors', () => {
    const html = md.render('# 安装 指南\n\n## Café Über');
    assert.match(html, /<h1 id="安装-指南">/);
    assert.match(html, /<h2 id="café-über">/);
  });

  it('escapes heading text and ids so markup never survives', () => {
    const html = md.render('# <img src=x onerror="alert(1)">hi');
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('onerror="'));
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;hi/);
    assert.match(html, /<h1 id="hi">/);
  });

  it('wraps code blocks with a language label and a handler-free copy button', () => {
    const html = md.render(['```python', 'print("<b>hi</b>")', '```', '', '```', 'plain text', '```'].join('\n'));
    assert.match(html, /<span class="md-code-lang">python<\/span>/);
    assert.match(html, /<button type="button" class="md-code-copy" data-md-copy[^>]*>/);
    assert.match(html, /<span data-i18n="md\.copy"><\/span>/);
    // Unlabelled fences still get a header, with a neutral language tag.
    assert.match(html, /<span class="md-code-lang">text<\/span>/);
    // Nothing remote may execute: no inline handlers, no code in attributes.
    assert.ok(!/\son[a-z]+="/.test(html));
    assert.match(html, /print\(&quot;&lt;b&gt;hi&lt;\/b&gt;&quot;\)/);
    assert.ok(!html.includes('<b>hi</b>'));
  });

  it('keeps mermaid fences escaped until the preview draws them', () => {
    const html = md.render([
      '```mermaid',
      'graph TD',
      '  A["<img src=x onerror=alert(1)>"] --> B',
      '```',
      '',
      '```Mermaid',
      'sequenceDiagram',
      '  Alice->>Bob: hi',
      '```',
    ].join('\n'));
    assert.equal((html.match(/class="md-code md-mermaid"/g) || []).length, 2);
    assert.match(html, /<code class="language-mermaid">/);
    assert.match(html, /graph TD/);
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('<script'));
    assert.ok(!/\son[a-z]+="/.test(html));
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('marks up table column alignment from the separator row', () => {
    const html = md.render([
      '| Left | Center | Right | Default |',
      '| :--- | :---: | ---: | --- |',
      '| a | b | c | d |',
    ].join('\n'));
    assert.match(html, /<th class="ta-left">Left<\/th>/);
    assert.match(html, /<th class="ta-center">Center<\/th>/);
    assert.match(html, /<th class="ta-right">Right<\/th>/);
    assert.match(html, /<th class="ta-left">Default<\/th>/);
    assert.match(html, /<td class="ta-center">b<\/td>/);
    assert.match(html, /<td class="ta-right">c<\/td>/);
    assert.match(html, /<\/tbody><\/table><\/div>/);
  });

  it('emits image placeholders and keeps safe relative sources', () => {
    const html = md.render('![logo](img/pixel.png "Logo")');
    assert.match(html, /<img class="md-img" data-md-src="img\/pixel.png" alt="logo" data-i18n-aria="md\.imageZoom" title="Logo">/);
  });

  it('escapes raw HTML and refuses javascript links', () => {
    const html = md.render('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.ok(!html.includes('javascript:'));
  });

  it('escapes code fences', () => {
    const html = md.render('```html\n<b>x</b>\n```');
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
    assert.ok(!html.includes('<b>x</b>'));
  });
});
