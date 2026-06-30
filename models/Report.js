const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema({
  reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  reported: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  game: { type: mongoose.Schema.Types.ObjectId, ref: "Game" },
  reason: { type: String, required: true },
  details: {type: String },
  status: { type: String, enum: ["pending", "reviewed"], default: "pending" },
}, { timestamps: true });

module.exports = mongoose.model("Report", reportSchema); // exports as model