Benchmark tří AI asistentů (ChatGPT, Gemini, Claude; Grok vynechán, viz zpráva) na úloze:
doplnit diakritiku do české věty a u víceznačných slov vypsat všechny platné podoby `[podoba1|podoba2]`.
Tři podmínky promptu: P1 výchozí, P2 strukturovaný, P3 optimalizovaný. 40 vět: 20 dev, 10 val, 10 test.

## Obsah balíčku

| Část zadání | Kde |
|---|---|
| 1. Výzkumný protokol | `mereni.pdf` (sekce 1–2), zdroj `mereni.tex` |
| 2. Benchmarková data | `dataset_1.json` (všech 40 případů, rozdělení, původ, okrajové případy) |
| 3. Sada promptů | P1 a P2 ve zprávě; P3 a historie verzí v `runs/runs_*.json` → `threads.P3.prompt_versions` (zpráva = prompt, v němž se `{SENTENCE}` nahradí větou z datové sady) |
| 4. Metadata běhů | `runs/runs_chatgpt.json`, `runs_gemini.json`, `runs_claude.json` (model, rozhraní, čas, nastavení, latence, selhání, zásahy) |
| 5. Hodnocení | `hodnoceni_modelu.js` (automatické metriky), `prevod_runs.js`, `vysledky.py`, `latency/` (měření času), `human_review/` + `human_review.py` (lidské hodnocení: rubrika, tabulky dvou hodnotitelů, neshody) |
| 6. Výsledky | `eval/results_06/` (souhrny, párová porovnání, shoda hodnotitelů), `vystupy/` (tabulky a grafy) |
| 7. Analýza chyb | `mereni.pdf`, sekce Analýza chyb; podklad `eval/results_06/error_analysis.md`, `per_run_results.jsonl` |
| 8. Závěrečná zpráva | `mereni.pdf` |

## Zopakování analýzy

Potřeba: Node.js 20+, Python 3 s `matplotlib`. Ve složce balíčku:

```
node prevod_runs.js --dataset dataset_1.json --out eval --approver "Ondřej Studničný" --approved-at 2026-10-13 runs/runs_chatgpt.json runs/runs_gemini.json runs/runs_claude.json
node hodnoceni_modelu.js --config eval/config.json --out results_07
python3 vysledky.py eval/results_07 --out vystupy
```

- `prevod_runs.js` nepřepisuje `eval/reviews.jsonl` (lidská hodnocení); ten vzniká z tabulek příkazem `python3 human_review.py prevod`.
- Výstupní složka výsledků musí být nová (skript existující nepřepisuje). Výsledky ve zprávě odpovídají `eval/results_06`.
