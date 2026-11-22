require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const sb = require('./studentbeans');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const favourites = new Map();
const recent = new Map();

function getFavs(userId) {
  if (!favourites.has(userId)) favourites.set(userId, new Set());
  return favourites.get(userId);
}

function getRecent(userId) {
  if (!recent.has(userId)) recent.set(userId, []);
  return recent.get(userId);
}

function addRecent(userId, entry) {
  const list = getRecent(userId);
  const idx = list.findIndex(r => r.url === entry.url);
  if (idx !== -1) list.splice(idx, 1);
  list.unshift(entry);
  if (list.length > 10) list.pop();
}

function slugToName(slug) {
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🎓 Student Beans Discount Bot')
    .setDescription(
      'Get your **Student Beans** discount codes instantly.\n\n' +
      '🔍 **Search** — look up any brand\n' +
      '⭐ **Favourites** — your saved brands\n' +
      '🕐 **Recent** — your last codes'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Codes are unique to your account — never share them' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sb_search').setLabel('Search').setStyle(ButtonStyle.Primary).setEmoji('🔍'),
    new ButtonBuilder().setCustomId('sb_favourites').setLabel('Favourites').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
    new ButtonBuilder().setCustomId('sb_recent').setLabel('Recent').setStyle(ButtonStyle.Secondary).setEmoji('🕐'),
  );

  return { embeds: [embed], components: [row] };
}

const commands = [
  { name: 'sb-panel', description: 'Post the Student Beans panel in this channel' },
  { name: 'sb-login', description: 'Force re-login to Student Beans (use if codes stop working)' },
];

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log('✅ Slash commands registered');
  sb.login().then(r => console.log(r.success ? '✅ SB login OK' : `⚠️ SB: ${r.message}`));
});

client.on('interactionCreate', async (interaction) => {

  if (interaction.isChatInputCommand() && interaction.commandName === 'sb-panel') {
    await interaction.reply(buildPanel());
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'sb-login') {
    await interaction.deferReply({ flags: 64 });
    sb.resetSession();
    const r = await sb.login();
    await interaction.editReply(r.success ? '✅ Logged in!' : `❌ ${r.message.substring(0, 1800)}`);
    return;
  }

  if (interaction.isButton() && interaction.customId === 'sb_search') {
    const modal = new ModalBuilder()
      .setCustomId('sb_search_modal')
      .setTitle('Search for a Brand');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('sb_brand_input')
          .setLabel('Brand name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. ASOS, Nike, Spotify')
          .setRequired(true)
      )
    );
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'sb_search_modal') {
    const query = interaction.fields.getTextInputValue('sb_brand_input');
    await interaction.deferReply({ flags: 64 });
    await fetchAndShowCode(interaction, query);
    return;
  }

  if (interaction.isButton() && interaction.customId === 'sb_favourites') {
    const favs = [...getFavs(interaction.user.id)];
    if (favs.length === 0) {
      await interaction.reply({
        flags: 64,
        embeds: [new EmbedBuilder()
          .setTitle('⭐ Your Favourites')
          .setDescription('No favourites yet. Search for a brand and click **☆ Save to Favourites**.')
          .setColor(0xfaa61a)],
      });
      return;
    }
    const rows = buildBrandButtons(favs, 'sb_fav_pick_');
    await interaction.reply({
      flags: 64,
      embeds: [new EmbedBuilder().setTitle('⭐ Your Favourites').setDescription('Pick a brand:').setColor(0xfaa61a)],
      components: rows,
    });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_fav_pick_')) {
    const slug = interaction.customId.replace('sb_fav_pick_', '');
    await interaction.deferReply({ flags: 64 });
    await fetchAndShowCode(interaction, slug);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_fav_remove_')) {
    const slug = interaction.customId.replace('sb_fav_remove_', '');
    getFavs(interaction.user.id).delete(slug);
    await interaction.reply({ flags: 64, content: `✅ Removed **${slugToName(slug)}** from favourites.` });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_fav_add_')) {
    const slug = interaction.customId.replace('sb_fav_add_', '');
    getFavs(interaction.user.id).add(slug);
    await interaction.reply({ flags: 64, content: `⭐ Added **${slugToName(slug)}** to favourites!` });
    return;
  }

  if (interaction.isButton() && interaction.customId === 'sb_recent') {
    const list = getRecent(interaction.user.id);
    if (list.length === 0) {
      await interaction.reply({
        flags: 64,
        embeds: [new EmbedBuilder().setTitle('🕐 Recent Codes').setDescription('No recent codes yet. Search for a brand first!').setColor(0x99aab5)],
      });
      return;
    }
    const embed = new EmbedBuilder().setTitle('🕐 Recent Codes').setColor(0x99aab5);
    for (const entry of list.slice(0, 8)) {
      const ago = timeAgo(entry.timestamp);
      const val = entry.type === 'code' ? `\`${entry.code}\` · ${ago}` : `Direct link · ${ago}`;
      embed.addFields({ name: entry.name, value: val, inline: false });
    }
    const slugs = list.slice(0, 5).map(e => e.url.split('/').pop());
    await interaction.reply({ flags: 64, embeds: [embed], components: buildBrandButtons(slugs, 'sb_recent_pick_') });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_recent_pick_')) {
    const slug = interaction.customId.replace('sb_recent_pick_', '');
    await interaction.deferReply({ flags: 64 });
    await fetchAndShowCode(interaction, slug);
    return;
  }

});

function buildBrandButtons(slugs, prefix) {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;
  for (const slug of slugs.slice(0, 25)) {
    if (count > 0 && count % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(
      new ButtonBuilder().setCustomId(`${prefix}${slug}`).setLabel(slugToName(slug).slice(0, 80)).setStyle(ButtonStyle.Primary)
    );
    count++;
  }
  if (count > 0) rows.push(row);
  return rows;
}

async function fetchAndShowCode(interaction, query) {
  await interaction.editReply({
    embeds: [new EmbedBuilder().setTitle(`⏳ Fetching **${query}**...`).setDescription('~10 seconds.').setColor(0xffa500)],
    components: [],
  });

  let retailers;
  try { retailers = await sb.searchRetailers(query); }
  catch (err) { await interaction.editReply({ embeds: [errEmbed('Search failed', err.message)], components: [] }); return; }

  if (!retailers || retailers.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setTitle('❌ Not found').setDescription(`No results for **${query}**. Try a different spelling.`).setColor(0xff0000)],
      components: [],
    });
    return;
  }

  const retailer = retailers[0];
  const slug = retailer.url.split('/').pop();

  let result;
  try { result = await sb.getCode(retailer.url); }
  catch (err) { await interaction.editReply({ embeds: [errEmbed('Failed to get code', err.message)], components: [] }); return; }

  const isFav = getFavs(interaction.user.id).has(slug);
  const favBtn = new ButtonBuilder()
    .setCustomId(isFav ? `sb_fav_remove_${slug}` : `sb_fav_add_${slug}`)
    .setLabel(isFav ? '★ Remove Favourite' : '☆ Save to Favourites')
    .setStyle(isFav ? ButtonStyle.Danger : ButtonStyle.Secondary);

  if (result.type === 'code' && result.code) {
    addRecent(interaction.user.id, { name: retailer.name, url: retailer.url, code: result.code, type: 'code', timestamp: Date.now() });
    const embed = new EmbedBuilder()
      .setTitle(`🎉 ${retailer.name} Student Discount`)
      .setDescription('Here\'s your unique one-time-use code:')
      .addFields(
        { name: '🏷️ Your Code', value: `\`\`\`${result.code}\`\`\`` },
        { name: '⚠️ Important', value: 'This code is **unique to your account**. Do not share it.' }
      )
      .setColor(0x00c853).setFooter({ text: 'Student Beans • Only you can see this' }).setTimestamp();
    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Shop Now').setStyle(ButtonStyle.Link).setURL(retailer.url), favBtn
      )],
    });

  } else if (result.type === 'redirect' && result.url) {
    addRecent(interaction.user.id, { name: retailer.name, url: retailer.url, code: null, type: 'redirect', timestamp: Date.now() });
    const embed = new EmbedBuilder()
      .setTitle(`🔗 ${retailer.name} — No Code Needed`)
      .setDescription('This retailer uses a **direct access link**. The discount is applied automatically.')
      .setColor(0x00bfff).setFooter({ text: 'Student Beans • Only you can see this' }).setTimestamp();
    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Access Student Discount').setStyle(ButtonStyle.Link).setURL(result.url), favBtn
      )],
    });

  } else {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle(`⚠️ Couldn't extract code for ${retailer.name}`)
        .setDescription(`Page loaded but no code found.\n\n[Get it manually here](${retailer.url})`)
        .setColor(0xff9800)],
      components: [new ActionRowBuilder().addComponents(favBtn)],
    });
  }
}

function errEmbed(title, msg) {
  return new EmbedBuilder().setTitle(`❌ ${title}`).setDescription((msg || 'Unknown error').substring(0, 1000)).setColor(0xff0000);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

process.on('SIGINT', async () => { await sb.closeBrowser(); client.destroy(); process.exit(0); });

if (!process.env.DISCORD_TOKEN) { console.error('❌ DISCORD_TOKEN not set'); process.exit(1); }

client.login(process.env.DISCORD_TOKEN);
