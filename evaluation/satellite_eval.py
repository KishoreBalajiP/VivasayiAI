"""Run Vivasayi AI's NDVI rule on field-verified points and compute paper-style metrics.

The rule is copied from the backend, not re-invented:
  windows      services/satelliteVerification.service.js buildClaimWindows + config/verificationPolicy.js
               pre  = [event - 40 d 00:00Z, event - 5 d 00:00Z]
               post = [event + 1 d 00:00Z, event + 20 d 00:00Z]  (the backend also caps post at "today")
  scene filter tile cloud cover <= 90 %  (SATELLITE_PROCESSING_SCENE_CLOUD_MAX default 0.9, provider.js)
  pixel mask   SCL classes 0, 1, 3, 8, 9, 10 are invalid; water (6) and snow (11) are KEPT
               (services/satellite/ndviStatistics.js INVALID_SCL_CLASSES); B08 + B04 == 0 is invalid
  window value per-pixel NDVI averaged over the valid pixels of EVERY scene in the window
               (weighted by valid pixels), and valid fraction = valid pixels / all pixels of all scenes
               (parseNdviStatisticalResponse)
  decision     delta = round(after - before, 4); valid fraction < 0.6 in either window -> INCONCLUSIVE;
               delta <= -0.15 -> SUPPORTS_LOSS ("damaged"), else NO_CHANGE ("not_damaged")
               (interpretNdviChange)
Known unavoidable difference: the backend computes over the CLAIM POLYGON through the Copernicus
Sentinel Hub Statistical API; fields.csv has points only, so this script uses a 50 m x 50 m box around
the point and reads Sentinel-2 L2A from Microsoft Planetary Computer.
"""
import argparse, datetime as dt
import numpy as np, pandas as pd, rasterio, planetary_computer, pystac_client
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds
from sklearn.metrics import confusion_matrix, accuracy_score, precision_score, recall_score, f1_score, cohen_kappa_score

NDVI_DROP_SUPPORT, MIN_VALID_FRACTION = 0.15, 0.60
PRE_WINDOW_DAYS, POST_WINDOW_DAYS = (40, 5), (1, 20)
INVALID_SCL = {0, 1, 3, 8, 9, 10}
SCENE_CLOUD_MAX = 90
HALF = 25  # metres -> 50 m x 50 m box

cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                modifier=planetary_computer.sign_inplace)


def boa_offset(item):
    # Processing baseline 04.00+ (from 25 Jan 2022) stores reflectance with a +1000 DN offset.
    # Sentinel Hub (used by the backend) removes it by default, so it must be removed here as well.
    try:
        return 1000.0 if float(item.properties.get("s2:processing_baseline", "0")) >= 4.0 else 0.0
    except ValueError:
        return 0.0


def window_ndvi(lat, lon, start, end):
    d = HALF / 111320.0; e = HALF / (111320.0 * np.cos(np.radians(lat)))
    bbox = [lon - e, lat - d, lon + e, lat + d]
    items = cat.search(collections=["sentinel-2-l2a"], bbox=bbox,
                       datetime=f"{start.isoformat()}T00:00:00Z/{end.isoformat()}T00:00:00Z",
                       query={"eo:cloud_cover": {"lte": SCENE_CLOUD_MAX}}).item_collection()
    ndvi_sum, valid, total, dates = 0.0, 0, 0, []
    for it in items:
        try:
            with rasterio.open(it.assets["B04"].href) as src:
                bb = transform_bounds("EPSG:4326", src.crs, *bbox)
                win = from_bounds(*bb, src.transform)
                shape = (max(1, round(win.height)), max(1, round(win.width)))
                red = src.read(1, window=win, boundless=True, out_shape=shape).astype(float)
            with rasterio.open(it.assets["B08"].href) as src:
                nir = src.read(1, window=from_bounds(*bb, src.transform), boundless=True, out_shape=shape).astype(float)
            with rasterio.open(it.assets["SCL"].href) as src:  # 20 m, read onto the 10 m grid
                scl = src.read(1, window=from_bounds(*bb, src.transform), boundless=True, out_shape=shape)
            off = boa_offset(it)
            red, nir = np.clip(red - off, 0, None), np.clip(nir - off, 0, None)
            denom = nir + red
            ok = ~np.isin(scl, list(INVALID_SCL)) & (denom != 0)
            total += ok.size; valid += int(ok.sum())
            if ok.any():
                ndvi_sum += float(((nir - red)[ok] / denom[ok]).sum())
            dates.append(it.datetime.date().isoformat())
        except Exception as ex:
            print("   skip scene:", ex)
    if total == 0:
        return None
    return (valid / total, ndvi_sum / valid if valid else np.nan, ";".join(sorted(dates)))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--fields", default="fields.csv")
    ap.add_argument("--out", default="satellite_results.csv"); a = ap.parse_args()
    f = pd.read_csv(a.fields); res = []
    for _, r in f.iterrows():
        ev = dt.date.fromisoformat(str(r.event_date))
        b = window_ndvi(r.lat, r.lon, ev - dt.timedelta(PRE_WINDOW_DAYS[0]), ev - dt.timedelta(PRE_WINDOW_DAYS[1]))
        af = window_ndvi(r.lat, r.lon, ev + dt.timedelta(POST_WINDOW_DAYS[0]), ev + dt.timedelta(POST_WINDOW_DAYS[1]))
        if not b or not af or np.isnan(b[1]) or np.isnan(af[1]) or b[0] < MIN_VALID_FRACTION or af[0] < MIN_VALID_FRACTION:
            pred, delta = "inconclusive", np.nan
        else:
            delta = round(af[1] - b[1], 4)
            pred = "damaged" if delta <= -NDVI_DROP_SUPPORT else "not_damaged"
        res.append(dict(field_id=r.field_id, label=r.label, prediction=pred,
                        ndvi_before=b[1] if b else np.nan, ndvi_after=af[1] if af else np.nan,
                        delta_ndvi=delta, scenes_before=b[2] if b else "", scenes_after=af[2] if af else "",
                        valid_before=b[0] if b else 0, valid_after=af[0] if af else 0))
        print(f"{r.field_id}: label={r.label:<12} pred={pred:<13} delta={delta:.4f}" if pred != "inconclusive" else f"{r.field_id}: inconclusive")
    out = pd.DataFrame(res); out.to_csv(a.out, index=False)
    dec = out[out.prediction != "inconclusive"]
    summary = [f"Fields: {len(out)}  decided: {len(dec)}  inconclusive: {len(out)-len(dec)} ({(len(out)-len(dec))/len(out)*100:.1f}%)"]
    if len(dec) >= 2:
        y, p = dec.label, dec.prediction; L = ["damaged", "not_damaged"]
        cm = confusion_matrix(y, p, labels=L)
        summary += ["Confusion matrix (rows = ground truth, cols = predicted)",
                    str(pd.DataFrame(cm, index=["true damaged", "true not_damaged"], columns=["pred damaged", "pred not_damaged"])),
                    f"Overall accuracy : {accuracy_score(y, p)*100:.2f}%",
                    f"Precision        : {precision_score(y, p, pos_label='damaged', zero_division=0):.3f}",
                    f"Recall           : {recall_score(y, p, pos_label='damaged', zero_division=0):.3f}",
                    f"F1 score         : {f1_score(y, p, pos_label='damaged', zero_division=0):.3f}",
                    f"Cohen's kappa    : {cohen_kappa_score(y, p):.3f}"]
    text = "\n".join(summary)
    print("\n" + text)
    open(a.out.replace(".csv", "_summary.txt"), "w", encoding="utf-8").write(text + "\n")


if __name__ == "__main__":
    main()
