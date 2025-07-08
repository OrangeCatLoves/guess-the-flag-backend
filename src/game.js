// game.js
const fs = require('fs');
const path = require('path');

// Example: preload all flags
const flagsDir = path.join(__dirname, '../assets/flags');
const flags = fs.readdirSync(flagsDir).map(f => ({
  code: path.basename(f, path.extname(f)),        // "afghanistan"
  imagePath: `/assets/flags/${f}`,                 // for your static server
  hints: JSON.parse(
    fs.readFileSync(path.join(__dirname, '../assets/hints.json'), 'utf8')
  )[path.basename(f, path.extname(f))] || []
}));

function getRandomFlag() {
  return flags[Math.floor(Math.random() * flags.length)];
}

module.exports = { getRandomFlag, flags };
