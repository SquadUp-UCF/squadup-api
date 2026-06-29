const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User"); // mongoose MODEL

// ///////////////  REGISTER \\\\\\\\\\\\\\\\\
router.post("/register", async (req, res) => {
  try {
    const {first_name, last_name, email, password } = req.body; // this is the body that is received
    if (await User.findOne({ email })) return res.status(400).json({ msg: "user already exists" }); // already registered

    const hashed = await bcrypt.hash(password, 10); // hashes the password
    const new_user = await User.create({ first_name, last_name, email, password: hashed }); // create user
    const name = `${new_user.first_name} ${new_user.last_name}`; // name
    
    
    const token = jwt.sign({ id: new_user._id }, process.env.JWT_SECRET, { expiresIn: "1d" }); // create a new token for that user
    res.status(201).json({ token, user: { id: new_user._id, name: name } }); // add that new user to the db
  } catch (err) {
    res.status(500).json({ msg: "Server error" }); // if we could not connect to db
  }
});

// //////////////// LOGIN \\\\\\\\\\\\\\\\\\
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body; // info that was just input
    const found_user = await User.findOne({ email });
    if (!found_user) return res.status(400).json({ msg: "Invalid credentials" }); // check if email exists in db

    const match = await bcrypt.compare(password, found_user.password);
    if (!match) return res.status(400).json({ msg: "Invalid credentials" }); // compare hashed passwords

    const name = `${found_user.first_name} ${found_user.last_name}`; // name


    const token = jwt.sign({ id: found_user._id }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ token, user: { id: found_user._id, name: name } }); // this is your token that the user has logged in
  } catch (err) {
    res.status(500).json({ msg: "Server error" }); // could not connect to db
  }
});

module.exports = router;