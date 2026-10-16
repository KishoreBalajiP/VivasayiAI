# Manuscript

- `main.tex` is the IEEEtran journal-format draft. `main.pdf` is the compiled copy from 16 October 2026: 6 pages, 0 LaTeX errors, 0 undefined citations.
- `generated_tables.tex` is written by `node scripts/eval/manuscriptTables.js` from `docs/research/evaluation/results/*.json` and `docs/research/evaluation/live/*.json`. Do not edit it by hand.
- References come from `../references.bib` (74 entries).

## Build

TeX Live BasicTeX does not include IEEEtran. Download the class from CTAN (https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip) and put `IEEEtran.cls` and `IEEEtran.bst` next to `main.tex`, or on `TEXINPUTS`/`BSTINPUTS`. Then run:

```sh
node scripts/eval/manuscriptTables.js
cd docs/research/manuscript
pdflatex main && bibtex main && pdflatex main && pdflatex main
```

## Before submission

The target venue is IEEE Access (see `../venue_selection.md`), which needs its own template. Porting to it will reflow the text and should clear the remaining overfull line.
