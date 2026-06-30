const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: {
        type: String,
        enum: ["joined", "confirmed", "cancelled"],
        default: "joined"
    },
    joined_at: { type: Date, default: Date.now },
    
}, {_id: false});

const gameSchema = new mongoose.Schema({
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sport: { type: String, required: true },
    description: { type: String },
    location: { type: String, required: true },
    start_time: { type: Date, required: true},
    latitude: {type: Number, required: true },
    longitude: {type: Number, required: true },
    min_players: {type: Number, required: true }, // hit this -> confirmed
    max_players: {type: Number, required: true }, // hit this -> locked
    status: {
        type: String,
        enum: ["open", "confirmed", "locked", "completed", "cancelled"],
        default: "open"
    },
    participants: {type: [participantSchema], default: []}, // roster
    photo_url: {type: String},
}, {timestamps: true});

module.exports = mongoose.model("Game", gameSchema);