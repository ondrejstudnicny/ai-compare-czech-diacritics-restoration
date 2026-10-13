#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vysledky.py — z výstupu hodnoceni_modelu.js udělá tabulky a grafy do zprávy.

Použití:
    python vysledky.py eval/results_01 --out vystupy

Čte per_run_results.jsonl (a pro křížovou kontrolu summary.csv) z adresáře výsledků.
Zapisuje do --out:
    souhrn.csv              všechna čísla po systémech a promptech
    tabulky.tex             tři tabulky (booktabs) k vložení přes \\input{...}
    obrazky.tex             prostředí figure s popisky ke grafům
    vysledky_sekce.tex      text sekce Výsledky s dosazenými čísly; načítá tabulky i obrázky
    graf_m1.pdf/.png        M1 podle systému a promptu s 95% Wilsonovými intervaly
    graf_falesne.pdf/.png   podíl odpovědí s falešně označenou víceznačností
    graf_latence.pdf/.png   M1 proti mediánu doby do prvního textu

Volby:
    --split test            která sada se vykazuje (výchozí test)
    --poradi "A,B,C"        pořadí systémů v tabulkách a grafech

Potřebuje Python 3.9+ a matplotlib 3.5+ (pip install matplotlib). Nic nepočítá jinak než
hodnoticí skript: Wilsonův interval a kvartily mají stejný vzorec, shodu s summary.csv
skript sám ověří. Nedělá testy významnosti ani žádný výrok o hypotéze.
"""
import argparse
import csv
import json
import math
import sys
from collections import OrderedDict, defaultdict
from pathlib import Path

CONDITIONS = ["baseline", "structured", "optimized"]
SHORT = {"baseline": "P1", "structured": "P2", "optimized": "P3"}
LONG = {"baseline": "výchozí", "structured": "strukturovaný", "optimized": "optimalizovaný"}
PAIRS = [("baseline", "structured"), ("structured", "optimized"), ("baseline", "optimized")]
KNOWN_ORDER = ["ChatGPT", "Gemini", "Claude", "Grok"]
Z = 1.959963984540054

# Barvy: jedna datová barva, zbytek neutrální (text nikdy nenese barvu dat).
BLUE, INK, INK2, GRID, AXIS = "#2a78d6", "#0b0b0b", "#52514e", "#e1e0d9", "#c3c2b7"


def wilson(k, n):
    if not n:
        return None, None
    p = k / n
    d = 1 + Z * Z / n
    c = (p + Z * Z / (2 * n)) / d
    h = Z * math.sqrt(p * (1 - p) / n + Z * Z / (4 * n * n)) / d
    return max(0.0, 100 * (c - h)), min(100.0, 100 * (c + h))


def quantile(values, p):
    if not values:
        return None
    a = sorted(values)
    h = (len(a) - 1) * p
    i = math.floor(h)
    return a[i] + (a[min(i + 1, len(a) - 1)] - a[i]) * (h - i)


def cz(x, nd=1):
    """Číslo s desetinnou čárkou; None -> pomlčka."""
    if x is None:
        return "–"
    return f"{x:.{nd}f}".replace(".", ",")


def tex_num(x, nd=1):
    return "--" if x is None else f"{x:.{nd}f}".replace(".", "{,}")


def tex_escape(s):
    out = str(s)
    for a, b in [("\\", r"\textbackslash{}"), ("&", r"\&"), ("%", r"\%"), ("_", r"\_"), ("#", r"\#"), ("$", r"\$"), ("{", r"\{"), ("}", r"\}")]:
        out = out.replace(a, b)
    return out


def load(results_dir, split):
    load.extra_attempts = 0
    path = results_dir / "per_run_results.jsonl"
    if not path.exists():
        sys.exit(f"Chyba: {path} neexistuje. První argument má být adresář s výstupem hodnoceni_modelu.js.")
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                r = json.loads(line)
                if r.get("first_planned_attempt") and r.get("split") == split:
                    rows.append(r)
                elif r.get("split") == split and r.get("first_planned_attempt") is False:
                    load.extra_attempts += 1
    if not rows:
        sys.exit(f"Chyba: ve výsledcích není žádný první pokus ze sady {split}.")
    return rows


def aggregate(rows):
    """Jeden záznam na (systém, prompt). Slučuje i případné rozdělení vlákna podle označení modelu."""
    cells = OrderedDict()
    for r in rows:
        cells.setdefault((r["product"], r["prompt_condition"]), []).append(r)
    out = OrderedDict()
    for (product, cond), rs in cells.items():
        n = len(rs)
        missing = sum(1 for r in rs if r["status"] == "missing_run")
        m1_pending = sum(1 for r in rs if r["M1"] is None)
        m1_k = sum(1 for r in rs if r["M1"] == 1)
        m2_pending = sum(1 for r in rs if r["M2"] is None)
        m2_vals = [r["M2"] if r["M2"] is not None else r.get("M2_provisional") for r in rs]
        m2_k = sum(1 for v in m2_vals if v == 1)
        lat = [r["latency_s"] for r in rs if r.get("latency_s") is not None]
        fa_resp = sum(1 for r in rs if r.get("false_ambiguities", 0) > 0)
        fa_pos = sum(r.get("false_ambiguities", 0) for r in rs)
        positions = sum(r.get("unambiguous_word_positions", 0) for r in rs)
        fmt = sum(1 for r in rs if any(d.get("code") == "format_error" for d in r.get("diagnostics", [])))
        failures = sum(1 for r in rs if r["status"] not in ("completed", "missing_run"))
        chars = sorted({(r.get("collection_metadata") or {}).get("prompt_chars") for r in rs} - {None})
        lo1, hi1 = wilson(m1_k, n)
        lo2, hi2 = wilson(m2_k, n)
        lof, hif = wilson(fa_resp, n)
        out[(product, cond)] = dict(
            product=product, condition=cond, n=n, missing=missing, collected=n - missing,
            models=sorted({r["model_label"] for r in rs}), versions=sorted({r["prompt_version"] for r in rs}),
            m1_k=m1_k, m1_pending=m1_pending, m1_pct=100 * m1_k / n, m1_lo=lo1, m1_hi=hi1,
            m2_k=m2_k, m2_pending=m2_pending, m2_pct=100 * m2_k / n, m2_lo=lo2, m2_hi=hi2,
            fa_resp=fa_resp, fa_resp_pct=100 * fa_resp / n, fa_lo=lof, fa_hi=hif,
            fa_pos=fa_pos, positions=positions, fa_pos_pct=(100 * fa_pos / positions) if positions else None,
            format_errors=fmt, failures=failures,
            lat_n=len(lat), lat_med=quantile(lat, 0.5), lat_q1=quantile(lat, 0.25), lat_q3=quantile(lat, 0.75),
            prompt_chars=chars[0] if len(chars) == 1 else None,
            m1_by_task={r["task_id"]: r["M1"] for r in rs},
        )
    return out


def compare(agg, products):
    """Párové srovnání promptů na stejných úlohách; rozdíl v procentních bodech."""
    out = OrderedDict()
    for a, b in PAIRS:
        per = OrderedDict()
        for p in products:
            ca, cb = agg.get((p, a)), agg.get((p, b))
            if not ca or not cb or not ca["collected"] or not cb["collected"]:
                continue
            tasks = [t for t in ca["m1_by_task"] if t in cb["m1_by_task"]]
            pairs = [(ca["m1_by_task"][t], cb["m1_by_task"][t]) for t in tasks]
            valid = [(x, y) for x, y in pairs if x is not None and y is not None]
            if not valid:
                continue
            up = sum(1 for x, y in valid if y > x)
            down = sum(1 for x, y in valid if y < x)
            per[p] = dict(n=len(valid), up=up, down=down, same=len(valid) - up - down,
                          diff=100 * (up - down) / len(valid), provisional=len(valid) < len(pairs))
        diffs = [v["diff"] for v in per.values()]
        out[(a, b)] = dict(per=per, mean=sum(diffs) / len(diffs) if diffs else None,
                           improved=sum(1 for d in diffs if d > 0), systems=len(diffs))
    return out


def cross_check(results_dir, split, agg, rows):
    """Porovná počty úspěchů s summary.csv tam, kde systému a promptu odpovídá jediná skupina."""
    path = results_dir / "summary.csv"
    if not path.exists():
        return ["summary.csv nenalezen, křížová kontrola vynechána."]
    groups = defaultdict(list)
    with open(path, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["split"] == split:
                groups[(r["product"], r["prompt_condition"])].append(r)
    problems = []
    for key, gs in groups.items():
        if len(gs) != 1 or key not in agg:
            continue
        g, c = gs[0], agg[key]
        if int(g["N"]) != c["n"] or int(g["M1_successes"]) != c["m1_k"]:
            problems.append(f"NESHODA s summary.csv u {key}: summary M1 {g['M1_successes']}/{g['N']}, tady {c['m1_k']}/{c['n']}.")
        if g["M3_median_s"] and c["lat_med"] is not None and abs(float(g["M3_median_s"]) - c["lat_med"]) > 1e-9:
            problems.append(f"NESHODA s summary.csv u {key}: medián latence {g['M3_median_s']} vs {c['lat_med']}.")
    return problems


def write_csv(path, agg, products):
    fields = ["system", "model", "prompt", "verze_promptu", "znaku_promptu", "N", "sebrano", "M1_uspechu", "M1_ceka", "M1_procent",
              "M1_ci95_od", "M1_ci95_do", "M2_uspechu", "M2_ceka_na_cloveka", "M2_procent", "M2_ci95_od", "M2_ci95_do",
              "odpovedi_s_falesnou_viceznacnosti", "falesne_pozice", "jednoznacnych_pozic", "falesne_pozice_procent",
              "chyby_formatu", "technicka_selhani", "latence_n", "latence_median_s", "latence_q1_s", "latence_q3_s"]
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(fields)
        for p in products:
            for c in CONDITIONS:
                a = agg.get((p, c))
                if not a:
                    continue
                r = lambda x, nd=2: "" if x is None else str(round(x, nd)).replace(".", ",")
                w.writerow([p, " / ".join(a["models"]), SHORT[c], " / ".join(a["versions"]), a["prompt_chars"] or "", a["n"], a["collected"],
                            a["m1_k"], a["m1_pending"], r(a["m1_pct"]), r(a["m1_lo"]), r(a["m1_hi"]),
                            a["m2_k"], a["m2_pending"], r(a["m2_pct"]), r(a["m2_lo"]), r(a["m2_hi"]),
                            a["fa_resp"], a["fa_pos"], a["positions"], r(a["fa_pos_pct"]),
                            a["format_errors"], a["failures"], a["lat_n"], r(a["lat_med"]), r(a["lat_q1"]), r(a["lat_q3"])])


def write_tex(path, agg, cmp, products, split):
    any_m1_pending = any(a["m1_pending"] and a["collected"] for a in agg.values())
    any_m2_pending = any(a["m2_pending"] and a["collected"] for a in agg.values())
    L = []
    L.append("% Vygenerováno skriptem vysledky.py — neupravujte ručně, raději skript spusťte znovu.")
    L.append("% Vyžaduje balíčky booktabs a tabularx (v mereni.tex už jsou).")
    L.append("")
    # --- Tabulka 1: výsledky
    L.append(r"\begin{table}[htbp]")
    L.append(r"\centering\small")
    sada = {"test": "testovací", "validation": "validační", "development": "vývojové"}[split]
    L.append(r"\caption{Výsledky na " + sada + r" sadě: M1 (úplná a přesná množina podob), M2 (správnost zbytku věty), "
             r"odpovědi s falešně označenou víceznačností, odpovědi porušující formát (víc řádků nebo neplatná závorka; počítají se jako chybné v~M1 i~M2) a M3 (medián doby do prvního textu). "
             r"IS jsou 95\% Wilsonovy intervaly; popisují nejistotu mezi úlohami, ne variabilitu opakovaného generování.}")
    L.append(r"\label{tab:vysledky}")
    L.append(r"\begin{tabular}{@{}llcccccc@{}}")
    L.append(r"\toprule")
    L.append(r"Systém & Prompt & M1 & M1 95\% IS & M2 & Falešná víc. & Formát & M3 medián [Q1--Q3] \\")
    L.append(r" & & (úloh) & (\%) & (úloh) & (odpovědí) & (chybných) & (s) \\")
    L.append(r"\midrule")
    for i, p in enumerate(products):
        if i:
            L.append(r"\addlinespace")
        for j, c in enumerate(CONDITIONS):
            a = agg.get((p, c))
            name = tex_escape(p) if j == 0 else ""
            if not a or not a["collected"]:
                L.append(f"{name} & {SHORT[c]} & \\multicolumn{{6}}{{c}}{{nesebráno}} \\\\")
                continue
            m1 = f"{a['m1_k']}/{a['n']}" + (r"\textsuperscript{a}" if a["m1_pending"] else "")
            ci = f"{tex_num(a['m1_lo'])}--{tex_num(a['m1_hi'])}"
            m2 = f"{a['m2_k']}/{a['n']}" + (r"\textsuperscript{b}" if a["m2_pending"] else "")
            fa = f"{a['fa_resp']}/{a['n']}"
            if a["lat_n"]:
                lat = f"{tex_num(a['lat_med'])} [{tex_num(a['lat_q1'])}--{tex_num(a['lat_q3'])}]"
                if a["lat_n"] < a["n"]:
                    lat += f" ($n={a['lat_n']}$)"
            else:
                lat = "--"
            fmt = f"{a['format_errors']}/{a['n']}"
            L.append(f"{name} & {SHORT[c]} & {m1} & {ci} & {m2} & {fa} & {fmt} & {lat} \\\\")
    L.append(r"\bottomrule")
    L.append(r"\end{tabular}")
    notes = []
    if any_m1_pending:
        notes.append(r"\textsuperscript{a}\,Část odpovědí čeká na ruční zarovnání; uvedena je dolní mez.")
    if any_m2_pending:
        notes.append(r"\textsuperscript{b}\,Předběžná hodnota: část odpovědí čeká na lidské posouzení.")
    if notes:
        L.append(r"\par\smallskip\footnotesize " + " ".join(notes))
    L.append(r"\end{table}")
    L.append("")
    # --- Tabulka 2: efekt promptu
    L.append(r"\begin{table}[htbp]")
    L.append(r"\centering\small")
    L.append(r"\caption{Změna M1 mezi podmínkami promptu na stejných úlohách (" + sada + r" sada), v~procentních bodech. "
             r"V~závorce počet úloh, které se zlepšily\,/\,zhoršily. Průměr je nevážený přes systémy; bez testu významnosti.}")
    L.append(r"\label{tab:efekt-promptu}")
    L.append(r"\begin{tabular}{@{}lccc@{}}")
    L.append(r"\toprule")
    L.append(r"Systém & P1 $\rightarrow$ P2 & P2 $\rightarrow$ P3 & P1 $\rightarrow$ P3 \\")
    L.append(r"\midrule")

    def signed(x):
        return "--" if x is None else ("$+$" if x > 0 else ("$-$" if x < 0 else "")) + tex_num(abs(x), 0)

    for p in products:
        cells = []
        for pair in PAIRS:
            v = cmp[pair]["per"].get(p)
            cells.append("--" if not v else f"{signed(v['diff'])} ({v['up']}\\,/\\,{v['down']})" + (r"\textsuperscript{a}" if v["provisional"] else ""))
        L.append(f"{tex_escape(p)} & " + " & ".join(cells) + r" \\")
    L.append(r"\midrule")
    L.append("Průměr systémů & " + " & ".join(signed(cmp[pair]["mean"]) if cmp[pair]["systems"] else "--" for pair in PAIRS) + r" \\")
    L.append("Zlepšených systémů & " + " & ".join(f"{cmp[pair]['improved']} z {cmp[pair]['systems']}" for pair in PAIRS) + r" \\")
    L.append(r"\bottomrule")
    L.append(r"\end{tabular}")
    L.append(r"\end{table}")
    L.append("")
    # --- Tabulka 3: úsilí
    L.append(r"\begin{table}[htbp]")
    L.append(r"\centering\small")
    L.append(r"\caption{Úsilí: označení modelu viditelné v~rozhraní, délka promptu ve znacích bez testované věty "
             r"a~zmrazená verze optimalizovaného promptu. Ladění P3 navíc u~každého systému stálo 30 vývojových a~validačních dotazů.}")
    L.append(r"\label{tab:usili}")
    L.append(r"\begin{tabular}{@{}llrrrc@{}}")
    L.append(r"\toprule")
    L.append(r"Systém & Model & P1 & P2 & P3 & Verze P3 \\")
    L.append(r"\midrule")
    for p in products:
        models = sorted({m for c in CONDITIONS if agg.get((p, c)) for m in agg[(p, c)]["models"] if agg[(p, c)]["collected"]})
        chars = [str(agg[(p, c)]["prompt_chars"]) if agg.get((p, c)) and agg[(p, c)]["prompt_chars"] else "--" for c in CONDITIONS]
        o = agg.get((p, "optimized"))
        ver = " / ".join(o["versions"]) if o and o["collected"] else "--"
        L.append(f"{tex_escape(p)} & {tex_escape(', '.join(models) or '--')} & " + " & ".join(chars) + f" & {tex_escape(ver)} \\\\")
    L.append(r"\bottomrule")
    L.append(r"\end{tabular}")
    L.append(r"\end{table}")
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


def write_figures_tex(path, has_latency, m1_provisional=False, prefix=""):
    L = ["% Vygenerováno skriptem vysledky.py. Vyžaduje \\usepackage{graphicx} v preambuli.", ""]
    figs = [("graf_m1", "fig:m1", "M1 podle systému a~podmínky promptu na testovací sadě. Body jsou podíly úloh "
             "s~úplnou a~přesnou množinou podob, svislé úsečky 95\\% Wilsonovy intervaly. Průměr systémů je nevážený a~bez intervalu."
             + (" Prázdné body jsou předběžné dolní meze: část odpovědí chybí nebo čeká na ruční posouzení." if m1_provisional else "")),
            ("graf_falesne", "fig:falesne", "Podíl odpovědí, v~nichž systém označil za víceznačné slovo, které víceznačné není, "
             "s~95\\% Wilsonovými intervaly. Odpovědi vyřazené pro chybu formátu se sem nepromítají.")]
    if has_latency:
        figs.append(("graf_latence", "fig:latence", "Kvalita a~rychlost: M1 proti mediánu doby do prvního textu odpovědi. "
                     "Vodorovné úsečky jsou mezikvartilová rozpětí. Intervaly pro M1 jsou na obrázku~\\ref{fig:m1}."))
    for name, label, caption in figs:
        L += [r"\begin{figure}[htbp]", r"\centering", f"\\includegraphics[width=\\linewidth]{{{prefix}{name}.pdf}}",
              f"\\caption{{{caption}}}", f"\\label{{{label}}}", r"\end{figure}", ""]
    path.write_text("\n".join(L), encoding="utf-8")


def write_section_tex(path, agg, cmp, products, split, extra_attempts, prefix):
    """Text sekce Výsledky s čísly dosazenými z dat. Slouží jako základ; před odevzdáním si ho přečtěte."""
    sada = {"test": "testovací", "validation": "validační", "development": "vývojové"}[split]
    have = lambda p, c: agg.get((p, c)) and agg[(p, c)]["collected"]
    systems = [p for p in products if any(have(p, c) for c in CONDITIONS)]
    n_tasks = max(a["n"] for a in agg.values())
    pct = lambda x: tex_num(x, 0) if abs(x - round(x)) < 1e-9 else tex_num(x, 1)
    sgn = lambda x: ("$+$" if x > 0 else "$-$" if x < 0 else "") + pct(abs(x))

    def spread(c):
        vals = [agg[(p, c)]["m1_pct"] for p in systems if have(p, c)]
        if not vals:
            return "nezjištěna"
        return f"u~všech systémů {pct(vals[0])}~\\%" if min(vals) == max(vals) else f"mezi {pct(min(vals))} a~{pct(max(vals))}~\\%"

    cells = [(agg[(p, c)]["m1_pct"], p, c) for p in systems for c in CONDITIONS if have(p, c)]
    top = max(v for v, _, _ in cells)
    best = ", ".join(f"{tex_escape(p)} ({SHORT[c]})" for v, p, c in cells if v == top)
    any_m2_pending = any(a["m2_pending"] and a["collected"] for a in agg.values())

    L = ["% Vygenerováno skriptem vysledky.py z výsledků hodnocení. Čísla odpovídají tabulkám.",
         "% Při změně dat spusťte skript znovu; ruční úpravy tohoto souboru se tím přepíšou.",
         r"\section{Výsledky}", r"\label{sec:vysledky}", ""]
    L.append(f"Tabulka~\\ref{{tab:vysledky}} a~obrázek~\\ref{{fig:m1}} shrnují výsledky {len(systems)}~systémů na {sada} sadě "
             f"({n_tasks}~vět, každá zadaná v~každé podmínce promptu jednou). Hlavní metrika M1 udává podíl vět, u~nichž odpověď "
             f"obsahovala úplnou a~přesnou množinu podob všech víceznačných slov a~žádnou závorku navíc. S~výchozím promptem (P1) byla M1 "
             f"{spread('baseline')}, se strukturovaným (P2) {spread('structured')} a~s~optimalizovaným (P3) {spread('optimized')}. "
             f"Nejvyšší hodnotu, {pct(top)}~\\%, má {best}."
             + (" Hodnoty vedlejší metriky M2 označené v~tabulce jako předběžné čekají na lidské posouzení." if any_m2_pending else ""))
    L.append("")

    def effect(pair):
        v = cmp[pair]
        if not v["systems"]:
            return None
        per = ", ".join(f"{tex_escape(p)} {sgn(d['diff'])}" for p, d in v["per"].items())
        return v, per
    e12, e23 = effect(("baseline", "structured")), effect(("structured", "optimized"))
    if e12:
        v, per = e12
        met = v["mean"] > 0 and v["improved"] * 2 > v["systems"]
        txt = (f"Hypotéza předpokládá, že strukturovaný prompt zvýší M1 oproti výchozímu. Na stejných větách se M1 mezi P1 a~P2 zvýšila "
               f"u~{v['improved']} z~{v['systems']} systémů a~nevážený průměr změny je {sgn(v['mean'])}~p.~b. ({per}; tabulka~\\ref{{tab:efekt-promptu}}). "
               f"Kritérium stanovené v~hypotéze, tedy zlepšení souhrnně i~u~většiny systémů, {'je' if met else 'není'} v~těchto datech splněno.")
        if e23:
            v2, per2 = e23
            txt += (f" Optimalizovaný prompt změnil M1 oproti strukturovanému v~průměru o~{sgn(v2['mean'])}~p.~b. "
                    f"(zlepšení u~{v2['improved']} z~{v2['systems']} systémů; {per2}).")
        L += [txt, ""]

    widths = [a["m1_hi"] - a["m1_lo"] for a in agg.values() if a["collected"]]
    apart = []
    for c in CONDITIONS:
        ps = [p for p in systems if have(p, c)]
        for i in range(len(ps)):
            for j in range(i + 1, len(ps)):
                a, b = agg[(ps[i], c)], agg[(ps[j], c)]
                if a["m1_hi"] < b["m1_lo"] or b["m1_hi"] < a["m1_lo"]:
                    apart.append(f"{tex_escape(ps[i])} a~{tex_escape(ps[j])} ({SHORT[c]})")
    overlap = ("Intervaly všech systémů se v~každé podmínce promptu překrývají." if not apart
               else "Nepřekrývají se pouze intervaly těchto dvojic: " + ", ".join(apart) + ".")
    L.append(f"Nejistotu skóre vyjadřujeme 95\\% Wilsonovými intervaly \\cite{{wilson1927}}. Popisují nejistotu danou malým počtem vět, "
             f"nikoli kolísání odpovědí při opakovaném zadání. Při {n_tasks}~větách jsou intervaly široké, od {pct(min(widths))} do {pct(max(widths))}~p.~b. "
             f"{overlap} Rozdíly mezi systémy proto uvádíme jako pozorování na této sadě, ne jako doklad obecné převahy některého z~nich.")
    L.append("")

    failures = sum(a["failures"] for a in agg.values())
    rep_txt = "Každá věta byla v~každé podmínce zadána jednou, analýza opakovaných běhů proto není relevantní."
    if extra_attempts:
        rep_txt += f" Opakovaných pokusů po technickém selhání bylo {extra_attempts}; do skóre nevstupují a~vykazujeme je odděleně."
    rep_txt += (" Technická selhání služby se v~hodnocených bězích nevyskytla." if not failures
                else f" Technických selhání služby bylo {failures}; počítají se jako chybné odpovědi.")
    L += [rep_txt, ""]

    def tot(c, key):
        return sum(agg[(p, c)][key] for p in systems if have(p, c)), sum(agg[(p, c)]["n"] for p in systems if have(p, c))
    fa = {c: tot(c, "fa_resp") for c in CONDITIONS}
    fe = {c: tot(c, "format_errors") for c in CONDITIONS}
    a1, a2, f1, f2 = fa["baseline"][0], fa["structured"][0], fe["baseline"][0], fe["structured"][0]
    if a2 > a1:
        verdict = "Takových odpovědí se strukturovaným promptem přibylo, alternativní vysvětlení proto nelze vyloučit."
    elif f2 > f1:
        verdict = (f"Takových odpovědí se strukturovaným promptem nepřibylo. Přibylo ale odpovědí porušujících formát (z~{f1} na {f2}), "
                   "u~nichž se falešné závorky nevyhodnocují, takže alternativní vysvětlení nelze na těchto datech spolehlivě vyloučit.")
    else:
        verdict = "Takových odpovědí se strukturovaným promptem nepřibylo a~data alternativní vysvětlení nepodporují."
    L.append("Alternativní vysvětlení říká, že strukturovaný prompt jen zvýší ochotu označovat slova za víceznačná. Odpovědí, v~nichž systém "
             f"dal do závorky slovo, které víceznačné není, bylo s~P1 {fa['baseline'][0]} z~{fa['baseline'][1]}, s~P2 {fa['structured'][0]} z~{fa['structured'][1]} "
             f"a~s~P3 {fa['optimized'][0]} z~{fa['optimized'][1]} (obrázek~\\ref{{fig:falesne}}). {verdict} "
             f"Odpovědí porušujících formát (víc řádků nebo neplatná závorka) bylo s~P1 {fe['baseline'][0]}, s~P2 {fe['structured'][0]} a~s~P3 {fe['optimized'][0]}; "
             "počítají se jako chybné.")
    L.append("")

    def chars(c):
        vals = sorted({agg[(p, c)]["prompt_chars"] for p in systems if have(p, c) and agg[(p, c)]["prompt_chars"]})
        return None if not vals else (str(vals[0]) if len(vals) == 1 else f"{vals[0]} až {vals[-1]}")
    lat = "; ".join(f"{tex_escape(p)} z~{tex_num(agg[(p, 'baseline')]['lat_med'])} na {tex_num(agg[(p, 'optimized')]['lat_med'])}~s"
                    for p in systems if have(p, "baseline") and have(p, "optimized")
                    and agg[(p, "baseline")]["lat_n"] and agg[(p, "optimized")]["lat_n"])
    eff = f"Porovnání kvality a~úsilí ukazují tabulka~\\ref{{tab:usili}} a~obrázek~\\ref{{fig:latence}}."
    if chars("baseline") and chars("structured"):
        eff += f" Výchozí prompt má {chars('baseline')} znaků, strukturovaný {chars('structured')}"
        eff += (f" a~optimalizované {chars('optimized')}." if chars("optimized") else ".")
    eff += " Ladění optimalizovaného promptu navíc stálo u~každého systému 30 vývojových a~validačních dotazů."
    if lat:
        eff += f" Medián doby do prvního textu odpovědi (M3) se mezi P1 a~P3 změnil takto: {lat}."
    eff += " Vyšší přesnost optimalizovaného promptu je tedy třeba vážit proti delšímu promptu, času na ladění a~době odezvy; metriky neslučujeme do jednoho skóre."
    L += [eff, "", f"\\input{{{prefix}tabulky.tex}}", f"\\input{{{prefix}obrazky.tex}}", ""]
    path.write_text("\n".join(L), encoding="utf-8")


# ---------------------------------------------------------------- grafy

def setup_matplotlib():
    try:
        import matplotlib
    except ImportError:
        sys.exit("Chyba: chybí matplotlib. Nainstalujte ho příkazem: pip install matplotlib")
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        "font.family": "DejaVu Sans", "font.size": 8, "pdf.fonttype": 42, "ps.fonttype": 42,
        "axes.edgecolor": AXIS, "axes.linewidth": 0.8, "axes.labelcolor": INK2, "text.color": INK,
        "xtick.color": INK2, "ytick.color": INK2, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "figure.facecolor": "white", "axes.facecolor": "white", "savefig.facecolor": "white",
    })
    return plt


def style_axis(ax, grid_axis="y"):
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(AXIS)
    ax.grid(axis=grid_axis, color=GRID, linewidth=0.8, linestyle="-")
    ax.set_axisbelow(True)
    ax.tick_params(length=0, pad=4)


def panel_title(ax, title, subtitle=""):
    ax.set_title(title, fontsize=9, fontweight="bold", color=INK, pad=16, loc="left")
    if subtitle:
        t = ax.text(0, 1.03, subtitle, transform=ax.transAxes, fontsize=7, color=INK2, va="bottom", ha="left")
        t.set_in_layout(False)
        t.set_gid("subtitle")


def fit_subtitles(fig):
    """Podtitulek (označení modelu) nesmí přetéct do sousedního panelu: zmenšit, pak zkrátit."""
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    for ax in fig.axes:
        for t in ax.texts:
            if t.get_gid() != "subtitle":
                continue
            limit = ax.bbox.width * 0.98
            while t.get_window_extent(renderer).width > limit and t.get_fontsize() > 5.5:
                t.set_fontsize(t.get_fontsize() - 0.5)
            text = t.get_text()
            while t.get_window_extent(renderer).width > limit and len(text) > 4:
                text = text[:-1]
                t.set_text(text.rstrip() + "…")


def save(fig, out, name):
    fig.savefig(out / f"{name}.pdf")
    fig.savefig(out / f"{name}.png", dpi=200)


def plot_share(plt, out, name, agg, products, key, lo, hi, ylabel, with_mean, pending_key=None):
    """Malé násobky: jeden panel na systém, osa x = P1/P2/P3, bod = podíl, úsečka = Wilsonův interval."""
    n_panels = len(products) + (1 if with_mean and len(products) > 1 else 0)
    fig, axes = plt.subplots(1, n_panels, figsize=(6.3, 2.45), sharey=True, constrained_layout=True, squeeze=False)
    axes = axes[0]
    xs = list(range(len(CONDITIONS)))
    for ax, p in zip(axes, products):
        px, py = [], []
        for x, c in zip(xs, CONDITIONS):
            a = agg.get((p, c))
            if not a or not a["collected"]:
                continue
            px.append(x)
            py.append(a[key])
            ax.plot([x, x], [a[lo], a[hi]], color=BLUE, linewidth=1.0, alpha=0.55, solid_capstyle="butt", zorder=2)
        ax.plot(px, py, color=BLUE, linewidth=2, solid_joinstyle="round", solid_capstyle="round", zorder=3)
        ax.plot(px, py, linestyle="none", marker="o", markersize=7.5, markerfacecolor=BLUE, markeredgecolor="white", markeredgewidth=1.5, zorder=4)
        # Předběžná hodnota (část odpovědí čeká na člověka nebo chybí): prázdný bod.
        hollow = [(x, y) for x, y, c in zip(px, py, [c for c in CONDITIONS if agg.get((p, c)) and agg[(p, c)]["collected"]])
                  if pending_key and agg[(p, c)][pending_key]]
        if hollow:
            ax.plot([h[0] for h in hollow], [h[1] for h in hollow], linestyle="none", marker="o", markersize=5.5,
                    markerfacecolor="white", markeredgecolor=BLUE, markeredgewidth=1.5, zorder=5)
        models = sorted({m for c in CONDITIONS if agg.get((p, c)) and agg[(p, c)]["collected"] for m in agg[(p, c)]["models"]})
        panel_title(ax, p, ", ".join(models) if len(models) == 1 else "")
    if n_panels > len(products):
        ax = axes[-1]
        px, py = [], []
        for x, c in zip(xs, CONDITIONS):
            vals = [agg[(p, c)][key] for p in products if agg.get((p, c)) and agg[(p, c)]["collected"]]
            if len(vals) == len(products):
                px.append(x)
                py.append(sum(vals) / len(vals))
        ax.plot(px, py, color=INK2, linewidth=2, solid_joinstyle="round", solid_capstyle="round", zorder=3)
        ax.plot(px, py, linestyle="none", marker="o", markersize=7.5, markerfacecolor=INK2, markeredgecolor="white", markeredgewidth=1.5, zorder=4)
        panel_title(ax, "Průměr", "nevážený")
    for ax in axes:
        style_axis(ax)
        if not any(len(line.get_xdata()) for line in ax.lines):
            ax.text(0.5, 0.5, "nesebráno" if ax is not axes[-1] or n_panels == len(products) else "neúplné",
                    transform=ax.transAxes, ha="center", va="center", fontsize=8, color=INK2)
        ax.set_xlim(-0.45, len(CONDITIONS) - 0.55)
        ax.set_ylim(-5, 105)
        ax.set_xticks(xs, [SHORT[c] for c in CONDITIONS])
        ax.set_yticks(range(0, 101, 20))
    axes[0].set_ylabel(ylabel)
    axes[0].yaxis.set_major_formatter(lambda v, _: f"{v:.0f} %")
    fit_subtitles(fig)
    save(fig, out, name)
    plt.close(fig)


def plot_latency(plt, out, name, agg, products):
    """M1 proti mediánu doby do prvního textu; jeden panel na systém, body popsané P1/P2/P3."""
    cells = [a for a in agg.values() if a["collected"] and a["lat_n"]]
    if not cells:
        return False
    xmax = max(a["lat_q3"] for a in cells) * 1.08
    fig, axes = plt.subplots(1, len(products), figsize=(6.3, 2.45), sharey=True, sharex=True, constrained_layout=True, squeeze=False)
    axes = axes[0]
    placed = []
    for ax, p in zip(axes, products):
        style_axis(ax, grid_axis="both")
        ax.set_xlim(0, xmax)
        ax.set_ylim(-8, 116)
        ax.set_yticks(range(0, 101, 20))
        ax.xaxis.set_major_formatter(lambda v, _: f"{v:.0f}")
        pts = []
        for c in CONDITIONS:
            a = agg.get((p, c))
            if a and a["collected"] and a["lat_n"]:
                pts.append((a["lat_med"], a["m1_pct"], a["lat_q1"], a["lat_q3"], SHORT[c]))
        if len(pts) > 1:
            ax.plot([q[0] for q in pts], [q[1] for q in pts], color=AXIS, linewidth=1.2, zorder=2)
        for x, y, q1, q3, _ in pts:
            ax.plot([q1, q3], [y, y], color=BLUE, linewidth=1.0, alpha=0.55, solid_capstyle="butt", zorder=3)
        ax.plot([q[0] for q in pts], [q[1] for q in pts], linestyle="none", marker="o", markersize=7.5,
                markerfacecolor=BLUE, markeredgecolor="white", markeredgewidth=1.5, zorder=4)
        models = sorted({m for c in CONDITIONS if agg.get((p, c)) and agg[(p, c)]["collected"] for m in agg[(p, c)]["models"]})
        panel_title(ax, p, ", ".join(models) if len(models) == 1 else "")
        placed.append((ax, pts))
    axes[0].set_ylabel("M1 (% úloh)")
    axes[0].yaxis.set_major_formatter(lambda v, _: f"{v:.0f} %")
    fig.supxlabel("medián doby do prvního textu (s)", fontsize=8, color=INK2)
    # Popisky bodů: z osmi míst kolem bodu vybrat to, kde popisek nejméně překáží
    # jiným bodům, popiskům, úsečkám rozpětí a spojnici.
    fit_subtitles(fig)
    scale = fig.dpi / 72.0
    half_w, half_h = 8 * scale, 5.5 * scale
    candidates = [(0, 12, "center", "center"), (0, -12, "center", "center"), (16, 0, "center", "center"), (-16, 0, "center", "center"),
                  (13, 10, "center", "center"), (-13, 10, "center", "center"), (13, -10, "center", "center"), (-13, -10, "center", "center")]

    def seg_hits(box, p0, p1):
        x0, y0, x1, y1 = box
        for i in range(41):
            t = i / 40
            x, y = p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t
            if x0 <= x <= x1 and y0 <= y <= y1:
                return True
        return False

    for ax, pts in placed:
        px = [ax.transData.transform((x, y)) for x, y, *_ in pts]
        segments = [(ax.transData.transform((q1, y)), ax.transData.transform((q3, y))) for x, y, q1, q3, _ in pts]
        segments += [(px[i], px[i + 1]) for i in range(len(px) - 1)]
        boxes = []
        frame = ax.bbox
        for i, (x, y, q1, q3, label) in enumerate(pts):
            best = None
            for rank, (dx, dy, ha, va) in enumerate(candidates):
                cx, cy = px[i][0] + dx * scale, px[i][1] + dy * scale
                box = (cx - half_w, cy - half_h, cx + half_w, cy + half_h)
                score = rank * 0.1
                if box[0] < frame.x0 or box[2] > frame.x1 or box[1] < frame.y0 or box[3] > frame.y1:
                    score += 100
                r = 5 * scale
                score += 50 * sum(1 for j, q in enumerate(px) if j != i and box[0] - r <= q[0] <= box[2] + r and box[1] - r <= q[1] <= box[3] + r)
                score += 50 * sum(1 for o in boxes if not (box[2] < o[0] or o[2] < box[0] or box[3] < o[1] or o[3] < box[1]))
                score += 10 * sum(1 for p0, p1 in segments if seg_hits(box, p0, p1))
                if best is None or score < best[0]:
                    best = (score, dx, dy, ha, va, box)
            _, dx, dy, ha, va, box = best
            ax.annotate(label, (x, y), xytext=(dx, dy), textcoords="offset points", ha=ha, va=va, fontsize=8, color=INK, zorder=5)
            boxes.append(box)
    save(fig, out, name)
    plt.close(fig)
    return True


def main():
    # Windows: při přesměrování výstupu by jinak znaky jako → shodily skript na kódování konzole.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Tabulky a grafy z výstupu hodnoceni_modelu.js")
    ap.add_argument("results", help="adresář s per_run_results.jsonl")
    ap.add_argument("--out", default="vystupy", help="kam zapsat tabulky a grafy (výchozí: vystupy)")
    ap.add_argument("--split", default="test", choices=["development", "validation", "test"])
    ap.add_argument("--tex-prefix", default=None, help="cesta od hlavního .tex souboru ke složce s výstupy (výchozí: název složky --out a lomítko)")
    ap.add_argument("--poradi", default="", help='pořadí systémů oddělené čárkou, např. "ChatGPT,Gemini,Claude,Grok"')
    args = ap.parse_args()

    results = Path(args.results)
    rows = load(results, args.split)
    agg = aggregate(rows)
    present = list(OrderedDict.fromkeys(k[0] for k in agg))
    wanted = [s.strip() for s in args.poradi.split(",") if s.strip()] or KNOWN_ORDER
    products = [p for p in wanted if p in present] + [p for p in present if p not in wanted]
    cmp = compare(agg, products)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "souhrn.csv", agg, products)
    write_tex(out / "tabulky.tex", agg, cmp, products, args.split)
    plt = setup_matplotlib()
    plot_share(plt, out, "graf_m1", agg, products, "m1_pct", "m1_lo", "m1_hi", "M1 (% úloh)", with_mean=True, pending_key="m1_pending")
    plot_share(plt, out, "graf_falesne", agg, products, "fa_resp_pct", "fa_lo", "fa_hi", "odpovědi s falešnou\nvíceznačností", with_mean=False)
    has_latency = plot_latency(plt, out, "graf_latence", agg, products)
    prefix = args.tex_prefix if args.tex_prefix is not None else out.name + "/"
    write_figures_tex(out / "obrazky.tex", has_latency, any(a["m1_pending"] and a["collected"] for a in agg.values()), prefix)
    write_section_tex(out / "vysledky_sekce.tex", agg, cmp, products, args.split, load.extra_attempts, prefix)

    # ---- shrnutí do konzole
    print(f"Sada: {args.split}. Systémy: {', '.join(products)}.")
    print(f"{'systém':<10}{'prompt':<8}{'M1':>7}{'95% IS':>16}{'M2':>8}{'faleš.':>8}{'formát':>8}{'TTFT medián [Q1–Q3] s':>26}")
    for p in products:
        for c in CONDITIONS:
            a = agg.get((p, c))
            if not a or not a["collected"]:
                print(f"{p:<10}{SHORT[c]:<8}{'nesebráno':>12}")
                continue
            m2 = f"{a['m2_k']}/{a['n']}" + ("*" if a["m2_pending"] else "")
            m1 = f"{a['m1_k']}/{a['n']}" + ("*" if a["m1_pending"] else "")
            lat = f"{cz(a['lat_med'])} [{cz(a['lat_q1'])}–{cz(a['lat_q3'])}]" if a["lat_n"] else "–"
            print(f"{p:<10}{SHORT[c]:<8}{m1:>7}{cz(a['m1_lo']) + '–' + cz(a['m1_hi']):>16}{m2:>8}{str(a['fa_resp']) + '/' + str(a['n']):>8}{a['format_errors']:>8}{lat:>26}")
    print("* = předběžné, část odpovědí čeká na člověka")
    print("\nZměna M1 mezi prompty (p. b.; zlepšené/zhoršené úlohy):")
    for (a, b), v in cmp.items():
        parts = [f"{p} {v['per'][p]['diff']:+.0f} ({v['per'][p]['up']}/{v['per'][p]['down']}" + (f", jen {v['per'][p]['n']} párů*" if v['per'][p]['provisional'] else "") + ")" for p in v["per"]]
        mean = f"průměr {v['mean']:+.1f}, zlepšilo se {v['improved']} z {v['systems']} systémů" if v["systems"] else "bez dat"
        print(f"  {SHORT[a]}→{SHORT[b]}: " + "; ".join(parts) + f" | {mean}")

    notes = cross_check(results, args.split, agg, rows)
    for a in agg.values():
        tag = f"{a['product']} {SHORT[a['condition']]}"
        if a["missing"]:
            notes.append(f"{tag}: chybí {a['missing']} z {a['n']} běhů.")
        if a["collected"] and a["m1_pending"] > a["missing"]:
            notes.append(f"{tag}: {a['m1_pending'] - a['missing']} odpovědí čeká na ruční zarovnání (M1 je dolní mez).")
        if a["collected"] and a["m2_pending"] > a["missing"]:
            notes.append(f"{tag}: {a['m2_pending'] - a['missing']} odpovědí čeká na lidské posouzení M2.")
        if a["collected"] and len(a["models"]) > 1:
            notes.append(f"{tag}: více označení modelu ({', '.join(a['models'])}).")
        if a["collected"] and a["lat_n"] < a["collected"]:
            notes.append(f"{tag}: latence jen u {a['lat_n']} z {a['collected']} běhů.")
    if len(products) < 4:
        notes.append(f"Ve výsledcích jsou jen {len(products)} systémy; zadání chce aspoň čtyři.")
    if notes:
        print("\nUpozornění:")
        for n in notes:
            print(" - " + n)
    print(f"\nZapsáno do {out.resolve()}")


if __name__ == "__main__":
    main()
