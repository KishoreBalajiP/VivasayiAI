import fs from "fs";

async function makeLog(message, filecat, filename) {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // IST offset in milliseconds
  const istTime = new Date(now.getTime() + istOffset)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  const line = `${istTime} - ${filecat}: ${message}\n`;

  fs.appendFile(filename, line, (err) => {
    if (err) throw err;
  });
}

export { makeLog };