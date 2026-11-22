require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ApplicationCommandOptionType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} = require('discord.js');

const sb = require('./studentbeans');

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── Slash commands ────────────────────────────────────────────────────────────
const commands = [
  {
    name: 'discount',
    description: 'Search for a Student Beans discount code',
    options: [
      {
        name: 'retailer',
        description: 'Name of the retailer (e.g. ASOS, Dominos, Spotify)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
    ],
  },
  {
    name: 'sb-login',
    description: 'Force re-login to Student Beans (use if codes stop working)',
  },
];

// ── Register slash commands on ready ─────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }

  // Warm up: log in to Student Beans in the background
  console.log('🔄 Logging into Student Beans...');
  sb.login().then((r) => console.log(r.success ? '✅ SB login OK' : `⚠️ SB login: ${r.message}`));
});

// ── Interaction handler ───────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  // ── Button: pick a retailer from search results ───────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('sb_pick_')) {
    const retailerUrl = Buffer.from(interaction.customId.replace('sb_pick_', ''), 'base64').toString();
    await handleGetCode(interaction, retailerUrl);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /sb-login ─────────────────────────────────────────────────────────────
  if (interaction.commandName === 'sb-login') {
    await interaction.deferReply({ ephemeral: true });
    sb.resetSession();
    const result = await sb.login();
    await interaction.editReply(result.success ? '✅ Logged in to Student Beans!' : `❌ ${result.message.substring(0, 1800)}`);
    return;
  }

  // ── /discount <retailer> ──────────────────────────────────────────────────
  if (interaction.commandName === 'discount') {
    const query = interaction.options.getString('retailer');
    await interaction.deferReply({ ephemeral: true });

    let results;
    try {
      results = await sb.searchRetailers(query);
    } catch (err) {
      const shortErr = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
      await interaction.editReply(`❌ Search failed: ${shortErr}`);
      return;
    }

    if (!results || results.length === 0) {
      await interaction.editReply(`❌ No results found for **${query}**. Try a different spelling.`);
      return;
    }

    // If only one result, go straight to fetching the code
    if (results.length === 1) {
      await handleGetCode(interaction, results[0].url, results[0].name);
      return;
    }

    // Show a list of matches as buttons
    const embed = new EmbedBuilder()
      .setTitle('🔍 Multiple matches found')
      .setDescription(`Pick the retailer you want a code for:`)
      .setColor(0x00bfff)
      .setFooter({ text: 'Student Beans • This message is only visible to you' });

    const rows = [];
    let row = new ActionRowBuilder();
    let count = 0;

    for (const r of results.slice(0, 10)) {
      const idSafe = Buffer.from(r.url).toString('base64');
      const btn = new ButtonBuilder()
        .setCustomId(`sb_pick_${idSafe}`)
        .setLabel(r.name.slice(0, 80))
        .setStyle(ButtonStyle.Primary);

      row.addComponents(btn);
      count++;

      // Discord allows max 5 buttons per row
      if (count % 5 === 0 || count === results.length) {
        rows.push(row);
        row = new ActionRowBuilder();
      }
    }

    await interaction.editReply({ embeds: [embed], components: rows });
    return;
  }
});

// ── Helper: fetch and display a code ─────────────────────────────────────────
async function handleGetCode(interaction, retailerUrl, retailerName = null) {
  const isDeferred = interaction.deferred || interaction.replied;
  if (!isDeferred) {
    await interaction.deferReply({ ephemeral: true });
  }

  // Extract name from URL if not provided
  if (!retailerName) {
    retailerName = retailerUrl.split('/').pop().replace(/-/g, ' ');
    retailerName = retailerName.charAt(0).toUpperCase() + retailerName.slice(1);
  }

  const loadingEmbed = new EmbedBuilder()
    .setTitle(`⏳ Fetching code for ${retailerName}...`)
    .setDescription('Logging into Student Beans and grabbing your code. This takes ~10 seconds.')
    .setColor(0xffa500);

  await interaction.editReply({ embeds: [loadingEmbed], components: [] });

  let result;
  try {
    result = await sb.getCode(retailerUrl);
  } catch (err) {
    const shortErr = err.message.length > 500 ? err.message.substring(0, 500) + '...' : err.message;
    const errEmbed = new EmbedBuilder()
      .setTitle('❌ Failed to get code')
      .setDescription(`${shortErr}\n\nTry \`/sb-login\` to refresh the session.`)
      .setColor(0xff0000);
    await interaction.editReply({ embeds: [errEmbed], components: [] });
    return;
  }

  if (result.type === 'code' && result.code) {
    const embed = new EmbedBuilder()
      .setTitle(`🎉 ${retailerName} Student Discount`)
      .setDescription(`Here's your unique one-time-use code:`)
      .addFields({ name: '🏷️ Your Code', value: `\`\`\`${result.code}\`\`\`` })
      .addFields({ name: '⚠️ Important', value: 'This code is unique to your account. **Do not share it.**' })
      .setColor(0x00c853)
      .setURL(retailerUrl)
      .setFooter({ text: 'Student Beans • Only you can see this' })
      .setTimestamp();

    const shopBtn = new ButtonBuilder()
      .setLabel('Shop Now')
      .setStyle(ButtonStyle.Link)
      .setURL(retailerUrl);

    const row = new ActionRowBuilder().addComponents(shopBtn);
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else if (result.type === 'redirect') {
    const embed = new EmbedBuilder()
      .setTitle(`🔗 ${retailerName} — No Code Needed`)
      .setDescription(
        `This retailer uses a **direct access link** instead of a code.\nClick the button below to access your student discount — the discount is applied automatically.`
      )
      .setColor(0x00bfff)
      .setFooter({ text: 'Student Beans • Only you can see this' })
      .setTimestamp();

    const linkBtn = new ButtonBuilder()
      .setLabel('Access Student Discount')
      .setStyle(ButtonStyle.Link)
      .setURL(result.url);

    const row = new ActionRowBuilder().addComponents(linkBtn);
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else {
    const embed = new EmbedBuilder()
      .setTitle(`⚠️ Couldn't extract code for ${retailerName}`)
      .setDescription(
        `The Student Beans page loaded but the code couldn't be pulled automatically.\n\nThis can happen if:\n• The layout changed recently\n• You need to verify your student status again\n• The offer requires the mobile app\n\n[Click here to get it manually](${retailerUrl})`
      )
      .setColor(0xff9800)
      .setFooter({ text: 'Student Beans • Only you can see this' });

    await interaction.editReply({ embeds: [embed], components: [] });
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await sb.closeBrowser();
  client.destroy();
  process.exit(0);
});

// ── Start ─────────────────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set in .env');
  process.exit(1);
}
if (!process.env.SB_EMAIL || !process.env.SB_PASSWORD) {
  console.error('❌ SB_EMAIL and SB_PASSWORD must be set in .env');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
