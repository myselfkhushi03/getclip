
(() => {
  'use strict';

  const form = document.getElementById('dl-form');
  if (!form) return;

  const input = document.getElementById('url');
  const pasteBtn = document.getElementById('paste-btn');
  const submitBtn = document.getElementById('submit-btn');
  const hint = document.getElementById('hint');
  const statusBox = document.getElementById('status');
  const result = document.getElementById('result');
  const resultBody = document.getElementById('result-body');

  const DEFAULT_HINT = hint.textContent;
  const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
  const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am']);
  const PLATFORM_NAMES = { youtube: 'YouTube', instagram: 'Instagram' };

  let busy = false;
  let preparing = false;
  let currentUrl = '';

  /* Helpers */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function normalize(raw) {
    let text = String(raw || '').trim();
    if (!text) return '';
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
    return text;
  }

  function detect(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase();
    const path = u.pathname;

    if (YT_HOSTS.has(host)) {
      if (host === 'youtu.be') return /^\/[\w-]{11}/.test(path) ? 'youtube' : null;
      if (path === '/watch' && /^[\w-]{11}$/.test(u.searchParams.get('v') || '')) return 'youtube';
      if (/^\/(shorts|live|embed)\/[\w-]{11}/.test(path)) return 'youtube';
      return null;
    }

    if (IG_HOSTS.has(host)) {
      if (/^\/(p|reel|reels|tv)\/[\w-]+/.test(path)) return 'instagram';
      if (/^\/[\w.]+\/(p|reel|tv)\/[\w-]+/.test(path)) return 'instagram';
      if (/^\/stories\/[\w.]+\/\d+/.test(path)) return 'instagram';
      if (/^\/share\/(reel|p)\/[\w-]+/.test(path)) return 'instagram';
      return null;
    }
    return null;
  }

  function fmtDuration(total) {
    const s = Math.max(0, Math.round(total));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + sec : m + ':' + sec;
  }

  function fmtBytes(bytes) {
    if (!bytes || bytes < 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
  }

  /* Status and state */

  function showStatus(type, message) {
    statusBox.className = 'notice notice-' + type;
    statusBox.replaceChildren();
    if (type === 'info' && busy) {
      statusBox.append(el('span', 'spinner spinner-dark'), el('span', '', message));
    } else {
      statusBox.textContent = message;
    }
    statusBox.hidden = false;
  }

  function hideStatus() {
    statusBox.hidden = true;
    statusBox.textContent = '';
  }

  function hideResult() {
    result.hidden = true;
    resultBody.replaceChildren();
  }

  function setBusy(value) {
    busy = value;
    submitBtn.disabled = value;
    const label = submitBtn.querySelector('.btn-label');
    submitBtn.querySelectorAll('.spinner').forEach((n) => n.remove());
    if (value) {
      submitBtn.prepend(el('span', 'spinner'));
      label.textContent = 'Fetching';
    } else {
      label.textContent = 'Download';
    }
  }

  function updatePasteButton() {
    pasteBtn.textContent = input.value ? 'Clear' : 'Paste';
  }

  function updateHint() {
    const value = normalize(input.value);
    if (!value) {
      hint.textContent = DEFAULT_HINT;
      hint.className = 'hint';
      return;
    }
    const platform = detect(value);
    if (platform) {
      hint.textContent = PLATFORM_NAMES[platform] + ' link detected';
      hint.className = 'hint is-ok';
    } else {
      hint.textContent = DEFAULT_HINT;
      hint.className = 'hint';
    }
  }

  /* Network */

  async function api(path, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error('The request took too long. Please try again.');
      }
      throw new Error('Could not reach the server. Check your connection and try again.');
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = await response.json(); } catch (e) { /* not JSON */ }

    if (!response.ok) {
      const message = data && data.error && data.error.message;
      throw new Error(message || 'Something went wrong on the server. Please try again.');
    }
    if (!data) throw new Error('The server sent an unexpected response. Please try again.');
    return data;
  }

  /* Rendering */

  function optionRow(option) {
    const li = el('li', 'option');
    const info = el('div', 'option-info');
    info.append(el('span', 'option-label', option.label));
    const note = [option.note, option.size ? 'about ' + fmtBytes(option.size) : ''].filter(Boolean).join(', ');
    if (note) info.append(el('span', 'option-note', note));

    const button = el('button', 'btn btn-primary btn-sm', 'Download');
    button.type = 'button';
    button.setAttribute('aria-label', 'Download ' + option.label);
    button.addEventListener('click', () => startDownload(option, button));

    li.append(info, button);
    return li;
  }

  function optionGroup(title, note, options) {
    const section = el('section', 'group');
    section.append(el('h3', '', title));
    if (note) section.append(el('p', 'group-note', note));
    const list = el('ul', 'options');
    options.forEach((option) => list.append(optionRow(option)));
    section.append(list);
    return section;
  }

  function renderResult(data) {
    resultBody.replaceChildren();

    const card = el('div', 'card');
    const head = el('div', 'card-head');

    const thumb = el('div', 'thumb');
    if (data.thumbnail) {
      const img = document.createElement('img');
      img.src = data.thumbnail;
      img.alt = '';
      img.width = 320;
      img.height = 180;
      img.decoding = 'async';
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    }
    if (data.duration) thumb.append(el('span', 'duration', fmtDuration(data.duration)));

    const meta = el('div', 'card-meta');
    meta.append(el('span', 'tag', PLATFORM_NAMES[data.platform] || 'Video'));
    meta.append(el('h2', 'card-title', data.title || 'Untitled video'));
    if (data.uploader) meta.append(el('p', 'card-sub', data.uploader));

    head.append(thumb, meta);
    card.append(head);

    if (data.videoOptions && data.videoOptions.length) {
      card.append(optionGroup('Video', 'Saved as published, with the original audio.', data.videoOptions));
    }
    if (data.audioOptions && data.audioOptions.length) {
      card.append(optionGroup('Audio only', '', data.audioOptions));
    }

    resultBody.append(card);
    result.hidden = false;
  }

  /* Actions */

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;

    const value = normalize(input.value);
    if (!value) {
      showStatus('error', 'Paste a YouTube or Instagram link first.');
      input.focus();
      return;
    }
    const platform = detect(value);
    if (!platform) {
      showStatus('error', 'This link is not supported. Use a YouTube video or Shorts link, or an Instagram Reel, post or story link.');
      input.focus();
      return;
    }

    hideResult();
    setBusy(true);
    showStatus('info', 'Loading video details');

    try {
      const data = await api('/api/info', { url: value }, 60000);
      currentUrl = value;
      hideStatus();
      renderResult(data);
      result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showStatus('error', err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startDownload(option, button) {
    if (preparing) {
      showStatus('error', 'Another file is still being prepared. Please wait for it to finish.');
      return;
    }
    preparing = true;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'Preparing';
    showStatus('info', 'Preparing ' + option.label + '. Large files can take a minute or more, so keep this tab open.');
    busy = true;

    try {
      const data = await api('/api/prepare', Object.assign({ url: currentUrl }, option.request), 15 * 60 * 1000);
      busy = false;
      const link = document.createElement('a');
      link.href = data.downloadUrl;
      link.download = data.filename || '';
      link.rel = 'noopener';
      document.body.append(link);
      link.click();
      link.remove();
      const size = data.size ? ' (' + fmtBytes(data.size) + ')' : '';
      showStatus('success', 'Your download has started: ' + data.filename + size + '. If nothing happens, check your browser download permissions.');
    } catch (err) {
      busy = false;
      showStatus('error', err.message);
    } finally {
      busy = false;
      preparing = false;
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* Events */

  form.addEventListener('submit', onSubmit);

  input.addEventListener('input', () => {
    updatePasteButton();
    updateHint();
    if (statusBox.classList.contains('notice-error')) hideStatus();
  });

  pasteBtn.addEventListener('click', async () => {
    if (input.value) {
      input.value = '';
      updatePasteButton();
      updateHint();
      hideStatus();
      hideResult();
      input.focus();
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      input.value = text.trim();
      updatePasteButton();
      updateHint();
      if (!input.value) showStatus('error', 'The clipboard is empty. Copy a link first.');
      else hideStatus();
    } catch (err) {
      showStatus('error', 'Your browser blocked clipboard access. Paste the link into the field manually.');
      input.focus();
    }
  });

  updatePasteButton();
})();