const mongoose = require("mongoose");

const emailCodeSchema = new mongoose.Schema({
  email: { type: String, required: true },
  code: { type: String, required: true },
  used: { type: Boolean , default: false},
  expires_at: { type: Date , required: true },
  
}, { timestamps: true });

emailCodeSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("EmailVerificationCode", emailCodeSchema); // exports as model