#!/usr/bin/env node
'use strict';

// Usage: node scripts/set-domain.js yourdomain.com
// Replaces the current site origin in every page, robots.txt and sitemap.xml.

const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/set-domain.js yourdomain.com');
  process.exit(1);
}

const host = input.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host)) {
  console.error('That does not look like a valid domain: ' + input);
  process.exit(1);
}
const next = 'https://' + host;

const publicDir = path.join(__dirname, '..', 'public');
const files = ['index.html', 'privacy.html', 'terms.html', 'robots.txt', 'sitemap.xml'];

const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const match = /<link rel="canonical" href="(https?:\/\/[^/"]+)\//.exec(indexHtml);
if (!match) {
  console.error('Could not find the current canonical origin in index.html.');
  process.exit(1);
}
const current = match[1];

if (current === next) {
  console.log('Already set to ' + next);
  process.exit(0);
}

for (const name of files) {
  const file = path.join(publicDir, name);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.split(current).join(next));
  console.log('Updated ' + name);
}
console.log('Domain changed from ' + current + ' to ' + next);
