"""Score the judge's ratings: overall accuracy like KrishokBondhu / AgroLLM."""
import argparse, pandas as pd

ap = argparse.ArgumentParser(); ap.add_argument("--rated", default="answers_rated.csv"); a = ap.parse_args()
df = pd.read_csv(a.rated, encoding="utf-8-sig")
df["rating"] = df["rating"].astype(str).str.strip().str.lower()
valid = {"correct", "partly correct", "wrong"}
bad = df[~df["rating"].isin(valid)]
if len(bad):
    print("Unrated / invalid rows:", bad["no"].tolist()); df = df[df["rating"].isin(valid)]
n = len(df); c = (df.rating == "correct").sum(); p = (df.rating == "partly correct").sum(); wr = (df.rating == "wrong").sum()
print(f"Rated answers      : {n}")
print(f"Correct            : {c}\nPartly correct     : {p}\nWrong              : {wr}")
print(f"Overall accuracy   : {c/n*100:.1f}%   (Correct / Total)  <- main result")
print(f"Lenient accuracy   : {(c+p)/n*100:.1f}%   ((Correct + Partly) / Total)")
for lang, g in df.groupby("language"):
    print(f"  {lang:<8} accuracy: {(g.rating=='correct').mean()*100:.1f}%  (n={len(g)})")
for t, g in df.groupby("topic"):
    print(f"  {t:<16} {(g.rating=='correct').sum()}/{len(g)}")
