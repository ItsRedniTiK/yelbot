require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType
} = require('discord.js');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const fetch = require('node-fetch');

// PREFIX: default is '.' now
const PREFIX = process.env.PREFIX || '.';
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('No TOKEN found in .env');
  process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
const assetsDir = path.join(__dirname, 'assets');
const dbPath = path.join(dataDir, 'db.json');

// image for .quote / .q
const QUOTE_IMAGE_URL = 'https://i.postimg.cc/9ft8X6V7/reaction-tiktok-comment-reaction-pic.jpg';

async function ensureDirs() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(assetsDir, { recursive: true });
}

let db = {};
async function loadDB() {
  try {
    const raw = await fs.readFile(dbPath, 'utf8');
    db = JSON.parse(raw || '{}');
  } catch (e) {
    db = {};
    await saveDB();
  }
}
async function saveDB() {
  await fs.writeFile(dbPath, JSON.stringify(db, null, 2), 'utf8');
}

function getGuildConfig(gid) {
  if (!db[gid]) {
    db[gid] = {
      welcomeChannelId: null,
      welcomeMessage: 'Welcome to {server}, {user} — make yourself at home!',
      welcomeImagePath: path.join(assetsDir, 'welcome.png'),
      rulesChannelId: null,
      rulesMessage: '1) Be respectful\n2) No spam or hate\n3) Have fun and make friends',
      announceChannelId: null,
      autoRoleId: null,
      customRoleId: null,
      customBioString: '.gg/ifeelredd',
      spotifyArtistId: null,
      socialLinks: {
        twitter: '',
        instagram: '',
        youtube: '',
        spotify: '',
        tiktok: ''
      },
      lastSpotifyRelease: null,
      roleAnnounceChannelId: null,
      reactionRoles: {},
      lastBioCheck: {},

      // XP system
      xp: {},
      xpBoost: 1,
      wallOfFameChannelId: null,
      _lastXp: {},

      // level rewards
      levelRoles: {},

      // join to create
      jtcChannelId: null
    };
    saveDB();
  }
  return db[gid];
}

// XP helpers
function getRequiredXPForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

async function addXP(guildId, userId, amount) {
  const cfg = getGuildConfig(guildId);
  if (!cfg.xp[userId]) {
    cfg.xp[userId] = { xp: 0, level: 0 };
  }

  amount = Math.floor(amount * (cfg.xpBoost || 1));
  cfg.xp[userId].xp += amount;
  let leveledUp = false;

  while (cfg.xp[userId].xp >= getRequiredXPForLevel(cfg.xp[userId].level)) {
    cfg.xp[userId].xp -= getRequiredXPForLevel(cfg.xp[userId].level);
    cfg.xp[userId].level += 1;
    leveledUp = true;
  }

  await saveDB();
  return { leveledUp, level: cfg.xp[userId].level };
}

// ONLY show real discord IDs + users with some XP
function getLeaderboard(guildId, limit = 10) {
  const cfg = getGuildConfig(guildId);

  const entries = Object.entries(cfg.xp || {})
    .filter(([userId]) => /^\d{10,}$/.test(userId))
    .map(([userId, data]) => ({
      userId,
      level: data.level || 0,
      xp: data.xp || 0
    }))
    .filter(e => e.level > 0 || e.xp > 0);

  entries.sort((a, b) => {
    if (b.level === a.level) return b.xp - a.xp;
    return b.level - a.level;
  });

  return entries.slice(0, limit);
}

// Spotify
let spotifyToken = null;
let lastTokenTime = 0;
const spotifyEnvOk = !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

async function getSpotifyToken() {
  if (!spotifyEnvOk) return null;

  if (spotifyToken && Date.now() - lastTokenTime < 3600000) {
    return spotifyToken;
  }
  try {
    const auth = Buffer.from(
      `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
    ).toString('base64');

    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    if (!data.access_token) {
      console.error('Error getting Spotify token response:', data);
      return null;
    }
    spotifyToken = data.access_token;
    lastTokenTime = Date.now();
    return spotifyToken;
  } catch (err) {
    console.error('Error getting Spotify token:', err);
    return null;
  }
}

async function checkSpotify(guild, cfg) {
  if (!cfg.spotifyArtistId) return;
  const token = await getSpotifyToken();
  if (!token) {
    // silently skip if no creds / token
    return;
  }
  try {
    const res = await fetch(
      `https://api.spotify.com/v1/artists/${cfg.spotifyArtistId}/albums?include_groups=album,single&market=US&limit=5`,
      {
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    if (!res.ok) {
      console.error('Spotify API error:', res.status, await res.text());
      return;
    }
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      const latest = data.items[0];
      const releaseDate = latest.release_date;
      if (!cfg.lastSpotifyRelease || new Date(releaseDate) > new Date(cfg.lastSpotifyRelease)) {
        cfg.lastSpotifyRelease = releaseDate;
        await saveDB();
        const ch = guild.channels.cache.get(cfg.announceChannelId);
        if (ch) {
          const embed = new EmbedBuilder()
            .setTitle(`New Music Drop: ${latest.name}`)
            .setDescription('Check it out!')
            .setURL(latest.external_urls.spotify)
            .setThumbnail(latest.images?.[0]?.url)
            .setColor('#1DB954')
            .setTimestamp(new Date(releaseDate));
          await ch.send({ embeds: [embed] });
        }
      }
    }
  } catch (err) {
    console.error('Error checking Spotify:', err);
  }
}

async function checkUserBio(member, cfg) {
  try {
    const userProfile = await Promise.race([
      member.user.fetch(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Profile fetch timeout')), 3000))
    ]);
    const activities = member.presence?.activities || [];
    const customStatus = activities.find(a => a.type === 4)?.state || '';
    const bio = userProfile.about_me || userProfile.bio || '';
    const bioString = cfg.customBioString || '.gg/ifeelredd';
    const hasLink = (
      bio.toLowerCase().includes(bioString.toLowerCase()) ||
      customStatus.toLowerCase().includes(bioString.toLowerCase())
    );

    const role = member.guild.roles.cache.get(cfg.customRoleId);
    if (!role) return;

    if (!cfg.lastBioCheck) cfg.lastBioCheck = {};
    const now = Date.now();

    if (hasLink && !member.roles.cache.has(cfg.customRoleId)) {
      if (!member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
      if (role.position >= member.guild.members.me.roles.highest.position) return;
      await member.roles.add(role).catch(err => console.error(`Error assigning role ${role.name} to ${member.user.tag}:`, err));
      await member.send(`✅ You got the ${role.name} role for adding ${bioString} to your bio or status!`).catch(() => {});
      const announceCh = member.guild.channels.cache.get(cfg.roleAnnounceChannelId);
      if (announceCh) {
        const embed = new EmbedBuilder()
          .setTitle('New Supporter!')
          .setDescription(`Congrats <@${member.id}> for adding ${bioString} to their bio or status and getting the ${role} role!`)
          .setColor('#00FF00')
          .setTimestamp();
        await announceCh.send({ embeds: [embed] }).catch(() => {});
      }
      cfg.lastBioCheck[member.id] = now;
      await saveDB();
    } else if (!hasLink && member.roles.cache.has(cfg.customRoleId)) {
      if (!member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;
      if (role.position >= member.guild.members.me.roles.highest.position) return;
      await member.roles.remove(role).catch(err => console.error(`Error removing role ${role.name} from ${member.user.tag}:`, err));
      await member.send(`❌ Removed ${role.name} role—no ${bioString} in your bio or status.`).catch(() => {});
      cfg.lastBioCheck[member.id] = now;
      await saveDB();
    }
  } catch (err) {
    if (err.message === 'Profile fetch timeout') {
      // ignore spammy timeout logs
      return;
    }
    console.error(`Error in checkUserBio for ${member.user.tag}:`, err);
  }
}

const commandAliases = {
  'h': 'help',
  'swc': 'setwelcomechannel',
  'swm': 'setwelcomemsg',
  'swi': 'setwelcomeimage',
  'src': 'setruleschannel',
  'srm': 'setrulesmsg',
  'sac': 'setannouncechannel',
  'ann': 'announce',
  'cfg': 'config',
  'tw': 'testwelcome',
  'sar': 'setautorole',
  'scr': 'setcustomrole',
  'sbs': 'setbiostring',
  'gr': 'giverole',
  'cr': 'createrole',
  'ssp': 'setspotify',
  'ss': 'setsocial',
  'sos': 'socials',
  'srac': 'setroleannouncechannel',
  'cb': 'checkbio',
  'rr': 'reactionrole',
  'fb': 'forcebio',
  'rdb': 'resetdb',
  'pr': 'postrules',
  'rxp': 'resetxp', // reset XP alias
  'pvp': 'postvoicepanel'
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates
  ],
});

// temp VCs from JTC
const tempVoiceChannels = {}; // { channelId: { ownerId, guildId } }

const commands = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show bot commands'),
  new SlashCommandBuilder()
    .setName('checkbio')
    .setDescription('Check a user\'s bio/status for the custom string')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to check')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
  new SlashCommandBuilder()
    .setName('forcebio')
    .setDescription('Force check bios for all members')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Show server configuration'),
  new SlashCommandBuilder()
    .setName('setcustomrole')
    .setDescription('Set custom role for the bio string')
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('Role to assign')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('setbiostring')
    .setDescription('Set custom string for bio/status check')
    .addStringOption(option =>
      option.setName('string')
        .setDescription('String to check (e.g., .gg/myserver)')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('setroleannouncechannel')
    .setDescription('Set channel for supporter announcements')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel for announcements')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('resetdb')
    .setDescription('Reset bio check cache')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Manage reaction roles')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add a reaction role')
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Channel with the message')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('message_id')
            .setDescription('Message ID')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('emoji')
            .setDescription('Emoji for the reaction')
            .setRequired(true)
        )
        .addRoleOption(option =>
          option
            .setName('role')
            .setDescription('Role to assign')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove a reaction role')
        .addStringOption(option =>
          option
            .setName('message_id')
            .setDescription('Message ID')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('emoji')
            .setDescription('Emoji to remove')
            .setRequired(true)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all reaction roles')
    )
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show XP and level')
    .addUserOption(o =>
      o.setName('user')
        .setDescription('User to check')
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show XP leaderboard'),
  new SlashCommandBuilder()
    .setName('setxpboost')
    .setDescription('Set server XP multiplier')
    .addNumberOption(o =>
      o.setName('multiplier')
        .setDescription('Example: 1, 1.5, 2')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('resetxp')
    .setDescription('Reset all XP data for this server')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('setwall')
    .setDescription('Set Wall of Fame channel')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel to post level ups')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('setlevelrole')
    .setDescription('Give a role when a user reaches a level')
    .addIntegerOption(o =>
      o.setName('level')
        .setDescription('Level number')
        .setRequired(true))
    .addRoleOption(o =>
      o.setName('role')
        .setDescription('Role to give')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
  new SlashCommandBuilder()
    .setName('removelevelrole')
    .setDescription('Remove a level reward')
    .addIntegerOption(o =>
      o.setName('level')
        .setDescription('Level to remove')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageRoles),
  new SlashCommandBuilder()
    .setName('listlevelroles')
    .setDescription('List level rewards'),
  new SlashCommandBuilder()
    .setName('postvoicepanel')
    .setDescription('Post a permanent voice panel in this channel')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName('voicepanel')
    .setDescription('Open the voice control panel for your current voice channel'),
  new SlashCommandBuilder()
    .setName('setjtc')
    .setDescription('Set the Join To Create hub voice channel')
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Voice channel to use as Join To Create')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
].map(command => command.toJSON());

// use ready event (correct)
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Clearing global slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    console.log('Cleared. Re-registering slash commands...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands registered globally!');
  } catch (err) {
    console.error('Error registering slash commands:', err);
  }

  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      const cfg = getGuildConfig(guild.id);
      if (cfg.spotifyArtistId) await checkSpotify(guild, cfg);

      if (cfg.customRoleId) {
        guild.members.cache
          .filter(m => !m.user.bot)
          .forEach(m => {
            checkUserBio(m, cfg);
          });
      }
    }
  }, 30000);
});

// SLASH COMMANDS
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, options, guild, member } = interaction;
  if (!guild) return;
  const cfg = getGuildConfig(guild.id);

  if (commandName === 'help') {
    const help = new EmbedBuilder()
      .setTitle('Bot Help')
      .setColor('#ff0000')
      .setDescription(
        `Prefix commands use ${PREFIX}
Slash commands:
help
checkbio
forcebio
config
setcustomrole
setbiostring
setroleannouncechannel
resetdb
reactionrole
rank
leaderboard
setxpboost
resetxp
setwall
setlevelrole
removelevelrole
listlevelroles
postvoicepanel
voicepanel
setjtc`
      );
    return interaction.reply({ embeds: [help] });
  }

  if (commandName === 'checkbio') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: 'You need Manage Roles permission.', ephemeral: true });
    }
    const target = options.getMember('user');
    if (!target) return interaction.reply({ content: 'Select a valid user.', ephemeral: true });
    await checkUserBio(target, cfg);
    return interaction.reply({ content: `✅ Checked bio/status for ${target.user.tag}`, ephemeral: true });
  }

  if (commandName === 'forcebio') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: 'You need Manage Roles permission.', ephemeral: true });
    }
    if (!cfg.customRoleId) return interaction.reply({ content: 'No custom role set. Use /setcustomrole.', ephemeral: true });
    await interaction.reply({ content: '🚀 Starting force bio check for all members...', ephemeral: true });

    let count = 0;
    try {
      const members = await guild.members.fetch();
      for (const m of members.values()) {
        if (!m.user.bot) {
          await checkUserBio(m, cfg);
          count++;
        }
      }
    } catch (err) {
      console.error('forcebio fetch error:', err);
    }

    return interaction.followUp({ content: `✅ Force checked ${count} members for custom string`, ephemeral: true });
  }

  if (commandName === 'config') {
    const socialPreview = Object.entries(cfg.socialLinks)
      .filter(([_, link]) => link)
      .map(([p, l]) => `${p}: ${l}`)
      .join('\n') || 'None';
    const rrCount = Object.keys(cfg.reactionRoles).length;
    const embed = new EmbedBuilder()
      .setTitle('Server Config')
      .setColor('#ff0000')
      .addFields(
        { name: 'Welcome Channel', value: cfg.welcomeChannelId ? `<#${cfg.welcomeChannelId}>` : 'Not set', inline: true },
        { name: 'Rules Channel', value: cfg.rulesChannelId ? `<#${cfg.rulesChannelId}>` : 'Not set', inline: true },
        { name: 'Announce Channel', value: cfg.announceChannelId ? `<#${cfg.announceChannelId}>` : 'Not set', inline: true },
        { name: 'Role Announce Channel', value: cfg.roleAnnounceChannelId ? `<#${cfg.roleAnnounceChannelId}>` : 'Not set', inline: true },
        { name: 'Auto Role', value: cfg.autoRoleId ? `<@&${cfg.autoRoleId}>` : 'Not set', inline: true },
        { name: 'Custom Role (Bio Check)', value: cfg.customRoleId ? `<@&${cfg.customRoleId}>` : 'Not set', inline: true },
        { name: 'Custom Bio String', value: cfg.customBioString || '.gg/ifeelredd', inline: true },
        { name: 'Reaction Roles', value: rrCount > 0 ? `${rrCount} active` : 'None', inline: true },
        { name: 'Spotify Artist ID', value: cfg.spotifyArtistId || 'Not set', inline: true },
        { name: 'Join To Create VC', value: cfg.jtcChannelId ? `<#${cfg.jtcChannelId}>` : 'Not set', inline: true },
        { name: 'Social Links', value: socialPreview.length > 1024 ? socialPreview.slice(0, 1000) + '...' : socialPreview }
      );
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setcustomrole') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    const role = options.getRole('role');
    cfg.customRoleId = role.id;
    await saveDB();
    return interaction.reply({ content: `✅ Custom role for bio string set to ${role}`, ephemeral: true });
  }

  if (commandName === 'setbiostring') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    const bioString = options.getString('string').trim();
    if (!bioString) return interaction.reply({ content: 'Provide a non-empty string.', ephemeral: true });
    cfg.customBioString = bioString;
    await saveDB();
    return interaction.reply({ content: `✅ Custom bio string set to "${bioString}"`, ephemeral: true });
  }

  if (commandName === 'setroleannouncechannel') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    const channel = options.getChannel('channel');
    cfg.roleAnnounceChannelId = channel.id;
    await saveDB();
    return interaction.reply({ content: `✅ Role announce channel set to ${channel}`, ephemeral: true });
  }

  if (commandName === 'resetdb') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    cfg.lastBioCheck = {};
    await saveDB();
    return interaction.reply({ content: '✅ Reset bio check cache.', ephemeral: true });
  }

  if (commandName === 'reactionrole') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: 'You need Manage Roles permission.', ephemeral: true });
    }
    const subcommand = options.getSubcommand();
    if (!cfg.reactionRoles) cfg.reactionRoles = {};

    if (subcommand === 'add') {
      const channel = options.getChannel('channel');
      const messageId = options.getString('message_id');
      const emoji = options.getString('emoji');
      const role = options.getRole('role');
      if (!cfg.reactionRoles[messageId]) cfg.reactionRoles[messageId] = [];
      cfg.reactionRoles[messageId].push({ emoji, roleId: role.id });
      await saveDB();
      return interaction.reply({ content: `✅ Added reaction role: ${emoji} → ${role} on message ${messageId} in ${channel}`, ephemeral: true });
    } else if (subcommand === 'remove') {
      const messageId = options.getString('message_id');
      const emoji = options.getString('emoji');
      if (!cfg.reactionRoles[messageId]) return interaction.reply({ content: 'No reaction roles found for that message.', ephemeral: true });
      const index = cfg.reactionRoles[messageId].findIndex(rr => rr.emoji === emoji);
      if (index === -1) return interaction.reply({ content: 'No matching emoji found.', ephemeral: true });
      cfg.reactionRoles[messageId].splice(index, 1);
      if (cfg.reactionRoles[messageId].length === 0) delete cfg.reactionRoles[messageId];
      await saveDB();
      return interaction.reply({ content: `✅ Removed ${emoji} from message ${messageId}`, ephemeral: true });
    } else if (subcommand === 'list') {
      if (Object.keys(cfg.reactionRoles).length === 0) return interaction.reply({ content: 'No reaction roles set.', ephemeral: true });
      const fields = Object.entries(cfg.reactionRoles).map(([msgId, rrs]) => ({
        name: `Message ${msgId}`,
        value: rrs.map(rr => `${rr.emoji} → <@&${rr.roleId}>`).join('\n'),
        inline: true
      }));
      const embed = new EmbedBuilder().setTitle('Reaction Roles').setColor('#ff0000').addFields(fields);
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }

  if (commandName === 'rank') {
    const target = options.getMember('user') || member;
    const data = (cfg.xp && cfg.xp[target.id]) ? cfg.xp[target.id] : { xp: 0, level: 0 };
    const needed = getRequiredXPForLevel(data.level);
    const embed = new EmbedBuilder()
      .setTitle(`${target.user.username}'s rank`)
      .setColor('#ff0000')
      .setDescription(`Level: **${data.level}**\nXP: **${data.xp}/${needed}**`);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'leaderboard') {
    const top = getLeaderboard(guild.id, 10);
    if (top.length === 0) {
      return interaction.reply({ content: 'No XP data yet.' });
    }
    let desc = '';
    for (let i = 0; i < top.length; i++) {
      const entry = top[i];
      const m = await guild.members.fetch(entry.userId).catch(() => null);
      if (!m) continue;
      const name = m.user.username;
      desc += `**${i + 1}. ${name}** — Level ${entry.level} (${entry.xp} XP)\n`;
    }
    if (!desc) {
      return interaction.reply({ content: 'No XP data yet.' });
    }
    const embed = new EmbedBuilder().setTitle('XP Leaderboard').setColor('#ff0000').setDescription(desc);
    return interaction.reply({ embeds: [embed] });
  }

  if (commandName === 'setxpboost') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    const mult = options.getNumber('multiplier');
    cfg.xpBoost = mult;
    await saveDB();
    return interaction.reply({ content: `✅ XP boost set to x${mult}`, ephemeral: true });
  }

  if (commandName === 'resetxp') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({
        content: 'You need Manage Server permission to reset XP.',
        ephemeral: true
      });
    }

    cfg.xp = {};
    cfg._lastXp = {};
    await saveDB();

    return interaction.reply({
      content: '✅ All XP data for this server has been reset.',
      ephemeral: true
    });
  }

  if (commandName === 'setwall') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    const channel = options.getChannel('channel');
    cfg.wallOfFameChannelId = channel.id;
    await saveDB();
    return interaction.reply({ content: `✅ Wall of Fame channel set to ${channel}`, ephemeral: true });
  }

  if (commandName === 'setlevelrole') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: 'You need Manage Roles permission.', ephemeral: true });
    }
    const lvl = options.getInteger('level');
    const role = options.getRole('role');
    if (!cfg.levelRoles) cfg.levelRoles = {};
    cfg.levelRoles[lvl] = role.id;
    await saveDB();
    return interaction.reply({ content: `✅ When someone reaches level ${lvl} they will get ${role}`, ephemeral: true });
  }

  if (commandName === 'removelevelrole') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: 'You need Manage Roles permission.', ephemeral: true });
    }
    const lvl = options.getInteger('level');
    if (!cfg.levelRoles || !cfg.levelRoles[lvl]) {
      return interaction.reply({ content: 'No role set for that level.', ephemeral: true });
    }
    delete cfg.levelRoles[lvl];
    await saveDB();
    return interaction.reply({ content: `✅ Removed level role for level ${lvl}`, ephemeral: true });
  }

  if (commandName === 'listlevelroles') {
    const entries = cfg.levelRoles ? Object.entries(cfg.levelRoles) : [];
    if (entries.length === 0) {
      return interaction.reply({ content: 'No level roles set.' });
    }
    let txt = 'Level roles:\n';
    for (const [lvl, roleId] of entries) {
      const r = guild.roles.cache.get(roleId);
      txt += `Level ${lvl} → ${r ? r.name : `role ${roleId}`}\n`;
    }
    return interaction.reply({ content: txt });
  }

  if (commandName === 'postvoicepanel') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('Voice Panel')
      .setColor('#ff0000')
      .setDescription(
        'This panel always controls the **voice channel you are currently in**.\n\n' +
        'You have to be in a voice channel to use the voice panel.\n\n' +
        '🔒 Lock / 🔓 Unlock join access\n' +
        '👻 Ghost (hide) / 🌟 Reveal the channel\n' +
        '➕ / ➖ change user limit\n' +
        '📤 Disconnect yourself from the call'
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vc_lock')
        .setEmoji('🔒')
        .setLabel('Lock')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_unlock')
        .setEmoji('🔓')
        .setLabel('Unlock')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_hide')
        .setEmoji('👻')
        .setLabel('Ghost')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_show')
        .setEmoji('🌟')
        .setLabel('Reveal')
        .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vc_limit_up')
        .setEmoji('➕')
        .setLabel('Limit +1')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_limit_down')
        .setEmoji('➖')
        .setLabel('Limit -1')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_disconnect')
        .setEmoji('📤')
        .setLabel('Disconnect me')
        .setStyle(ButtonStyle.Danger)
    );

    return interaction.reply({
      content: '🎚️ Voice Panel Setup',
      embeds: [embed],
      components: [row1, row2]
    });
  }

  if (commandName === 'voicepanel') {
    const me = await guild.members.fetch(member.id);
    const vc = me.voice?.channel;
    if (!vc) {
      return interaction.reply({
        content: 'You have to be in a voice channel to use the voice panel.',
        ephemeral: true
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('Voice Panel')
      .setColor('#ff0000')
      .setDescription(
        `Controlling: **${vc.name}**\n\n` +
        'Use the buttons below to control your voice channel:\n' +
        '🔒 Lock / 🔓 Unlock join access\n' +
        '👻 Ghost (hide) / 🌟 Reveal the channel\n' +
        '➕ / ➖ change user limit\n' +
        '📤 Disconnect yourself from the call'
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vc_lock')
        .setEmoji('🔒')
        .setLabel('Lock')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_unlock')
        .setEmoji('🔓')
        .setLabel('Unlock')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_hide')
        .setEmoji('👻')
        .setLabel('Ghost')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_show')
        .setEmoji('🌟')
        .setLabel('Reveal')
        .setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('vc_limit_up')
        .setEmoji('➕')
        .setLabel('Limit +1')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_limit_down')
        .setEmoji('➖')
        .setLabel('Limit -1')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('vc_disconnect')
        .setEmoji('📤')
        .setLabel('Disconnect me')
        .setStyle(ButtonStyle.Danger)
    );

    return interaction.reply({
      embeds: [embed],
      components: [row1, row2],
      ephemeral: true
    });
  }

  if (commandName === 'setjtc') {
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content: 'You need Manage Server permission.', ephemeral: true });
    }
    const channel = options.getChannel('channel');
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      return interaction.reply({ content: 'Select a voice channel.', ephemeral: true });
    }
    cfg.jtcChannelId = channel.id;
    await saveDB();
    return interaction.reply({ content: `✅ Join To Create hub set to ${channel}`, ephemeral: true });
  }
});

// BUTTON HANDLER (voice panel)
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const { guild, member, customId } = interaction;
  if (!guild || !member) return;

  const validIds = [
    'vc_lock',
    'vc_unlock',
    'vc_hide',
    'vc_show',
    'vc_limit_up',
    'vc_limit_down',
    'vc_disconnect'
  ];
  if (!validIds.includes(customId)) return;

  const me = await guild.members.fetch(member.id);
  const vc = me.voice?.channel;
  if (!vc) {
    return interaction.reply({
      content: 'You have to be in a voice channel to use the voice panel.',
      ephemeral: true
    });
  }

  // Restrict control of temp JTC channels to owner OR users with ManageChannels
  const tempMeta = tempVoiceChannels[vc.id];
  if (tempMeta) {
    const isOwner = tempMeta.ownerId === member.id;
    const hasManageChannelsUser = member.permissions.has(PermissionsBitField.Flags.ManageChannels);
    if (!isOwner && !hasManageChannelsUser) {
      return interaction.reply({
        content: 'You can only control the voice channel you created. (Admins with Manage Channels can control any.)',
        ephemeral: true
      });
    }
  }

  const mePerms = vc.permissionsFor(guild.members.me);
  if (!mePerms || !mePerms.has(PermissionsBitField.Flags.ManageChannels)) {
    return interaction.reply({
      content: 'I need **Manage Channels** permission to control this voice channel.',
      ephemeral: true
    });
  }

  const everyone = guild.roles.everyone;

  try {
    switch (customId) {
      case 'vc_lock': {
        await vc.permissionOverwrites.edit(everyone, { Connect: false });
        return interaction.reply({
          content: `🔒 Locked **${vc.name}** — new people can’t join.`,
          ephemeral: true
        });
      }
      case 'vc_unlock': {
        await vc.permissionOverwrites.edit(everyone, { Connect: null });
        return interaction.reply({
          content: `🔓 Unlocked **${vc.name}** — anyone can join (if they can see it).`,
          ephemeral: true
        });
      }
      case 'vc_hide': {
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: false });
        return interaction.reply({
          content: `👻 Ghosted **${vc.name}** — hidden from everyone.`,
          ephemeral: true
        });
      }
      case 'vc_show': {
        await vc.permissionOverwrites.edit(everyone, { ViewChannel: null });
        return interaction.reply({
          content: `🌟 Revealed **${vc.name}** — visible again.`,
          ephemeral: true
        });
      }
      case 'vc_limit_up': {
        const currentLimit = vc.userLimit || 0;
        const newLimit = Math.min(currentLimit + 1, 99);
        await vc.setUserLimit(newLimit);
        return interaction.reply({
          content: `➕ User limit set to **${newLimit || 'no limit'}** for **${vc.name}**.`,
          ephemeral: true
        });
      }
      case 'vc_limit_down': {
        let currentLimit = vc.userLimit || 0;
        if (currentLimit === 0) {
          return interaction.reply({
            content: 'There is currently **no limit** set. Increase it first before lowering.',
            ephemeral: true
          });
        }
        const membersInVC = vc.members.size;
        let newLimit = currentLimit - 1;
        if (newLimit < membersInVC) newLimit = membersInVC;
        await vc.setUserLimit(newLimit);
        return interaction.reply({
          content: `➖ User limit set to **${newLimit}** for **${vc.name}**.`,
          ephemeral: true
        });
      }
      case 'vc_disconnect': {
        if (!me.voice?.channel) {
          return interaction.reply({
            content: 'You are not connected to a voice channel.',
            ephemeral: true
          });
        }
        await me.voice.disconnect().catch(() => {});
        return interaction.reply({
          content: '📤 Disconnected you from the voice channel.',
          ephemeral: true
        });
      }
    }
  } catch (err) {
    console.error('Voice panel error:', err);
    return interaction.reply({
      content: 'Something went wrong trying to control the voice channel.',
      ephemeral: true
    });
  }
});

// JOIN TO CREATE HANDLER
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;
    const cfg = getGuildConfig(guild.id);

    // user joined a channel
    if (newState.channelId && newState.channelId !== oldState.channelId) {
      // joined the JTC hub
      if (cfg.jtcChannelId && newState.channelId === cfg.jtcChannelId) {
        const hub = newState.channel;
        const member = newState.member;
        if (!hub || !member) return;

        const parent = hub.parentId ? guild.channels.cache.get(hub.parentId) : null;

        const created = await guild.channels.create({
          name: `${member.displayName}'s channel`,
          type: ChannelType.GuildVoice,
          parent: parent || undefined,
          bitrate: hub.bitrate,
          userLimit: hub.userLimit || 0
        });

        tempVoiceChannels[created.id] = { ownerId: member.id, guildId: guild.id };

        await newState.setChannel(created).catch(() => {});
      }
    }

    // user left a channel, check if we should delete temp VC
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      if (tempVoiceChannels[oldState.channelId]) {
        const ch = oldState.channel;
        if (ch && ch.members.size === 0) {
          await ch.delete('Join To Create temp VC is empty').catch(() => {});
          delete tempVoiceChannels[oldState.channelId];
        }
      }
    }
  } catch (err) {
    console.error('voiceStateUpdate error:', err);
  }
});

client.on('guildMemberAdd', async member => {
  try {
    const cfg = getGuildConfig(member.guild.id);
    let channel = member.guild.channels.cache.get(cfg.welcomeChannelId)
      || member.guild.systemChannel
      || member.guild.channels.cache.find(c => c.name === 'welcome' && c.isTextBased());

    if (channel) {
      const embed = new EmbedBuilder()
        .setColor('#ff0000')
        .setTitle(`👋 Welcome, ${member.user.username}!`);
      const messageText = (cfg.welcomeMessage || '')
        .replace('{user}', `<@${member.id}>`)
        .replace('{username}', member.user.username)
        .replace('{server}', member.guild.name);
      embed.setDescription(messageText);

      const files = [];
      if (cfg.welcomeImagePath && fsSync.existsSync(cfg.welcomeImagePath)) {
        const imageName = path.basename(cfg.welcomeImagePath);
        files.push(new AttachmentBuilder(cfg.welcomeImagePath, { name: imageName }));
        embed.setImage(`attachment://${imageName}`);
      }

      await channel.send({ embeds: [embed], files });
    }

    if (cfg.autoRoleId) {
      const role = member.guild.roles.cache.get(cfg.autoRoleId);
      if (role && member.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        await member.roles.add(role).catch(err => console.error('Error assigning autorole:', err));
      }
    }

    await checkUserBio(member, cfg);
  } catch (err) {
    console.error('Error in guildMemberAdd:', err);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const cfg = getGuildConfig(newMember.guild.id);
    if (!cfg.customRoleId) return;
    await checkUserBio(newMember, cfg);
  } catch (err) {
    console.error('Error in guildMemberUpdate:', err);
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  const message = reaction.message;
  if (!message.guild) return;
  const cfg = getGuildConfig(message.guild.id);
  const messageId = message.id;
  if (!cfg.reactionRoles[messageId]) return;

  const reactionRole = cfg.reactionRoles[messageId].find(rr =>
    rr.emoji === reaction.emoji.name || rr.emoji === reaction.emoji.id
  );
  if (!reactionRole) return;

  const role = message.guild.roles.cache.get(reactionRole.roleId);
  if (!role || !message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

  const member = await message.guild.members.fetch(user.id);
  if (!member.roles.cache.has(reactionRole.roleId)) {
    await member.roles.add(role).catch(err => console.error('Error adding reaction role:', err));
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  const message = reaction.message;
  if (!message.guild) return;
  const cfg = getGuildConfig(message.guild.id);
  const messageId = message.id;
  if (!cfg.reactionRoles[messageId]) return;

  const reactionRole = cfg.reactionRoles[messageId].find(rr =>
    rr.emoji === reaction.emoji.name || rr.emoji === reaction.emoji.id
  );
  if (!reactionRole) return;

  const role = message.guild.roles.cache.get(reactionRole.roleId);
  if (!role || !message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

  const member = await message.guild.members.fetch(user.id);
  if (member.roles.cache.has(reactionRole.roleId)) {
    await member.roles.remove(role).catch(err => console.error('Error removing reaction role:', err));
  }
});

// MESSAGE HANDLER
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.guild) {
    await message.reply('Commands only work in servers.').catch(() => {});
    return;
  }

  // non-prefix quote command
  if (message.content.startsWith('.quote') || message.content.startsWith('.q')) {
    const raw = message.content.split(' ').slice(1).join(' ').trim();
    const quoteText = raw || 'say something next time 🤨';
    const author = message.member ? message.member.displayName : message.author.username;

    await message.channel.send({
      content: `**${quoteText}**\n— *${author}*`,
      files: [QUOTE_IMAGE_URL]
    });
    return;
  }

  // XP gain (+ level role swapping)
  try {
    const cfg = getGuildConfig(message.guild.id);
    const now = Date.now();
    if (!cfg._lastXp) cfg._lastXp = {};
    const last = cfg._lastXp[message.author.id] || 0;
    if (now - last > 5000) {
      cfg._lastXp[message.author.id] = now;
      const gained = Math.floor(Math.random() * 11) + 10;
      const res = await addXP(message.guild.id, message.author.id, gained);

      if (res.leveledUp) {
        // handle level roles: remove old level roles, give the new one
        if (cfg.levelRoles) {
          const me = message.guild.members.me;
          if (me && me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            const entries = Object.entries(cfg.levelRoles);
            for (const [lvlStr, roleId] of entries) {
              const lvl = parseInt(lvlStr, 10);
              const role = message.guild.roles.cache.get(roleId);
              if (!role) continue;
              // bot must be above this role
              if (role.position >= me.roles.highest.position) continue;

              if (lvl === res.level) {
                // give new level role if missing
                if (!message.member.roles.cache.has(roleId)) {
                  await message.member.roles.add(role).catch(err =>
                    console.error('Error giving level role:', err)
                  );
                }
              } else {
                // remove all other level roles
                if (message.member.roles.cache.has(roleId)) {
                  await message.member.roles.remove(role).catch(err =>
                    console.error('Error removing old level role:', err)
                  );
                }
              }
            }
          }
        }

        const wallId = cfg.wallOfFameChannelId;
        const wallCh = wallId ? message.guild.channels.cache.get(wallId) : null;
        if (wallCh) {
          wallCh.send(`⭐ ${message.author} reached level ${res.level}`).catch(() => {});
        } else {
          message.channel.send(`⭐ ${message.author} reached level ${res.level}`).catch(() => {});
        }
      }
    }
  } catch (err) {
    console.error('XP error:', err);
  }

  if (!message.content.startsWith(PREFIX)) return;

  try {
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    let cmd = args.shift().toLowerCase();
    cmd = commandAliases[cmd] || cmd;

    const hasManage = message.member.permissions.has(PermissionsBitField.Flags.ManageGuild);
    const hasManageRoles = message.member.permissions.has(PermissionsBitField.Flags.ManageRoles);

    if (cmd === 'postrules') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('only admins can post rules.');
      }
      const rulesEmbed = new EmbedBuilder()
        .setColor('#ff1b47')
        .setTitle(':scroll: Server Rules')
        .setDescription(`**welcome to darween’s closet**
Read these before you start posting weird shii:


**1. Don’t Be a Jerk (It’s Free to Be Nice)**
Racism, homophobia, transphobia, sexism, and all those “-isms” = instant L. We're here to vibe, not to ruin lives.

**2. Keep Your Pants On (Literally & Digitally)**
No NSFW, no "accidental" sauce, no thirst traps. This ain’t OnlyFans, fam.

**3. No Spam, Ma’am**
Don’t flood the chat with walls of nonsense, links to your mixtape, or "sub for sub." We get it. You're built different. Still, no.

**4. Wrong Channel? Go to Jail (jk, but fr tho)**
Memes go in #memes. Music in <#1382024376635097292>. If you drop your SoundCloud link in <#1438764300272402452>, we will clown you.

**5. No Drama, Save It for Your Therapist**
This is a Discord server, not Keeping Up With the Krusty Krew. Sort it out privately or with a mod.

**6. Mods Are Not Your Enemies (Unless... :eyes:)**
Listen to the mod team. They’re not power-hungry, they just drank too much coffee and now they run the server.

**7. No Fake Flexing or Catfishing**
Don’t pretend to be someone you're not. Especially if that someone is Drake. You're not Drake.

**8. Protect Ya Neck (and Your Personal Info)**
Don’t share your number, address, bank pin, or your Netflix password. (Unless you're offering :eyes:)

**9. Speak English, Mostly**
This server runs on English. Throw in some spice if you want, but don’t go full Shakespeare or alien language.

**10. Be Funny, Not a Menace**
Sarcasm? Great. Dark humor? Maybe. Just don’t cross the line into “Why are you like this?”



:warning: Break these rules and staff can mute, kick or ban you if needed.`)
        .setFooter({ text: 'darween’s closet • stay real.' });

      await message.channel.send({ embeds: [rulesEmbed] });
      return;
    }

    if (cmd === 'help') {
      const help = new EmbedBuilder()
        .setTitle('Bot Help')
        .setColor('#ff0000')
        .setDescription(
          `Prefix: ${PREFIX}
Admin:
${PREFIX}setwelcomechannel
${PREFIX}setwelcomemsg
${PREFIX}setwelcomeimage
${PREFIX}setruleschannel
${PREFIX}setrulesmsg
${PREFIX}setannouncechannel
${PREFIX}announce
${PREFIX}setautorole
${PREFIX}setcustomrole
${PREFIX}setbiostring
${PREFIX}giverole
${PREFIX}createrole
${PREFIX}setspotify
${PREFIX}setsocial
${PREFIX}setroleannouncechannel
${PREFIX}checkbio
${PREFIX}forcebio
${PREFIX}resetdb
${PREFIX}reactionrole
${PREFIX}setxpboost
${PREFIX}resetxp
${PREFIX}setwall
${PREFIX}setlevelrole
${PREFIX}removelevelrole
${PREFIX}listlevelroles
${PREFIX}setjtc
${PREFIX}postvoicepanel

User:
${PREFIX}rules
${PREFIX}testwelcome
${PREFIX}config
${PREFIX}socials
${PREFIX}rank
${PREFIX}leaderboard
${PREFIX}voicepanel`
        );
      return message.channel.send({ embeds: [help] });
    }

    if (cmd === 'setwelcomechannel') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('Mention a channel like: #welcome');
      const cfg = getGuildConfig(message.guild.id);
      cfg.welcomeChannelId = ch.id;
      await saveDB();
      return message.reply(`✅ Welcome channel set to ${ch}`);
    }

    if (cmd === 'setwelcomemsg') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const text = args.join(' ');
      if (!text) return message.reply('Provide a message. Use {user} {username} {server}');
      const cfg = getGuildConfig(message.guild.id);
      cfg.welcomeMessage = text;
      await saveDB();
      return message.reply('✅ Welcome message updated.');
    }

    if (cmd === 'setwelcomeimage') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const cfg = getGuildConfig(message.guild.id);

      if (message.attachments.size > 0) {
        const url = message.attachments.first().url;
        try {
          const ext = path.extname(new URL(url).pathname) || '.png';
          const dest = path.join(dataDir, `${message.guild.id}-welcome${ext}`);
          const res = await fetch(url);
          if (!res.ok) return message.reply('Failed to download attachment.');
          const buffer = await res.buffer();
          await fs.writeFile(dest, buffer);
          cfg.welcomeImagePath = dest;
          await saveDB();
          return message.reply('✅ Saved welcome image from attachment.');
        } catch (err) {
          console.error(err);
          return message.reply('Error saving attachment.');
        }
      }

      const url = args[0];
      if (!url) return message.reply('Attach an image or provide an image URL.');
      try {
        const ext = path.extname(new URL(url).pathname) || '.png';
        const dest = path.join(dataDir, `${message.guild.id}-welcome${ext}`);
        const res = await fetch(url);
        if (!res.ok) return message.reply('Failed to download image URL.');
        const buffer = await res.buffer();
        await fs.writeFile(dest, buffer);
        cfg.welcomeImagePath = dest;
        await saveDB();
        return message.reply('✅ Downloaded and saved welcome image.');
      } catch (err) {
        console.error(err);
        return message.reply('Error downloading image URL.');
      }
    }

    if (cmd === 'setruleschannel') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('Mention a channel like: #rules');
      const cfg = getGuildConfig(message.guild.id);
      cfg.rulesChannelId = ch.id;
      await saveDB();
      return message.reply(`✅ Rules channel set to ${ch}`);
    }

    if (cmd === 'setrulesmsg') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const text = args.join(' ');
      if (!text) return message.reply('Provide the rules text.');
      const cfg = getGuildConfig(message.guild.id);
      cfg.rulesMessage = text;
      await saveDB();
      return message.reply('✅ Rules updated.');
    }

    if (cmd === 'rules') {
      const cfg = getGuildConfig(message.guild.id);
      const ch = message.guild.channels.cache.get(cfg.rulesChannelId) || message.channel;
      const embed = new EmbedBuilder().setTitle('📜 Server Rules').setColor('#ff0000').setDescription(cfg.rulesMessage);
      return ch.send({ embeds: [embed] });
    }

    if (cmd === 'setannouncechannel') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('Mention a channel like: #announcements');
      const cfg = getGuildConfig(message.guild.id);
      cfg.announceChannelId = ch.id;
      await saveDB();
      return message.reply(`✅ Announce channel set to ${ch}`);
    }

    if (cmd === 'announce') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const text = args.join(' ');
      if (!text) return message.reply('Provide the announcement text.');
      const cfg = getGuildConfig(message.guild.id);
      const ch = message.guild.channels.cache.get(cfg.announceChannelId);
      if (!ch) return message.reply(`Announce channel not set. Use ${PREFIX}setannouncechannel #channel`);
      const embed = new EmbedBuilder().setTitle('announcements').setColor('#ff0000').setDescription(text).setTimestamp();
      return ch.send({ embeds: [embed] });
    }

    if (cmd === 'config') {
      const cfg = getGuildConfig(message.guild.id);
      const socialPreview = Object.entries(cfg.socialLinks)
        .filter(([_, link]) => link)
        .map(([p, l]) => `${p}: ${l}`)
        .join('\n') || 'None';
      const rrCount = Object.keys(cfg.reactionRoles).length;
      const embed = new EmbedBuilder()
        .setTitle('Server Config')
        .setColor('#ff0000')
        .addFields(
          { name: 'Welcome Channel', value: cfg.welcomeChannelId ? `<#${cfg.welcomeChannelId}>` : 'Not set', inline: true },
          { name: 'Rules Channel', value: cfg.rulesChannelId ? `<#${cfg.rulesChannelId}>` : 'Not set', inline: true },
          { name: 'Announce Channel', value: cfg.announceChannelId ? `<#${cfg.announceChannelId}>` : 'Not set', inline: true },
          { name: 'Role Announce Channel', value: cfg.roleAnnounceChannelId ? `<#${cfg.roleAnnounceChannelId}>` : 'Not set', inline: true },
          { name: 'Auto Role', value: cfg.autoRoleId ? `<@&${cfg.autoRoleId}>` : 'Not set', inline: true },
          { name: 'Custom Role (Bio Check)', value: cfg.customRoleId ? `<@&${cfg.customRoleId}>` : 'Not set', inline: true },
          { name: 'Custom Bio String', value: cfg.customBioString || '.gg/ifeelredd', inline: true },
          { name: 'Reaction Roles', value: rrCount > 0 ? `${rrCount} active` : 'None', inline: true },
          { name: 'Spotify Artist ID', value: cfg.spotifyArtistId || 'Not set', inline: true },
          { name: 'Join To Create VC', value: cfg.jtcChannelId ? `<#${cfg.jtcChannelId}>` : 'Not set', inline: true },
          { name: 'Social Links', value: socialPreview.length > 1024 ? socialPreview.slice(0, 1000) + '...' : socialPreview },
          {
            name: 'Welcome Message',
            value: cfg.welcomeMessage
              ? (cfg.welcomeMessage.length > 1020 ? cfg.welcomeMessage.slice(0, 1000) + '...' : cfg.welcomeMessage)
              : 'None'
          },
          {
            name: 'Rules (preview)',
            value: cfg.rulesMessage
              ? (cfg.rulesMessage.length > 1020 ? cfg.rulesMessage.slice(0, 1000) + '...' : cfg.rulesMessage)
              : 'None'
          }
        );
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd === 'testwelcome') {
      const cfg = getGuildConfig(message.guild.id);
      const channel = message.mentions.channels.first() || message.channel;
      const embed = new EmbedBuilder().setColor('#ff0000').setTitle(`👋 Welcome, ${message.author.username}!`);
      const text = cfg.welcomeMessage
        .replace('{user}', `<@${message.author.id}>`)
        .replace('{username}', message.author.username)
        .replace('{server}', message.guild.name);
      embed.setDescription(text);

      const files = [];
      if (cfg.welcomeImagePath && fsSync.existsSync(cfg.welcomeImagePath)) {
        const imageName = path.basename(cfg.welcomeImagePath);
        files.push(new AttachmentBuilder(cfg.welcomeImagePath, { name: imageName }));
        embed.setImage(`attachment://${imageName}`);
      }

      return channel.send({ embeds: [embed], files });
    }

    if (cmd === 'setautorole') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const role = message.mentions.roles.first();
      if (!role) return message.reply('Mention a role like: @Member');
      const cfg = getGuildConfig(message.guild.id);
      cfg.autoRoleId = role.id;
      await saveDB();
      return message.reply(`✅ Auto role set to ${role}`);
    }

    if (cmd === 'setcustomrole') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const role = message.mentions.roles.first();
      if (!role) return message.reply('Mention a role like: @Supporter');
      const cfg = getGuildConfig(message.guild.id);
      cfg.customRoleId = role.id;
      await saveDB();
      return message.reply(`✅ Custom role for bio string set to ${role}`);
    }

    if (cmd === 'setbiostring') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const bioString = args.join(' ').trim();
      if (!bioString) return message.reply(`Provide a non-empty string like: ${PREFIX}setbiostring .gg/myserver`);
      const cfg = getGuildConfig(message.guild.id);
      cfg.customBioString = bioString;
      await saveDB();
      return message.reply(`✅ Custom bio string set to "${bioString}"`);
    }

    if (cmd === 'giverole') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const user = message.mentions.members.first();
      const role = message.mentions.roles.first();
      if (!user || !role) return message.reply(`Mention a user and a role like: ${PREFIX}giverole @User @Role`);
      if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('I need Manage Roles permission to assign roles.');
      }
      try {
        await user.roles.add(role);
        return message.reply(`✅ Gave ${role} to ${user}`);
      } catch (err) {
        console.error('Error assigning role:', err);
        return message.reply('Error assigning role. Ensure my role is above the target role.');
      }
    }

    if (cmd === 'createrole') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const roleName = args[0];
      const color = args[1] || '#000000';
      if (!roleName) return message.reply(`Provide a role name like: ${PREFIX}createrole VIP #FF0000`);
      if (!message.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        return message.reply('I need Manage Roles permission to create roles.');
      }
      try {
        const role = await message.guild.roles.create({
          name: roleName,
          color: color.startsWith('#') ? color : `#${color}`,
          reason: `Created by ${message.author.tag} via ${PREFIX}createrole`
        });
        return message.reply(`✅ Created role ${role}`);
      } catch (err) {
        console.error('Error creating role:', err);
        return message.reply('Error creating role. Ensure I have permission and the color is a valid hex (e.g., #FF0000).');
      }
    }

    if (cmd === 'setspotify') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const artistId = args[0];
      if (!artistId) return message.reply(`Provide a Spotify artist ID like: ${PREFIX}setspotify 4q3ewBCX7sLwd24euuV69X`);
      const cfg = getGuildConfig(message.guild.id);
      cfg.spotifyArtistId = artistId;
      await saveDB();
      return message.reply(`✅ Spotify music drop monitoring set to artist ID ${artistId}`);
    }

    if (cmd === 'setsocial') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const platform = args[0]?.toLowerCase();
      const link = args.slice(1).join(' ');
      if (!platform || !link) {
        return message.reply(`Usage: ${PREFIX}setsocial <platform> <link> (twitter, instagram, youtube, spotify, tiktok)`);
      }
      const validPlatforms = ['twitter', 'instagram', 'youtube', 'spotify', 'tiktok'];
      if (!validPlatforms.includes(platform)) return message.reply(`Invalid platform. Use: ${validPlatforms.join(', ')}`);
      const cfg = getGuildConfig(message.guild.id);
      if (!cfg.socialLinks) cfg.socialLinks = {};
      cfg.socialLinks[platform] = link;
      await saveDB();
      return message.reply(`✅ Set ${platform} link to ${link}`);
    }

    if (cmd === 'socials') {
      const cfg = getGuildConfig(message.guild.id);
      const links = cfg.socialLinks || {};
      const fields = Object.entries(links)
        .filter(([_, l]) => l)
        .map(([p, l]) => ({ name: p.charAt(0).toUpperCase() + p.slice(1), value: l, inline: true }));
      if (fields.length === 0) return message.reply('No social links configured. Use setsocial to add them.');
      const embed = new EmbedBuilder()
        .setTitle('My Social Media')
        .setColor('#ff0000')
        .addFields(fields);
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd === 'setroleannouncechannel') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('Mention a channel like: #supporter-announce');
      const cfg = getGuildConfig(message.guild.id);
      cfg.roleAnnounceChannelId = ch.id;
      await saveDB();
      return message.reply(`✅ Role announce channel set to ${ch}`);
    }

    if (cmd === 'checkbio') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const member = message.mentions.members.first();
      if (!member) return message.reply(`Mention a user like: ${PREFIX}checkbio @User`);
      const cfg = getGuildConfig(message.guild.id);
      await checkUserBio(member, cfg);
      return message.reply(`✅ Checked bio/status for ${member.user.tag}`);
    }

    if (cmd === 'forcebio') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const cfg = getGuildConfig(message.guild.id);
      if (!cfg.customRoleId) return message.reply(`No custom role set. Use ${PREFIX}setcustomrole @Role`);
      const reply = await message.reply('🚀 Starting force bio check for all members...');
      let count = 0;
      try {
        const members = await message.guild.members.fetch();
        for (const m of members.values()) {
          if (!m.user.bot) {
            await checkUserBio(m, cfg);
            count++;
          }
        }
      } catch (err) {
        console.error('Error fetching members:', err);
      }
      return reply.edit(`✅ Force checked ${count} members for custom string`);
    }

    if (cmd === 'resetdb') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const cfg = getGuildConfig(message.guild.id);
      cfg.lastBioCheck = {};
      await saveDB();
      return message.reply('✅ Reset bio check cache.');
    }

    if (cmd === 'reactionrole') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const subcmd = args.shift()?.toLowerCase();
      const cfg = getGuildConfig(message.guild.id);
      if (!cfg.reactionRoles) cfg.reactionRoles = {};

      if (subcmd === 'add') {
        const channel = message.mentions.channels.first();
        if (!channel) return message.reply('Mention a channel like: #roles');
        const messageId = args.shift();
        const emoji = args.shift();
        const role = message.mentions.roles.first();
        if (!messageId || !emoji || !role) {
          return message.reply(`Usage: ${PREFIX}reactionrole add #channel <message_id> <emoji> @role`);
        }
        if (!cfg.reactionRoles[messageId]) cfg.reactionRoles[messageId] = [];
        cfg.reactionRoles[messageId].push({ emoji, roleId: role.id });
        await saveDB();
        return message.reply(`✅ Added reaction role: ${emoji} → ${role} on message ${messageId} in ${channel}`);
      } else if (subcmd === 'remove') {
        const messageId = args.shift();
        const emoji = args.shift();
        if (!messageId || !emoji) {
          return message.reply(`Usage: ${PREFIX}reactionrole remove <message_id> <emoji>`);
        }
        if (!cfg.reactionRoles[messageId]) return message.reply('No reaction roles found for that message.');
        const index = cfg.reactionRoles[messageId].findIndex(rr => rr.emoji === emoji);
        if (index === -1) return message.reply('No matching emoji found.');
        cfg.reactionRoles[messageId].splice(index, 1);
        if (cfg.reactionRoles[messageId].length === 0) delete cfg.reactionRoles[messageId];
        await saveDB();
        return message.reply(`✅ Removed ${emoji} from message ${messageId}`);
      } else if (subcmd === 'list') {
        if (Object.keys(cfg.reactionRoles).length === 0) return message.reply('No reaction roles set.');
        const fields = Object.entries(cfg.reactionRoles).map(([msgId, rrs]) => ({
          name: `Message ${msgId}`,
          value: rrs.map(rr => `${rr.emoji} → <@&${rr.roleId}>`).join('\n'),
          inline: true
        }));
        const embed = new EmbedBuilder().setTitle('Reaction Roles').setColor('#ff0000').addFields(fields);
        return message.channel.send({ embeds: [embed] });
      } else {
        return message.reply(
          `Usage: ${PREFIX}reactionrole add #channel <message_id> <emoji> @role | remove <message_id> <emoji> | list`
        );
      }
    }

    if (cmd === 'postvoicepanel') {
      if (!hasManage) return message.reply('You need Manage Server permission.');

      const embed = new EmbedBuilder()
        .setTitle('Voice Panel')
        .setColor('#ff0000')
        .setDescription(
          'This panel always controls the **voice channel you are currently in**.\n\n' +
          'You have to be in a voice channel to use the voice panel.\n\n' +
          '🔒 Lock / 🔓 Unlock join access\n' +
          '👻 Ghost (hide) / 🌟 Reveal the channel\n' +
          '➕ / ➖ change user limit\n' +
          '📤 Disconnect yourself from the call'
        );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vc_lock')
          .setEmoji('🔒')
          .setLabel('Lock')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_unlock')
          .setEmoji('🔓')
          .setLabel('Unlock')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_hide')
          .setEmoji('👻')
          .setLabel('Ghost')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_show')
          .setEmoji('🌟')
          .setLabel('Reveal')
          .setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vc_limit_up')
          .setEmoji('➕')
          .setLabel('Limit +1')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_limit_down')
          .setEmoji('➖')
          .setLabel('Limit -1')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_disconnect')
          .setEmoji('📤')
          .setLabel('Disconnect me')
          .setStyle(ButtonStyle.Danger)
      );

      return message.channel.send({
        content: '🎚️ Voice Panel Setup',
        embeds: [embed],
        components: [row1, row2]
      });
    }

    if (cmd === 'voicepanel') {
      const vc = message.member.voice?.channel;
      if (!vc) {
        return message.reply('You have to be in a voice channel to use the voice panel.');
      }

      const embed = new EmbedBuilder()
        .setTitle('Voice Panel')
        .setColor('#ff0000')
        .setDescription(
          `Controlling: **${vc.name}**\n\n` +
          'Use the buttons below to control your voice channel:\n' +
          '🔒 Lock / 🔓 Unlock join access\n' +
          '👻 Ghost (hide) / 🌟 Reveal the channel\n' +
          '➕ / ➖ change user limit\n' +
          '📤 Disconnect yourself from the call'
        );

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vc_lock')
          .setEmoji('🔒')
          .setLabel('Lock')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_unlock')
          .setEmoji('🔓')
          .setLabel('Unlock')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_hide')
          .setEmoji('👻')
          .setLabel('Ghost')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_show')
          .setEmoji('🌟')
          .setLabel('Reveal')
          .setStyle(ButtonStyle.Secondary)
      );

      const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('vc_limit_up')
          .setEmoji('➕')
          .setLabel('Limit +1')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_limit_down')
          .setEmoji('➖')
          .setLabel('Limit -1')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId('vc_disconnect')
          .setEmoji('📤')
          .setLabel('Disconnect me')
          .setStyle(ButtonStyle.Danger)
      );

      return message.channel.send({
        embeds: [embed],
        components: [row1, row2]
      });
    }

    if (cmd === 'setjtc') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const ch = message.mentions.channels.first();
      if (!ch || ch.type !== ChannelType.GuildVoice) {
        return message.reply(`Mention a **voice** channel like: ${PREFIX}setjtc #Join-To-Create`);
      }
      const cfg = getGuildConfig(message.guild.id);
      cfg.jtcChannelId = ch.id;
      await saveDB();
      return message.reply(`✅ Join To Create hub set to ${ch}`);
    }

    if (cmd === 'rank' || cmd === 'level') {
      const cfg = getGuildConfig(message.guild.id);
      const target = message.mentions.members.first() || message.member;
      const data = (cfg.xp && cfg.xp[target.id]) ? cfg.xp[target.id] : { xp: 0, level: 0 };
      const needed = getRequiredXPForLevel(data.level);
      const embed = new EmbedBuilder()
        .setTitle(`${target.user.username}'s rank`)
        .setColor('#ff0000')
        .setDescription(`Level: **${data.level}**\nXP: **${data.xp}/${needed}**`);
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd === 'leaderboard' || cmd === 'lb') {
      const top = getLeaderboard(message.guild.id, 10);
      if (top.length === 0) {
        return message.channel.send('No XP data yet.');
      }
      let desc = '';
      for (let i = 0; i < top.length; i++) {
        const entry = top[i];
        const member = await message.guild.members.fetch(entry.userId).catch(() => null);
        if (!member) continue;
        const name = member.user.username;
        desc += `${i + 1}. ${name} — Level ${entry.level} (${entry.xp} XP)\n`;
      }
      if (!desc) {
        return message.channel.send('No XP data yet.');
      }
      const embed = new EmbedBuilder()
        .setTitle('XP Leaderboard')
        .setColor('#ff0000')
        .setDescription(desc);
      return message.channel.send({ embeds: [embed] });
    }

    if (cmd === 'setxpboost') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const mult = parseFloat(args[0]);
      if (isNaN(mult) || mult <= 0) {
        return message.reply(`Give a valid number, example: ${PREFIX}setxpboost 2`);
      }
      const cfg = getGuildConfig(message.guild.id);
      cfg.xpBoost = mult;
      await saveDB();
      return message.reply(`✅ XP boost set to x${mult}`);
    }

    if (cmd === 'resetxp') {
      if (!hasManage) {
        return message.reply('You need Manage Server permission to reset XP.');
      }
      const cfg = getGuildConfig(message.guild.id);
      cfg.xp = {};
      cfg._lastXp = {};
      await saveDB();
      return message.reply('✅ All XP data for this server has been reset.');
    }

    if (cmd === 'setwall') {
      if (!hasManage) return message.reply('You need Manage Server permission.');
      const ch = message.mentions.channels.first();
      if (!ch) return message.reply('Mention a channel like: #wall-of-fame');
      const cfg = getGuildConfig(message.guild.id);
      cfg.wallOfFameChannelId = ch.id;
      await saveDB();
      return message.reply(`✅ Wall Of Fame channel set to ${ch}`);
    }

    if (cmd === 'setlevelrole') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const level = parseInt(args[0], 10);
      const role = message.mentions.roles.first();
      if (isNaN(level) || level < 1) {
        return message.reply(`Give a valid level. Example: ${PREFIX}setlevelrole 5 @Supporter`);
      }
      if (!role) {
        return message.reply(`Mention the role. Example: ${PREFIX}setlevelrole 5 @Supporter`);
      }
      const cfg = getGuildConfig(message.guild.id);
      if (!cfg.levelRoles) cfg.levelRoles = {};
      cfg.levelRoles[level] = role.id;
      await saveDB();
      return message.reply(`✅ When someone reaches level ${level} they will get ${role}`);
    }

    if (cmd === 'removelevelrole') {
      if (!hasManageRoles) return message.reply('You need Manage Roles permission.');
      const level = parseInt(args[0], 10);
      if (isNaN(level)) {
        return message.reply(`Example: ${PREFIX}removelevelrole 5`);
      }
      const cfg = getGuildConfig(message.guild.id);
      if (!cfg.levelRoles || !cfg.levelRoles[level]) {
        return message.reply('There is no role set for that level.');
      }
      delete cfg.levelRoles[level];
      await saveDB();
      return message.reply(`✅ Removed level role for level ${level}`);
    }

    if (cmd === 'listlevelroles') {
      const cfg = getGuildConfig(message.guild.id);
      const entries = cfg.levelRoles ? Object.entries(cfg.levelRoles) : [];
      if (entries.length === 0) return message.reply('No level roles set.');
      let txt = 'Level roles:\n';
      for (const [lvl, roleId] of entries) {
        const r = message.guild.roles.cache.get(roleId);
        txt += `Level ${lvl} → ${r ? r.name : `role ${roleId}`}\n`;
      }
      return message.reply(txt);
    }

  } catch (err) {
    console.error('Error in messageCreate:', err);
    await message.reply('An error occurred while processing your command. Please try again.').catch(() => {});
  }
});

(async () => {
  await ensureDirs();
  await loadDB();
  client.login(TOKEN);
})();
