#!/usr/bin/env node
/**
 * Build the single-file release HTML from the readable sources in src/.
 *
 * Source of truth:
 *   src/index.html        markup, with <link> and <script src> references
 *   src/styles/*.css      stylesheets, in the order linked by src/index.html
 *   src/js/ (all .js)     scripts, in the order referenced by src/index.html
 *
 * Output:
 *   index.html            everything inlined; open this file directly in a browser
 *
 * Usage:  node tools/build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'src');
const outputFile = path.join(root, 'index.html');

const LINK_RE = /[ \t]*<link rel="stylesheet" href="([^"]+)">[ \t]*\r?\n?/g;
const SCRIPT_RE = /[ \t]*<script src="([^"]+)"><\/script>[ \t]*\r?\n?/g;

/** Read a file referenced from src/index.html, relative to src/. */
function readSource(relativePath) {
  const fullPath = path.join(sourceDir, relativePath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Referenced source file not found: src/${relativePath}`);
  }
  return fs.readFileSync(fullPath, 'utf8').trimEnd();
}

/** Replace stylesheet links with one inlined <style> block. */
function inlineStyles(html) {
  const parts = [];
  return html.replace(LINK_RE, (_match, href) => {
    parts.push(readSource(href));
    return parts.length === 1 ? '<!--STYLES-->\n' : '';
  }).replace('<!--STYLES-->', () => `<style>\n${parts.join('\n\n')}\n</style>`);
}

/** Replace script tags with one inlined, encapsulated <script> block. */
function inlineScripts(html) {
  const parts = [];
  return html.replace(SCRIPT_RE, (_match, src) => {
    parts.push(readSource(src));
    return parts.length === 1 ? '<!--SCRIPTS-->\n' : '';
  }).replace('<!--SCRIPTS-->', () => {
    const body = parts.join('\n\n');
    const bundle = `(() => {\n'use strict';\n\n${body}\n\n})();`;
    return `<script>\n${bundle}\n</script>`;
  });
}

function main() {
  let html = fs.readFileSync(path.join(sourceDir, 'index.html'), 'utf8');
  html = inlineStyles(html);
  html = inlineScripts(html);
  html = html.replace(
    '<!DOCTYPE html>',
    '<!DOCTYPE html>\n<!-- Generated from src/ by tools/build.js — do not edit directly. Run: node tools/build.js -->'
  );
  fs.writeFileSync(outputFile, html, 'utf8');

  const cssCount = (html.match(/<style>/g) || []).length;
  const jsCount = (html.match(/<script>/g) || []).length;
  console.log(`Built index.html (${Math.round(html.length / 1024)} kB, ${cssCount} style block, ${jsCount} script block).`);
}

try {
  main();
} catch (err) {
  console.error('Build failed:', err.message);
  process.exitCode = 1;
}
