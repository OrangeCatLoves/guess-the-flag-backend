// src/bot.js
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
} = require('discord.js');
const db = require('./db');
const { getRandomFlag } = require('./game');
const { v4: uuidv4 } = require('uuid');

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

bot.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${bot.user.tag}`);
});

bot.on(Events.MessageCreate, async (message) => {
  // ignore bots, DMs, etc.
  if (message.author.bot || !message.guild) return;

  if (message.content.toLowerCase() === 'play now') {
    // 1️⃣ pick a random flag & create a session
    const { code } = getRandomFlag();
    const sessionId = uuidv4();

    // ensure the player exists
    await db.query(
      `
      INSERT INTO players (discord_id, name)
      VALUES ($1, $2)
      ON CONFLICT (discord_id) DO NOTHING
      `,
      [message.author.id, message.author.username]
    );

    // save the session
    await db.query(
      `
      INSERT INTO sessions (id, player_id, flag_code)
      VALUES (
        $1,
        (SELECT id FROM players WHERE discord_id = $2),
        $3
      )
      `,
      [sessionId, message.author.id, code]
    );

    // 2️⃣ build your frontend URL
    const gameUrl = `${process.env.FRONTEND_URL}/play?sessionId=${sessionId}`;

    // 3️⃣ send a Link‐style button that opens the browser immediately
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Play Now')
        .setStyle(ButtonStyle.Link)
        .setURL(gameUrl)
    );

    await message.channel.send({
      content: '🎮 Ready to guess that flag? Click below to start!',
      components: [row],
    });
  }
});

module.exports = bot;
