require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test DB connection
pool.connect()
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch(err => console.error('❌ DB connection error:', err));

// Discord bot
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

bot.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${bot.user.tag}`);
});

bot.login(process.env.DISCORD_TOKEN);

// Example API route
app.get('/', (req, res) => {
  res.send('Hello from backend API + Discord bot!');
});

app.listen(port, () => {
  console.log(`✅ API server listening at http://localhost:${port}`);
});
