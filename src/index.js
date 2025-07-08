// index.js
require('dotenv').config();
const express = require('express');
const bot = require('./bot');
const api = require('./api');
const auth = require('./auth');

const app = express();
const port = process.env.PORT || 3000;

// middleware
app.use(express.json());
const cors = require('cors');
app.use(
  cors({
    origin: process.env.FRONTEND_URL,  // e.g. http://localhost:5173
    methods: ['GET','POST']
  })
);
app.use('/assets', express.static('assets'));  // now after app is defined
app.use('/auth', auth);  // mount auth routes
app.use('/api', api);

app.listen(port, () => {
  console.log(`✅ API server listening at http://localhost:${port}`);
});

bot.login(process.env.DISCORD_TOKEN);
