import app from "./app.js";
import { connectDB } from "./config/db.js";
import { validateEnv, SERVER_REQUIRED } from "./config/env.js";
import serverless from "serverless-http";

validateEnv(SERVER_REQUIRED);

// MongoDB connection
await connectDB();

// Local server
// const PORT = process.env.PORT || 8000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Lambda server
export const handler = serverless(app);