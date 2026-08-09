const fs = require("fs");
const path = require("path");

const dir = __dirname;
const env = {};

function loadEnvFile() {
  const file = path.join(dir, ".env");
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function main() {
  loadEnvFile();
  const keys = ["KEY_CALORIES", "KEY_FRIDGE", "KEY_GENERAL", "KEY_RECIPES"];
  const missing = keys.filter(function (k) {
    env[k] = process.env[k] || env[k] || "";
    return !env[k];
  });
  if (missing.length) {
    console.log(
      "WARNING: No values set for " + missing.join(", ") +
      ". config.js will be keyless (API_BASE-only mode). " +
      "Provide keys in RecipeVerse/.env or as environment variables if you want direct AI mode."
    );
  }
  const tpl = fs.readFileSync(path.join(dir, "config.template.js"), "utf8");
  let out = tpl;
  keys.forEach(function (k) {
    out = out.split("%%" + k + "%%").join(env[k]);
  });
  fs.writeFileSync(path.join(dir, "config.js"), out, "utf8");
  console.log("Generated config.js");
}

main();