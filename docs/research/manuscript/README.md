# Manuscript

> **NOT SUBMISSION-READY.** Neither version can be submitted yet. The blockers are listed below under [NOT SUBMISSION-READY](#not-submission-ready).

- `main.tex` is the IEEEtran journal-format draft. `main.pdf` is the compiled copy, rebuilt on 16 October 2026 after the text was aligned with policy `v1.1-safe-ai` (see [Alignment](#alignment-with-v11-safe-ai-16-october-2026)). It has 7 pages, 0 LaTeX errors, 0 LaTeX warnings, 0 undefined citations or references and 0 overfull boxes.
  - *Correction (2026-10-16):* an earlier version of this README put the one overfull line in the chat table. The log shows it was in the fusion table (`generated_tables.tex`, lines 39–51). A two-line column header now removes it.
- `main-access.tex` is the same text ported to the official IEEE Access template. `main-access.pdf` is its compiled copy. See [IEEE Access version](#ieee-access-version-main-accesstex).
- `vendor/` holds the IEEE Access LaTeX template zip exactly as downloaded. `vendor/SOURCE.md` records its source URL, SHA-256, contents and licence status. The licence is unclear: see that file.
- `generated_tables.tex` is written by `node scripts/eval/manuscriptTables.js` from `docs/research/evaluation/results/*.json` and `docs/research/evaluation/live/*.json`. The fusion table's `v1.1-safe-ai` row comes from its own dated, write-once file, `results/fusion_v1.1_2026-10-16.json`, because `results/fusion.json` is the published baseline. Do not edit the generated file by hand. Both `main.tex` and `main-access.tex` use it.
- `generated_numbers.tex` is written by the same script. It holds one `\newcommand` per number in the prose, and `main.tex` loads it with `\input{generated_numbers}`. `generated_numbers.json` gives each macro's value, source file or module, pointer and formatter. Sources:
  - the result and live JSON files;
  - the code defaults (policy thresholds and windows, satellite configuration, AI timeout, rate limits). The current rate-limit defaults come from `RATE_LIMIT_DEFAULTS` in `config/env.js`;
  - the date of the `v1.1-safe-ai` decision, taken from the ADR-022 status line in `docs/decisions/18_DECISIONS.md`;
  - `scripts/live/lib/syntheticLandDocs.js`;
  - the bibliography (`scripts/eval/bibStats.js`) and `../source_ledger.json`.
  
  Do not edit either file by hand.
- `number_allowlist.json` lists the only number literals allowed in the prose, each with a justification. These are names, identifiers and event dates, such as "Sentinel-2" and the policy id `v1.1-safe-ai`.
- References come from `../references.bib`. `../source_ledger.json` records, for every entry, how much of the source was read. It takes this only from explicit statements in `../literature_review.md`, and the author still has to confirm each row.

## Checking the numbers

```sh
node scripts/eval/manuscriptTables.js
npm run manuscript:numbers        # node scripts/eval/checkManuscriptNumbers.js
```

The check fails on any of these:

- a number literal in `main.tex` that is neither a macro nor allow-listed;
- a macro that is undefined, or whose value differs from a fresh recomputation (stale generated files);
- a source-ledger count that disagrees with `../research_gap.md` or `../literature_review.md`;
- a changed frozen result file (`../evaluation/live/FROZEN_HASHES.json`);
- a `main.pdf` older than `main.tex`, the generated files or the bibliography.

`manuscriptTables.js` rewrites a generated file only when its content changes, so a no-op run does not make the PDF look stale. The Disclosures section reports study-time behaviour, so its values come from commit `6dbe6b8`, the code that ran the study. They were extracted once into `../evaluation/live/study_code_defaults_2026-10-16.json` (file, line and blob per value), which `FROZEN_HASHES.json` pins. The claim-write limit is read from that record. The AI timeout and the scene cloud limits are read from today's code but must still equal the recorded values, and the generator stops if they differ. When `6dbe6b8` is in the checkout, the generator also re-reads each recorded value from the code at that commit and stops on any difference. A shallow clone (CI uses `actions/checkout` with depth 1) or a copy without `.git` skips that cross-check with a warning, so the check does not need the git history.

The source ledger's `confirmedByAuthor` must be `true` or `false` on every row. Rows not yet confirmed are reported as a warning, not an error.

`npm run manuscript:numbers` scans `main.tex` only. `main-access.tex` shares its abstract and body. `tests/researchAlignment.unit.test.js` checks the following:

- the shared text is identical in both files, apart from the template's drop cap;
- every macro `main-access.tex` uses is defined;
- `main-access.tex` has no number literal outside its template front matter that is not allow-listed;
- the abstract has 150 to 250 words once the macros are expanded;
- `main-access.pdf` is not older than its sources;
- the vendored template zip matches the SHA-256 recorded in `vendor/SOURCE.md`.

The generator also asserts each statement the prose makes about the `v1.1-safe-ai` row:

- it has the same invalid approvals as `v1-legacy`;
- it rejects nothing on the AI reading alone;
- the only decisions that change are AI-rule rejections that become holds;
- satellite and weather change no outcome and no hold.

A recomputed row that disagrees stops the generator.

## The fusion `v1.1-safe-ai` row

```sh
VIVASAYI_SKIP_DOTENV=1 node scripts/eval/fusion.eval.js --safe-ai-row --date=YYYY-MM-DD
```

The command writes `docs/research/evaluation/results/fusion_v1.1_<date>.json` with the write-once helper, so an existing file is never replaced. It first checks that the published rows of `results/fusion.json` still reproduce byte for byte (EV-16), and refuses to run when they do not. It also refuses to run when the developer's `.env` or a `CLAIM_*` rule override could change the policy hash.

The run of 2026-10-16 (commit `6dbe6b8`, dirty working tree) gives:

| Measure | `v1-legacy` | `v1.1-safe-ai` |
|---|---|---|
| Invalid approvals | 10/190 | 10/190 |
| Rejected on the AI reading alone | 2/2 | 0/2 |
| Held for review | 0 | 12 |
| Satellite/weather changed an outcome | 0/1,536 | 0/1,536 |
| Satellite/weather changed an outcome or a hold | not computed | 0/1,536 |

Against `v1-legacy`, the only change is 12 AI-rule rejections that become holds; the other 180 decisions are unchanged. `v1.1-safe-ai` does **not** reduce invalid approvals. The numbers above are copied from the result file. The manuscript takes them through macros.

## Build

Build in a scratch copy, not inside the repository, so that no auxiliary file or unpacked template ends up here. The `\bibliography{../references}` path needs the copy to keep the `research/manuscript/` and `research/references.bib` layout.

**IEEEtran (`main.tex`).** TeX Live BasicTeX does not include IEEEtran. Download the class from CTAN (https://mirrors.ctan.org/macros/latex/contrib/IEEEtran.zip) and put `IEEEtran.cls` and `IEEEtran.bst` next to the copied `main.tex`. Then run:

```sh
node scripts/eval/manuscriptTables.js
B=$(mktemp -d); mkdir -p $B/research/manuscript
cp docs/research/references.bib $B/research/
cp docs/research/manuscript/{main.tex,generated_numbers.tex,generated_tables.tex} $B/research/manuscript/
cp IEEEtran.cls IEEEtran.bst $B/research/manuscript/
cd $B/research/manuscript
pdflatex -no-shell-escape main && bibtex main && pdflatex -no-shell-escape main && pdflatex -no-shell-escape main
cp main.pdf <repo>/docs/research/manuscript/main.pdf
```

**IEEE Access (`main-access.tex`).** Unpack the vendored zip into the scratch copy. Copy every file except the sample `access.*` next to `main-access.tex`. The class loads its font map files and Type 1 fonts from the working directory.

```sh
B=$(mktemp -d); mkdir -p $B/research/manuscript $B/tpl
cp docs/research/references.bib $B/research/
cp docs/research/manuscript/{main-access.tex,generated_numbers.tex,generated_tables.tex} $B/research/manuscript/
unzip -q docs/research/manuscript/vendor/ieee-access-20260513/ACCESS_latex_template_20260513-1-1.zip -d $B/tpl
find $B/tpl/ACCESS_latex_template_20260513 -type f ! -name 'access.*' -exec cp {} $B/research/manuscript/ \;
cd $B/research/manuscript
pdflatex -no-shell-escape main-access && bibtex main-access && pdflatex -no-shell-escape main-access && pdflatex -no-shell-escape main-access
cp main-access.pdf <repo>/docs/research/manuscript/main-access.pdf
```

**Results of the 2026-10-16 builds** (TeX Live 2025 BasicTeX, pdfTeX 1.40.27):

| | `main.pdf` (IEEEtran) | `main-access.pdf` (IEEE Access) |
|---|---|---|
| Pages | 7 | 7 |
| Errors | 0 | 0 |
| Undefined citations or references | 0 | 0 |
| LaTeX warnings | 0 | 0 |
| Overfull boxes | 0 | 17, all from the template |
| Other | 5 underfull lines (long URLs in the bibliography, one paragraph) | 21 underfull lines, mostly URLs; 6 font-shape substitutions from the template's own fonts; an `epstopdf` notice that shell escape is off |

The template's own boxes are 2 at `\maketitle` (9.3 pt) and 15 "while `\output` is active" (505 pt). The template's sample log contains the same boxes (2 and 17), and the same `formata/m/sl` font substitution.

## NOT SUBMISSION-READY

`main-access.tex` is a faithful port, and it says so in its header comment. It must **not** be submitted until all of these are resolved:

1. **Authors.** Author names, affiliations, the corresponding author and the support statement are missing. IEEE Access requires a short biography for **every** author, placed below the references; a photograph is optional in the template. A placeholder biography stands in for them.
2. **Live LLM evaluations are BLOCKED.** The live chat comparison and the synthetic land-document extraction wait for a billed Gemini key (owner decision D6). Their scripts are ready.
3. **Expert-rated chat answers** are pending (rubric in `../evaluation/README.md`).
4. **No real-claim data.** Every claim result is synthetic or a feasibility case study.
5. **RAG before/after table** is pending. Only the 16 October 2026 baseline table is reported, and the re-chunked local index has not been evaluated in this manuscript.
6. **Tamil copy unreviewed.** A native speaker has not reviewed the application's Tamil text.

Also open, though it does not block submission: the hermetic `v1.1-safe-ai` acceptance run (`acceptance_v1.1-safe-ai_<date>.json`, mock AI) has not been recorded. The manuscript says that no acceptance run used `v1.1-safe-ai`. The template zip's licence is also unclear (`vendor/SOURCE.md`).

## IEEE Access version (`main-access.tex`)

- **Class.** `\documentclass{ieeeaccess}`, from the template dated 13 May 2026 and downloaded on 2026-10-16. Source: the LaTeX link on https://ieeeaccess.ieee.org/authors/submission-guidelines/. SHA-256 and licence are in `vendor/SOURCE.md`.
- **Shared with `main.tex`.** `main-access.tex` uses the same `generated_numbers.tex`, `generated_tables.tex` and `../references.bib`. The abstract and the body, from the Introduction to the Conclusion, are the same text. Only the template's drop cap differs. Change both files together; `tests/researchAlignment.unit.test.js` fails if they diverge.
- **Template-specific front matter.**
  - `\history` and `\doi` say "assigned by IEEE".
  - The keywords are in alphabetical order, as the template asks.
  - The template's sample footer ("VOLUME 11, 2023") is replaced by placeholders.
  - A placeholder biography follows the references, and the file ends with `\EOD`.
- **Abstract.** 246 words. The template asks for 150–250 words in one paragraph, without references. `main.tex` uses the same abstract.
- **Submission requirements**, from the IEEE Access submission-guidelines page, checked on 2026-10-16:
  - the IEEE Access template is required: double column, single spaced;
  - a Word or LaTeX source **and** a matching PDF are both required, and their content must match exactly;
  - files may be at most 40 MB;
  - fewer than 20 pages is strongly recommended, and longer submissions get an initial editorial review;
  - short biographies are required for all authors, below the references.

## Alignment with `v1.1-safe-ai` (16 October 2026)

The text now matches owner decisions D1, D2 and D5 (ADR-022 in `docs/decisions/18_DECISIONS.md`):

- **Three policies.**
  - `v1-legacy` is historical, and it was the policy of the live study.
  - `v1.1-safe-ai` is the default as of the change of 16 October 2026. It makes four changes: an AI-only "no damage" reading goes to human review; a technical failure leads to a hold; the claim window is measured at first submission; satellite is never waited for.
  - `v2-components` was evaluated but is not the default, because no authoritative claimant-rights provider exists.
  - The switch of the code default (`DEFAULT_CLAIM_VERIFICATION_POLICY`) is a separate engineering step. The manuscript describes the decision, not a deployment.
- **Policy-specific statements.** "Never reads a provider failure as a negative finding" now holds at the component level for every policy. At the decision level it is policy-specific. Under `v1-legacy` and `v2-components`, an unreadable model answer returns the claim for more evidence. Only `v1-legacy` lets a model reading alone reject a claim.
- **Timing.** Satellite runs independently and never blocks or changes a decision, under any policy. Under `v1.1-safe-ai` the claim window is measured at first submission.
- **Automatic processing.** The text briefly describes the durable enqueue, the worker and the farmer progress tracker as implemented and tested, but not deployed.
- **Fusion.** The computed `v1.1-safe-ai` row is in the table. The text states that it does not reduce invalid approvals relative to `v1-legacy`.
- **Disclosures.** The write budget keeps the study-time value (five per hour, from the pinned study-defaults record). It adds the current defaults (fifteen claim writes and 60 evidence requests per hour, D5), which are not deployed.
- **Limitations.** All earlier limitations are kept. One is added: `v1.1-safe-ai` has only synthetic and test evidence.

Still to do: the RAG before/after table, and the hermetic `v1.1-safe-ai` acceptance run. Both are listed under [NOT SUBMISSION-READY](#not-submission-ready).
