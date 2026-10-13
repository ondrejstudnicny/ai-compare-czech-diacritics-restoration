# Podklady k lidské analýze chyb

Výběr: první úplný úspěch, následně dosud nezastoupené diagnostické příčiny, poté další různé task_id v pořadí plánu. Nejvýše osm případů; pouze první plánované pokusy.

## 1. test08 / ChatGPT-P1-v1-test08-a1

ChatGPT; baseline; test; M1=1, M2=1.

Vstup:

    Ta kura pro nej byla velmi tvrda.

Reference:

    ["Ta kůra pro něj byla velmi tvrdá.","Ta kúra pro něj byla velmi tvrdá."]

Odpověď:

    Ta [kůra|kúra] pro něj byla velmi tvrdá.

Diagnostika:

    []

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 2. test01 / ChatGPT-P1-v1-test01-a1

ChatGPT; baseline; test; M1=0, M2=1.

Vstup:

    Doby , kdy se staty dobyvaly valkami, jsou bohudik pryc, ale i tato metoda obsazeni statu pristehovalci zpusobi valku.

Reference:

    ["Doby, kdy se státy dobývaly válkami, jsou bohudík pryč, ale i tato metoda obsazení států přistěhovalci způsobí válku.","Doby, kdy se státy dobývaly válkami, jsou bohudík pryč, ale i tato metoda obsazení státu přistěhovalci způsobí válku."]

Odpověď:

    Doby, kdy se státy dobývaly válkami, jsou bohudík pryč, ale i tato metoda obsazení států přistěhovalci způsobí válku.

Diagnostika:

    [{"code":"ambiguity_not_marked","word_index":14,"chosen":"států"}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 3. test05 / ChatGPT-P1-v1-test05-a1

ChatGPT; baseline; test; M1=0, M2=0.

Vstup:

    Na zahrade videl lisku.

Reference:

    ["Na zahradě viděl lišku.","Na zahradě viděl lísku."]

Odpověď:

    Na zahradě viděl [lišku|lišču].

Diagnostika:

    [{"code":"format_error","details":["invalid_bracket"]}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 4. test10 / ChatGPT-P1-v1-test10-a1

ChatGPT; baseline; test; M1=0, M2=1.

Vstup:

    Kdyz se otocil, uvidel tam spici.

Reference:

    ["Když se otočil, uviděl tam špici.","Když se otočil, uviděl tam spící."]

Odpověď:

    Když se otočil, uviděl tam [spící|špicí].

Diagnostika:

    [{"code":"missing_form","word_index":5,"forms":["špici"]},{"code":"extra_form","word_index":5,"forms":["špicí"]}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 5. test03 / ChatGPT-P2-v1-test03-a1

ChatGPT; structured; test; M1=0, M2=0.

Vstup:

    Legalizace je jedna vec, ale nulova tolerance kanabinoidu v organismu by urcite zustala zachovana jak za volantem, tak v praci.

Reference:

    ["Legalizace je jedna věc, ale nulová tolerance kanabinoidu v organismu by určitě zůstala zachována jak za volantem, tak v práci.","Legalizace je jedna věc, ale nulová tolerance kanabinoidů v organismu by určitě zůstala zachována jak za volantem, tak v práci.","Legalizace je jedna věc, ale nulová tolerance kanabinoidu v organismu by určitě zůstala zachovaná jak za volantem, tak v práci.","Legalizace je jedna věc, ale nulová tolerance kanabinoidů v organismu by určitě zůstala zachovaná jak za volantem, tak v práci."]

Odpověď:

    Legalizace je jedna [věc|več], ale nulová tolerance kanabinoidů v organismu by určitě zůstala zachována jak za volantem, tak v práci.

Diagnostika:

    [{"code":"ambiguity_not_marked","word_index":7,"chosen":"kanabinoidů"},{"code":"ambiguity_not_marked","word_index":13,"chosen":"zachována"},{"code":"false_ambiguity","output_word_index":3}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 6. test02 / ChatGPT-P1-v1-test02-a1

ChatGPT; baseline; test; M1=0, M2=1.

Vstup:

    Marka srazi autqo.

Reference:

    ["Marka sráží auto.","Marka srazí auto."]

Odpověď:

    Marka srazí auto.

Diagnostika:

    [{"code":"ambiguity_not_marked","word_index":1,"chosen":"srazí"}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 7. test04 / ChatGPT-P1-v1-test04-a1

ChatGPT; baseline; test; M1=0, M2=0.

Vstup:

    Pivoteka je polokalk( tedy vyraz, jehoz jedna cast je prelozena a druha nikoli.

Reference:

    ["Pivotéka je polokalk, tedy výraz, jehož jedna část je přeložena a druhá nikoli.","Pivotéka je polokalk, tedy výraz, jehož jedna část je přeložená a druhá nikoli."]

Odpověď:

    Pivotéka je polokalk( tedy výraz, jehož jedna část je přeložena a druhá nikoli.

Diagnostika:

    [{"code":"ambiguity_not_marked","word_index":9,"chosen":"přeložena"}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

## 8. test06 / ChatGPT-P1-v1-test06-a1

ChatGPT; baseline; test; M1=0, M2=0.

Vstup:

    Mysli na me.

Reference:

    ["Mysli na mě.","Myslí na mě."]

Odpověď:

    Mysli na [mě|mne].

Diagnostika:

    [{"code":"format_error","details":["invalid_bracket"]}]

Lidský rozbor: doplňte chybu, pravděpodobnou příčinu, omezení automatické kontroly a možné zlepšení.

Wilsonovy intervaly popisují nejistotu mezi případy, nikoli variabilitu opakovaného generování. Malá sada nepodporuje obecnou převahu produktu.
