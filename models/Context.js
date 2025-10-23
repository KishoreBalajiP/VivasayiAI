import mongoose from "mongoose";

const contextSchema = new mongoose.Schema({
  districtName: { type: String, required: true, unique: true },
  soilType: { type: String },
  crops: [{ type: String }], // major crops
  fertilizerRecommendations: [{ type: String }],
  lat: { type: Number },      // latitude for GPS matching
  lon: { type: Number },      // longitude for GPS matching
  season: { type: String },   // e.g., "Kharif", "Rabi", "Summer"
  month: [{ type: String }],  // e.g., ["Jan", "Feb"] for month-specific advice
}, { timestamps: true });

export default mongoose.model("Context", contextSchema);
