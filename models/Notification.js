const mongoose = require("mongoose");

const notifSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, required: true },
  game: { type: mongoose.Schema.Types.ObjectId, ref: "Game" },
  user_trigger: {type: mongoose.Schema.Types.ObjectId, ref: "User"},
  read: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model("Notification", notifSchema); // exports as model