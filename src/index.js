// index.js
require('dotenv').config();
const express = require('express');
const bot = require('./bot');
const api = require('./api');
const auth = require('./auth');
const http = require('http');
const { initSocket } = require('./socket');

const app = express();
const port = process.env.PORT || 3000;

const server = http.createServer(app);
initSocket(server);  // initialize socket.io with the server
server.listen(port, () => {
  console.log(`✅ API + Socket.IO server listening at http://localhost:${port}`);
});

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

bot.login(process.env.DISCORD_TOKEN);
