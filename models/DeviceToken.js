const mongoose = require("mongoose");

const deviceTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  token: { type: String, required: true },
  platform: { type: String, enum: ["ios", "android"] },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model("DeviceToken", deviceTokenSchema);