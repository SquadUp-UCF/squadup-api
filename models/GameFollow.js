const mongoose = require("mongoose");

const gameFollowSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  game: { type: mongoose.Schema.Types.ObjectId, ref: "Game", required: true }
}, { timestamps: true });

followSchema.index({ user: 1, game: 1 }, { unique: true });

module.exports = mongoose.model("GameFollow", gameFollowSchema); // exports as model