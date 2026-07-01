const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Resend } = require("resend");
const User = require("../models/User");
const VerificationCode = require("../models/EmailVerificationCode");

const resend = new Resend(process.env.RESEND_API_KEY);

const sendCodeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1,
  keyGenerator: (req) => req.body.email?.toLowerCase(),
  message: { error: "Please wait before requesting another code." }
});

// /////////////// REGISTER \\\\\\\\\\\\\\\\\
router.post("/register", async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ msg: "user already exists" });
    const hashed = await bcrypt.hash(password, 10);
    const new_user = await User.create({ first_name, last_name, email, password: hashed });
    const name = `${new_user.first_name} ${new_user.last_name}`;
    const token = jwt.sign({ id: new_user._id }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.status(201).json({ token, user: { id: new_user._id, name: name } });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// //////////////// LOGIN \\\\\\\\\\\\\\\\\\
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const found_user = await User.findOne({ email });
    if (!found_user) return res.status(400).json({ msg: "Invalid credentials" });
    const match = await bcrypt.compare(password, found_user.password);
    if (!match) return res.status(400).json({ msg: "Invalid credentials" });
    const name = `${found_user.first_name} ${found_user.last_name}`;
    const token = jwt.sign({ id: found_user._id }, process.env.JWT_SECRET, { expiresIn: "1d" });
    res.json({ token, user: { id: found_user._id, name: name } });
  } catch (err) {
    res.status(500).json({ msg: "Server error" });
  }
});

// /////////////// SEND CODE \\\\\\\\\\\\\\\\\
router.post("/send-code", sendCodeLimiter, async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    if (!email || !email.endsWith("@ucf.edu")) {
      return res.status(400).json({ error: "Must use a valid @ucf.edu email." });
    }
    await VerificationCode.updateMany({ email, used: false }, { used: true });
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await VerificationCode.create({ email, code, expiresAt });
    await resend.emails.send({
      from: "Squad Up <onboarding@resend.dev>",
      to: email,
      subject: "Your Verification Code",
      html: "<p>Your verification code is: <strong>" + code + "</strong></p><p>Expires in 10 minutes.</p>"
    });
    return res.status(200).json({ message: "Verification code sent." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

// /////////////// VERIFY CODE \\\\\\\\\\\\\\\\\
router.post("/verify-code", async (req, res) => {
  try {
    const email = req.body.email?.toLowerCase().trim();
    const code = req.body.code?.trim();
    if (!email || !code) {
      return res.status(400).json({ error: "Email and code are required." });
    }
    const record = await VerificationCode.findOne({
      email,
      code,
      used: false,
      expiresAt: { $gt: new Date() }
    });
    if (!record) {
      return res.status(400).json({ error: "Invalid or expired code." });
    }
    record.used = true;
    await record.save();
    return res.status(200).json({ message: "Email verified successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong." });
  }
});

module.exports = router;