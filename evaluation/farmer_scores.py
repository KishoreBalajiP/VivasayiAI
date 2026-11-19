"""Score the two farmers' ratings of the 40 answered questions (answers_40.csv).
Farmer 1 numbered by original question number; farmer 2 by the sheet number (1-40) of
farmer_rating_sheet.md, mapped here to the question number. Run: py -3 farmer_scores.py"""
import csv, json
from collections import Counter

rows = list(csv.DictReader(open("answers_40.csv", encoding="utf-8-sig")))
qnos = [int(r["no"]) for r in rows]
sheet_to_q = {i + 1: q for i, q in enumerate(qnos)}
lang = {int(r["no"]): r["language"] for r in rows}
C, P, W = "Correct", "Partly correct", "Wrong"

def build(groups):
    out = {}
    for label, nums in groups.items():
        for n in nums:
            assert n not in out, f"duplicate {n}"
            out[n] = label
    return out

f1 = build({W: [17, 19, 23, 33, 34], P: [1, 3, 4, 5, 6, 7, 9, 10, 11, 13, 15, 16, 21, 22, 27],
            C: [2, 8, 12, 14, 18, 20, 24, 25, 26, 28, 29, 30, 31, 32, 36, 39, 40, 44, 48, 49]})
f2_sheet = build({C: [2, 8, 9, 12, 14, 15, 20, 21, 22, 24, 25, 32, 35, 38, 39, 40],
                  P: [1, 3, 4, 5, 6, 10, 11, 13, 16, 18, 19, 23, 27, 28, 30, 31, 34, 37],
                  W: [7, 17, 26, 29, 33, 36]})
f2 = {sheet_to_q[s]: v for s, v in f2_sheet.items()}
assert sorted(f1) == sorted(qnos) and sorted(f2) == sorted(qnos), "ratings must cover exactly the 40 questions"

llm = {int(r["no"]): r["rating"] for r in csv.DictReader(open("answers_rated_40.csv", encoding="utf-8-sig"))}

def score(r):
    c = Counter(r.values()); n = len(r)
    by_lang = {l: f"{sum(1 for q in r if lang[q] == l and r[q] == C)}/{sum(1 for q in r if lang[q] == l)}" for l in ("English", "Tamil")}
    return {"n": n, "correct": c[C], "partly": c[P], "wrong": c[W], "strict_accuracy": round(100 * c[C] / n, 1),
            "lenient_accuracy": round(100 * (c[C] + c[P]) / n, 1), "correct_by_language": by_lang}

def kappa(a, b):
    qs = sorted(a); n = len(qs); cats = [C, P, W]
    po = sum(a[q] == b[q] for q in qs) / n
    pe = sum((sum(a[q] == k for q in qs) / n) * (sum(b[q] == k for q in qs) / n) for k in cats)
    return {"exact_agreement": round(100 * po, 1), "cohen_kappa": round((po - pe) / (1 - pe), 3)}

# Consensus: the two farmers agree -> that label; they differ -> the lower (stricter) label.
rank = {W: 0, P: 1, C: 2}
consensus = {q: (f1[q] if f1[q] == f2[q] else min(f1[q], f2[q], key=rank.get)) for q in qnos}

result = {
    "note": "Ratings supplied by the project author as given by two farmers; farmer 2 mapped from sheet numbers. Rater names/villages not recorded here.",
    "farmer1": score(f1), "farmer2": score(f2),
    "consensus_stricter_on_disagreement": score(consensus),
    "agreement_farmer1_vs_farmer2": kappa(f1, f2),
    "agreement_farmer1_vs_llm": kappa(f1, llm), "agreement_farmer2_vs_llm": kappa(f2, llm),
    "disagreements_farmer1_vs_farmer2": {q: [f1[q], f2[q]] for q in qnos if f1[q] != f2[q]},
    "per_question": {q: {"farmer1": f1[q], "farmer2": f2[q], "consensus": consensus[q], "llm": llm[q]} for q in qnos},
}
json.dump(result, open("farmer_scores.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
with open("answers_farmer_rated_40.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f); w.writerow(["no", "question", "language", "topic", "farmer1", "farmer2", "consensus", "llm_judge"])
    for r in rows:
        q = int(r["no"]); w.writerow([q, r["question"], r["language"], r["topic"], f1[q], f2[q], consensus[q], llm[q]])
for k in ("farmer1", "farmer2", "consensus_stricter_on_disagreement", "agreement_farmer1_vs_farmer2", "agreement_farmer1_vs_llm", "agreement_farmer2_vs_llm"):
    print(k, result[k])
print("disagreements:", len(result["disagreements_farmer1_vs_farmer2"]))
