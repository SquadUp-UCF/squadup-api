require("dotenv").config(); // require env file
console.log("URI loaded:", !!process.env.MONGO_URI); // should print true
const express = require("express"); // server that seperately talks to db
const connectDB = require("./db"); 

const app = express();
app.use(express.json()); // start server
connectDB(); // connect to the db

app.use("/api/auth", require("./routes/auth")); // authentication

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server on :${PORT}`)); // listening on port 5000