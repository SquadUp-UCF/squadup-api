const mongoose = require("mongoose");

const ratingSchema = new mongoose.Schema({
  game: { type: mongoose.Schema.Types.ObjectId, ref: "Game", required: true },
  rater: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  ratee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  sport: { type: String, required: true},
  overall: { type: Number, required: true, min: 1, max: 6},
  comment: { type: String },

}, { timestamps: true });

ratingSchema.index({ game: 1, rater: 1, ratee: 1 }, { unique: true });

module.exports = mongoose.model("Rating", ratingSchema); // exports as model