#!/usr/bin/env node
'use strict';
/**
 * CZAI — vyhodnocení české diakritiky a víceznačnosti, verze 1.0.0.
 * Samostatný CommonJS skript; Node.js >= 20; žádné npm balíčky, síť ani API klíče.
 * Soubor ponechte jako .js mimo projekt s package.json {"type":"module"},
 * případně jej v takovém projektu přejmenujte na hodnoceni_modelu.cjs.
 *
 * RYCHLÝ START
 *   node hodnoceni_modelu.js --help
 *   node hodnoceni_modelu.js --self-test
 *   node hodnoceni_modelu.js --init demo
 *   node hodnoceni_modelu.js --config demo/config.json
 * --init vytváří pouze SYNTETICKOU ukázku, nikoli skutečný benchmark!
 * Vytváří config.json, cases.jsonl, runs.jsonl, reviews.jsonl. Soubory upravte
 * podle skutečně zmrazeného plánu, schválených referencí a sesbíraných odpovědí.
 * Poté změňte allow_illustrative_references na false. Skript modely nespouští.
 *
 * KONFIGURACE (všechny cesty relativní k adresáři config.json)
 * {
 *   "protocol_version":"CZAI-1.0", "cases":"cases.jsonl",
 *   "runs":"runs.jsonl", "reviews":"reviews.jsonl", "out":"results",
 *   "seed":42, "max_combinations":10000,
 *   "allow_illustrative_references":false,
 *   "typographic_equivalences":[],
 *   "groups":[{
 *     "product":"ChatGPT", "model_label":"viditelné označení",
 *     "interface":"web", "prompt_condition":"baseline", "prompt_version":"v1",
 *     "collection_protocol_version":"v1", "timing_method":"web_monotonic",
 *     "task_ids":["T01","T02"], "first_attempt":1
 *   }]
 * }
 * Pro každý produkt vytvořte samostatné skupiny baseline/structured/optimized.
 * task_ids je explicitní plán: zahrnuje i běhy, které se nepodařilo sesbírat.
 * Při změně modelu/verze rozdělte plán do skupin, neslučujte je zpětně.
 * Podporované metody času: web_monotonic, api_stream_monotonic,
 * manual_monotonic, unknown. API měření se neslučuje s webovým.
 * unknown znamená nedostupné měření; oba časové údaje musejí být null.
 * Ruční metoda vyžaduje timing_resolution_ms; u ostatních je doporučeno.
 * typographic_equivalences: např. [["’", "'"]] pouze po schválení PŘED testem.
 * Index word_index počítá pouze slova od nuly, čísla jsou další zarovnávací
 * tokeny (ne slovní indexy). Referenční/input čísla musí mít stejné pozice.
 *
 * CASES.JSONL (jeden JSON objekt na řádek)
 * Minimální hodnoticí pole: task_id, split, language:"cs", input_sentence,
 * reference_version, reference_sentences:string[], ambiguous_positions:
 * [{word_index:3,forms:["vila","víla"]}], reference_review:
 * {status:"approved", evaluator_id:"...", reviewed_at_utc:"..."}.
 * Dále vyplňte capability, task_type, difficulty, expected_properties,
 * edge_case_type, context_or_files, evaluation_method, source_or_provenance.
 * Jedna referenční věta nemusí obsáhnout kombinace všech cílových variant,
 * ale union schválených vět musí obsahovat každou podobu každého cíle.
 * Úplnost a jazykovou přípustnost reference musí ověřit člověk.
 *
 * RUNS.JSONL: run_id, task_id, product, model_label, interface,
 * prompt_condition, prompt_version, collection_protocol_version, timing_method,
 * attempt (kladné celé číslo), status, response_text (string nebo null při
 * selhání), submitted_monotonic_ms, first_text_monotonic_ms, timing_resolution_ms,
 * timeout_limit_ms, submitted_at_utc, conversation_id, prompt_text (nebo
 * prompt_archive_ref), system_instruction, tools_enabled, temperature,
 * max_output_tokens, repeat_index, manual_interventions, failure_detail.
 * Nedostupná metadata mají null. Status: completed, timeout, rate_limit,
 * service_error, tool_error, collection_error. Prázdná/odmítnutá odpověď
 * je completed a neúspěch kontraktu, nikoli nedostupnost služby.
 * Sběrač měří oba časové body JEDNĚMI monotónními hodinami ve stejné relaci.
 * web_monotonic: první viditelný text výsledku, nikoli indikátor přemýšlení.
 * Date.now ani přibližná „doba generování“ nejsou vhodné náhrady.
 * Na odlišné relace hodin nelze přijít jen z čísel; odpovídá za ně sběrač.
 *
 * LIDSKÉ POSOUZENÍ — iterativní workflow
 * 1. Spusťte skript. review_queue.jsonl je promíchaný a bez identity produktů.
 *    Obsahuje všechny odpovědi pro jazykové hodnocení (automatická shoda sama
 *    neplní povinnou lidskou složku). review_required značí nutnou kontrolu.
 *    double_review_selected označuje stratifikovaný vzorek >=20 % záznamů.
 * 2. Vybraným odpovědím přidělte dva různé hodnotitele. Nesdílejte s nimi
 *    per_run_results ani manifest: obsahují identitu systémů.
 * 3. Posouzení připište do reviews.jsonl, poté přepočítejte stejným příkazem.
 * {
 *   "blinded_id":"B_...", "reference_version":"v1", "evaluator_id":"E1",
 *   "dimension":"language_correction", "decision":"pass",
 *   "reason":"Oprava mimo maskované pozice je přípustná.",
 *   "adjudicated":false, "reviewed_at_utc":"2026-10-11T15:00:00Z"
 * }
 * Lze použít i původní run_id. blinded_id je stabilní hash seed+run_id.
 * decision: pass/fail/pending. Rozporná rozhodnutí zůstávají pending,
 * dokud třetí posouzení s adjudicated:true nepotvrdí konečné rozhodnutí.
 * Více konečných adjudikací musí souhlasit; jinak je třeba opravit vstup.
 * Opakovaná rozhodnutí téhož hodnotitele pro tutéž dimenzi/verzi nejsou
 * dovolena (nezaměňovat změnu hlasu za druhého hodnotitele).
 * reference_validity: fail/pending blokuje výsledky dotčeného případu;
 * opravenou referenci uložte pod NOVOU verzí a přepočítejte VŠECHNY systémy.
 * Starší reviews zůstávají v auditu, ale neovlivní novou verzi.
 *
 * ALIGNMENT review při nejasném zarovnání:
 * dimension:"alignment", decision:"pass", word_map:[0,1,2,3],
 * order_preserved:true, extra_words:false, missing_words:false.
 * word_map mapuje referenční SLOVNÍ index -> slovní index výstupu, null značí
 * chybějící slovo. Má délku počtu referenčních slov. Každý výstupní index se
 * smí použít jednou. Pole jsou povinná a odvozují se i automaticky z mapy.
 * Člověk může jednoznačně určit cíle i u věty s přidaným slovem; M1 pak
 * vyhodnotí cíle, M2 je vždy 0 kvůli porušení pořadí/počtu slov.
 * alignment fail: M1=0 (alignment_error); M2 čeká na language_correction.
 * Formátové chyby jsou předem deklarované M1=M2=0, nelze je přepsat
 * jazykovým pass. Jedna řádka nesmí obsahovat komentář; nejasné jednořádkové
 * doplňky rozpozná konzervativní zarovnání a člověk, nikoli heuristický LLM.
 *
 * METODIKA
 * M1: úplná rovnost množin na všech cílech a žádné závorky jinde. Case-insensitive,
 * NFC; diakritika zůstává. M2: masky pouze referenčních cílů, včetně M1 chyb,
 * zachovaná interpunkce/case ostatních slov. Závorky mimo cíle vyžadují shodu
 * VŠECH kombinací s některou referencí; nad limit -> pending, nikoli nula.
 * Neshoda M2 je předběžná 0; konečné skóre až po lidském potvrzení.
 * Zarovnání je automatické jen pro stejný počet tokenů a shodu každé pozice
 * s input nebo některou referencí po odstranění diakritiky; nové opravy čekají
 * na člověka. Nelze automaticky dokázat, že identická slova nebyla prohozena.
 * M3: medián dostupných latencí prvních plánovaných pokusů, i při následném
 * selhání; chybějící/negativní časy nevstupují do numerického skóre.
 * Intervaly M1/M2: 95% Wilson, kvartily lineární interpolace (n-1)*p.
 * N zahrnuje celý explicitní plán, technická selhání mají skóre 0.
 * Chybějící běhy a collection_error blokují finální report (skóre null).
 * Pokusy > first_attempt jsou pouze v per_run_results, nepřepisují první.
 * Split se reportuje odděleně. Verze, metody času a protokoly se neslučují.
 * Párová porovnání používají stejné task_id a shodný model/interface/protokol/
 * timing_method; při nedokončených dvojicích jen předběžné skóre a počet párů.
 * Souhrnný efekt = nevážený průměr úplných rozdílů systémů. Bez bootstrapu,
 * testu významnosti, automatického výroku o podpoře H nebo váženého skóre.
 * Hodnotitelé: Cohenova kappa a shoda jsou počítány pro každou dvojici zvlášť
 * z neadjudikovaných pass/fail; pending a staré verze se nezapočítávají.
 *
 * VÝSTUP: šest požadovaných souborů a reviewer_agreement.json,
 * pooled_prompt_effects.json. CSV je RFC4180 s BOM pro Excel; JSONL UTF-8.
 * Manifest obsahuje SHA256 vstupů/skriptu, konfiguraci, audit, plán, upozornění.
 * error_analysis.md je PODKLAD, nikoli nahrazení lidské analýzy: vybírá
 * deterministicky až 8 různých případů, úspěchy i různé druhy chyb.
 * --out lze změnit; použijte nový adresář pro každou verzi experimentu.
 * Existující reporty nikdy nepřepisuje; zdrojová data nikdy nemění.
 * Stejné vstupy dávají stejná skóre/pořadí; čas v manifestu se přirozeně mění.
 * Exit 0: kompletní skóre; 2: předběžné výsledky/chybějící data; 1: chyba vstupu.
 * Kompletní skóre neznamená automaticky splnění školního zadání: ověřte
 * 40 případů, 4 produkty, 3 prompty, terminologii, reference a dvojí hodnocení.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const VERSION = '1.0.0';
const CONDITIONS = ['baseline', 'structured', 'optimized'];
const SPLITS = ['development', 'validation', 'test'];
const STATUSES = ['completed','timeout','rate_limit','service_error','tool_error','collection_error'];
const METHODS = ['web_monotonic','api_stream_monotonic','manual_monotonic','unknown'];
const KEYS = ['product','model_label','interface','prompt_condition','prompt_version',
  'collection_protocol_version','timing_method'];
const WORD = /\p{L}[\p{L}\p{M}]*(?:[-'’]\p{L}[\p{L}\p{M}]*)*/u;
const FULL_WORD = new RegExp(`^(?:${WORD.source})$`, 'u');
const SCAN = new RegExp(`\\[[^\\[\\]]*\\]|${WORD.source}|\\p{N}+|[^\\s]`, 'gu');
function check(ok, message) { if (!ok) throw new Error(message); }
function str(v) { return typeof v === 'string' && v.trim().length > 0; }
function lower(s) { return s.normalize('NFC').toLocaleLowerCase('cs'); }
// Czech-restricted casefold: toLocaleLowerCase suffices for Czech alphabet.
function base(s) { return lower(s).normalize('NFD').replace(/\p{M}/gu,''); }
function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function key(o) { return JSON.stringify(KEYS.map(k => o[k])); }
function blind(run, seed) { return 'B_' + hash(JSON.stringify([seed,run.run_id])).slice(0,24); }
function rng(seed) { let a = seed >>> 0; return () => {
  a += 0x6D2B79F5; let t=a; t=Math.imul(t^(t>>>15),t|1);
  t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296;
}; }
function shuffle(a, random) { const b=[...a]; for(let i=b.length-1;i>0;i--) {
  const j=Math.floor(random()*(i+1)); [b[i],b[j]]=[b[j],b[i]];
} return b; }
function quantile(values,p) { if(!values.length) return null;
  const a=[...values].sort((x,y)=>x-y), h=(a.length-1)*p, i=Math.floor(h);
  return a[i]+(a[Math.min(i+1,a.length-1)]-a[i])*(h-i);
}
function wilson(k,n) { if(!n) return [null,null]; const z=1.959963984540054,
  p=k/n, d=1+z*z/n, c=(p+z*z/(2*n))/d,
  h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [Math.max(0,100*(c-h)),Math.min(100,100*(c+h))];
}
function jsonl(file) {
  const s=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'');
  return s.split(/\r?\n/).flatMap((line,i)=>{ if(!line.trim()) return [];
    try { const v=JSON.parse(line); check(v && typeof v==='object' && !Array.isArray(v),'objekt'); return [v]; }
    catch(e) { throw new Error(`${file}:${i+1}: ${e.message}`); }
  });
}
function unique(items, field, label) { const set=new Set(); for(const o of items) {
  check(str(o[field]),`${label}: chybí ${field}`);
  check(!set.has(o[field]),`${label}: duplicitní ${field} ${o[field]}`); set.add(o[field]);
} }
/** Punctuation remains its own token, never swallowed by an ambiguity mask. */
function parse(text) {
  const normalized=typeof text==='string' ? text.normalize('NFC').trim() : '';
  const errors=[];
  if(!normalized) errors.push('empty_response');
  if(normalized.split(/\r?\n/).filter(l=>l.trim()).length>1) errors.push('multiple_lines');
  if(/[`{}<>]/u.test(normalized)) errors.push('markdown_or_markup');
  const tokens=[], words=[]; let previousEnd=0;
  for(const m of normalized.matchAll(SCAN)) {
    const raw=m[0]; let token={kind:'punct',raw};
    if(raw.startsWith('[') && raw.endsWith(']')) {
      const forms=raw.slice(1,-1).split('|');
      if(forms.length<2 || forms.some(f=>!FULL_WORD.test(f)) ||
        new Set(forms.map(lower)).size!==forms.length ||
        new Set(forms.map(base)).size!==1) errors.push('invalid_bracket');
      token={kind:'word', raw, forms, bracket:true};
    } else if(FULL_WORD.test(raw)) token={kind:'word',raw,forms:[raw],bracket:false};
    else if(/^\p{N}+$/u.test(raw)) token={kind:'number',raw};
    else if(/[\[\]|]/u.test(raw)) errors.push('stray_bracket_or_bar');
    token.gap=normalized.slice(previousEnd,m.index).length>0 ? ' ' : '';
    previousEnd=m.index+raw.length;
    if(token.kind==='word') { token.word_index=words.length; words.push(token); }
    tokens.push(token);
  }
  // [..] must occupy an entire word, not e.g. pra[ha|há] or [vila|víla]x.
  if(/(?:[\p{L}\p{M}\p{N}'’\-]\[|\][\p{L}\p{M}\p{N}'’\-])/u.test(normalized))
    errors.push('bracket_inside_word');
  if(!words.length) errors.push('no_words');
  return {normalized,tokens,words,errors:[...new Set(errors)]};
}
function canonicalTokens(tokens, cfg) {
  return tokens.map(t=>{ let s=t;
    for(const [from,to] of cfg.typographic_equivalences) s=s.split(from).join(to);
    return s.normalize('NFC');
  });
}
function signature(tokens,cfg) { return JSON.stringify(canonicalTokens(tokens,cfg).join('')); }
function maskedRef(parsed,amb,cfg) { return signature(parsed.tokens.map(t=>
  t.gap+(t.kind==='word' && amb.has(t.word_index) ? `<AMB_${t.word_index}>` : t.raw)),cfg); }
function automaticAlignment(c,p) {
  const input=parse(c.input_sentence), refs=c._refs;
  const lex=x=>x.tokens.filter(t=>t.kind!=='punct');
  const a=lex(p), b=lex(input);
  if(a.length!==b.length) return null;
  if(a.some((t,i)=>t.kind!==b[i].kind)) return null;
  for(let i=0;i<a.length;i++) {
    if(a[i].kind==='number') { if(a[i].raw!==b[i].raw) return null; continue; }
    const allowed=new Set([b[i].raw,...refs.map(r=>lex(r)[i].raw)].map(base));
    if(a[i].forms.some(f=>!allowed.has(base(f)))) return null;
  }
  return c._refs[0].words.map((_,i)=>i);
}
function resolveReview(reviews,dimension) {
  const a=reviews.filter(r=>r.dimension===dimension);
  if(!a.length) return {decision:null,records:[]};
  const adjudications=a.filter(r=>r.adjudicated);
  const votes=adjudications.length ? adjudications : a;
  const choices=new Set(votes.map(r=>r.decision));
  if(choices.size!==1 || choices.has('pending')) return {decision:'pending',records:a};
  const decision=votes[0].decision;
  // Maps may not be silently chosen when independent raters disagree.
  if(dimension==='alignment' && decision==='pass' &&
    new Set(votes.map(r=>JSON.stringify([r.word_map,r.order_preserved,r.extra_words,r.missing_words]))).size!==1)
    return {decision:'pending',records:a};
  return {decision,record:votes[0],records:a};
}
function latency(run) {
  const start=run.submitted_monotonic_ms, first=run.first_text_monotonic_ms;
  if(start==null || first==null) return {seconds:null,issue:'missing_timing'};
  if(!Number.isFinite(start)||!Number.isFinite(first)||start<0||first<start)
    return {seconds:null,issue:'invalid_timing'};
  if(run.timing_method==='unknown') return {seconds:null,issue:'unknown_timing_method'};
  // Keep the protocol's exact difference. Declared resolution travels alongside
  // the value; consumers must not interpret decimal digits as extra precision.
  return {seconds:(first-start)/1000,issue:null};
}
function languageMatch(c,p,map,cfg) {
  const amb=new Set(c.ambiguous_positions.map(a=>a.word_index));
  const reverse=new Map(map.map((out,ref)=>[out,ref]));
  const refs=new Set(c._refs.map(r=>maskedRef(r,amb,cfg)));
  let variants=[[]];
  for(const t of p.tokens) {
    let options=[t.raw];
    if(t.kind==='word') {
      const ref=reverse.get(t.word_index);
      options=amb.has(ref) ? [`<AMB_${ref}>`] : t.forms;
    }
    if(variants.length*options.length>cfg.max_combinations) return {score:null,reason:'combination_limit'};
    variants=variants.flatMap(v=>options.map(o=>[...v,t.gap+o]));
  }
  return {score:variants.every(v=>refs.has(signature(v,cfg))) ? 1 : 0,
    combinations:variants.length};
}
function evaluate(c,run,reviews,cfg) {
  const p=parse(run.response_text), t=latency(run);
  const r={run_id:run.run_id, task_id:c.task_id, reference_version:c.reference_version,
    split:c.split, ...Object.fromEntries(KEYS.map(k=>[k,run[k]])),attempt:run.attempt,
    status:run.status, response_text:run.response_text, parsed:p,
    M1_auto:null,M1:null,M2_auto:null,M2:null, M2_provisional:null,
    latency_s:t.seconds,timing_issue:t.issue,diagnostics:[],needs_human_review:[],
    false_ambiguities:0,unambiguous_word_positions:c._refs[0].words.length-c.ambiguous_positions.length,
    collection_metadata:{...run},timing_resolution_ms:run.timing_resolution_ms,
    timeout_limit_ms:run.timeout_limit_ms??null,review_audit:reviews};
  const diag=(code,detail={})=>r.diagnostics.push({code,...detail});
  if(run.status==='collection_error') { diag('collection_error'); r.needs_human_review.push('collection_error'); return r; }
  if(run.status!=='completed') { r.M1_auto=r.M1=r.M2_auto=r.M2=r.M2_provisional=0; diag(run.status); return r; }
  if(p.errors.length) {
    r.M1_auto=r.M1=r.M2_auto=r.M2=r.M2_provisional=0; diag('format_error',{details:p.errors}); return r;
  }
  const ar=resolveReview(reviews,'alignment'); let map=automaticAlignment(c,p);
  let violation=false;
  if(ar.decision==='pending') { map=null; }
  else if(ar.decision==='fail') { map=null; r.M1_auto=r.M1=0; diag('alignment_error'); }
  else if(ar.decision==='pass') {
    map=ar.record.word_map;
    const used=map.filter(x=>x!==null);
    violation=used.length!==map.length || used.length!==p.words.length ||
      used.some((v,i)=>i>0 && v<used[i-1]) || !ar.record.order_preserved ||
      ar.record.extra_words || ar.record.missing_words;
  }
  if(!map) {
    if(ar.decision!=='fail') { diag('alignment_error'); r.needs_human_review.push('alignment'); }
  } else {
    const amb=new Map(c.ambiguous_positions.map(a=>[a.word_index,a.forms.map(lower)]));
    let ok=true;
    for(const [j,gold] of amb) {
      const tok=map[j]===null ? null : p.words[map[j]];
      if(!tok?.bracket) { ok=false; diag('ambiguity_not_marked',{word_index:j,chosen:tok?.raw??null}); continue; }
      const pred=tok.forms.map(lower), missing=gold.filter(f=>!pred.includes(f)), extra=pred.filter(f=>!gold.includes(f));
      if(missing.length) { ok=false; diag('missing_form',{word_index:j,forms:missing}); }
      if(extra.length) { ok=false; diag('extra_form',{word_index:j,forms:extra}); }
      const approved=new Set(c._refs.map(ref=>ref.words[j].raw));
      for(const f of tok.forms) if(gold.includes(lower(f)) && !approved.has(f))
        diag('masked_capitalization',{word_index:j,form:f});
    }
    const targets=new Set([...amb.keys()].map(j=>map[j]).filter(j=>j!==null));
    for(const tok of p.words) if(tok.bracket && !targets.has(tok.word_index)) {
      ok=false; r.false_ambiguities++; diag('false_ambiguity',{output_word_index:tok.word_index});
    }
    r.M1_auto=r.M1=Number(ok);
    if(violation) { diag('word_order_or_count_violation'); r.M2_auto=r.M2=r.M2_provisional=0; }
    else {
      const m=languageMatch(c,p,map,cfg); r.M2_auto=m.score;
      r.M2_provisional=m.score===null ? null : m.score;
      if(m.reason) diag(m.reason);
      if(m.score===1) r.M2=1;
      else r.needs_human_review.push('language_correction');
    }
  }
  const lr=resolveReview(reviews,'language_correction');
  if(!violation && lr.decision!==null) {
    r.M2=lr.decision==='pending' ? null : Number(lr.decision==='pass');
    if(lr.decision!=='pending') r.needs_human_review=r.needs_human_review.filter(d=>d!=='language_correction');
  }
  if(r.M2===null && !r.needs_human_review.includes('language_correction')) r.needs_human_review.push('language_correction');
  return r;
}
function validateCases(cases,cfg) {
  unique(cases,'task_id','cases'); check(cases.length,'Prázdná sada případů');
  for(const c of cases) {
    check(SPLITS.includes(c.split) && c.language==='cs',`${c.task_id}: split/language`);
    check(str(c.input_sentence)&&str(c.reference_version),`${c.task_id}: input/reference_version`);
    check(Array.isArray(c.reference_sentences)&&c.reference_sentences.length>0 &&
      c.reference_sentences.every(str),`${c.task_id}: reference_sentences`);
    check(Array.isArray(c.ambiguous_positions),`${c.task_id}: ambiguous_positions`);
    const review=c.reference_review;
    check(review && (review.status==='approved' ||
      (cfg.allow_illustrative_references && review.status==='illustrative_only')),`${c.task_id}: neschválená reference`);
    if(review.status==='approved') check(str(review.evaluator_id)&&validDate(review.reviewed_at_utc),`${c.task_id}: kdo/kdy schválil referenci`);
    c._refs=c.reference_sentences.map(parse); const input=parse(c.input_sentence);
    check(!input.errors.length && input.words.every(w=>!w.bracket),`${c.task_id}: neplatný input`);
    for(const ref of c._refs) {
      check(!ref.errors.length && ref.words.every(w=>!w.bracket),`${c.task_id}: neplatná reference`);
      const lex=p=>p.tokens.filter(t=>t.kind!=='punct'); const a=lex(input), b=lex(ref);
      check(a.length===b.length && a.every((t,i)=>t.kind===b[i].kind &&
        (t.kind!=='number'||t.raw===b[i].raw)),`${c.task_id}: reference mění počet slov/pozici čísel`);
    }
    const ids=new Set(); for(const a of c.ambiguous_positions) {
      check(Number.isInteger(a.word_index)&&a.word_index>=0&&a.word_index<input.words.length&&!ids.has(a.word_index),`${c.task_id}: cílový index`);
      ids.add(a.word_index);
      check(Array.isArray(a.forms)&&a.forms.length>=2&&a.forms.every(f=>str(f)&&FULL_WORD.test(f))&&
        new Set(a.forms.map(lower)).size===a.forms.length&&new Set(a.forms.map(base)).size===1,`${c.task_id}: neplatná množina podob`);
      const forms=new Set(a.forms.map(lower)), union=new Set(c._refs.map(ref=>lower(ref.words[a.word_index].raw)));
      check([...union].every(f=>forms.has(f))&&[...forms].every(f=>union.has(f)),`${c.task_id}: podoby a reference si neodpovídají`);
    }
  }
}
function validDate(s) { return str(s) && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(s) && Number.isFinite(Date.parse(s)); }
function validateGroups(cfg,cases) {
  check(str(cfg.protocol_version),'Chybí protocol_version');
  check(Number.isInteger(cfg.seed)&&cfg.seed>=0&&cfg.seed<=0xffffffff,'seed: uint32');
  check(Number.isSafeInteger(cfg.max_combinations)&&cfg.max_combinations>0,'max_combinations: kladné celé číslo');
  check(typeof cfg.allow_illustrative_references==='boolean','allow_illustrative_references: boolean');
  check(Array.isArray(cfg.typographic_equivalences)&&cfg.typographic_equivalences.every(p=>
    Array.isArray(p)&&p.length===2&&p.every(str)), 'typographic_equivalences: dvojice řetězců');
  check(Array.isArray(cfg.groups)&&cfg.groups.length>0,'Chybí explicitní groups/plán');
  const caseIds=new Set(cases.map(c=>c.task_id)), keys=new Set();
  for(const g of cfg.groups) {
    check(KEYS.every(k=>str(g[k])), 'Skupina: chybí identifikační údaj');
    check(CONDITIONS.includes(g.prompt_condition)&&METHODS.includes(g.timing_method),'Skupina: podmínka/metoda času');
    check(!keys.has(key(g)),'Duplicitní skupina'); keys.add(key(g));
    check(Number.isInteger(g.first_attempt)&&g.first_attempt>0,'first_attempt');
    check(Array.isArray(g.task_ids)&&g.task_ids.length>0&&new Set(g.task_ids).size===g.task_ids.length &&
      g.task_ids.every(t=>caseIds.has(t)),'Skupina: neplatný/duplicitní task_ids');
  }
}
function validateRuns(runs,cases,cfg) {
  unique(runs,'run_id','runs'); const ids=new Set(cases.map(c=>c.task_id)), combinations=new Set();
  for(const r of runs) {
    check(ids.has(r.task_id),`${r.run_id}: neznámé task_id`);
    check(KEYS.every(k=>str(r[k])),`${r.run_id}: chybí metadata skupiny`);
    const g=cfg.groups.find(g=>key(g)===key(r));
    check(g && g.task_ids.includes(r.task_id),`${r.run_id}: běh mimo explicitní plán`);
    check(Number.isInteger(r.attempt)&&r.attempt>=g.first_attempt,`${r.run_id}: attempt`);
    check(STATUSES.includes(r.status),`${r.run_id}: status`);
    check(typeof r.response_text==='string' || (r.response_text===null && r.status!=='completed'),`${r.run_id}: response_text`);
    const ck=JSON.stringify([key(r),r.task_id,r.attempt]);
    check(!combinations.has(ck),`${r.run_id}: duplicitní kombinace pokusu`); combinations.add(ck);
    for(const k of ['submitted_monotonic_ms','first_text_monotonic_ms'])
      check(r[k]===null||Number.isFinite(r[k]),`${r.run_id}: ${k} má být číslo/null`);
    check(r.timing_resolution_ms===null || (Number.isFinite(r.timing_resolution_ms)&&r.timing_resolution_ms>0),`${r.run_id}: timing_resolution_ms`);
    if(r.timing_method==='manual_monotonic') check(r.timing_resolution_ms>0,`${r.run_id}: ruční měření vyžaduje rozlišení`);
    if(r.timing_method==='unknown') check(r.first_text_monotonic_ms===null&&r.submitted_monotonic_ms===null,`${r.run_id}: unknown vyžaduje null časy`);
    if(r.timeout_limit_ms!=null) check(Number.isFinite(r.timeout_limit_ms)&&r.timeout_limit_ms>0,`${r.run_id}: timeout_limit_ms`);
    if(r.status==='timeout') check(r.timeout_limit_ms>0,`${r.run_id}: timeout potřebuje limit`);
  }
}
function validateReviews(reviews,runs,cases,cfg) {
  const rm=new Map(runs.map(r=>[r.run_id,r])), bm=new Map(runs.map(r=>[blind(r,cfg.seed),r.run_id]));
  const cm=new Map(cases.map(c=>[c.task_id,c])), seen=new Set();
  for(const r of reviews) {
    if(r.blinded_id) {
      check(bm.has(r.blinded_id),`Neznámé blinded_id ${r.blinded_id}`);
      check(!r.run_id||r.run_id===bm.get(r.blinded_id),'run_id a blinded_id se liší');
      r.run_id=bm.get(r.blinded_id);
    }
    check(rm.has(r.run_id),'Review: neznámé run_id');
    check(str(r.reference_version)&&str(r.evaluator_id)&&str(r.reason)&&validDate(r.reviewed_at_utc),'Review: chybí verze/hodnotitel/důvod/UTC datum');
    check(['language_correction','alignment','reference_validity'].includes(r.dimension),'Review: dimenze');
    check(['pass','fail','pending'].includes(r.decision)&&typeof r.adjudicated==='boolean','Review: decision/adjudicated');
    const k=JSON.stringify([r.run_id,r.reference_version,r.evaluator_id,r.dimension,r.adjudicated]);
    check(!seen.has(k),'Review: duplicitní hlas téhož hodnotitele'); seen.add(k);
    if(r.dimension==='alignment' && r.decision==='pass') {
      const run=rm.get(r.run_id), c=cm.get(run.task_id), p=parse(run.response_text);
      // Old versions remain audit-only; their old number of words can differ.
      if(r.reference_version!==c.reference_version) continue;
      check(Array.isArray(r.word_map)&&r.word_map.length===c._refs[0].words.length &&
        r.word_map.every(i=>i===null || (Number.isInteger(i)&&i>=0&&i<p.words.length)), 'Review: word_map');
      const a=r.word_map.filter(i=>i!==null);
      check(new Set(a).size===a.length,'Review: mapování není jednoznačné');
      check(['order_preserved','extra_words','missing_words'].every(k=>typeof r[k]==='boolean'),'Review: povinné příznaky pořadí/počtu');
    }
  }
}
function metric(rows,field,provisional=false) {
  const vals=rows.map(r=>provisional ? (r[field]??r[field+'_provisional']) : r[field]);
  const pending=vals.filter(v=>v===null||v===undefined).length, n=rows.length,
    successes=vals.filter(v=>v===1).length;
  const pct=pending||!n ? null : 100*successes/n;
  return {successes,N:n,pending,percent:pct,ci95:pct===null?[null,null]:wilson(successes,n)};
}
function summarize(rows,g,split) {
  const M1=metric(rows,'M1'),M2=metric(rows,'M2'),lat=rows.map(r=>r.latency_s).filter(v=>v!==null);
  return {...Object.fromEntries(KEYS.map(k=>[k,g[k]])),split,N:rows.length,
    M1_successes:M1.successes,M1_pending:M1.pending,M1_percent:M1.percent,M1_ci95_low:M1.ci95[0],M1_ci95_high:M1.ci95[1],
    M2_successes:M2.successes,M2_pending:M2.pending,M2_percent:M2.percent,M2_ci95_low:M2.ci95[0],M2_ci95_high:M2.ci95[1],
    M2_provisional_percent:metric(rows,'M2',true).percent,
    M3_median_s:quantile(lat,.5),M3_q1_s:quantile(lat,.25),M3_q3_s:quantile(lat,.75),
    M3_IQR_s:lat.length?quantile(lat,.75)-quantile(lat,.25):null,
    timing_resolution_ms_values:JSON.stringify([...new Set(rows.filter(r=>r.latency_s!==null).map(r=>r.timing_resolution_ms??null))]),
    timing_precision_note:'Desetinná místa nepředstavují přesnost vyšší než uvedené rozlišení měření.',
    timing_valid:lat.length,timing_missing:rows.filter(r=>r.timing_issue==='missing_timing').length,
    timing_invalid:rows.filter(r=>r.timing_issue==='invalid_timing').length,
    timing_unknown:rows.filter(r=>r.timing_issue==='unknown_timing_method').length,
    M3_note:!lat.length?'Žádné platné měření':lat.length<10?'Malý vzorek; omezená přesnost':null,
    missing_runs:rows.filter(r=>r.status==='missing_run').length,
    timeouts:rows.filter(r=>r.status==='timeout').length,
    failures:rows.filter(r=>r.status!=='completed'&&r.status!=='missing_run').length,
    failure_counts:JSON.stringify(Object.fromEntries(STATUSES.filter(s=>s!=='completed').map(s=>[s,rows.filter(r=>r.status===s).length]))),
    false_ambiguities:rows.reduce((s,r)=>s+r.false_ambiguities,0),
    false_ambiguity_percent:(()=>{ const d=rows.reduce((s,r)=>s+r.unambiguous_word_positions,0);
      return d?100*rows.reduce((s,r)=>s+r.false_ambiguities,0)/d:null; })(),
    false_ambiguity_note:'Jmenovatel: všechny plánované jednoznačné pozice; nezarovnané/selhané výstupy nelze posoudit.',
    completed_N:rows.filter(r=>r.status==='completed').length,
    completed_M1_percent:metric(rows.filter(r=>r.status==='completed'),'M1').percent,
    completed_M2_percent:metric(rows.filter(r=>r.status==='completed'),'M2').percent,
    report_state:rows.some(r=>r.M1===null||r.M2===null)?'provisional':'final'};
}
function compareGroups(groups,rows) {
  const comparisons=[];
  const compatible=(a,b)=>['product','model_label','interface','collection_protocol_version','timing_method'].every(k=>a[k]===b[k]);
  for(let i=0;i<groups.length;i++) for(let j=i+1;j<groups.length;j++) {
    let a=groups[i],b=groups[j]; if(!compatible(a,b)||a.prompt_condition===b.prompt_condition) continue;
    if(CONDITIONS.indexOf(a.prompt_condition)>CONDITIONS.indexOf(b.prompt_condition)) [a,b]=[b,a];
    for(const split of SPLITS) {
      const ar=rows.filter(r=>key(r)===key(a)&&r.split===split), br=rows.filter(r=>key(r)===key(b)&&r.split===split);
      if(!ar.length||!br.length) continue;
      const pairs=ar.map(x=>[x,br.find(y=>y.task_id===x.task_id)]).filter(p=>p[1]);
      for(const m of ['M1','M2']) {
        const valid=pairs.filter(([x,y])=>x[m]!==null&&y[m]!==null);
        const improved=valid.filter(([x,y])=>y[m]>x[m]).length, worsened=valid.filter(([x,y])=>y[m]<x[m]).length;
        const complete=pairs.length===ar.length&&pairs.length===br.length&&valid.length===pairs.length;
        comparisons.push({product:a.product,model_label:a.model_label,interface:a.interface,
          collection_protocol_version:a.collection_protocol_version,timing_method:a.timing_method,split,
          from:a.prompt_condition,from_version:a.prompt_version,to:b.prompt_condition,to_version:b.prompt_version,
          metric:m,paired_task_ids:JSON.stringify(pairs.map(([x])=>x.task_id).sort()),planned_from_N:ar.length,planned_to_N:br.length,paired_N:pairs.length,resolved_pairs:valid.length,
          improved,worsened,unchanged:valid.length-improved-worsened,
          difference_pp:complete&&valid.length?100*(improved-worsened)/valid.length:null,
          resolved_pairs_difference_pp:valid.length?100*(improved-worsened)/valid.length:null,
          report_state:complete?'final':'provisional'});
      }
    }
  }
  return comparisons;
}
function agreement(reviews,rows) {
  const active=reviews.filter(r=>!r.adjudicated && ['pass','fail'].includes(r.decision) &&
    rows.some(x=>x.run_id===r.run_id&&x.reference_version===r.reference_version));
  const ids=[...new Set(active.map(r=>r.evaluator_id))].sort(), output=[];
  for(let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++)
    for(const d of ['language_correction','alignment','reference_validity']) {
      const a=active.filter(r=>r.evaluator_id===ids[i]&&r.dimension===d),
        b=active.filter(r=>r.evaluator_id===ids[j]&&r.dimension===d);
      const pairs=a.map(x=>[x,b.find(y=>y.run_id===x.run_id)]).filter(p=>p[1]);
      if(!pairs.length) continue;
      const n=pairs.length, po=pairs.filter(([x,y])=>x.decision===y.decision).length/n,
        pa=pairs.filter(([x])=>x.decision==='pass').length/n,
        pb=pairs.filter(([,y])=>y.decision==='pass').length/n,pe=pa*pb+(1-pa)*(1-pb);
      output.push({evaluators:[ids[i],ids[j]],dimension:d,N:n,agreement:po,
        cohen_kappa:Math.abs(1-pe)<1e-12?null:(po-pe)/(1-pe),
        disagreements:pairs.filter(([x,y])=>x.decision!==y.decision).map(([x])=>x.run_id)});
    }
  return output;
}
function csv(rows,emptyHeaders=[]) {
  const fields=rows.length?[...new Set(rows.flatMap(r=>Object.keys(r)))]:emptyHeaders;
  const esc=v=>{ const s=v==null?'':String(v); return '"'+s.replace(/"/g,'""')+'"'; };
  return '\uFEFF'+[fields.map(esc).join(','),...rows.map(r=>fields.map(k=>esc(r[k])).join(','))].join('\r\n')+'\r\n';
}
function errorAnalysis(rows) {
  const chosen=[],ids=new Set(),codes=new Set();
  const add=r=>{ if(chosen.length<8&&!ids.has(r.task_id)) { chosen.push(r);ids.add(r.task_id);r.diagnostics.forEach(d=>codes.add(d.code)); } };
  const good=rows.find(r=>r.M1===1&&r.M2===1); if(good) add(good);
  for(const r of rows) if(r.diagnostics.some(d=>!codes.has(d.code))) add(r);
  rows.forEach(add);
  const fenced=s=>'    '+String(s??'(bez odpovědi)').replace(/\n/g,'\n    ');
  return '# Podklady k lidské analýze chyb\n\nVýběr: první úplný úspěch, následně dosud nezastoupené diagnostické příčiny, poté další různé task_id v pořadí plánu. Nejvýše osm případů; pouze první plánované pokusy.\n\n'+
    (chosen.length<8?'**Nedostatek dat pro osm různých případů.**\n\n':'')+
    chosen.map((r,i)=>`## ${i+1}. ${r.task_id} / ${r.run_id??'missing_run'}\n\n`+
      `${r.product}; ${r.prompt_condition}; ${r.split}; M1=${r.M1??'pending'}, M2=${r.M2??'pending'}.\n\n`+
      `Vstup:\n\n${fenced(r.input_sentence)}\n\nReference:\n\n${fenced(JSON.stringify(r.reference_sentences))}\n\nOdpověď:\n\n${fenced(r.response_text)}\n\nDiagnostika:\n\n${fenced(JSON.stringify(r.diagnostics))}\n\n`+
      'Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.\n').join('\n')+
    '\nWilsonovy intervaly popisují nejistotu mezi případy, nikoli variabilitu opakovaného generování. Malá sada nepodporuje obecnou převahu produktu.\n';
}
function pooledEffects(comparisons) {
  const buckets=new Map(); for(const c of comparisons.filter(c=>c.report_state==='final')) {
    const k=JSON.stringify([c.split,c.from,c.to,c.metric,c.interface,c.collection_protocol_version,c.timing_method]);
    if(!buckets.has(k)) buckets.set(k,[]); buckets.get(k).push(c);
  }
  return [...buckets.values()].map(a=>{
    const products=new Set(a.map(c=>c.product));
    const comparable=products.size===a.length && new Set(a.map(c=>c.paired_task_ids)).size===1;
    return {split:a[0].split,from:a[0].from,to:a[0].to,metric:a[0].metric,
      interface:a[0].interface,collection_protocol_version:a[0].collection_protocol_version,
      timing_method:a[0].timing_method,systems:a.map(c=>({product:c.product,model:c.model_label,difference_pp:c.difference_pp})),
      mean_difference_pp:comparable?a.reduce((s,c)=>s+c.difference_pp,0)/a.length:null,
      systems_improved:a.filter(c=>c.difference_pp>0).length, systems_N:a.length,
      note:comparable?'Nevážený průměr úplných systémových rozdílů; bez testu významnosti.':'Nelze sloučit více verzí téhož produktu nebo rozdílné párové N.'};
  });
}
function mainEvaluation(configFile,outOverride) {
  const full=path.resolve(configFile), root=path.dirname(full), cfg=JSON.parse(fs.readFileSync(full,'utf8'));
  const files=['cases','runs','reviews'].map(k=>{check(str(cfg[k]),`Chybí cesta ${k}`);return path.resolve(root,cfg[k]);});
  check(str(cfg.out)||outOverride,'Chybí out'); const out=path.resolve(root,outOverride||cfg.out);
  check(!fs.existsSync(out),`Výstupní adresář již existuje: ${out}. Zvolte nový --out.`);
  const cases=jsonl(files[0]),runs=jsonl(files[1]),reviews=jsonl(files[2]);
  validateCases(cases,cfg);validateGroups(cfg,cases);validateRuns(runs,cases,cfg);validateReviews(reviews,runs,cases,cfg);
  const cm=new Map(cases.map(c=>[c.task_id,c])), warnings=[];
  const results=runs.map(run=>{
    const c=cm.get(run.task_id), active=reviews.filter(r=>r.run_id===run.run_id&&r.reference_version===c.reference_version);
    const result=evaluate(c,run,active,cfg);
    result.first_planned_attempt=run.attempt===cfg.groups.find(g=>key(g)===key(run)).first_attempt;
    result.blinded_id=blind(run,cfg.seed);
    result.input_sentence=c.input_sentence; result.reference_sentences=c.reference_sentences;
    // A validity objection anywhere blocks every response evaluated against that reference.
    const validity=reviews.filter(r=>r.dimension==='reference_validity'&&r.reference_version===c.reference_version&&
      runs.find(x=>x.run_id===r.run_id)?.task_id===c.task_id);
    const v=resolveReview(validity,'reference_validity');
    if(v.decision==='fail'||v.decision==='pending') {
      result.M1=result.M2=null; result.needs_human_review.push('reference_validity');
      result.diagnostics.push({code:'reference_validity_unresolved'});
    }
    return result;
  });
  const planned=[];
  for(const g of cfg.groups) for(const id of g.task_ids) {
    const found=results.find(r=>key(r)===key(g)&&r.task_id===id&&r.first_planned_attempt);
    if(found) planned.push(found);
    else { const c=cm.get(id); planned.push({ ...Object.fromEntries(KEYS.map(k=>[k,g[k]])),
      run_id:null,task_id:id,reference_version:c.reference_version,split:c.split,status:'missing_run',
      attempt:g.first_attempt,first_planned_attempt:true,M1:null,M2:null,M2_provisional:null,
      latency_s:null,timing_issue:'missing_timing',response_text:null,input_sentence:c.input_sentence,reference_sentences:c.reference_sentences,diagnostics:[{code:'missing_run'}],
      needs_human_review:['missing_run'],false_ambiguities:0,
      unambiguous_word_positions:c._refs[0].words.length-c.ambiguous_positions.length}); }
  }
  const summaries=[];
  for(const g of cfg.groups) for(const split of SPLITS) {
    const rows=planned.filter(r=>key(r)===key(g)&&r.split===split);
    if(rows.length) summaries.push(summarize(rows,g,split));
  }
  const comparisons=compareGroups(cfg.groups,planned);
  // Blinded queue includes all collected first attempts, not only mismatches.
  const random=rng(cfg.seed), selected=new Set();
  for(const g of cfg.groups) for(const split of SPLITS) {
    const a=planned.filter(r=>key(r)===key(g)&&r.split===split&&r.run_id);
    shuffle(a,random).slice(0,Math.ceil(a.length*.2)).forEach(r=>selected.add(r.run_id));
  }
  const queue=shuffle(planned.filter(r=>r.run_id).map(r=>{
    const c=cm.get(r.task_id); return {blinded_id:r.blinded_id,reference_version:c.reference_version,
      input_sentence:c.input_sentence,response_text:r.response_text,reference_sentences:c.reference_sentences,
      ambiguous_positions:c.ambiguous_positions,review_required:r.needs_human_review.length>0,
      dimensions:r.needs_human_review.length?r.needs_human_review:['language_correction'],
      double_review_selected:selected.has(r.run_id),
      rubric:'Mimo referenční cíle musí každá realizace zachovat slova/pořadí a být jazykově přípustná. Masky neodstraňují interpunkci. Neobvyklou povolenou opravu potvrďte mapou alignment; chybnou referenci eskalujte.'};
  }),random);
  const reviewedIds=new Set(reviews.filter(r=>r.dimension==='language_correction'&&['pass','fail'].includes(r.decision)&&
    planned.some(x=>x.run_id===r.run_id&&x.reference_version===r.reference_version)).map(r=>r.run_id));
  const doubleIds=planned.filter(x=>x.run_id&&new Set(reviews.filter(r=>r.run_id===x.run_id&&
    r.reference_version===x.reference_version&&r.dimension==='language_correction'&&!r.adjudicated&&
    ['pass','fail'].includes(r.decision)).map(r=>r.evaluator_id)).size>=2).map(x=>x.run_id);
  const collected=planned.filter(r=>r.run_id).length;
  if(cases.length<40) warnings.push('Méně než 40 případů; demo či neúplný benchmark.');
  if(cases.filter(c=>c.split==='test').length<10) warnings.push('Méně než 10 testovacích případů.');
  if(new Set(cfg.groups.map(g=>g.product)).size<4) warnings.push('Méně než čtyři produkty.');
  for(const product of new Set(cfg.groups.map(g=>g.product)))
    if(CONDITIONS.some(p=>!cfg.groups.some(g=>g.product===product&&g.prompt_condition===p))) warnings.push(`${product}: chybí podmínka promptu.`);
  if(cfg.allow_illustrative_references) warnings.push('Povoleny ilustrační reference: výsledky nepoužívejte jako finální benchmark.');
  if(doubleIds.length<Math.ceil(collected*.2)) warnings.push('Nesplněno dvojí jazykové hodnocení alespoň 20 % sesbíraných prvních pokusů.');
  if(!reviewedIds.size) warnings.push('Chybí lidská složka hodnocení odpovědí.');
  if(cases.filter(c=>Array.isArray(c.edge_case_type)&&c.edge_case_type.length).length<Math.ceil(cases.length*.2)) warnings.push('Méně než 20 % deklarovaných okrajových případů.');
  const missingMetadata=['submitted_at_utc','conversation_id','system_instruction','tools_enabled','temperature',
    'max_output_tokens','repeat_index','manual_interventions','failure_detail'];
  for(const run of runs) {
    const absent=missingMetadata.filter(k=>!Object.hasOwn(run,k));
    if(!Object.hasOwn(run,'prompt_text')&&!Object.hasOwn(run,'prompt_archive_ref')) absent.push('prompt_text/prompt_archive_ref');
    if(absent.length) warnings.push(`${run.run_id}: neuvedená sběrná metadata (${absent.join(', ')}).`);
  }
  const complete=planned.every(r=>r.M1!==null&&r.M2!==null);
  fs.mkdirSync(out,{recursive:true});
  const write=(f,data)=>fs.writeFileSync(path.join(out,f),data,{encoding:'utf8',flag:'wx'});
  const jl=a=>a.map(x=>JSON.stringify(x)).join('\n')+(a.length?'\n':'');
  write('per_run_results.jsonl',jl([...results,...planned.filter(r=>!r.run_id)]));
  write('summary.csv',csv(summaries));
  write('prompt_comparisons.csv',csv(comparisons,['product','split','metric','difference_pp','report_state']));
  write('review_queue.jsonl',jl(queue));write('error_analysis.md',errorAnalysis(planned));
  write('reviewer_agreement.json',JSON.stringify(agreement(reviews,planned),null,2)+'\n');
  write('pooled_prompt_effects.json',JSON.stringify(pooledEffects(comparisons),null,2)+'\n');
  const allInputs=[full,...files];
  write('evaluation_manifest.json',JSON.stringify({script_version:VERSION,protocol_version:cfg.protocol_version,
    evaluated_at_utc:new Date().toISOString(),node_version:process.version,
    config:cfg,effective_output_path:out,inputs:allInputs.map(f=>({file:f,sha256:hash(fs.readFileSync(f))})),
    script_sha256:hash(fs.readFileSync(__filename)),seed:cfg.seed,
    first_attempt_results_complete:complete,planned_runs:planned.length,collected_first_attempts:collected,
    missing_runs:planned.filter(r=>!r.run_id).length,all_attempts:runs.length,
    human_language_reviewed:reviewedIds.size,double_reviewed:doubleIds.length,
    double_review_required:Math.ceil(collected*.2),reference_versions:cases.map(c=>({task_id:c.task_id,version:c.reference_version})),
    full_review_audit:reviews,warnings,
    note:'Skóre je oddělené od splnění zadání. Nevyřešené posouzení blokuje finální M2; opakované běhy nemění hlavní N. Bez bootstrapu.'},null,2)+'\n');
  console.log(`Výsledky: ${out}\nPlán ${planned.length}; sesbíráno ${collected}; stav ${complete?'kompletní skóre':'předběžný'}.`);
  if(warnings.length) console.log('Upozornění:\n'+warnings.map(w=>' - '+w).join('\n'));
  return complete?0:2;
}
/** Creates runnable synthetic demo, never quietly overwrites existing data. */
function initDemo(dir) {
  const d=path.resolve(dir); check(!fs.existsSync(d),'Demo adresář již existuje');fs.mkdirSync(d,{recursive:true});
  const c={task_id:'DEMO_001',capability:'czech_diacritic_ambiguity',task_type:'lexical_homograph',
    difficulty:'easy',language:'cs',split:'development',input_sentence:'Na kopci stoji vila.',reference_version:'demo-v1',
    reference_sentences:['Na kopci stojí vila.','Na kopci stojí víla.'],
    ambiguous_positions:[{word_index:3,forms:['vila','víla']}],expected_properties:{single_line:true,preserve_word_order:true},
    edge_case_type:['ambiguous_input'],context_or_files:[],evaluation_method:'reference_match_and_human_review',
    source_or_provenance:'Syntetická ukázka; není skutečné měření',reference_review:{status:'illustrative_only'}};
  const g={product:'DEMO',model_label:'synthetic',interface:'web',prompt_condition:'baseline',prompt_version:'demo-v1',
    collection_protocol_version:'demo-v1',timing_method:'web_monotonic',first_attempt:1,task_ids:[c.task_id]};
  const run={...g,run_id:'DEMO_RUN_001',task_id:c.task_id,attempt:1,status:'completed',response_text:'Na kopci stojí [vila|víla].',
    submitted_monotonic_ms:1000,first_text_monotonic_ms:3500,timing_resolution_ms:1,timeout_limit_ms:60000,
    submitted_at_utc:null,conversation_id:null,system_instruction:null,tools_enabled:false,temperature:null,
    max_output_tokens:null,prompt_text:'Pouze syntetické demo.',repeat_index:0,manual_interventions:[],failure_detail:null};
  delete run.task_ids;delete run.first_attempt;
  const cfg={protocol_version:'CZAI-1.0',cases:'cases.jsonl',runs:'runs.jsonl',reviews:'reviews.jsonl',out:'results',
    seed:42,max_combinations:10000,allow_illustrative_references:true,typographic_equivalences:[],groups:[g]};
  for(const [name,data] of Object.entries({'config.json':JSON.stringify(cfg,null,2)+'\n','cases.jsonl':JSON.stringify(c)+'\n',
    'runs.jsonl':JSON.stringify(run)+'\n','reviews.jsonl':''})) fs.writeFileSync(path.join(d,name),data,{flag:'wx'});
  console.log(`Syntetické demo: ${d}\nSpuštění: node "${__filename}" --config "${path.join(d,'config.json')}"`);
}
function selfTest() {
  const cfg={max_combinations:10000,typographic_equivalences:[]};
  const c={task_id:'demo',split:'development',input_sentence:'Na kopci stoji vila.',reference_version:'v1',
    reference_sentences:['Na kopci stojí vila.','Na kopci stojí víla.'],ambiguous_positions:[{word_index:3,forms:['vila','víla']} ]};
  c._refs=c.reference_sentences.map(parse);
  const run=text=>({run_id:'R',attempt:1,status:'completed',response_text:text,timing_method:'web_monotonic',
    submitted_monotonic_ms:1000,first_text_monotonic_ms:2000,timing_resolution_ms:1});
  const examples=[['Na kopci stojí [vila|víla].',1,1],['Na kopci stojí [víla|vila].',1,1],
    ['Na kopci stojí víla.',0,1],['Na kopci stoji [vila|víla].',1,0],
    ['Na kopci stojí [vila|víla|vilá].',0,1],['Na [kopci|kópci] stojí [vila|víla].',0,0],
    ['Na kopci stojí [vila|vila].',0,0],['Na kopci stojí [vila|víla.',0,0],
    ['',0,0],['Na kopci stojí [vila|víla].\nKomentář',0,0],
    ['Na kopci stojí [vila|víla].'.normalize('NFD'),1,1]];
  for(const [text,m1,m2] of examples) { const r=evaluate(c,run(text),[],cfg);assert.equal(r.M1,m1,text);assert.equal(r.M2_auto,m2,text); }
  assert.equal(evaluate(c,run(examples[3][0]),[],cfg).M2,null,'M2 mismatch stays pending');
  assert.equal(evaluate(c,run('Na kopci stojí [vila|víla] .'),[],cfg).M2,null,'Punctuation spacing matters');
  assert.equal(evaluate(c,run('Na   kopci stojí [vila|víla].'),[],cfg).M2,1,'Repeated spaces normalized');
  const fail=[{dimension:'language_correction',decision:'fail',adjudicated:false}];
  assert.equal(evaluate(c,run(examples[3][0]),fail,cfg).M2,0);
  const pass=[{dimension:'language_correction',decision:'pass',adjudicated:false}];
  assert.equal(evaluate(c,run(examples[3][0]),pass,cfg).M2,1);
  assert.equal(evaluate(c,run(examples[3][0]),[...pass,...fail],cfg).M2,null);
  assert.equal(evaluate(c,run(examples[3][0]),[...pass,...fail,{...pass[0],adjudicated:true}],cfg).M2,1);
  assert.equal(quantile([1,2,3,10],.5),2.5); assert.equal(quantile([1,2,3,10],.25),1.75);
  assert.equal(quantile([], .5),null);assert.equal(latency({...run(''),first_text_monotonic_ms:null}).seconds,null);
  assert.equal(latency({...run(''),first_text_monotonic_ms:999}).issue,'invalid_timing');
  const timeout=evaluate(c,{...run(null),status:'timeout',first_text_monotonic_ms:null},[],cfg);
  assert.equal(timeout.M1,0);assert.equal(timeout.M2,0);assert.equal(timeout.latency_s,null);
  assert.equal(evaluate(c,{...run(null),status:'service_error'},[],cfg).latency_s,1);
  assert.equal(evaluate(c,run('Na kopci stojí [vila|víla].'),[],{...cfg,max_combinations:1}).M2,1);
  assert.equal(evaluate(c,run('Na [kopci|kópci] stojí [vila|víla].'),[],{...cfg,max_combinations:1}).M2,null);
  assert.equal(parse('pra[ha|há]').errors.includes('bracket_inside_word'),true);
  const multi={...c,input_sentence:'Rada vidi vilu.',reference_sentences:['Rada vidí vilu.','Řada vidí vílu.'],
    ambiguous_positions:[{word_index:0,forms:['Rada','Řada']},{word_index:2,forms:['vilu','vílu']}]};
  multi._refs=multi.reference_sentences.map(parse);
  assert.equal(evaluate(multi,run('[Rada|Řada] vidí [vilu|vílu].'),[],cfg).M1,1);
  const number={...c,input_sentence:'Na kopci 2 stoji vila.',reference_sentences:['Na kopci 2 stojí vila.','Na kopci 2 stojí víla.']};
  number._refs=number.reference_sentences.map(parse);
  assert.equal(evaluate(number,run('Na kopci 2 stojí [vila|víla].'),[],cfg).M2,1);
  const rearranged=run('Na stojí kopci [vila|víla].');
  assert.equal(evaluate(c,rearranged,[],cfg).M1,null);
  const alignment=[{dimension:'alignment',decision:'pass',adjudicated:false,word_map:[0,2,1,3],
    order_preserved:false,extra_words:false,missing_words:false}];
  const rr=evaluate(c,rearranged,[...alignment,...pass],cfg);assert.equal(rr.M1,1);assert.equal(rr.M2,0);
  const wi=wilson(0,10);assert.ok(wi[0]>=-1e-10&&wi[1]>0);assert.deepEqual(wilson(0,0),[null,null]);
  const kapp=agreement([{run_id:'R',reference_version:'v1',evaluator_id:'A',dimension:'language_correction',decision:'pass',adjudicated:false},
    {run_id:'R',reference_version:'v1',evaluator_id:'B',dimension:'language_correction',decision:'pass',adjudicated:false}],
    [{run_id:'R',reference_version:'v1'}]);assert.equal(kapp[0].cohen_kappa,null);
  assert.ok(csv([{x:'a,"b"\nc'}]).includes('"a,""b""\nc"'));
  console.log('Self-test OK: parsování, M1/M2, review, více cílů, čísla, latence, limity, Wilson, kappa, CSV.');
}
function cli(args) {
  if(!args.length||args.includes('--help')) {
    console.log('CZAI hodnocení '+VERSION+'\nNode.js >=20; bez závislostí.\n'+
      '  --self-test\n  --init <nový-adresář>\n  --config <config.json> [--out <nový-adresář>]\n'+
      'Návod a schéma dat jsou v úvodním komentáři skriptu. Exit 0/2/1 = kompletní/předběžný/chyba.');return 0;
  }
  if(args[0]==='--self-test'&&args.length===1) {selfTest();return 0;}
  if(args[0]==='--init'&&args.length===2) {initDemo(args[1]);return 0;}
  const allowed=new Set(['--config','--out']), opts={};
  for(let i=0;i<args.length;i+=2) {check(allowed.has(args[i])&&str(args[i+1])&&!args[i+1].startsWith('--')&&!opts[args[i]],'Neplatné CLI; použijte --help');opts[args[i]]=args[i+1];}
  check(opts['--config'],'Chybí --config');return mainEvaluation(opts['--config'],opts['--out']);
}
if(require.main===module) {
  try {process.exitCode=cli(process.argv.slice(2));} catch(e) {console.error('Chyba: '+e.message);process.exitCode=1;}
}
// Exported for independent verification, importing does not execute the CLI.
module.exports={parse,evaluate,latency,quantile,wilson,resolveReview,validateCases,validateGroups,
  validateRuns,validateReviews,summarize,compareGroups,agreement,mainEvaluation};
