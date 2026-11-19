"""Ask Vivasayi AI every question in questions.csv and save the answers for an independent judge.

Matches the real backend contract (routes/chat.js, routes/chatSessions.js, utils/validation.schemas.js):
  POST /chatsessions/new   body {"title": "..."}                -> {"data": {"session": {"_id": ...}}}
  POST /chat               body {"message", "language": "en"|"ta", "chatId"}
                                                               -> {"data": {"response": "<reply text>", ...}}
Both need "Authorization: Bearer <access token>" (middlewares/auth.js). Each question gets its own new
session, so earlier questions cannot affect later ones. This script never rates answers: the rating
and judge_comment columns are always written empty.
"""
import argparse, csv, json, subprocess, time
import requests


def load_token(cfg):
    if cfg.get("token_command"):
        out = subprocess.run(cfg["token_command"], capture_output=True, check=True).stdout
        # dotenv may print a banner first; the token is the last line.
        return out.decode("utf-8", "replace").strip().splitlines()[-1].strip()
    return cfg["token"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", default="questions.csv")
    ap.add_argument("--out", default="answers.csv")
    ap.add_argument("--config", default="config.json")
    ap.add_argument("--limit", type=int, default=0, help="only the first N questions (smoke test)")
    ap.add_argument("--retry-errors", action="store_true", help="re-ask only rows of --out that failed")
    a = ap.parse_args()
    cfg = json.load(open(a.config, encoding="utf-8"))
    base = cfg["api_base"].rstrip("/")
    token, token_at = load_token(cfg), time.time()

    rows = list(csv.DictReader(open(a.questions, encoding="utf-8-sig")))
    if a.limit:
        rows = rows[: a.limit]
    header = ["no", "question", "language", "topic", "answer", "followup", "has_context", "sources",
              "chat_id", "http_status", "seconds", "attempts", "rating", "judge_comment"]
    # --retry-errors: keep every successful row of an earlier run, ask again only the ERROR rows.
    kept, attempts = {}, {}
    if a.retry_errors:
        for old in csv.DictReader(open(a.out, encoding="utf-8-sig")):
            attempts[old["no"]] = int(old.get("attempts") or 1)
            if not old["answer"].startswith("ERROR"):
                kept[old["no"]] = old
    out = open(a.out, "w", newline="", encoding="utf-8-sig")
    w = csv.writer(out)
    w.writerow(header)

    def post(path, body):
        nonlocal token, token_at
        # Access tokens live 15 minutes (ACCESS_TOKEN_TTL_MS): refresh before that when a command is configured.
        if cfg.get("token_command") and time.time() - token_at > cfg.get("token_refresh_s", 600):
            token, token_at = load_token(cfg), time.time()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        return requests.post(base + path, headers=headers, json=body, timeout=cfg["timeout_s"])

    for r in rows:
        if r["no"] in kept:
            w.writerow([kept[r["no"]].get(h, "") if h != "attempts" else attempts[r["no"]] for h in header])
            continue
        lang ="ta" if r["language"].strip().lower().startswith("ta") else "en"
        chat_id, answer, status, has_ctx, sources = "", "", "", "", ""
        t0 = time.time()
        try:
            s = post(cfg["new_session_path"], {"title": f"Eval Q{r['no']}"})
            if not s.ok:
                raise RuntimeError(f"session HTTP {s.status_code}: {s.text[:200]}")
            chat_id = s.json()["data"]["session"]["_id"]
            t0 = time.time()
            resp = post(cfg["chat_path"], {"message": r["question"], "language": lang, "chatId": chat_id})
            status = resp.status_code
            if resp.ok:
                data = resp.json()["data"]
                answer = data.get("response", "")
                has_ctx = data.get("hasContext", "")
                sources = "; ".join(s.get("filename", "") for s in data.get("sources") or [])
            else:
                answer = f"ERROR {resp.status_code}: {resp.text[:200]}"
        except Exception as e:  # recorded, never hidden
            answer = f"ERROR {e}"
        sec = round(time.time() - t0, 1)
        # Mechanical hint only (short reply ending in "?"); the judge decides what it is.
        followup = "yes" if answer.strip().endswith("?") and len(answer) < 400 else "no"
        w.writerow([r["no"], r["question"], r["language"], r["topic"], answer, followup, has_ctx, sources,
                    chat_id, status, sec, attempts.get(r["no"], 0) + 1, "", ""])
        out.flush()
        print(f"{r['no']:>3}  {status!s:>4}  {sec:>5}s  {answer[:70]!r}")
        time.sleep(cfg["pause_s"])
    out.close()
    print("Saved", a.out, "- give it to the judge to fill the 'rating' column.")


if __name__ == "__main__":
    main()
