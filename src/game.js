// --- backend/game.js ---
const fs   = require('fs');
const path = require('path');

// preload hints and answers
const hintsJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/hints.json'), 'utf8')
);
const answersJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/answers.json'), 'utf8')
);

const flagsDir = path.join(__dirname, '../assets/flags');
const flags = fs.readdirSync(flagsDir).map(f => {
  const code = path.basename(f, path.extname(f));
  const rawHints = hintsJson[code] || [];
  return {
    code,
    imagePath: `/assets/flags/${f}`,
    hints: rawHints,
    answers: (answersJson[code] || []).map(a => a.trim())
  };
});

// add a map for quick by-code lookup
const flagsByCode = new Map(flags.map(f => [f.code, f]));

function getRandomFlag() {
  return flags[Math.floor(Math.random() * flags.length)];
}

module.exports = { getRandomFlag, flags, flagsByCode };