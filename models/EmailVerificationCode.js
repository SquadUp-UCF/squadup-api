const mongoose = require('mongoose');
const { Schema } = mongoose;

const verificationCodeSchema = new Schema({
  email: { type: String, required: true, lowercase: true },
  code: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false }
}, { timestamps: true });

verificationCodeSchema.index({ email: 1, used: 1, expiresAt: 1 });
verificationCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('VerificationCode', verificationCodeSchema);