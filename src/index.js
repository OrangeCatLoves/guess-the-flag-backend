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

// Dynamic CORS for all REST endpoints
const cors = require('cors');
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map(u => u.trim());

app.use(cors({
  origin: (incomingOrigin, callback) => {
    if (!incomingOrigin) return callback(null, true);           // e.g. mobile apps, CLI
    if (allowedOrigins.includes(incomingOrigin)) 
      return callback(null, incomingOrigin);                    // reflect single origin
    callback(new Error('Not allowed by CORS'), false);
  },
  methods: ['GET','POST'],
  credentials: true
}));
app.use('/assets', express.static('assets'));  // now after app is defined
app.use('/auth', auth);  // mount auth routes
app.use('/api', api);

bot.login(process.env.DISCORD_TOKEN);
