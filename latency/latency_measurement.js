// Měření latence odpovědí ve webovém rozhraní chatu (doba do prvního znaku odpovědi a celková doba).
// Použití: F12 → Console → vložit celý skript → Enter. Výsledky: lat.table(), lat.copy(), lat.reset().
// Verze 3: za odpověď se považuje jen nový text obsahující slovo z testované věty; ignoruje popisky rozhraní
// a překreslení starších zpráv ve vlákně. Konec = poslední okamžik, kdy přibyl nový text odpovědi.
(() => {
  if (window.lat) { console.warn('Měření už běží – použij lat.reset() nebo obnov stránku (F5) a vlož skript znovu.'); return; }
  const QUIET_MS = 5000;      // ticho po poslední změně odpovědi = konec odpovědi
  const MAX_WAIT_MS = 120000; // pojistka, pokud se odpověď vůbec neobjeví
  const strip = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const results = [];
  let run = null, lastInput = '';

  const isEditable = el => el && (el.tagName === 'TEXTAREA' || el.isContentEditable);
  const inUi = n => { const e = n.nodeType === 3 ? n.parentElement : n;
    return !!(e && e.closest('button,[role="button"],textarea,[contenteditable="true"],[aria-hidden="true"]')); };

  // slova testované věty (z řádku "Sentence: …", jinak z posledního řádku zprávy)
  function sentenceWords(msg) {
    const all = [...msg.matchAll(/^\s*Sentence:\s*(.+)$/gm)];
    const s = all.length ? all[all.length - 1][1] : msg.trim().split('\n').pop();
    return [...new Set((strip(s).match(/\p{L}{3,}/gu) || []))];
  }

  function start(message) {
    if (run && performance.now() - run.t0 < 1000) return;
    if (run) finish('přerušeno dalším odesláním');
    const msg = message || lastInput;
    const pre = new WeakSet(), preTexts = new Set(), w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { pre.add(w.currentNode); const t = norm(w.currentNode.data); if (t) preTexts.add(t); }
    run = { t0: performance.now(), sentAt: new Date(), msg: norm(msg), words: sentenceWords(msg),
            pre, preTexts, seen: [], firstSeen: new WeakMap(), answer: new Set(), ttft: null, ttftText: '', tLast: null, timer: null,
            guard: setTimeout(() => finish('odpověď nezachycena'), MAX_WAIT_MS) };
    console.log(`%c#${results.length + 1} odesláno ${iso(run.sentAt)} – čekám na odpověď…`, 'color:gray');
  }

  function consider(node) {
    if (!run || node.nodeType !== 3 || run.pre.has(node) || inUi(node)) return;
    const now = performance.now(), txt = norm(node.data);
    if (!/\p{L}/u.test(txt)) return;
    if (!run.firstSeen.has(node)) run.firstSeen.set(node, now);
    if (run.msg.includes(txt)) return;                                  // ozvěna vlastní zprávy
    if (run.preTexts.has(txt)) return;                                  // překreslení staršího obsahu vlákna
    const st = strip(txt);
    if (!run.answer.has(node) && !run.words.some(w => st.includes(w))) return; // popisek rozhraní, ne odpověď
    run.answer.add(node);
    const fs = run.firstSeen.get(node);
    if (run.ttft === null || fs < run.ttft) { run.ttft = fs; run.ttftText = txt.slice(0, 50); }
    if (run.seen.some(s => s.includes(txt))) return;                    // stejný text jen znovu vykreslený
    run.seen.push(txt);
    run.tLast = now;
    clearTimeout(run.timer);
    run.timer = setTimeout(() => finish(''), QUIET_MS);
  }

  function finish(note) {
    if (!run) return;
    clearTimeout(run.timer); clearTimeout(run.guard);
    const r = {
      n: results.length + 1,
      sent_at: iso(run.sentAt),
      ttft_s: run.ttft === null ? null : +((run.ttft - run.t0) / 1000).toFixed(2),
      total_s: run.tLast === null ? null : +((run.tLast - run.t0) / 1000).toFixed(2),
      first_text: run.ttftText,
      text: [...run.answer].filter(n => n.isConnected).map(n => n.data).join('').trim(),
      note
    };
    results.push(r); run = null;
    console.log(`%c#${r.n}  TTFT ${r.ttft_s ?? '—'} s | celkem ${r.total_s ?? '—'} s  (začátek: "${r.first_text}")`,
                'color:green;font-weight:bold', note);
  }

  function iso(d) {
    const p = x => String(x).padStart(2, '0'), o = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${o >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(o)/60))}:${p(Math.abs(o)%60)}`;
  }

  document.addEventListener('input', e => { if (isEditable(e.target)) lastInput = e.target.value ?? e.target.innerText; }, true);
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && isEditable(e.target)) {
      const m = e.target.value ?? e.target.innerText;
      if (norm(m)) start(m);
    }
  }, true);
  document.addEventListener('click', e => {
    const b = e.target.closest('button,[role="button"]');
    if (!b) return;
    const label = [b.getAttribute('aria-label'), b.getAttribute('data-testid'), b.title, b.innerText].join(' ');
    if (/send|submit|odeslat/i.test(label) && norm(lastInput)) start(lastInput);
  }, true);

  new MutationObserver(muts => {
    if (!run) return;
    for (const m of muts) {
      if (m.type === 'characterData') consider(m.target);
      for (const n of m.addedNodes) {
        if (n.nodeType === 3) consider(n);
        else if (n.nodeType === 1) { const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT); while (w.nextNode()) consider(w.currentNode); }
      }
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  window.lat = {
    results,
    table: () => console.table(results.map(({ text, ...r }) => r)),
    copy: () => {
      const s = JSON.stringify(results.map(({ text, ...r }) => r), null, 2);
      try { copy(s); console.log('Výsledky zkopírovány do schránky.'); }
      catch { navigator.clipboard.writeText(s).then(() => console.log('Výsledky zkopírovány do schránky.'), () => console.log(s)); }
    },
    reset: () => { if (run) { clearTimeout(run.timer); clearTimeout(run.guard); } results.length = 0; run = null; console.log('Výsledky vymazány.'); },
  };
  console.log('%cMěření latence aktivní (v3). Odesílej zprávy normálně; po každé odpovědi se vypíše čas.', 'color:blue;font-weight:bold');
})();
