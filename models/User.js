const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  first_name: { type: String, required: true },
  last_name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  username: { type: String },
  reputation: { type: Number , default: 0 },
  games_joined: [{ type: mongoose.Schema.Types.ObjectId, ref: "Game" }],  // past games a part of array
  games_created: [{ type: mongoose.Schema.Types.ObjectId, ref: "Game" }], // array of game sessions created
  account_status: { type: Boolean, default: false }, // verified
  sports: [{
    sport: String,
    self_ratings: {
      offensive: Number, defensive: Number, strategic: Number,
      athletic: Number, technical: Number, mental: Number
    },
    earned: {
      offensive: { sum: Number, count: Number },
      defensive: { sum: Number, count: Number },
      strategic: { sum: Number, count: Number },
      athletic:  { sum: Number, count: Number },
      technical: { sum: Number, count: Number },
      mental:    { sum: Number, count: Number }
    },
    overall_earned: { sum: Number, count: Number },
    overall: { type: Number, default: 0 }
  }]

}, { timestamps: true });

module.exports = mongoose.model("User", userSchema); // exports as model