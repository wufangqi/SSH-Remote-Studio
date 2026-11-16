'use strict';
// Small, dependency-free and HTML-escaping Markdown renderer. Raw HTML is
// intentionally not supported: the renderer must never execute markup coming
// from a remote file. Images keep their source in data-md-src so the file
// layer can resolve relative paths over SFTP and inject a data URL.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  function safeImageSrc(raw) {
    const src = String(raw || '').trim().replace(/^<|>$/g, '');
    if (!src) return null;
    if (/^(https?:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml|bmp|x-icon|avif);base64,)/i.test(src)) return src;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    return src;
  }

  function safeLinkHref(raw) {
    const href = String(raw || '').trim().replace(/^<|>$/g, '');
    if (!href) return null;
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (href.startsWith('#')) return href;
    return null;
  }

  // Visible text of a heading, used only to build the anchor slug: inline
  // markup collapses to what the reader sees. The heading body itself still
  // goes through inline(), so nothing here reaches the DOM unescaped.
  function plainText(s) {
    return String(s == null ? '' : s)
      .replace(/`([^`\n]*)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '')
      .replace(/(\*\*|__|~~|[*_])/g, '');
  }

  // GitHub-like slug: lowercase, whitespace -> '-', letters/numbers/CJK and
  // -/_ kept. Repeated headings get -1, -2, ... so every id stays unique.
  function slug(text, used) {
    let base = plainText(text).trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .replace(/^-+|-+$/g, '');
    if (!base) base = 'section';
    if (!used) return base;
    // Claim the first free id, checking generated candidates against every id
    // already used: an explicit "Setup 1" must not be shadowed by the suffix
    // handed to a later "Setup" heading.
    if (!used.has(base)) { used.add(base); return base; }
    let n = 1;
    while (used.has(`${base}-${n}`)) n++;
    const id = `${base}-${n}`;
    used.add(id);
    return id;
  }

  function inline(text) {
    const stash = [];
    const put = (html) => {
      stash.push(html);
      return `\u0000X${stash.length - 1}\u0000`;
    };

    let s = String(text == null ? '' : text).replace(/\u0000/g, '');
    s = s.replace(/`([^`\n]+)`/g, (m, code) => put(`<code>${escapeHtml(code)}</code>`));

    // Images before links so "![alt](src)" is not consumed as a link.
    s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g, (m, alt, src, title) => {
      const safe = safeImageSrc(src);
      if (!safe) return escapeHtml(alt);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return put(`<img class="md-img" data-md-src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" data-i18n-aria="md.imageZoom"${t}>`);
    });
    s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+["']([^"']*)["'])?\s*\)/g, (m, label, href, title) => {
      const safe = safeLinkHref(href);
      if (!safe) return escapeHtml(label);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return put(`<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer noopener"${t}>${escapeHtml(label)}</a>`);
    });

    s = escapeHtml(s);
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\n]+)_/g, '$1<em>$2</em>');

    return s.replace(/\u0000X(\d+)\u0000/g, (m, i) => stash[Number(i)] || '');
  }

  const LIST_RE = /^\s*([-*+]|\d+\.)\s+(.*)$/;
  const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
  const HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
  const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

  function isBlockStart(line, next) {
    if (!line || !line.trim()) return true;
    if (FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line)) return true;
    if (/^\s*>\s?/.test(line) || LIST_RE.test(line)) return true;
    if (line.includes('|') && next && TABLE_SEP_RE.test(next)) return true;
    return false;
  }

  // ':' at one/both ends of a separator cell selects the column alignment.
  function colAlign(sep) {
    const s = String(sep || '').trim();
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  }

  const splitRow = (line) => String(line == null ? '' : line).trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function tableHtml(lines) {
    const head = splitRow(lines[0]);
    const align = splitRow(lines[1]).map(colAlign);
    const at = (i) => ` class="ta-${align[i] || 'left'}"`;
    // Wrapped in a scroller: a wide table must never widen the pane or clip.
    let html = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
    for (let i = 0; i < head.length; i++) html += `<th${at(i)}>${inline(head[i])}</th>`;
    html += '</tr></thead><tbody>';
    for (const row of lines.slice(2).map(splitRow)) {
      html += '<tr>';
      for (let i = 0; i < head.length; i++) html += `<td${at(i)}>${inline(row[i] || '')}</td>`;
      html += '</tr>';
    }
    return html + '</tbody></table></div>';
  }

  // The copy button carries no data itself: files.js reads the sibling
  // <pre><code> textContent. That keeps remote content out of attributes and
  // out of inline handlers (CSP script-src 'self' blocks the latter anyway).
  // Mermaid stays escaped text until the preview layer draws it. The source
  // never becomes markup here, so a remote diagram cannot carry a handler.
  function mermaidHtml(text) {
    return `<div class="md-code md-mermaid">`
      + `<div class="md-code-head"><span class="md-code-lang">mermaid</span>`
      + `<button type="button" class="md-code-copy" data-md-copy data-i18n-title="md.copy" data-i18n-aria="md.copy">`
      + `<svg class="ic" aria-hidden="true"><use href="#i-copy"></use></svg>`
      + `<span data-i18n="md.copy"></span></button></div>`
      + `<pre class="md-mermaid-src"><code class="language-mermaid">${escapeHtml(text)}</code></pre>`
      + `<div class="md-mermaid-view" hidden></div>`
      + `<p class="md-mermaid-error" hidden></p></div>`;
  }

  function codeHtml(text, lang) {
    if (String(lang || '').toLowerCase() === 'mermaid') return mermaidHtml(text);
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    const label = lang ? escapeHtml(lang) : 'text';
    return `<div class="md-code">`
      + `<div class="md-code-head"><span class="md-code-lang">${label}</span>`
      + `<button type="button" class="md-code-copy" data-md-copy data-i18n-title="md.copy" data-i18n-aria="md.copy">`
      + `<svg class="ic" aria-hidden="true"><use href="#i-copy"></use></svg>`
      + `<span data-i18n="md.copy"></span></button></div>`
      + `<pre><code${cls}>${escapeHtml(text)}</code></pre></div>`;
  }

  function renderBlocks(text, ctx) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      const fence = line.match(FENCE_RE);
      if (fence) {
        const marker = fence[1];
        const lang = fence[2];
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) buf.push(lines[i++]);
        if (i < lines.length) i++;
        html += codeHtml(buf.join('\n'), lang);
        continue;
      }

      const heading = line.match(HEADING_RE);
      if (heading) {
        const level = heading[1].length;
        const id = escapeHtml(slug(heading[2], ctx));
        html += `<h${level} id="${id}">${inline(heading[2])}`
          + `<a class="md-anchor" href="#${id}" tabindex="-1" aria-hidden="true">#</a></h${level}>`;
        i++;
        continue;
      }
      if (HR_RE.test(line)) { html += '<hr>'; i++; continue; }

      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        html += `<blockquote>${renderBlocks(buf.join('\n'), ctx)}</blockquote>`;
        continue;
      }

      if (LIST_RE.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && LIST_RE.test(lines[i])) {
          const m = lines[i++].match(LIST_RE);
          let content = m[2];
          const task = content.match(/^\[([ xX])\]\s+(.*)$/);
          if (task) {
            content = `<input type="checkbox" disabled${task[1].toLowerCase() === 'x' ? ' checked' : ''}> ${inline(task[2])}`;
          } else {
            content = inline(content);
          }
          items.push(`<li>${content}</li>`);
        }
        const tag = ordered ? 'ol' : 'ul';
        html += `<${tag}>${items.join('')}</${tag}>`;
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
        const buf = [lines[i++], lines[i++]];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) buf.push(lines[i++]);
        html += tableHtml(buf);
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
        para.push(lines[i++]);
      }
      html += `<p>${inline(para.join(' '))}</p>`;
    }
    return html;
  }

  // Public entry: one id registry per rendered document.
  function render(text) {
    return renderBlocks(text, new Set());
  }

  return { render, escapeHtml };
});
