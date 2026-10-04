import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import User from "../models/User.js";

const adminEmail = process.argv[2]?.trim().toLowerCase();

if (!adminEmail) {
  console.error("Usage: npm run seed:admin -- admin@example.com");
  process.exit(1);
}

await connectDB();

const user = await User.findOne({ email: adminEmail });

if (!user) {
  console.error(
    `No Vivasayi user found for ${adminEmail}. Log in with this Google account first, then run the command again.`
  );
  await mongoose.disconnect();
  process.exit(1);
}

user.role = "admin";
user.status = "active";
await user.save();

console.log(`Admin role assigned successfully to ${user.email}`);
console.log(`User ID: ${user._id}`);

await mongoose.disconnect();
process.exit(0);
