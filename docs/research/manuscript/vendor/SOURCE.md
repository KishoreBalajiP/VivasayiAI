# Vendored third-party files

## `ieee-access-20260513/ACCESS_latex_template_20260513-1-1.zip`

The official IEEE Access LaTeX template, used to build `../main-access.tex`. It is kept exactly as
downloaded. It has not been unpacked here or edited.

| Item | Value |
|---|---|
| Source URL | https://ieeeaccess.ieee.org/wp-content/uploads/2026/05/ACCESS_latex_template_20260513-1-1.zip |
| Linked from | https://ieeeaccess.ieee.org/authors/submission-guidelines/ (the "LaTeX template" download) |
| Retrieved | 2026-10-16, HTTP 200, `Content-Type: application/zip` |
| Size | 1,942,796 bytes |
| SHA-256 | `60c7efc9db8ac9e8bdb31c550ad4e03cb6f258a878ececc0bc690b6203e45a67` |
| Template date | 13 May 2026 (the folder name inside the zip and the comment "Adjusted 05/13/2026" in `access.tex`) |

To check a copy: `shasum -a 256 ieee-access-20260513/ACCESS_latex_template_20260513-1-1.zip`.

### Contents (56 files, one folder `ACCESS_latex_template_20260513/`)

- `ieeeaccess.cls`, the IEEE Access class. It loads `IEEEtran` and has no version or licence line.
- `IEEEtran.cls` (V1.8b, 2015/08/26) and `IEEEtran.bst`.
- `spotcolor.sty` (v1.2, 2006/11/15).
- A sample paper: `access.tex`, `access.pdf`, `access.aux` and `access.log`. The log shows it was built with MiKTeX on Windows.
- Images: `logo.png`, `notaglinelogo.png`, `bullet.png`, `fig1.png`, `equation3.png`, and sample author photos `author1.png` to `author3.png`.
- Type 1 fonts with metrics, font definitions and map files for Formata, Giovanni Std and Times (`t1-*.pfb`, `t1-*.tfm`, `t1*.fd`, `t1-*.map`). The class loads the map files with `\pdfmapfile`.

### Licence

The licence is **unclear**. This is an open issue.

- The zip has no licence or readme file.
- `ieeeaccess.cls` and `spotcolor.sty` say nothing about a licence.
- `IEEEtran.cls` and `IEEEtran.bst` state that they are distributed under the LaTeX Project Public License (LPPL) 1.3.
- The font files (Formata, Giovanni Std, Times) carry no licence text in the zip. Formata and Giovanni are commercial typefaces, so their redistribution terms cannot be assumed.
- The submission-guidelines page gives no licence or usage terms for the templates. Its only notice is the site footer, "© Copyright 2026 IEEE – All rights reserved".

**Open issue.** Before this repository is pushed anywhere public, the owner should decide whether the zip may stay in git. The safe default is to keep it out: add `docs/research/manuscript/vendor/ieee-access-*/` to `.gitignore` and download the zip at build time, checking it against the SHA-256 above. `.gitignore` belongs to another work stream, so this file does not change it.

### Handling (the zip is untrusted input)

- The zip was downloaded into this new, empty folder and listed with `unzip -l`. All 56 paths sit under one folder, with no absolute paths and no `..`.
- For builds it is unpacked into a scratch directory outside the repository, never here.
- Nothing in it is executed. TeX only reads the class, style, font and image files, and always runs with `pdflatex -no-shell-escape`.
- `ieeeaccess.cls` and `spotcolor.sty` were checked for `\write18`, `\immediate\write` and `\openout`; neither uses them. The class requires `ifpdf`, `xkeyval`, `color` and `spotcolor`. It loads `hyperref` only for the JTEHM option, and `ltxutil`/`ltxgrid` only for the editorial option.
- The sample `access.tex` was not compiled.

### What the template itself states (from `access.tex`)

- The abstract must be one paragraph of 150 to 250 words, with no abbreviations, footnotes, references, displayed equations or tables.
- Keywords go in alphabetical order.
- Author biographies go after the references in `IEEEbiography`, with a photo, or `IEEEbiographynophoto`, without one ("If you do not have or do not want to include a photo, you can use IEEEbiographynophoto"). The document ends with `\EOD`.
- `\history`, `\doi`, `\address`, `\tfootnote`, `\corresp` and `\markboth` are front-matter fields. The class prints a sample footer, "VOLUME 11, 2023" (`\thevol`, `\theyear`), which `main-access.tex` replaces with placeholders.
