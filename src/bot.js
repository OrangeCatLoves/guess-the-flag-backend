// src/bot.js
require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
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

//
// 1) Register slash commands globally (takes ~1h to propagate) or per-guild (instant).
//
const commands = [
  new SlashCommandBuilder()
    .setName('gtf-link')
    .setDescription('🔗 Get a link to connect your Discord account with your GuessTheFlag web account'),

  new SlashCommandBuilder()
    .setName('gtf-set-channel')
    .setDescription('📣 (Admin) Set this channel for GTF announcements')
    .addChannelOption(opt =>
      opt.setName('channel')
         .setDescription('Which channel to post in')
         .setRequired(true)
    )
    // restrict to users with Manage Guild
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');
    // for global:
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    // if you prefer per-guild for faster iteration, do:
    // await rest.put(
    //   Routes.applicationGuildCommands(
    //     process.env.DISCORD_CLIENT_ID,
    //     process.env.DISCORD_GUILD_ID
    //   ),
    //   { body: commands }
    // );
    console.log('✅ Slash commands registered.');
  } catch (err) {
    console.error('❌ Failed to register slash commands', err);
  }
})();

bot.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${bot.user.tag}`);
});

//
// 2) Handle slash‐commands
//
bot.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ─────── /gtf-link ───────
  if (commandName === 'gtf-link') {
    // state=discordId so your web callback can tie them together
    const link = `${process.env.FRONTEND_URL}/auth/discord?state=${interaction.user.id}`;
    await interaction.reply({
      content: `🔗 Click the link below to connect your accounts:\n${link}`,
      ephemeral: true
    });
    return;
  }

  // ─────── /gtf-set-channel ───────
  if (commandName === 'gtf-set-channel') {
    // must have MANAGE_GUILD (enforced by setDefaultMemberPermissions)
    const channel = interaction.options.getChannel('channel');
    const guildId = interaction.guild.id;

    try {
      // Assumes you have a `guild_settings` table: (guild_id PK, announce_channel_id)
      await db.query(
        `INSERT INTO guild_settings (guild_id, announce_channel_id)
           VALUES ($1, $2)
         ON CONFLICT (guild_id)
           DO UPDATE SET announce_channel_id = EXCLUDED.announce_channel_id`,
        [guildId, channel.id]
      );

      await interaction.reply({
        content: `✅ Announcements channel set to ${channel}.`,
        ephemeral: true
      });
    } catch (err) {
      console.error('Error saving guild_settings', err);
      await interaction.reply({
        content: '❌ Could not save that channel. Please try again later.',
        ephemeral: true
      });
    }
    return;
  }
});

//
// 3) Keep your old “play now” keyword handler intact
//
bot.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (message.content.toLowerCase() !== 'play now') return;

  // 3.1 ensure the player row exists (now using unified table `users`)
  await db.query(
    `INSERT INTO users (discord_id, display_name)
       VALUES ($1, $2)
     ON CONFLICT (discord_id) DO NOTHING`,
    [message.author.id, message.author.username]
  );

  // 3.2 create a new guessing session
  const { code } = getRandomFlag();
  const sessionId = uuidv4();
  await db.query(
    `INSERT INTO sessions (id, user_id, flag_code)
       VALUES (
         $1,
         (SELECT id FROM users WHERE discord_id = $2),
         $3
       )`,
    [sessionId, message.author.id, code]
  );

  // 3.3 build and send the button
  const gameUrl = `${process.env.FRONTEND_URL}/play?mode=solo&session=${sessionId}`;
  await message.channel.send({
    content: '🎮 Ready to guess that flag? Click below to start!',
    components: [{
      type: 1,
      components: [{
        type: 2,
        style: 5,                  // Link button
        label: 'Play Now',
        url: gameUrl,
      }]
    }]
  });
});

module.exports = bot;
