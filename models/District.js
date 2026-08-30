import mongoose from "mongoose";

// Tamil Nadu district reference data (E2-S2, ADR-014, 07_Database_Design §5/§8).
// Server-side single source of truth: district -> lat/lon/region + reserved soil/crops
// (context engine domain 5). `name` is the unique natural key that weather/context
// resolvers will use for lookups. `soilType`/`crops` are seeded as empty and backfilled
// in a later story from the TNAU district soil table + published crop lists (D-19) —
// never fabricated (APP-06).
const districtSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, index: true, trim: true },
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    regionType: { type: String, required: true },
    soilType: { type: String, default: undefined },
    crops: { type: [String], default: undefined },
  },
  { timestamps: true }
);

export default mongoose.model("District", districtSchema);
