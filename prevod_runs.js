#!/usr/bin/env node
'use strict';
/**
 * prevod_runs.js — převede dataset a soubory runs_*.json (formát runs_template.json)
 * na vstupy pro hodnoceni_modelu.js: config.json, cases.jsonl, runs.jsonl, reviews.jsonl.
 * Node.js >= 20, bez npm balíčků. Zdrojové soubory nemění.
 *
 * POUŽITÍ
 *   node prevod_runs.js --dataset dataset_1.json --out eval runs_gemini.json runs_claude.json ...
 *
 * VOLBY
 *   --dataset <soubor>      dataset se sadami development / validation / test (povinné)
 *   --out <adresář>         kam zapsat vstupy pro hodnocení (povinné)
 *   --splits test|all       které sady zařadit do plánu běhů; výchozí test (finální výsledky).
 *                           all přidá i vývojové a validační běhy optimalizovaného promptu.
 *   --approver "<jméno>"    kdo schválil referenční odpovědi v datasetu
 *   --approved-at <datum>   kdy je schválil, např. 2026-10-10 nebo 2026-10-10T18:00:00Z
 *                           Bez těchto dvou voleb se reference označí jako "illustrative_only"
 *                           a hodnoticí skript výsledky označí za nefinální.
 *   --skript <soubor>       cesta k hodnoceni_modelu.js (výchozí: vedle tohoto skriptu,
 *                           jinak v aktuálním adresáři). Používá se jeho tokenizace a validace.
 *   --seed <číslo>          seed pro zaslepení a výběr dvojího hodnocení (výchozí 42).
 *                           Po prvním běhu už ho neměňte, změnila by se blinded_id.
 *
 * CO SE KAM MAPUJE
 *   system                         -> product
 *   messages[].model               -> model_label (viditelné označení modelu)
 *   vlákno P1 / P2 / P3            -> prompt_condition baseline / structured / optimized
 *   prompt_version                 -> prompt_version "v<N>"
 *   output                         -> response_text
 *   ttft_s                         -> submitted_monotonic_ms = 0, first_text_monotonic_ms = ttft_s * 1000
 *                                     (šablona ukládá jen rozdíl změřený performance.now(), počátek je konvence)
 *   failure                        -> status + failure_detail (viz níže)
 *   intervention                   -> manual_interventions
 *   interface                      -> vždy "web", aby šly systémy porovnat; přesný popis rozhraní
 *                                     ze setup.interface zůstává v poli interface_detail
 *
 * SELHÁNÍ (pole failure v runs souboru)
 *   null                           -> status completed
 *   text a output není prázdný     -> status completed, text jde do failure_detail
 *                                     (nevyhovující odpověď se hodnotí tak, jak je)
 *   text a output je prázdný       -> podle začátku nebo obsahu textu:
 *        "rate_limit: ..." / limit  -> rate_limit
 *        "timeout: ..."             -> timeout (limit 120 s = MAX_WAIT_MS měřicího skriptu)
 *        "tool_error: ..."          -> tool_error
 *        cokoli jiného              -> service_error
 *
 * VOLITELNÁ POLE V runs souboru
 *   setup.timing_method            web_monotonic (výchozí) | manual_monotonic | unknown
 *   setup.timing_resolution_ms     výchozí 10 (ttft_s je zaokrouhlené na setiny sekundy)
 *
 * reviews.jsonl se vytvoří prázdný jen tehdy, když ještě neexistuje. Existující lidská
 * hodnocení skript nikdy nepřepíše.
 */
const fs = require('node:fs');
const path = require('node:path');

const THREADS = [['P1', 'baseline'], ['P2', 'structured'], ['P3', 'optimized']];
const SPLITS = ['development', 'validation', 'test'];
const STATUS_PREFIX = /^(rate_limit|timeout|service_error|tool_error)\b/i;

function fail(msg) { console.error('Chyba: ' + msg); process.exit(1); }

function parseArgs(argv) {
  const valued = new Set(['--dataset', '--out', '--splits', '--approver', '--approved-at', '--skript', '--seed']);
  const opts = {}, files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (valued.has(a)) {
      if (i + 1 >= argv.length) fail(`Volba ${a} vyžaduje hodnotu.`);
      opts[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) fail(`Neznámá volba ${a}. Zkuste --help.`);
    else files.push(a);
  }
  return { opts, files };
}

function loadEvaluator(explicit) {
  const candidates = explicit ? [explicit]
    : [path.join(__dirname, 'hodnoceni_modelu.js'), path.join(process.cwd(), 'hodnoceni_modelu.js'),
       path.join(__dirname, 'hodnoceni_modelu.cjs'), path.join(process.cwd(), 'hodnoceni_modelu.cjs')];
  for (const c of candidates) if (fs.existsSync(c)) return require(path.resolve(c));
  fail('Nenašel jsem hodnoceni_modelu.js. Dejte ho do stejné složky jako tento skript, nebo použijte --skript <cesta>.');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { fail(`${file}: ${e.message}`); }
}

/** Všechny věty, které vzniknou dosazením podob do šablony s [a|b]. */
function expandTemplate(parsed) {
  let variants = [''];
  for (const t of parsed.tokens) {
    const options = t.kind === 'word' && t.bracket ? t.forms : [t.raw];
    variants = variants.flatMap(v => options.map(o => v + t.gap + o));
  }
  return variants;
}

function buildCases(dataset, ev, review, warn) {
  const cases = [];
  for (const split of SPLITS) {
    for (const t of dataset[split] || []) {
      const ref = t.reference_answer_or_tests || {};
      if (!t.task_id || !ref.compact_variant_template || !Array.isArray(ref.accepted_full_sentences))
        fail(`Dataset, sada ${split}: úloze chybí task_id, compact_variant_template nebo accepted_full_sentences.`);
      if (t.development_validation_test_split && t.development_validation_test_split !== split)
        warn(`${t.task_id}: pole development_validation_test_split (${t.development_validation_test_split}) nesouhlasí se sadou ${split}.`);
      const tpl = ev.parse(ref.compact_variant_template);
      if (tpl.errors.length) fail(`${t.task_id}: šablonu reference nelze přečíst (${tpl.errors.join(', ')}).`);
      const positions = tpl.words.filter(w => w.bracket).map(w => ({ word_index: w.word_index, forms: w.forms }));
      if (!positions.length) fail(`${t.task_id}: šablona reference neobsahuje žádné víceznačné slovo.`);
      const fromTemplate = new Set(expandTemplate(tpl));
      const listed = new Set(ref.accepted_full_sentences.map(s => s.normalize('NFC').trim()));
      if (fromTemplate.size !== listed.size || [...fromTemplate].some(s => !listed.has(s)))
        warn(`${t.task_id}: accepted_full_sentences neodpovídají všem kombinacím ze šablony. Zkontrolujte referenci.`);
      cases.push({
        task_id: t.task_id, capability: t.capability ?? null, task_type: t.task_type ?? null,
        difficulty: t.difficulty ?? null, language: t.language, split,
        input_sentence: t.user_prompt, reference_version: 'v1',
        reference_sentences: ref.accepted_full_sentences, ambiguous_positions: positions,
        expected_properties: t.expected_properties ?? null, edge_case_type: t.edge_case_type ?? [],
        context_or_files: t.context_or_files ?? [], evaluation_method: t.evaluation_method ?? null,
        source_or_provenance: t.source_or_provenance ?? null, reference_review: review,
      });
    }
  }
  return cases;
}

function classifyFailure(m) {
  const output = typeof m.output === 'string' ? m.output : '';
  if (m.failure == null || m.failure === '') return { status: 'completed', response_text: output, detail: null };
  const detail = String(m.failure);
  if (output.trim()) return { status: 'completed', response_text: output, detail };
  const prefix = detail.match(STATUS_PREFIX);
  let status = 'service_error';
  if (prefix) status = prefix[1].toLowerCase();
  else if (/limit|quota|kv[oó]t/i.test(detail)) status = 'rate_limit';
  else if (/time ?out|vypr[sš]el/i.test(detail)) status = 'timeout';
  return { status, response_text: null, detail };
}

function toUtc(sentAt) {
  if (typeof sentAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(sentAt)) return null;
  const t = Date.parse(sentAt);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function convertFile(file, caseById, wantedSplits, warn) {
  const data = readJson(file);
  const name = path.basename(file);
  const product = typeof data.system === 'string' ? data.system.trim() : '';
  if (!product) fail(`${name}: vyplňte pole "system" (např. "Claude").`);
  const setup = data.setup || {};
  const timingMethod = setup.timing_method || 'web_monotonic';
  const resolution = setup.timing_resolution_ms ?? 10;
  const testIds = [...caseById.values()].filter(c => c.split === 'test').map(c => c.task_id);
  const allIds = [...caseById.keys()];
  const runs = [], groups = new Map();
  const keyOf = g => JSON.stringify([g.model_label, g.prompt_condition, g.prompt_version]);

  for (const [thread, condition] of THREADS) {
    const th = (data.threads || {})[thread];
    if (!th) { warn(`${name}: chybí vlákno ${thread}.`); continue; }
    const where = `${name} / ${thread}`;
    const versions = new Map((th.prompt_versions || []).map(v => [v.version, v]));
    // Řádky šablony, které ještě nikdo nevyplnil, se berou jako nesebrané běhy.
    const untouched = m => !(m.output && String(m.output).trim()) && !(m.model && String(m.model).trim()) && !m.sent_at && m.failure == null;
    const messages = (th.messages || []).filter(m => m && m.task_id && !untouched(m));
    const expected = thread === 'P3' ? allIds : testIds;
    const seen = new Set();
    let previous = null, testStarted = false;

    if (thread === 'P3') {
      if (th.frozen_version == null) warn(`${where}: není vyplněné frozen_version.`);
      else if (!versions.has(th.frozen_version)) warn(`${where}: frozen_version ${th.frozen_version} není v prompt_versions.`);
      for (const v of versions.values())
        if (v.version > 1 && !(v.reason && String(v.reason).trim())) warn(`${where}: verze ${v.version} promptu nemá zdůvodnění změny.`);
    }

    for (const m of messages) {
      const c = caseById.get(m.task_id);
      if (!c) fail(`${where}: neznámé task_id "${m.task_id}".`);
      if (!expected.includes(m.task_id)) warn(`${where}: ${m.task_id} do tohoto vlákna nepatří (sada ${c.split}).`);
      const attempt = Number.isInteger(m.attempt) ? m.attempt : 1;
      if (attempt === 1) {
        if (seen.has(m.task_id)) fail(`${where}: ${m.task_id} je tam dvakrát se stejným attempt. Opakování po technickém selhání označte attempt: 2.`);
        seen.add(m.task_id);
      }
      const version = thread === 'P3' ? m.prompt_version : th.prompt_version;
      if (!Number.isInteger(version)) fail(`${where} / ${m.task_id}: chybí číslo verze promptu.`);
      let promptText = th.prompt;
      if (thread === 'P3') {
        if (!versions.has(version)) fail(`${where} / ${m.task_id}: prompt_version ${version} není v prompt_versions.`);
        promptText = versions.get(version).prompt;
        if (c.split === 'test') {
          testStarted = true;
          if (th.frozen_version != null && version !== th.frozen_version)
            warn(`${where} / ${m.task_id}: testovací úloha běžela s verzí ${version}, zmrazená je ${th.frozen_version}.`);
        } else if (testStarted) warn(`${where} / ${m.task_id}: vývojová/validační úloha je zapsaná až za testovacími.`);
      }
      if (typeof promptText !== 'string' || !promptText.includes('{SENTENCE}'))
        warn(`${where}: prompt (verze ${version}) neobsahuje zástupný symbol {SENTENCE}.`);
      const model = typeof m.model === 'string' ? m.model.trim() : '';
      if (!model) fail(`${where} / ${m.task_id}: vyplňte pole "model" (viditelné označení modelu).`);

      const f = classifyFailure(m);
      if (f.status === 'completed' && !f.response_text.trim()) warn(`${where} / ${m.task_id}: prázdný output bez uvedeného selhání; počítá se jako chybná odpověď.`);
      const hasTtft = typeof m.ttft_s === 'number' && Number.isFinite(m.ttft_s) && m.ttft_s >= 0;
      if (!hasTtft && f.status === 'completed' && timingMethod !== 'unknown') warn(`${where} / ${m.task_id}: chybí ttft_s, běh nevstoupí do latence.`);
      if (hasTtft && typeof m.total_s === 'number' && m.total_s < m.ttft_s) warn(`${where} / ${m.task_id}: total_s je menší než ttft_s.`);
      // Další zpráva odeslaná dřív, než předchozí odpověď vůbec začala = podezřelé měření času.
      if (previous && typeof m.sent_at === 'string' && m.sent_at.length >= 19 && previous.sent_at.length >= 19 && previous.ttft != null) {
        const gap = (Date.parse(m.sent_at) - Date.parse(previous.sent_at)) / 1000;
        if (Number.isFinite(gap) && gap + 1 < previous.ttft) // sent_at má rozlišení 1 s
          warn(`${where}: ${m.task_id} odesláno ${gap.toFixed(0)} s po ${previous.task_id}, jehož ttft_s je ${previous.ttft} s. Čas nebo sent_at nesedí.`);
      }
      if (attempt === 1) previous = { task_id: m.task_id, sent_at: typeof m.sent_at === 'string' ? m.sent_at : '', ttft: hasTtft ? m.ttft_s : null };

      if (!wantedSplits.includes(c.split)) continue;
      const group = {
        product, model_label: model, interface: 'web', prompt_condition: condition,
        prompt_version: 'v' + version, collection_protocol_version: 'v1', timing_method: timingMethod,
      };
      const gk = keyOf(group);
      if (!groups.has(gk)) groups.set(gk, { ...group, first_attempt: 1, task_ids: [] });
      if (!groups.get(gk).task_ids.includes(m.task_id)) groups.get(gk).task_ids.push(m.task_id);
      const timed = hasTtft && timingMethod !== 'unknown';
      runs.push({
        run_id: `${product}-${thread}-v${version}-${m.task_id}-a${attempt}`, task_id: m.task_id, ...group,
        attempt, status: f.status, response_text: f.response_text,
        submitted_monotonic_ms: timed ? 0 : null,
        first_text_monotonic_ms: timed ? Math.round(m.ttft_s * 1000) : null,
        timing_resolution_ms: resolution, timeout_limit_ms: f.status === 'timeout' ? 120000 : null,
        submitted_at_utc: toUtc(m.sent_at), sent_at_local: m.sent_at ?? null,
        total_s: typeof m.total_s === 'number' ? m.total_s : null,
        conversation_id: `${product}-${thread}`, prompt_archive_ref: `${name}#threads.${thread}` + (thread === 'P3' ? `.prompt_versions[version=${version}]` : '.prompt'),
        prompt_chars: typeof promptText === 'string' ? promptText.replace('{SENTENCE}', '').length : null,
        system_instruction: setup.system_instruction ?? null, tools_enabled: false, temperature: null,
        max_output_tokens: null, repeat_index: 0,
        manual_interventions: m.intervention ? [String(m.intervention)] : [], failure_detail: f.detail,
        interface_detail: setup.interface ?? null, cost: setup.cost ?? null, source_file: name, thread,
      });
    }

    // Plán: úlohy, které ve vlákně být mají. Chybějící se přiřadí ke skupině zmrazené / jediné verze,
    // aby je hodnoticí skript vykázal jako missing_run místo tichého vynechání.
    const planned = expected.filter(id => wantedSplits.includes(caseById.get(id).split));
    const missing = planned.filter(id => !seen.has(id));
    const labels = [...new Set(messages.map(m => (m.model || '').trim()).filter(Boolean))];
    if (labels.length > 1) warn(`${where}: ve vlákně je více označení modelu (${labels.join(', ')}). Hodnoticí skript je vyhodnotí jako oddělené skupiny.`);
    if (missing.length) {
      warn(`${where}: chybí ${missing.length} z ${planned.length} plánovaných běhů (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}).`);
      const version = thread === 'P3' ? (th.frozen_version ?? Math.max(1, ...versions.keys())) : (th.prompt_version ?? 1);
      const condGroups = [...groups.values()].filter(g => g.prompt_condition === condition);
      let target = condGroups.find(g => g.prompt_version === 'v' + version) || condGroups[condGroups.length - 1];
      if (!target) {
        target = { product, model_label: labels[0] || '(nesebráno)', interface: 'web', prompt_condition: condition,
          prompt_version: 'v' + version, collection_protocol_version: 'v1', timing_method: timingMethod, first_attempt: 1, task_ids: [] };
        groups.set(keyOf(target), target);
      }
      for (const id of missing) if (!target.task_ids.includes(id)) target.task_ids.push(id);
    }
  }
  return { product, runs, groups: [...groups.values()] };
}

function main() {
  const { opts, files } = parseArgs(process.argv.slice(2));
  if (opts.help || !files.length || !opts.dataset || !opts.out) {
    console.log('Použití: node prevod_runs.js --dataset dataset_1.json --out eval runs_gemini.json runs_claude.json ...\n' +
      'Volby: --splits test|all, --approver "<jméno>" --approved-at <datum>, --skript <hodnoceni_modelu.js>, --seed <n>\n' +
      'Podrobnosti jsou v komentáři na začátku skriptu.');
    process.exit(opts.help ? 0 : 1);
  }
  const ev = loadEvaluator(opts.skript);
  const warnings = [];
  const warn = w => warnings.push(w);
  const wantedSplits = (opts.splits || 'test') === 'all' ? SPLITS : (opts.splits || 'test').split(',').map(s => s.trim());
  if (wantedSplits.some(s => !SPLITS.includes(s))) fail('--splits: použijte test, all, nebo seznam z development,validation,test.');

  let review = { status: 'illustrative_only' };
  if (opts.approver || opts['approved-at']) {
    if (!opts.approver || !opts['approved-at']) fail('--approver a --approved-at je potřeba zadat obě.');
    const raw = opts['approved-at'];
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw + 'T00:00:00Z' : raw);
    if (!Number.isFinite(t)) fail('--approved-at: nečitelné datum, použijte např. 2026-10-10.');
    review = { status: 'approved', evaluator_id: opts.approver, reviewed_at_utc: new Date(t).toISOString() };
  } else warn('Reference nejsou označené jako schválené (chybí --approver a --approved-at). Výsledky budou vedené jako nefinální.');

  const cases = buildCases(readJson(opts.dataset), ev, review, warn);
  const caseById = new Map(cases.map(c => [c.task_id, c]));
  const allRuns = [], allGroups = [], products = new Set();
  for (const file of files) {
    const r = convertFile(file, caseById, wantedSplits, warn);
    if (products.has(r.product)) fail(`Systém ${r.product} je ve vstupech dvakrát.`);
    products.add(r.product);
    allRuns.push(...r.runs); allGroups.push(...r.groups);
  }

  const seed = opts.seed === undefined ? 42 : Number(opts.seed);
  const config = {
    protocol_version: 'CZAI-1.0', cases: 'cases.jsonl', runs: 'runs.jsonl', reviews: 'reviews.jsonl', out: 'results',
    seed, max_combinations: 10000, allow_illustrative_references: review.status !== 'approved',
    typographic_equivalences: [], groups: allGroups,
  };
  // Stejné kontroly, jaké pak udělá hodnoticí skript. Běží na kopii, protože validace do případů zapisuje.
  try {
    const copy = JSON.parse(JSON.stringify(cases));
    ev.validateCases(copy, config); ev.validateGroups(config, copy); ev.validateRuns(JSON.parse(JSON.stringify(allRuns)), copy, config);
  } catch (e) { fail('Převedená data neprošla kontrolou hodnoticího skriptu: ' + e.message); }

  const out = path.resolve(opts.out);
  fs.mkdirSync(out, { recursive: true });
  const jl = a => a.map(x => JSON.stringify(x)).join('\n') + (a.length ? '\n' : '');
  fs.writeFileSync(path.join(out, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'cases.jsonl'), jl(cases));
  fs.writeFileSync(path.join(out, 'runs.jsonl'), jl(allRuns));
  const reviews = path.join(out, 'reviews.jsonl');
  const keptReviews = fs.existsSync(reviews);
  if (!keptReviews) fs.writeFileSync(reviews, '');

  console.log(`Zapsáno do ${out}`);
  console.log(`  případů ${cases.length}, systémů ${products.size} (${[...products].join(', ')}), skupin ${allGroups.length}, běhů ${allRuns.length}, sady: ${wantedSplits.join(', ')}`);
  console.log(`  reviews.jsonl: ${keptReviews ? 'ponechán stávající' : 'vytvořen prázdný'}`);
  if (warnings.length) console.log(`Upozornění (${warnings.length}):\n` + warnings.map(w => ' - ' + w).join('\n'));
  console.log(`Další krok: node hodnoceni_modelu.js --config "${path.join(opts.out, 'config.json')}" --out results_01`);
}

main();
