"""Lidské hodnocení M2 (language_correction) přes tabulky pro Excel.

1) Vytvořit tabulky z fronty:
   python3 human_review.py vytvor eval/results_04/review_queue.jsonl --hodnotitele reviewer1 reviewer2
   -> human_review/reviewer1.csv, reviewer2.csv (stejné odpovědi, každý v jiném náhodném pořadí)

2) Hodnotitelé vyplní sloupce "decision" (pass/fail) a "reason". Navzájem se neradí.

3) Převést do eval/reviews.jsonl:
   python3 human_review.py prevod
   Neshody se zapíšou do human_review/disagreements.csv. Po společné dohodě vyplňte
   "final_decision" a "final_reason" a spusťte prevod znovu.

Tabulky jsou zdroj pravdy: prevod vždy celý reviews.jsonl přepíše (starý uloží jako .bak).
"""
import argparse, csv, json, random, shutil, sys
from datetime import datetime, timezone
from pathlib import Path

DIR = Path('human_review')
REVIEWS = Path('eval/reviews.jsonl')
ADJ_ID = 'adjudication'
COLS = ['order', 'blinded_id', 'reference_version', 'input_no_diacritics', 'response',
        'reference', 'decision', 'reason']
NCOLS = ['blinded_id', 'reference_version', 'input_no_diacritics', 'response', 'reference',
         'reviewer_votes', 'final_decision', 'final_reason']


def write_csv(path, cols, rows):
    # UTF-8 s BOM a středníky, aby to český Excel otevřel správně.
    with open(path, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=';')
        w.writeheader()
        w.writerows(rows)


def read_csv(path):
    with open(path, encoding='utf-8-sig', newline='') as f:
        sample = f.read(4096); f.seek(0)
        delim = ';' if sample.count(';') >= sample.count(',') else ','
        return list(csv.DictReader(f, delimiter=delim))


def vytvor(a):
    queue = [json.loads(l) for l in open(a.queue, encoding='utf-8') if l.strip()]
    items = [q for q in queue if q['review_required'] or q['double_review_selected']]
    if not items:
        sys.exit('Ve frontě není nic k hodnocení.')
    DIR.mkdir(exist_ok=True)
    for name in a.hodnotitele:
        path = DIR / f'{name}.csv'
        if path.exists() and not a.prepsat:
            sys.exit(f'{path} už existuje (může obsahovat vyplněná hodnocení). Použij --prepsat.')
        order = items[:]
        random.Random(f'{a.seed}-{name}').shuffle(order)
        rows = [{'order': i, 'blinded_id': q['blinded_id'],
                 'reference_version': q['reference_version'],
                 'input_no_diacritics': q['input_sentence'], 'response': q['response_text'],
                 'reference': ' || '.join(q['reference_sentences']),
                 'decision': '', 'reason': ''} for i, q in enumerate(order, 1)]
        write_csv(path, COLS, rows)
        print(f'{path}: {len(rows)} odpovědí')
    print(f'Z toho povinných (neshoda s referencí): {sum(q["review_required"] for q in items)}, '
          f'vybraných pro dva hodnotitele: {sum(q["double_review_selected"] for q in items)}.')


def prevod(a):
    files = sorted(DIR.glob('reviewer*.csv'))
    if not files:
        sys.exit(f'V {DIR}/ nejsou žádné tabulky reviewer*.csv.')
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    out, votes, info, problems = [], {}, {}, []
    for path in files:
        name = path.stem
        for row in read_csv(path):
            bid = row['blinded_id'].strip()
            dec = row['decision'].strip().lower()
            reason = row['reason'].strip()
            info[bid] = row
            if not dec:
                problems.append(f'{path.name} řádek {row["order"]}: nevyplněno')
                continue
            if dec not in ('pass', 'fail'):
                problems.append(f'{path.name} řádek {row["order"]}: rozhodnutí "{dec}" (musí být pass/fail)')
                continue
            if not reason:
                problems.append(f'{path.name} řádek {row["order"]}: chybí důvod')
                continue
            votes.setdefault(bid, {})[name] = dec
            out.append({'blinded_id': bid, 'reference_version': row['reference_version'],
                        'evaluator_id': name, 'dimension': 'language_correction',
                        'decision': dec, 'reason': reason, 'adjudicated': False,
                        'reviewed_at_utc': now})

    # Neshody: zachovat už vyplněné dohody, přidat nové.
    npath = DIR / 'disagreements.csv'
    agreed = {r['blinded_id']: r for r in read_csv(npath)} if npath.exists() else {}
    disagree = [bid for bid, v in votes.items() if len(set(v.values())) > 1]
    nrows, open_n = [], 0
    for bid in disagree:
        old = agreed.get(bid, {})
        final = old.get('final_decision', '').strip().lower()
        why = old.get('final_reason', '').strip()
        r = info[bid]
        nrows.append({'blinded_id': bid, 'reference_version': r['reference_version'],
                      'input_no_diacritics': r['input_no_diacritics'], 'response': r['response'],
                      'reference': r['reference'],
                      'reviewer_votes': ', '.join(f'{k}: {v}' for k, v in sorted(votes[bid].items())),
                      'final_decision': final, 'final_reason': why})
        if final in ('pass', 'fail') and why:
            out.append({'blinded_id': bid, 'reference_version': r['reference_version'],
                        'evaluator_id': ADJ_ID, 'dimension': 'language_correction',
                        'decision': final, 'reason': why, 'adjudicated': True,
                        'reviewed_at_utc': now})
        else:
            open_n += 1
    if nrows:
        write_csv(npath, NCOLS, nrows)

    if REVIEWS.exists() and REVIEWS.stat().st_size:
        shutil.copy(REVIEWS, REVIEWS.with_suffix('.jsonl.bak'))
    with open(REVIEWS, 'w', encoding='utf-8') as f:
        for r in out:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')

    both = sum(1 for v in votes.values() if len(v) >= 2)
    print(f'Zapsáno {len(out)} hodnocení do {REVIEWS} (hodnotitelé: {", ".join(f.stem for f in files)}).')
    print(f'Odpovědi se dvěma hodnoceními: {both}; neshody: {len(disagree)}, z toho nedohodnuté: {open_n}.')
    if open_n:
        print(f'-> Doplňte final_decision a final_reason v {npath} a spusťte prevod znovu.')
    if problems:
        print(f'Nezapsáno ({len(problems)}):')
        for p in problems:
            print('  -', p)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    v = sub.add_parser('vytvor')
    v.add_argument('queue')
    v.add_argument('--hodnotitele', nargs=2, required=True)
    v.add_argument('--seed', default='czai')
    v.add_argument('--prepsat', action='store_true')
    sub.add_parser('prevod')
    a = p.parse_args()
    vytvor(a) if a.cmd == 'vytvor' else prevod(a)


if __name__ == '__main__':
    main()
