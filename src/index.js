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
const accts = require('./accounts');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── In-memory stores ──────────────────────────────────────────────────────────
const favourites = new Map();
const recent = new Map();
// Track which account index each user is currently using
// Falls back to account 1 (or whichever is first) if not set
const userAccount = new Map();

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
function getActiveAccount(userId) {
  const accounts = accts.loadAccounts();
  if (accounts.length === 0) return null;
  const idx = userAccount.get(userId);
  return accounts.find(a => a.index === idx) || accounts[0];
}

// ── Main panel ────────────────────────────────────────────────────────────────
function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🎓 Student Beans Discount Bot')
    .setDescription(
      'Get your **Student Beans** discount codes instantly.\n\n' +
      '🔍 **Search** — look up any brand\n' +
      '⭐ **Favourites** — your saved brands\n' +
      '🕐 **Recent** — your last codes\n' +
      '👤 **Accounts** — manage Student Beans accounts'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Codes are unique to your account — never share them' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sb_search').setLabel('Search').setStyle(ButtonStyle.Primary).setEmoji('🔍'),
    new ButtonBuilder().setCustomId('sb_favourites').setLabel('Favourites').setStyle(ButtonStyle.Secondary).setEmoji('⭐'),
    new ButtonBuilder().setCustomId('sb_recent').setLabel('Recent').setStyle(ButtonStyle.Secondary).setEmoji('🕐'),
    new ButtonBuilder().setCustomId('sb_accounts').setLabel('Accounts').setStyle(ButtonStyle.Secondary).setEmoji('👤'),
  );

  return { embeds: [embed], components: [row] };
}

// ── Account manager embed ─────────────────────────────────────────────────────
function buildAccountsEmbed(accounts, activeIndex) {
  const embed = new EmbedBuilder()
    .setTitle('👤 Account Manager')
    .setColor(0x5865F2);

  if (accounts.length === 0) {
    embed.setDescription('No accounts set up yet.\nClick **➕ Add Account** to add your Student Beans cookies.');
  } else {
    const lines = accounts.map(a => {
      const statusEmoji = a.status === 'ok' ? '✅' : a.status === 'expired' ? '❌' : a.status === 'error' ? '⚠️' : '❓';
      const active = a.index === activeIndex ? ' **(active)**' : '';
      return `${statusEmoji} **${a.name}**${active}`;
    });
    embed.setDescription(lines.join('\n'));
    embed.setFooter({ text: 'Select an account below to manage it' });
  }
  return embed;
}

function buildAccountsComponents(accounts, activeIndex) {
  const rows = [];

  // Account selection buttons (up to 4 per row)
  if (accounts.length > 0) {
    let row = new ActionRowBuilder();
    let count = 0;
    for (const a of accounts.slice(0, 4)) {
      const isActive = a.index === activeIndex;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`sb_acct_select_${a.index}`)
          .setLabel(a.name.slice(0, 20))
          .setStyle(isActive ? ButtonStyle.Primary : ButtonStyle.Secondary)
      );
      count++;
    }
    rows.push(row);
  }

  // Action buttons
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('sb_acct_add').setLabel('➕ Add Account').setStyle(ButtonStyle.Success),
  );
  if (accounts.length > 0) {
    actionRow.addComponents(
      new ButtonBuilder().setCustomId('sb_acct_test_all').setLabel('🔄 Test All').setStyle(ButtonStyle.Secondary),
    );
  }
  rows.push(actionRow);

  return rows;
}

function buildAccountDetailComponents(acctIndex) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sb_acct_rename_${acctIndex}`).setLabel('✏️ Rename').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sb_acct_updatecookies_${acctIndex}`).setLabel('🍪 Update Cookies').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sb_acct_test_${acctIndex}`).setLabel('🔄 Test').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sb_acct_remove_${acctIndex}`).setLabel('🗑️ Remove').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('sb_accounts').setLabel('← Back').setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  { name: 'sb-panel', description: 'Post the Student Beans panel in this channel' },
  { name: 'sb-login', description: 'Force re-login to Student Beans' },
];

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const guildId = process.env.GUILD_ID;
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    console.log(`✅ Guild commands registered`);
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Global commands registered');
  }

  // Log loaded accounts
  const accounts = accts.loadAccounts();
  console.log(`📋 Loaded ${accounts.length} account(s):`, accounts.map(a => a.name).join(', ') || 'none');

  // Use legacy SB_COOKIES as account 1 if no accounts configured yet
  if (accounts.length === 0 && process.env.SB_COOKIES) {
    console.log('⚡ Using legacy SB_COOKIES as default account');
  }

  // Pre-warm the browser so the first search isn't slow
  console.log('🔥 Pre-warming browser...');
  try {
    const firstAccount = accounts[0];
    const cookieStr = firstAccount ? firstAccount.cookies : process.env.SB_COOKIES;
    if (cookieStr) {
      await sb.setCookies(cookieStr);
      console.log('🔥 Browser warm, cookies injected');
    } else {
      // No cookies yet — just launch the browser so it's ready
      await sb.searchRetailers('__warmup__').catch(() => {});
      console.log('🔥 Browser warm (no account cookies)');
    }
  } catch (e) {
    console.log('🔥 Pre-warm failed (non-fatal):', e.message);
  }
});

// ── Interaction router ────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // /sb-panel
  if (interaction.isChatInputCommand() && interaction.commandName === 'sb-panel') {
    await interaction.reply(buildPanel());
    return;
  }

  // /sb-login
  if (interaction.isChatInputCommand() && interaction.commandName === 'sb-login') {
    await interaction.deferReply({ flags: 64 });
    sb.resetSession();
    const r = await sb.login();
    await interaction.editReply(r.success ? '✅ Logged in!' : `❌ ${r.message.substring(0, 1800)}`);
    return;
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'sb_search') {
    const modal = new ModalBuilder().setCustomId('sb_search_modal').setTitle('Search for a Brand');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sb_brand_input').setLabel('Brand name')
        .setStyle(TextInputStyle.Short).setPlaceholder('e.g. ASOS, Nike, Spotify').setRequired(true)
    ));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === 'sb_search_modal') {
    const query = interaction.fields.getTextInputValue('sb_brand_input');
    await interaction.deferReply({ flags: 64 });
    await fetchAndShowCode(interaction, query);
    return;
  }

  // ── Favourites ──────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'sb_favourites') {
    const favs = [...getFavs(interaction.user.id)];
    if (favs.length === 0) {
      await interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('⭐ Your Favourites')
        .setDescription('No favourites yet. Search for a brand and click **☆ Save to Favourites**.').setColor(0xfaa61a)] });
      return;
    }
    await interaction.reply({ flags: 64,
      embeds: [new EmbedBuilder().setTitle('⭐ Your Favourites').setDescription('Pick a brand:').setColor(0xfaa61a)],
      components: buildBrandButtons(favs, 'sb_fav_pick_') });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_fav_pick_')) {
    const slug = interaction.customId.replace('sb_fav_pick_', '');
    await interaction.deferReply({ flags: 64 });
    await fetchAndShowCode(interaction, slug);
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_fav_remove_')) {
    getFavs(interaction.user.id).delete(interaction.customId.replace('sb_fav_remove_', ''));
    await interaction.reply({ flags: 64, content: `✅ Removed from favourites.` });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith('sb_fav_add_')) {
    const slug = interaction.customId.replace('sb_fav_add_', '');
    getFavs(interaction.user.id).add(slug);
    await interaction.reply({ flags: 64, content: `⭐ Added **${slugToName(slug)}** to favourites!` });
    return;
  }

  // ── Recent ───────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'sb_recent') {
    const list = getRecent(interaction.user.id);
    if (list.length === 0) {
      await interaction.reply({ flags: 64, embeds: [new EmbedBuilder().setTitle('🕐 Recent Codes')
        .setDescription('No recent codes yet!').setColor(0x99aab5)] });
      return;
    }
    const embed = new EmbedBuilder().setTitle('🕐 Recent Codes').setColor(0x99aab5);
    for (const entry of list.slice(0, 8)) {
      const val = entry.type === 'code' ? `\`${entry.code}\` · ${timeAgo(entry.timestamp)}` : `Direct link · ${timeAgo(entry.timestamp)}`;
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

  // ── Account Manager ──────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'sb_accounts') {
    const accounts = accts.loadAccounts();
    const activeAcct = getActiveAccount(interaction.user.id);
    const activeIndex = activeAcct ? activeAcct.index : null;
    await interaction.reply({
      flags: 64,
      embeds: [buildAccountsEmbed(accounts, activeIndex)],
      components: buildAccountsComponents(accounts, activeIndex),
    });
    return;
  }

  // Select an account to view its details
  if (interaction.isButton() && interaction.customId.startsWith('sb_acct_select_')) {
    const index = parseInt(interaction.customId.replace('sb_acct_select_', ''));
    const accounts = accts.loadAccounts();
    const acct = accounts.find(a => a.index === index);
    if (!acct) { await interaction.reply({ flags: 64, content: '❌ Account not found.' }); return; }
    const embed = new EmbedBuilder()
      .setTitle(`👤 ${acct.name}`)
      .setDescription(`Status: **${acct.status === 'ok' ? '✅ Active' : acct.status === 'expired' ? '❌ Expired' : '❓ Not tested'}**\n\nWhat would you like to do?`)
      .setColor(0x5865F2);
    await interaction.reply({ flags: 64, embeds: [embed], components: buildAccountDetailComponents(index) });
    return;
  }

  // Add account — show modal
  if (interaction.isButton() && interaction.customId === 'sb_acct_add') {
    const modal = new ModalBuilder().setCustomId('sb_acct_add_modal').setTitle('Add Student Beans Account');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sb_acct_name').setLabel('Account name (e.g. "My Account")')
          .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sb_acct_cookies').setLabel('Paste your Student Beans cookies')
          .setStyle(TextInputStyle.Paragraph).setRequired(true)
          .setPlaceholder('Paste the full cookie string from your browser here')
      )
    );
    await interaction.showModal(modal);
    return;
  }

  // Add account modal submit
  if (interaction.isModalSubmit() && interaction.customId === 'sb_acct_add_modal') {
    await interaction.deferReply({ flags: 64 });
    const name = interaction.fields.getTextInputValue('sb_acct_name');
    const cookies = interaction.fields.getTextInputValue('sb_acct_cookies');
    try {
      const idx = await accts.addAccount(name, cookies);
      await accts.triggerRedeploy();
      await interaction.editReply({ content: `✅ Added **${name}** as account #${idx}!\n🔄 Railway is redeploying to apply the new account...` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed to add account: ${err.message}` });
    }
    return;
  }

  // Rename account — show modal
  if (interaction.isButton() && interaction.customId.startsWith('sb_acct_rename_')) {
    const index = parseInt(interaction.customId.replace('sb_acct_rename_', ''));
    const modal = new ModalBuilder().setCustomId(`sb_acct_rename_modal_${index}`).setTitle('Rename Account');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sb_acct_newname').setLabel('New name')
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)
    ));
    await interaction.showModal(modal);
    return;
  }

  // Rename modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith('sb_acct_rename_modal_')) {
    await interaction.deferReply({ flags: 64 });
    const index = parseInt(interaction.customId.replace('sb_acct_rename_modal_', ''));
    const newName = interaction.fields.getTextInputValue('sb_acct_newname');
    try {
      await accts.renameAccount(index, newName);
      await accts.triggerRedeploy();
      await interaction.editReply({ content: `✅ Renamed to **${newName}**!\n🔄 Railway is redeploying...` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
    return;
  }

  // Update cookies — show modal
  if (interaction.isButton() && interaction.customId.startsWith('sb_acct_updatecookies_')) {
    const index = parseInt(interaction.customId.replace('sb_acct_updatecookies_', ''));
    const modal = new ModalBuilder().setCustomId(`sb_acct_cookies_modal_${index}`).setTitle('Update Cookies');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sb_acct_newcookies').setLabel('Paste new cookies')
        .setStyle(TextInputStyle.Paragraph).setRequired(true)
        .setPlaceholder('Paste the full cookie string from your browser')
    ));
    await interaction.showModal(modal);
    return;
  }

  // Update cookies modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith('sb_acct_cookies_modal_')) {
    await interaction.deferReply({ flags: 64 });
    const index = parseInt(interaction.customId.replace('sb_acct_cookies_modal_', ''));
    const cookies = interaction.fields.getTextInputValue('sb_acct_newcookies');
    try {
      await accts.updateCookies(index, cookies);
      await accts.triggerRedeploy();
      await interaction.editReply({ content: `✅ Cookies updated!\n🔄 Railway is redeploying...` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
    return;
  }

  // Test single account
  if (interaction.isButton() && interaction.customId.startsWith('sb_acct_test_')) {
    const index = parseInt(interaction.customId.replace('sb_acct_test_', ''));
    await interaction.deferReply({ flags: 64 });
    await interaction.editReply({ content: `🔄 Testing account... (~15 seconds)` });
    try {
      const status = await accts.testAccount(index);
      const msg = status === 'ok' ? '✅ Cookies are valid and working!'
        : status === 'expired' ? '❌ Cookies have expired — please update them.'
        : '⚠️ Test failed — couldn\'t connect to Student Beans.';
      await interaction.editReply({ content: msg });
    } catch (err) {
      await interaction.editReply({ content: `❌ Test error: ${err.message}` });
    }
    return;
  }

  // Test all accounts
  if (interaction.isButton() && interaction.customId === 'sb_acct_test_all') {
    await interaction.deferReply({ flags: 64 });
    const accounts = accts.loadAccounts();
    await interaction.editReply({ content: `🔄 Testing ${accounts.length} account(s)... (~15s each)` });
    const results = [];
    for (const a of accounts) {
      const status = await accts.testAccount(a.index);
      const emoji = status === 'ok' ? '✅' : status === 'expired' ? '❌' : '⚠️';
      results.push(`${emoji} **${a.name}**: ${status}`);
    }
    await interaction.editReply({ content: results.join('\n') });
    return;
  }

  // Remove account
  if (interaction.isButton() && interaction.customId.startsWith('sb_acct_remove_')) {
    const index = parseInt(interaction.customId.replace('sb_acct_remove_', ''));
    await interaction.deferReply({ flags: 64 });
    try {
      const accounts = accts.loadAccounts();
      const acct = accounts.find(a => a.index === index);
      await accts.removeAccount(index);
      await accts.triggerRedeploy();
      await interaction.editReply({ content: `✅ Removed **${acct?.name || 'account'}**.\n🔄 Railway is redeploying...` });
    } catch (err) {
      await interaction.editReply({ content: `❌ Failed: ${err.message}` });
    }
    return;
  }

});

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildBrandButtons(slugs, prefix) {
  const rows = [];
  let row = new ActionRowBuilder();
  let count = 0;
  for (const slug of slugs.slice(0, 25)) {
    if (count > 0 && count % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
    row.addComponents(new ButtonBuilder().setCustomId(`${prefix}${slug}`).setLabel(slugToName(slug).slice(0, 80)).setStyle(ButtonStyle.Primary));
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

  // Pick cookies: use account system if available, fall back to legacy SB_COOKIES
  const account = getActiveAccount(interaction.user.id);
  const cookiesToUse = account ? account.cookies : process.env.SB_COOKIES;
  if (!cookiesToUse) {
    await interaction.editReply({ embeds: [errEmbed('No account set up', 'Go to **👤 Accounts** and add a Student Beans account first.')], components: [] });
    return;
  }

  // Inject cookies into the warm browser — no browser restart needed
  await sb.setCookies(cookiesToUse);

  let retailers;
  try { retailers = await sb.searchRetailers(query); }
  catch (err) {
    await interaction.editReply({ embeds: [errEmbed('Search failed', err.message)], components: [] });
    return;
  }

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
  catch (err) {
    await interaction.editReply({ embeds: [errEmbed('Failed to get code', err.message)], components: [] });
    return;
  }

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
      .setColor(0x00c853).setFooter({ text: `Student Beans • ${account?.name || 'Default'} account` }).setTimestamp();
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
      .setColor(0x00bfff).setFooter({ text: `Student Beans • ${account?.name || 'Default'} account` }).setTimestamp();
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
