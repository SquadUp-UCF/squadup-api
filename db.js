const mongoose = require("mongoose");

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI); // read the env file and if correct we've connected
    console.log("MongoDB connected");
  } catch (err) {
    console.error("DB connection error:", err); // otherwise error
    process.exit(1);
  }
}
module.exports = connectDB;