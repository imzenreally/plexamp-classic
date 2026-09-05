const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "node_modules", "webamp", "built");
const destination = path.join(root, "vendor");
const files = [
  "webamp.bundle.min.js",
  "webamp.butterchurn-bundle.min.mjs",
];

fs.mkdirSync(destination, { recursive: true });
for (const file of files) {
  const from = path.join(source, file);
  const to = path.join(destination, file);
  if (!fs.existsSync(from)) {
    throw new Error(`Missing ${from}; install webamp@2.3.1 first.`);
  }
  fs.copyFileSync(from, to);
  console.log(`Prepared vendor/${file}`);
}
