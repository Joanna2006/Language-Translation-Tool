/* Lingua – front-end logic. All translation requests go to /api/translate (our backend). */
(() => {
  'use strict';

  const LANGUAGES = [
    ['af', 'Afrikaans'], ['ar', 'Arabic'], ['bn', 'Bengali'], ['bg', 'Bulgarian'],
    ['zh-CN', 'Chinese (Simplified)'], ['zh-TW', 'Chinese (Traditional)'], ['cs', 'Czech'],
    ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['fi', 'Finnish'], ['fr', 'French'],
    ['de', 'German'], ['el', 'Greek'], ['gu', 'Gujarati'], ['he', 'Hebrew'], ['hi', 'Hindi'],
    ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'],
    ['kn', 'Kannada'], ['ko', 'Korean'], ['ms', 'Malay'], ['ml', 'Malayalam'], ['mr', 'Marathi'],
    ['no', 'Norwegian'], ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'],
    ['pa', 'Punjabi'], ['ro', 'Romanian'], ['ru', 'Russian'], ['es', 'Spanish'], ['sw', 'Swahili'],
    ['sv', 'Swedish'], ['ta', 'Tamil'], ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'],
    ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['vi', 'Vietnamese']
  ];
  const nameOf = code => (LANGUAGES.find(l => l[0] === code) || [])[1];
  // Speech synthesis needs BCP-47 tags
  const SPEECH = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', no: 'nb-NO' };

  const $ = id => document.getElementById(id);
  const el = {
    source: $('sourceLang'), target: $('targetLang'), swap: $('swapBtn'),
    input: $('inputText'), output: $('outputText'), count: $('charCount'),
    translate: $('translateBtn'), clear: $('clearBtn'), copy: $('copyBtn'),
    copyLabel: $('copyLabel'), speak: $('speakBtn'), loader: $('loader'),
    error: $('errorBox'), detected: $('detectedInfo'), toast: $('toast'), pill: $('providerPill')
  };

  let MAX_CHARS = 5000;
  let hasResult = false;      // is there a real translation in the output panel?
  let lastDetected = null;    // language code detected by the API (auto mode)
  let inflight = null;        // AbortController of the current request
  let toastTimer = null;

  /* ---------- setup ---------- */
  function fillSelects() {
    const options = LANGUAGES.map(([c, n]) => `<option value="${c}">${n}</option>`).join('');
    el.source.innerHTML = `<option value="auto">Detect language</option>${options}`;
    el.target.innerHTML = options;
    el.source.value = 'auto';
    el.target.value = 'es';
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      if (!res.ok) return;
      const cfg = await res.json();
      if (cfg.maxChars) { MAX_CHARS = cfg.maxChars; el.input.maxLength = MAX_CHARS; updateCount(); }
      if (cfg.provider) {
        const labels = { mymemory: 'MyMemory', libretranslate: 'LibreTranslate', google: 'Google Cloud Translation' };
        el.pill.textContent = `Powered by ${labels[cfg.provider] || cfg.provider}`;
        el.pill.hidden = false;
      }
    } catch { /* non-critical */ }
  }

  /* ---------- UI helpers ---------- */
  function showError(msg) { el.error.textContent = msg; el.error.hidden = false; }
  function hideError() { el.error.hidden = true; el.error.textContent = ''; }

  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }

  function updateCount() {
    const n = el.input.value.length;
    el.count.textContent = `${n.toLocaleString()} / ${MAX_CHARS.toLocaleString()}`;
    el.count.classList.toggle('near', n > MAX_CHARS * 0.9);
  }

  function setResult(text, detected) {
    hasResult = true;
    el.output.textContent = text;
    el.copy.disabled = false;
    el.speak.disabled = !('speechSynthesis' in window);
    const name = detected && (nameOf(detected) || nameOf(detected.split('-')[0]));
    el.detected.textContent = el.source.value === 'auto' && name ? `Detected: ${name}` : '';
    lastDetected = el.source.value === 'auto' ? (detected || null) : null;
  }

  function resetOutput() {
    hasResult = false;
    lastDetected = null;
    el.output.innerHTML = '<span class="placeholder">Your translation appears here.</span>';
    el.copy.disabled = true;
    el.speak.disabled = true;
    el.detected.textContent = '';
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }

  function setLoading(on) {
    el.loader.hidden = !on;
    el.loader.setAttribute('aria-hidden', String(!on));
    el.translate.disabled = on;
    el.translate.textContent = on ? 'Translating…' : 'Translate';
  }

  /* ---------- translate ---------- */
  async function translate() {
    hideError();
    const text = el.input.value;

    if (!text.trim()) {
      showError('Enter some text to translate.');
      el.input.focus();
      return;
    }
    if (el.source.value === el.target.value) {
      showError('The source and target languages are the same. Choose a different target language.');
      return;
    }
    if (!navigator.onLine) {
      showError('You appear to be offline. Check your internet connection and try again.');
      return;
    }

    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 45000);
    setLoading(true);

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source: el.source.value, target: el.target.value }),
        signal: controller.signal
      });

      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }

      if (!res.ok) throw new Error((data && data.error) || `Translation failed (error ${res.status}).`);
      if (!data || typeof data.translatedText !== 'string') throw new Error('The translation service returned an unexpected response.');

      setResult(decodeEntities(data.translatedText), data.detectedLanguage);
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason !== 'timeout') return; // replaced by a newer request
      if (controller.signal.reason === 'timeout') {
        showError('The request timed out. Please try again.');
      } else if (err instanceof TypeError) {
        showError('Network error: could not reach the server. Make sure it is running and you are online.');
      } else {
        showError(err.message);
      }
    } finally {
      clearTimeout(timeout);
      if (inflight === controller) { inflight = null; setLoading(false); }
    }
  }

  // Some APIs return HTML entities such as &#39; – turn them back into plain text.
  function decodeEntities(str) {
    const ta = document.createElement('textarea');
    ta.innerHTML = str;
    return ta.value;
  }

  /* ---------- actions ---------- */
  function swapLanguages() {
    hideError();
    let newTarget = el.source.value;
    if (newTarget === 'auto') {
      newTarget = lastDetected && LANGUAGES.some(l => l[0] === lastDetected) ? lastDetected
        : LANGUAGES.some(l => l[0] === (lastDetected || '').split('-')[0]) ? lastDetected.split('-')[0] : null;
      if (!newTarget) {
        showError('Choose a specific source language before swapping (auto-detect has no language to swap).');
        return;
      }
    }
    const newSource = el.target.value;
    el.source.value = newSource;
    el.target.value = newTarget;

    // Move the translation into the input so the swap feels natural
    if (hasResult) {
      el.input.value = el.output.textContent;
      updateCount();
    }
    resetOutput();

    el.swap.classList.remove('spin');
    void el.swap.offsetWidth;            // restart animation
    el.swap.classList.add('spin');
  }

  async function copyOutput() {
    if (!hasResult) return;
    const text = el.output.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for non-secure contexts / older browsers
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      if (!ok) { showError('Could not copy automatically. Select the text and copy it manually.'); return; }
    }
    el.copy.classList.add('done');
    el.copyLabel.textContent = 'Copied';
    toast('Translation copied to clipboard');
    setTimeout(() => { el.copy.classList.remove('done'); el.copyLabel.textContent = 'Copy'; }, 1800);
  }

  function speakOutput() {
    if (!hasResult || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(el.output.textContent);
    u.lang = SPEECH[el.target.value] || el.target.value;
    u.onerror = () => toast('Speech is not available for this language on your device');
    speechSynthesis.speak(u);
  }

  function clearAll() {
    if (inflight) { inflight.abort(); inflight = null; setLoading(false); }
    el.input.value = '';
    updateCount();
    resetOutput();
    hideError();
    el.input.focus();
  }

  /* ---------- events ---------- */
  el.translate.addEventListener('click', translate);
  el.swap.addEventListener('click', swapLanguages);
  el.copy.addEventListener('click', copyOutput);
  el.speak.addEventListener('click', speakOutput);
  el.clear.addEventListener('click', clearAll);

  el.input.addEventListener('input', () => { updateCount(); if (!el.error.hidden) hideError(); });
  el.input.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); translate(); }
  });
  // Changing a language invalidates the old translation
  [el.source, el.target].forEach(s => s.addEventListener('change', () => { hideError(); if (hasResult) resetOutput(); }));

  /* ---------- init ---------- */
  fillSelects();
  updateCount();
  loadConfig();
})();
